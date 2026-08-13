/**
 * setup-tools.js — Downloads and installs Real-ESRGAN portable CLI
 * 
 * Usage: node setup-tools.js
 * 
 * Downloads realesrgan-ncnn-vulkan from GitHub releases,
 * extracts to ./tools/, and verifies the executable.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TOOLS_DIR = path.join(__dirname, 'tools');
const RELEASE_URL = 'https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases/download/v0.2.0/realesrgan-ncnn-vulkan-v0.2.0-windows.zip';
const ZIP_PATH = path.join(TOOLS_DIR, 'realesrgan.zip');
const EXE_NAME = 'realesrgan-ncnn-vulkan.exe';

function log(msg) {
  console.log(`  ${msg}`);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    log('Using PowerShell to download (handles redirects automatically)...');
    try {
      execSync(
        `powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing"`,
        { stdio: 'inherit', timeout: 300000 } // 5 min timeout
      );
      resolve();
    } catch (err) {
      reject(new Error(`Download failed: ${err.message}`));
    }
  });
}

async function main() {
  console.log('\n🔧 VideoForge — Tool Setup\n');
  console.log('━'.repeat(50));

  // Create tools directory
  if (!fs.existsSync(TOOLS_DIR)) {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    log('📁 Created tools/ directory');
  }

  // Check if already installed
  const exePath = findExe();
  if (exePath) {
    log(`✅ Real-ESRGAN already installed at: ${exePath}`);
    verifyExe(exePath);
    return;
  }

  // Download
  log('⬇ Downloading Real-ESRGAN ncnn-vulkan (Windows portable)...');
  log(`  Source: ${RELEASE_URL}`);
  console.log('');

  try {
    await downloadFile(RELEASE_URL, ZIP_PATH);
    log('✅ Download complete');
  } catch (err) {
    console.error(`\n❌ Download failed: ${err.message}`);
    console.error('   Please download manually from:');
    console.error('   https://github.com/xinntao/Real-ESRGAN/releases');
    console.error(`   Extract to: ${TOOLS_DIR}`);
    process.exit(1);
  }

  // Extract using PowerShell
  log('📦 Extracting archive...');
  try {
    execSync(
      `powershell -Command "Expand-Archive -Path '${ZIP_PATH}' -DestinationPath '${TOOLS_DIR}' -Force"`,
      { stdio: 'pipe' }
    );
    log('✅ Extraction complete');
  } catch (err) {
    console.error(`❌ Extraction failed: ${err.message}`);
    process.exit(1);
  }

  // Clean up zip
  try {
    fs.unlinkSync(ZIP_PATH);
    log('🗑 Cleaned up zip file');
  } catch (e) { /* ignore */ }

  // Find and verify exe
  const installedExe = findExe();
  if (installedExe) {
    log(`✅ Installed at: ${installedExe}`);
    verifyExe(installedExe);
  } else {
    console.error('❌ Could not find realesrgan-ncnn-vulkan.exe after extraction');
    console.error(`   Check contents of: ${TOOLS_DIR}`);
    process.exit(1);
  }
}

function findExe() {
  // Search in tools/ and its subdirectories
  function searchDir(dir) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === EXE_NAME) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const found = searchDir(fullPath);
        if (found) return found;
      }
    }
    return null;
  }
  return searchDir(TOOLS_DIR);
}

function verifyExe(exePath) {
  log('🔍 Verifying installation...');
  try {
    const output = execSync(`"${exePath}" -h`, {
      stdio: 'pipe',
      timeout: 10000
    }).toString();
    
    if (output.includes('upscale') || output.includes('ESRGAN') || output.includes('scale')) {
      log('✅ Real-ESRGAN CLI is working!');
    } else {
      log('✅ Executable runs (output verification inconclusive)');
    }
  } catch (err) {
    // realesrgan-ncnn-vulkan exits with non-zero for -h, but still prints help
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    if (stderr.includes('Usage') || stdout.includes('Usage') || stderr.includes('scale') || stdout.includes('scale')) {
      log('✅ Real-ESRGAN CLI is working!');
    } else {
      log('⚠️  Could not fully verify executable (may still work)');
    }
  }

  console.log('\n━'.repeat(50));
  console.log('🎬 Setup complete! You can now run: npm start\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
