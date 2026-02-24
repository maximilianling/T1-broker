#!/bin/bash
# ================================================================
# T1 BROKER — DATABASE BACKUP SCRIPT
# Usage: ./scripts/backup.sh [--upload-s3]
# Runs via cron: 0 */4 * * * /opt/t1-broker/scripts/backup.sh --upload-s3
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../.env" 2>/dev/null || true

BACKUP_DIR="${BACKUP_DIR:-/var/backups/t1broker}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="t1broker_${TIMESTAMP}.sql.gz"
RETENTION_DAYS=${RETENTION_DAYS:-30}

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting backup..."

# Dump database
PGPASSWORD="${DB_PASSWORD}" pg_dump \
  -h "${DB_HOST:-localhost}" \
  -p "${DB_PORT:-5432}" \
  -U "${DB_USER:-t1admin}" \
  -d "${DB_NAME:-t1broker}" \
  --no-owner \
  --no-privileges \
  --format=custom \
  | gzip > "${BACKUP_DIR}/${FILENAME}"

SIZE=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
echo "[$(date)] Backup created: ${FILENAME} (${SIZE})"

# Upload to S3 if requested
if [ "${1:-}" = "--upload-s3" ] && [ -n "${S3_BUCKET:-}" ]; then
  echo "[$(date)] Uploading to S3..."
  aws s3 cp "${BACKUP_DIR}/${FILENAME}" \
    "s3://${S3_BUCKET}/backups/${FILENAME}" \
    --storage-class STANDARD_IA \
    --sse aws:kms
  echo "[$(date)] Uploaded to s3://${S3_BUCKET}/backups/${FILENAME}"
fi

# Cleanup old backups
echo "[$(date)] Cleaning backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "t1broker_*.sql.gz" -mtime +${RETENTION_DAYS} -delete

echo "[$(date)] Backup complete."
