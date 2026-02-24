// ================================================================
// T1 BROKER MOBILE — KYC DOCUMENT UPLOAD
// Camera capture, gallery pick, upload with progress
// ================================================================
import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, SafeAreaView,
  Image, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useStore } from '../services/store';
import { Colors, createStyles, Spacing, Fonts, Radius } from '../utils/theme';
import api from '../services/api';

const DOC_TYPES = [
  { key: 'passport', label: 'Passport', icon: '🛂', desc: 'Photo page of your passport' },
  { key: 'national_id', label: 'National ID', icon: '🪪', desc: 'Front and back of your ID card' },
  { key: 'drivers_license', label: "Driver's License", icon: '🚗', desc: 'Front and back of your license' },
  { key: 'proof_of_address', label: 'Proof of Address', icon: '🏠', desc: 'Utility bill or bank statement (<3 months)' },
  { key: 'selfie', label: 'Selfie Verification', icon: '🤳', desc: 'Take a selfie holding your ID' },
];

export default function KYCUploadScreen({ navigation }) {
  const theme = useStore(s => s.theme);
  const colors = Colors[theme];
  const styles = createStyles(colors);

  const [step, setStep] = useState('select'); // 'select' | 'capture' | 'preview' | 'uploading' | 'done'
  const [docType, setDocType] = useState(null);
  const [imageUri, setImageUri] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [documents, setDocuments] = useState([]);
  const [cameraFacing, setCameraFacing] = useState('back');
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  useEffect(() => { loadDocuments(); }, []);

  async function loadDocuments() {
    const res = await api.get('/documents');
    if (res?.data) setDocuments(res.data);
  }

  // ── Camera capture ──
  async function takePicture() {
    if (!cameraRef.current) return;
    const photo = await cameraRef.current.takePictureAsync({
      quality: 0.8,
      base64: false,
      exif: false,
    });
    setImageUri(photo.uri);
    setStep('preview');
  }

  // ── Gallery pick ──
  async function pickFromGallery() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: true,
      aspect: [4, 3],
    });
    if (!result.canceled && result.assets?.[0]) {
      setImageUri(result.assets[0].uri);
      setStep('preview');
    }
  }

  // ── Upload ──
  async function uploadDocument() {
    if (!imageUri || !docType) return;
    setStep('uploading');
    setUploadProgress(0);

    try {
      const formData = new FormData();
      formData.append('file', {
        uri: imageUri,
        type: 'image/jpeg',
        name: `kyc_${docType}_${Date.now()}.jpg`,
      });
      formData.append('documentType', docType);

      // Upload with progress tracking
      const xhr = new XMLHttpRequest();
      const uploadPromise = new Promise((resolve, reject) => {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error(xhr.responseText || 'Upload failed'));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
      });

      const apiUrl = api.constructor?.API_URL || 'https://api.t1broker.com/api/v1';
      xhr.open('POST', `${apiUrl}/documents/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${api.accessToken}`);
      xhr.send(formData);

      await uploadPromise;
      setStep('done');
      loadDocuments();
    } catch (err) {
      Alert.alert('Upload Failed', err.message || 'Please try again');
      setStep('preview');
    }
  }

  // ── Document Type Selection ──
  if (step === 'select') {
    return (
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 120 }}>
          <Text style={[styles.title, { marginBottom: 4 }]}>KYC Verification</Text>
          <Text style={[styles.subtitle, { marginBottom: Spacing.lg }]}>Upload documents to verify your identity</Text>

          {/* Existing documents */}
          {documents.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Submitted Documents</Text>
              <View style={styles.card}>
                {documents.map((doc, i) => (
                  <View key={doc.id || i} style={[styles.listItem, i === documents.length - 1 && { borderBottomWidth: 0 }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ ...Fonts.medium, color: colors.text, textTransform: 'capitalize' }}>
                        {(doc.document_type || doc.type || '').replace(/_/g, ' ')}
                      </Text>
                      <Text style={{ ...Fonts.caption, color: colors.text4 }}>
                        {new Date(doc.created_at || doc.uploadedAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <View style={[styles.badge, {
                      backgroundColor: doc.status === 'approved' ? colors.greenLight :
                        doc.status === 'rejected' ? colors.redLight : colors.yellowLight,
                      paddingHorizontal: 8, paddingVertical: 3,
                    }]}>
                      <Text style={{
                        ...Fonts.caption, fontWeight: '600',
                        color: doc.status === 'approved' ? colors.green :
                          doc.status === 'rejected' ? colors.red : colors.yellow,
                      }}>{doc.status || 'pending'}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </>
          )}

          {/* Upload new */}
          <Text style={styles.sectionTitle}>Upload Document</Text>
          {DOC_TYPES.map(dt => (
            <TouchableOpacity key={dt.key}
              style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 8 }]}
              onPress={() => { setDocType(dt.key); setStep('capture'); }}>
              <Text style={{ fontSize: 28 }}>{dt.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ ...Fonts.semibold, color: colors.text }}>{dt.label}</Text>
                <Text style={{ ...Fonts.caption, color: colors.text3 }}>{dt.desc}</Text>
              </View>
              <Text style={{ color: colors.blue, fontSize: 18 }}>›</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Camera Capture ──
  if (step === 'capture') {
    if (!permission?.granted) {
      return (
        <SafeAreaView style={[styles.screen, styles.center, { padding: Spacing.lg }]}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>📷</Text>
          <Text style={[styles.cardTitle, { textAlign: 'center', marginBottom: 8 }]}>Camera Access Required</Text>
          <Text style={{ ...Fonts.regular, color: colors.text3, textAlign: 'center', marginBottom: 24 }}>
            We need camera access to capture your document photos
          </Text>
          <TouchableOpacity style={styles.btnPrimary} onPress={requestPermission}>
            <Text style={styles.btnPrimaryText}>Grant Camera Access</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btnGhost, { marginTop: 12 }]} onPress={pickFromGallery}>
            <Text style={styles.btnGhostText}>Choose from Gallery Instead</Text>
          </TouchableOpacity>
          <TouchableOpacity style={{ marginTop: 24 }} onPress={() => setStep('select')}>
            <Text style={{ color: colors.blue, ...Fonts.medium }}>← Back</Text>
          </TouchableOpacity>
        </SafeAreaView>
      );
    }

    const isSelfie = docType === 'selfie';
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          ref={cameraRef}
          style={{ flex: 1 }}
          facing={isSelfie ? 'front' : cameraFacing}
        >
          {/* Overlay guide */}
          <View style={{ flex: 1, justifyContent: 'space-between' }}>
            <SafeAreaView style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 16 }}>
              <TouchableOpacity onPress={() => setStep('select')}>
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>✕ Cancel</Text>
              </TouchableOpacity>
              <Text style={{ color: '#fff', ...Fonts.semibold, textTransform: 'capitalize' }}>
                {(docType || '').replace(/_/g, ' ')}
              </Text>
              {!isSelfie && (
                <TouchableOpacity onPress={() => setCameraFacing(f => f === 'back' ? 'front' : 'back')}>
                  <Text style={{ color: '#fff', fontSize: 20 }}>🔄</Text>
                </TouchableOpacity>
              )}
            </SafeAreaView>

            {/* Document frame guide */}
            <View style={{ alignItems: 'center', paddingHorizontal: 30 }}>
              <View style={{
                width: '100%', aspectRatio: isSelfie ? 1 : 1.6,
                borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)',
                borderRadius: isSelfie ? 999 : 12, borderStyle: 'dashed',
              }} />
              <Text style={{ color: 'rgba(255,255,255,0.7)', ...Fonts.caption, marginTop: 8, textAlign: 'center' }}>
                {isSelfie ? 'Position your face in the circle' : 'Align your document within the frame'}
              </Text>
            </View>

            {/* Controls */}
            <SafeAreaView style={{ alignItems: 'center', paddingBottom: 20, gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 40 }}>
                <TouchableOpacity onPress={pickFromGallery} style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 24 }}>🖼️</Text>
                  <Text style={{ color: '#fff', ...Fonts.caption, marginTop: 4 }}>Gallery</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={takePicture} style={{
                  width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: '#fff',
                  backgroundColor: 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center',
                }}>
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' }} />
                </TouchableOpacity>
                <View style={{ width: 50 }} />
              </View>
            </SafeAreaView>
          </View>
        </CameraView>
      </View>
    );
  }

  // ── Preview ──
  if (step === 'preview') {
    return (
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
          <Text style={[styles.title, { textAlign: 'center', marginBottom: Spacing.md }]}>Review Photo</Text>

          <View style={{ borderRadius: Radius.lg, overflow: 'hidden', marginBottom: Spacing.lg }}>
            <Image source={{ uri: imageUri }} style={{ width: '100%', aspectRatio: 4 / 3 }} resizeMode="cover" />
          </View>

          <View style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: Spacing.md }]}>
            <Text style={{ fontSize: 20 }}>{DOC_TYPES.find(d => d.key === docType)?.icon}</Text>
            <View>
              <Text style={{ ...Fonts.semibold, color: colors.text, textTransform: 'capitalize' }}>
                {(docType || '').replace(/_/g, ' ')}
              </Text>
              <Text style={{ ...Fonts.caption, color: colors.text3 }}>Ready to upload</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.btnPrimary} onPress={uploadDocument}>
            <Text style={styles.btnPrimaryText}>Upload Document</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.btnGhost, { marginTop: Spacing.sm }]}
            onPress={() => { setImageUri(null); setStep('capture'); }}>
            <Text style={styles.btnGhostText}>📷 Retake Photo</Text>
          </TouchableOpacity>

          <TouchableOpacity style={{ marginTop: Spacing.md, alignItems: 'center' }} onPress={() => setStep('select')}>
            <Text style={{ color: colors.blue, ...Fonts.medium }}>← Back to Documents</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Uploading ──
  if (step === 'uploading') {
    return (
      <SafeAreaView style={[styles.screen, styles.center]}>
        <ActivityIndicator size="large" color={colors.blue} />
        <Text style={{ ...Fonts.semibold, color: colors.text, marginTop: 16 }}>Uploading document...</Text>
        <View style={{ width: 200, height: 6, backgroundColor: colors.bg3, borderRadius: 3, marginTop: 16 }}>
          <View style={{ width: `${uploadProgress}%`, height: 6, backgroundColor: colors.blue, borderRadius: 3 }} />
        </View>
        <Text style={{ ...Fonts.mono, color: colors.text3, marginTop: 8 }}>{uploadProgress}%</Text>
      </SafeAreaView>
    );
  }

  // ── Done ──
  return (
    <SafeAreaView style={[styles.screen, styles.center, { padding: Spacing.lg }]}>
      <Text style={{ fontSize: 64, marginBottom: 16 }}>✅</Text>
      <Text style={{ ...Fonts.h2, color: colors.text, textAlign: 'center', marginBottom: 8 }}>Document Uploaded</Text>
      <Text style={{ ...Fonts.regular, color: colors.text3, textAlign: 'center', marginBottom: 32 }}>
        Your document is being reviewed. You'll be notified once verification is complete.
      </Text>
      <TouchableOpacity style={styles.btnPrimary} onPress={() => { setStep('select'); setImageUri(null); }}>
        <Text style={styles.btnPrimaryText}>Upload Another Document</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.btnGhost, { marginTop: 12 }]} onPress={() => navigation.goBack()}>
        <Text style={styles.btnGhostText}>Done</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
