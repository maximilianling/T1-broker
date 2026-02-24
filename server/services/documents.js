// ================================================================
// T1 BROKER — FILE UPLOAD & KYC DOCUMENT SERVICE
// S3 storage with local fallback, integrity hashing, virus scan stub
// ================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const db = require('../config/database');
const logger = require('../utils/logger');
const AuditService = require('../utils/audit');
const { encrypt } = require('../utils/encryption');

// ----------------------------------------------------------------
// Multer configuration — temp storage before S3 upload
// ----------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.resolve(config.uploads.storagePath, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  if (config.uploads.allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} not allowed. Accepted: PDF, JPEG, PNG, WebP`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.uploads.maxFileSize },
});

// ----------------------------------------------------------------
// Document Service
// ----------------------------------------------------------------
class DocumentService {
  /**
   * Upload a KYC document for a client
   */
  static async uploadDocument({ clientId, documentType, file, uploadedBy, ipAddress }) {
    // 1. Compute file hash for integrity
    const fileBuffer = fs.readFileSync(file.path);
    const fileHash = crypto.createHash('sha512').update(fileBuffer).digest('hex');

    // 2. Check for duplicate upload
    const existing = await db('client_documents')
      .where('client_id', clientId)
      .where('file_hash', fileHash)
      .first();

    if (existing) {
      fs.unlinkSync(file.path); // Clean up temp file
      return { duplicate: true, existingId: existing.id };
    }

    // 3. Virus scan stub (integrate ClamAV or AWS S3 malware scanning in production)
    const scanResult = await this._virusScan(file.path);
    if (!scanResult.clean) {
      fs.unlinkSync(file.path);
      logger.error('Virus detected in uploaded file', { clientId, fileName: file.originalname });
      AuditService.log({
        userId: uploadedBy,
        action: `Malware detected in uploaded document: ${file.originalname}`,
        resourceType: 'document',
        level: 'critical',
        ipAddress,
      });
      throw new Error('File failed security scan');
    }

    // 4. Upload to storage (S3 or local)
    let storagePath;
    try {
      storagePath = await this._storeFile(clientId, file, fileBuffer);
    } finally {
      // Always clean up temp file
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }

    // 5. Save document record (encrypt the storage path)
    const [doc] = await db('client_documents').insert({
      client_id: clientId,
      document_type: documentType,
      file_name: file.originalname,
      file_path: encrypt(storagePath),
      file_hash: fileHash,
      mime_type: file.mimetype,
      file_size: file.size,
      status: 'pending',
    }).returning('*');

    // 6. Update client KYC status if it was 'not_started'
    await db('clients')
      .where('id', clientId)
      .where('kyc_status', 'not_started')
      .update({ kyc_status: 'in_progress' });

    AuditService.log({
      userId: uploadedBy,
      action: `KYC document uploaded: ${documentType} for client ${clientId}`,
      resourceType: 'document',
      resourceId: doc.id,
      level: 'info',
      ipAddress,
      newValues: { documentType, fileName: file.originalname, fileSize: file.size },
    });

    logger.info('Document uploaded', { clientId, documentType, docId: doc.id });
    return doc;
  }

  /**
   * Review a document (approve/reject)
   */
  static async reviewDocument({ documentId, status, reviewNotes, reviewedBy, ipAddress }) {
    const doc = await db('client_documents').where('id', documentId).first();
    if (!doc) throw new Error('Document not found');

    const [updated] = await db('client_documents')
      .where('id', documentId)
      .update({
        status,
        reviewed_by: reviewedBy,
        reviewed_at: new Date(),
        review_notes: reviewNotes,
      })
      .returning('*');

    // Check if all required documents are approved for this client
    if (status === 'approved') {
      await this._checkKycCompletion(doc.client_id, reviewedBy);
    }

    AuditService.log({
      userId: reviewedBy,
      action: `Document ${status}: ${doc.document_type} (${doc.file_name})`,
      resourceType: 'document',
      resourceId: documentId,
      level: status === 'approved' ? 'success' : 'warning',
      ipAddress,
      oldValues: { status: doc.status },
      newValues: { status, reviewNotes },
    });

    return updated;
  }

  /**
   * Get all documents for a client
   */
  static async getClientDocuments(clientId) {
    return db('client_documents')
      .where('client_id', clientId)
      .orderBy('uploaded_at', 'desc');
  }

  /**
   * Get document download URL (presigned S3 URL or local path)
   */
  static async getDownloadUrl(documentId) {
    const doc = await db('client_documents').where('id', documentId).first();
    if (!doc) throw new Error('Document not found');

    const { decrypt } = require('../utils/encryption');
    const storagePath = decrypt(doc.file_path);

    if (config.aws.accessKeyId && storagePath.startsWith('s3://')) {
      // Generate presigned S3 URL
      const AWS = require('aws-sdk');
      const s3 = new AWS.S3({
        region: config.aws.region,
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
      });
      const key = storagePath.replace(`s3://${config.aws.s3Bucket}/`, '');
      const url = s3.getSignedUrl('getObject', {
        Bucket: config.aws.s3Bucket,
        Key: key,
        Expires: 300, // 5 minutes
      });
      return { url, expiresIn: 300 };
    }

    // Local file fallback
    return { path: storagePath, local: true };
  }

  // ----------------------------------------------------------------
  // Check if all required KYC docs are approved
  // ----------------------------------------------------------------
  static async _checkKycCompletion(clientId, reviewedBy) {
    const requiredDocs = ['passport', 'proof_of_address', 'source_of_funds'];

    const approved = await db('client_documents')
      .where('client_id', clientId)
      .where('status', 'approved')
      .pluck('document_type');

    const allApproved = requiredDocs.every(d => approved.includes(d));

    if (allApproved) {
      await db('clients').where('id', clientId).update({
        kyc_status: 'approved',
        kyc_approved_at: new Date(),
        kyc_approved_by: reviewedBy,
        kyc_expiry_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        status: 'active', // Auto-activate on KYC approval
      });

      logger.info('Client KYC fully approved', { clientId });

      // Send email notification
      try {
        const { emailService, NotificationService } = require('./notifications');
        const client = await db('clients').where('id', clientId).first();
        const user = await db('users').where('id', client.user_id).first();

        await emailService.send({
          to: user.email,
          subject: emailService.getSubject('kycApproved', {}),
          template: 'kycApproved',
          data: { name: client.first_name },
        });

        await NotificationService.create({
          userId: client.user_id,
          title: 'KYC Approved',
          message: 'Your identity verification is complete. You can now trade.',
          type: 'success',
        });
      } catch (e) {
        logger.warn('Failed to send KYC approval notification', { error: e.message });
      }
    } else {
      // Check if client submitted all docs but some are pending
      const pending = await db('client_documents')
        .where('client_id', clientId)
        .where('status', 'pending')
        .count()
        .first();

      if (parseInt(pending.count) > 0) {
        await db('clients').where('id', clientId)
          .whereIn('kyc_status', ['not_started', 'in_progress'])
          .update({ kyc_status: 'pending_review' });
      }
    }
  }

  // ----------------------------------------------------------------
  // Virus scanning stub
  // ----------------------------------------------------------------
  static async _virusScan(filePath) {
    // In production: integrate ClamAV via clamdscan or AWS S3 malware protection
    // For now, basic checks:
    const buffer = fs.readFileSync(filePath, { encoding: null });
    const header = buffer.slice(0, 4).toString('hex');

    // Check for executable headers (PE, ELF, Mach-O)
    const dangerousHeaders = ['4d5a', '7f454c46', 'cafebabe', 'cefaedfe'];
    if (dangerousHeaders.some(h => header.startsWith(h))) {
      return { clean: false, reason: 'Executable file detected' };
    }

    return { clean: true };
  }

  // ----------------------------------------------------------------
  // File storage (S3 with local fallback)
  // ----------------------------------------------------------------
  static async _storeFile(clientId, file, buffer) {
    const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    const key = `clients/${clientId}/${datePrefix}/${file.filename}`;

    if (config.aws.accessKeyId) {
      // S3 upload
      const AWS = require('aws-sdk');
      const s3 = new AWS.S3({
        region: config.aws.region,
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
      });

      await s3.putObject({
        Bucket: config.aws.s3Bucket,
        Key: key,
        Body: buffer,
        ContentType: file.mimetype,
        ServerSideEncryption: 'aws:kms',
        Metadata: {
          clientId,
          originalName: file.originalname,
          uploadedAt: new Date().toISOString(),
        },
      }).promise();

      return `s3://${config.aws.s3Bucket}/${key}`;
    }

    // Local fallback
    const localDir = path.resolve(config.uploads.storagePath, 'documents', clientId);
    fs.mkdirSync(localDir, { recursive: true });
    const localPath = path.join(localDir, file.filename);
    fs.writeFileSync(localPath, buffer);
    return localPath;
  }
}

module.exports = { upload, DocumentService };
