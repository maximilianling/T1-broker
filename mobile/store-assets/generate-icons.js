#!/usr/bin/env node
// ================================================================
// T1 BROKER — APP ICON GENERATOR
// Generates all required icon sizes for iOS, Android, and Web
// Usage: node generate-icons.js [source-image.png]
// Requires: npm install sharp
// ================================================================
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, 'icons');
const SOURCE = process.argv[2];

// All required icon sizes
const ICONS = [
  // iOS App Icons
  { name: 'ios-20@2x.png', size: 40 },
  { name: 'ios-20@3x.png', size: 60 },
  { name: 'ios-29@2x.png', size: 58 },
  { name: 'ios-29@3x.png', size: 87 },
  { name: 'ios-40@2x.png', size: 80 },
  { name: 'ios-40@3x.png', size: 120 },
  { name: 'ios-60@2x.png', size: 120 },
  { name: 'ios-60@3x.png', size: 180 },
  { name: 'ios-76.png', size: 76 },
  { name: 'ios-76@2x.png', size: 152 },
  { name: 'ios-83.5@2x.png', size: 167 },
  { name: 'ios-1024.png', size: 1024 },

  // Android Adaptive (xxxhdpi)
  { name: 'android-mdpi.png', size: 48 },
  { name: 'android-hdpi.png', size: 72 },
  { name: 'android-xhdpi.png', size: 96 },
  { name: 'android-xxhdpi.png', size: 144 },
  { name: 'android-xxxhdpi.png', size: 192 },
  { name: 'android-adaptive-fg.png', size: 432 }, // 108dp * 4 (xxxhdpi)
  { name: 'android-playstore.png', size: 512 },

  // Web & PWA
  { name: 'favicon-16.png', size: 16 },
  { name: 'favicon-32.png', size: 32 },
  { name: 'favicon-48.png', size: 48 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-72.png', size: 72 },
  { name: 'icon-96.png', size: 96 },
  { name: 'icon-128.png', size: 128 },
  { name: 'icon-144.png', size: 144 },
  { name: 'icon-152.png', size: 152 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-384.png', size: 384 },
  { name: 'icon-512.png', size: 512 },
];

async function generateFromSource(sourcePath) {
  console.log(`\n🎨 Generating icons from: ${sourcePath}\n`);

  for (const icon of ICONS) {
    const outputPath = path.join(OUTPUT_DIR, icon.name);
    await sharp(sourcePath)
      .resize(icon.size, icon.size, { fit: 'cover', background: { r: 10, g: 15, b: 28 } })
      .png()
      .toFile(outputPath);

    console.log(`  ✓ ${icon.name} (${icon.size}×${icon.size})`);
  }
}

async function generateProgrammatic() {
  console.log('\n🎨 Generating T1 Broker icons programmatically\n');

  for (const icon of ICONS) {
    const size = icon.size;
    const fontSize = Math.max(8, Math.round(size * 0.4));
    const accentY = Math.round(size * 0.62);
    const accentW = Math.round(size * 0.35);

    // Create SVG for the icon
    const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#0f172a"/>
          <stop offset="100%" style="stop-color:#0a0f1c"/>
        </linearGradient>
        <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:#3b82f6"/>
          <stop offset="100%" style="stop-color:#60a5fa"/>
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" fill="url(#bg)"/>
      <text x="${size/2}" y="${size * 0.55}" font-family="Courier New, monospace" font-size="${fontSize}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">T1</text>
      <rect x="${(size - accentW)/2}" y="${accentY}" width="${accentW}" height="${Math.max(2, Math.round(size * 0.025))}" rx="${Math.max(1, Math.round(size * 0.01))}" fill="url(#accent)"/>
    </svg>`;

    const outputPath = path.join(OUTPUT_DIR, icon.name);
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(outputPath);

    console.log(`  ✓ ${icon.name} (${size}×${size})`);
  }

  // Generate feature graphic for Google Play
  const featureW = 1024, featureH = 500;
  const featureSvg = `<svg width="${featureW}" height="${featureH}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="fbg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#0a0f1c"/>
        <stop offset="50%" style="stop-color:#111827"/>
        <stop offset="100%" style="stop-color:#0f172a"/>
      </linearGradient>
    </defs>
    <rect width="${featureW}" height="${featureH}" fill="url(#fbg)"/>
    <text x="80" y="200" font-family="Courier New, monospace" font-size="72" font-weight="bold" fill="white">T1 Broker</text>
    <text x="80" y="260" font-family="Arial, sans-serif" font-size="24" fill="#94a3b8">Professional Multi-Asset Trading</text>
    <rect x="80" y="280" width="180" height="4" rx="2" fill="#3b82f6"/>
    <!-- Candlestick chart visualization -->
    ${Array.from({ length: 20 }, (_, i) => {
      const x = 600 + i * 22;
      const isGreen = Math.random() > 0.45;
      const h = 50 + Math.random() * 120;
      const y = 100 + Math.random() * 200;
      return `<rect x="${x}" y="${y}" width="12" height="${h}" rx="2" fill="${isGreen ? '#22c55e' : '#ef4444'}" opacity="0.7"/>
      <line x1="${x+6}" y1="${y - 15}" x2="${x+6}" y2="${y + h + 15}" stroke="${isGreen ? '#22c55e' : '#ef4444'}" stroke-width="1.5" opacity="0.5"/>`;
    }).join('\n')}
  </svg>`;

  await sharp(Buffer.from(featureSvg))
    .resize(featureW, featureH)
    .png()
    .toFile(path.join(OUTPUT_DIR, 'feature-graphic.png'));

  console.log(`  ✓ feature-graphic.png (${featureW}×${featureH})`);
}

async function main() {
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  if (SOURCE && fs.existsSync(SOURCE)) {
    await generateFromSource(SOURCE);
  } else {
    if (SOURCE) console.warn(`⚠ Source file not found: ${SOURCE}\n  Generating programmatic icons instead.`);
    await generateProgrammatic();
  }

  console.log(`\n✅ Generated ${ICONS.length + 1} icons in ${OUTPUT_DIR}\n`);

  // Summary
  console.log('📱 iOS:');
  console.log('   Copy ios-*.png to Xcode Assets.xcassets/AppIcon.appiconset/');
  console.log('   Upload ios-1024.png to App Store Connect\n');
  console.log('🤖 Android:');
  console.log('   Copy android-*.png to android/app/src/main/res/mipmap-*/');
  console.log('   Upload android-playstore.png and feature-graphic.png to Google Play Console\n');
  console.log('🌐 Web:');
  console.log('   Copy icon-*.png and apple-touch-icon.png to client/public/icons/');
  console.log('   Copy favicon-*.png to client/public/\n');
}

main().catch(console.error);
