/**
 * ai-upscaler.js — Real-ESRGAN CLI integration for video upscaling
 * 
 * Pipeline:
 *   1. Auto-detect discrete GPU (NVIDIA / AMD) for maximum performance
 *   2. Extract frames from video (FFmpeg with safe FPS handling)
 *   3. Enhance frames with Real-ESRGAN CLI using GPU acceleration
 *   4. Reconstruct video from enhanced frames & mux audio from source (FFmpeg)
 *   5. Cleanup temp files
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

const BASE_DIR = process.env.PORTABLE_EXECUTABLE_DIR || process.cwd();
const TEMP_DIR = path.join(BASE_DIR, 'temp');
const EXE_NAME = process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan';

function getCandidateToolsDirs() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'tools'));
  if (process.env.PORTABLE_EXECUTABLE_DIR) dirs.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'tools'));
  dirs.push(path.join(__dirname, 'tools'));
  dirs.push(path.join(process.cwd(), 'tools'));
  return dirs;
}

// Cached GPU info
let detectedGpu = { id: 0, name: 'Auto/Default' };

// ─── Find Real-ESRGAN executable ────────────────────────────────────
function findExe(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === EXE_NAME) return fullPath;
    if (entry.isDirectory()) {
      const found = findExe(fullPath);
      if (found) return found;
    }
  }
  return null;
}

// ─── Detect Best GPU (NVIDIA / AMD discrete GPU over Intel iGPU) ─────
function detectBestGpu(exePath) {
  try {
    const testImg = path.join(TOOLS_DIR, 'input.jpg');
    const testOut = path.join(TEMP_DIR, '_gputest.jpg');
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    const args = fs.existsSync(testImg) 
      ? ['-i', testImg, '-o', testOut] 
      : ['-v'];

    const res = spawn(exePath, args, { cwd: path.dirname(exePath) });
    let output = '';
    
    return new Promise((resolve) => {
      res.stdout.on('data', (d) => output += d.toString());
      res.stderr.on('data', (d) => output += d.toString());
      
      const timeout = setTimeout(() => {
        try { res.kill(); } catch (e) {}
        resolve({ id: 0, name: 'Default GPU' });
      }, 6000);

      res.on('close', () => {
        clearTimeout(timeout);
        try { if (fs.existsSync(testOut)) fs.unlinkSync(testOut); } catch (e) {}

        const gpuLines = output.split('\n').filter(l => l.includes('[') && l.includes(']'));
        
        let bestId = 0;
        let bestName = 'Default GPU';
        const gpus = [];

        for (const line of gpuLines) {
          const match = line.match(/\[(\d+)\s+([^\]]+)\]/);
          if (match) {
            const id = parseInt(match[1], 10);
            const name = match[2].trim();
            if (!gpus.some(g => g.id === id)) {
              gpus.push({ id, name });
            }
          }
        }

        if (gpus.length > 0) {
          // Prefer discrete GPUs (NVIDIA / GeForce / RTX / GTX / Radeon / AMD / Arc)
          const discreteKeywords = ['nvidia', 'geforce', 'rtx', 'gtx', 'radeon', 'amd', 'arc'];
          const discreteGpu = gpus.find(g => 
            discreteKeywords.some(kw => g.name.toLowerCase().includes(kw))
          );

          if (discreteGpu) {
            bestId = discreteGpu.id;
            bestName = discreteGpu.name;
          } else {
            bestId = gpus[gpus.length - 1].id;
            bestName = gpus[gpus.length - 1].name;
          }
        }

        console.log(`[GPU Setup] Detected ${gpus.length} GPU(s). Selected GPU ${bestId}: "${bestName}"`);
        detectedGpu = { id: bestId, name: bestName };
        resolve({ id: bestId, name: bestName });
      });
    });
  } catch (err) {
    return Promise.resolve({ id: 0, name: 'Default GPU' });
  }
}

// ─── Check if AI upscaler is available ──────────────────────────────
async function checkAIAvailability() {
  let exePath = null;
  for (const dir of getCandidateToolsDirs()) {
    exePath = findExe(dir);
    if (exePath) break;
  }
  if (!exePath) {
    return { available: false, path: null, reason: 'Real-ESRGAN executable not found in tools/' };
  }

  if (!detectedGpu || detectedGpu.name === 'Auto/Default' || detectedGpu.name === 'Default GPU') {
    detectedGpu = await detectBestGpu(exePath);
  }

  return { available: true, path: exePath, gpu: detectedGpu };
}

// ─── Safe FPS parser ────────────────────────────────────────────────
function parseFps(fpsStr) {
  if (!fpsStr) return 30;
  try {
    if (typeof fpsStr === 'number') return fpsStr > 0 ? fpsStr : 30;
    const parts = String(fpsStr).split('/');
    if (parts.length === 2) {
      const num = parseFloat(parts[0]);
      const den = parseFloat(parts[1]);
      if (den > 0 && num > 0) return num / den;
    }
    const val = parseFloat(fpsStr);
    return isNaN(val) || val <= 0 ? 30 : val;
  } catch (e) {
    return 30;
  }
}

// ─── Ensure temp directories exist ──────────────────────────────────
function ensureTempDirs(jobId) {
  const jobTempDir = path.join(TEMP_DIR, jobId);
  const framesInput = path.join(jobTempDir, 'frames_input');
  const framesOutput = path.join(jobTempDir, 'frames_output');

  [framesInput, framesOutput].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  return { jobTempDir, framesInput, framesOutput };
}

// ─── Cleanup temp directories ───────────────────────────────────────
function cleanupTemp(jobId) {
  const jobTempDir = path.join(TEMP_DIR, jobId);
  if (fs.existsSync(jobTempDir)) {
    try {
      fs.rmSync(jobTempDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[Cleanup] Non-fatal cleanup warning for ${jobId}: ${e.message}`);
    }
  }
}

// ─── Step 1: Extract frames from video ──────────────────────────────
function extractFrames(inputPath, framesDir, fps) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(new Error(`Probe failed: ${err.message}`));

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const duration = parseFloat(metadata.format.duration || 0);
      const sourceFps = videoStream ? parseFps(videoStream.r_frame_rate || videoStream.avg_frame_rate) : 30;

      const targetFps = fps || sourceFps;
      const outputPattern = path.join(framesDir, 'frame_%06d.jpg');

      const cmd = ffmpeg(inputPath)
        .outputOptions([
          '-vf', `fps=${targetFps}`,
          '-q:v', '2'  // High-quality JPEG for fast GPU I/O
        ])
        .output(outputPattern);

      cmd.on('end', () => {
        const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
        resolve({
          frameCount: files.length,
          fps: targetFps,
          duration
        });
      });

      cmd.on('error', (err) => {
        reject(new Error(`Frame extraction failed: ${err.message}`));
      });

      cmd.run();
    });
  });
}

// ─── Step 2: Enhance frames with Real-ESRGAN ───────────────────────
function enhanceFrames(exePath, framesInputDir, framesOutputDir, scale, job, gpuId = 0) {
  return new Promise((resolve, reject) => {
    const totalFrames = fs.readdirSync(framesInputDir).filter(f => f.endsWith('.jpg')).length;
    if (totalFrames === 0) {
      return reject(new Error('No frames to enhance'));
    }

    // Determine scale and model
    const scaleNum = scale === '4x' || scale === 'ai-enhance' ? 4 : 2;
    // Use realesr-animevideov3 for 2x, realesrgan-x4plus for 4x/ai-enhance
    const modelName = scaleNum === 2 ? 'realesr-animevideov3' : 'realesrgan-x4plus';

    const args = [
      '-i', framesInputDir,
      '-o', framesOutputDir,
      '-s', String(scaleNum),
      '-n', modelName,
      '-g', String(gpuId), // Explicit GPU ID (e.g. 1 for NVIDIA RTX 4060)
      '-f', 'jpg',
      '-j', '1:2:2'
    ];

    job.stage = `Enhancing frames with AI on GPU (0/${totalFrames})...`;
    job.progress = 10;

    const proc = spawn(exePath, args, {
      cwd: path.dirname(exePath),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderrBuffer = '';

    proc.stdout.on('data', (data) => {
      updateProgressFromOutput(data.toString(), totalFrames, job);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;
      updateProgressFromOutput(text, totalFrames, job);
    });

    proc.on('close', (code) => {
      const outputFrames = fs.existsSync(framesOutputDir)
        ? fs.readdirSync(framesOutputDir).filter(f => f.endsWith('.jpg'))
        : [];

      if (code !== 0 && outputFrames.length < totalFrames * 0.85) {
        reject(new Error(
          `Real-ESRGAN failed (exit code ${code}). ` +
          `Processed ${outputFrames.length}/${totalFrames} frames. ` +
          `Error: ${stderrBuffer.slice(-500)}`
        ));
      } else {
        resolve({ enhancedCount: outputFrames.length, totalFrames });
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Real-ESRGAN: ${err.message}`));
    });
  });
}

function updateProgressFromOutput(text, totalFrames, job) {
  const percentMatch = text.match(/([\d.]+)%/);
  if (percentMatch) {
    const rawPct = parseFloat(percentMatch[1]);
    const mappedProgress = Math.round(10 + (rawPct / 100) * 75);
    job.progress = Math.min(mappedProgress, 85);
  }

  const frameMatch = text.match(/(\d+)\/(\d+)/);
  if (frameMatch) {
    const done = parseInt(frameMatch[1]);
    const total = parseInt(frameMatch[2]);
    job.stage = `Enhancing frames with AI on GPU (${done}/${total})...`;
    const mappedProgress = Math.round(10 + (done / total) * 75);
    job.progress = Math.min(mappedProgress, 85);
  }
}

// ─── Step 3: Rebuild video from enhanced frames & Mux Source Audio ──
function rebuildVideo(framesDir, inputPath, outputPath, fps, formatSettings) {
  return new Promise((resolve, reject) => {
    const framePattern = path.join(framesDir, 'frame_%06d.jpg');

    const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
    if (frameFiles.length === 0) {
      return reject(new Error('No enhanced frames found for video reconstruction'));
    }

    // Input 0: Enhanced frames
    // Input 1: Original video file (for audio muxing)
    let cmd = ffmpeg()
      .input(framePattern)
      .inputFPS(fps)
      .input(inputPath);

    // Video encoding
    if (formatSettings.vcodec) {
      cmd = cmd.videoCodec(formatSettings.vcodec);
    }

    const outputOpts = [];

    if (formatSettings.crf !== undefined) {
      outputOpts.push('-crf', String(formatSettings.crf));
    }

    if (formatSettings.vcodec === 'libx264' || formatSettings.vcodec === 'libx265') {
      outputOpts.push('-preset', formatSettings.preset || 'fast');
    }

    outputOpts.push('-pix_fmt', 'yuv420p');

    if (formatSettings.extraArgs && formatSettings.extraArgs.length > 0) {
      outputOpts.push(...formatSettings.extraArgs);
    }

    // Map video stream from frames (0:v:0) and audio stream from input file if exists (1:a:0?)
    outputOpts.push('-map', '0:v:0', '-map', '1:a:0?', '-shortest');

    if (formatSettings.acodec) {
      cmd = cmd.audioCodec(formatSettings.acodec);
    }
    if (formatSettings.audioBitrate) {
      cmd = cmd.audioBitrate(formatSettings.audioBitrate);
    }

    cmd.outputOptions(outputOpts);
    cmd.output(outputPath);

    cmd.on('end', () => resolve());
    cmd.on('error', (err) => reject(new Error(`Video rebuild failed: ${err.message}`)));
    cmd.run();
  });
}

// ─── Main orchestrator: processVideoWithAI ──────────────────────────
async function processVideoWithAI(job, options) {
  const {
    inputPath,
    outputPath,
    format,
    quality,
    scale,
    formatSettings
  } = options;

  const jobId = path.basename(inputPath, path.extname(inputPath));
  const { jobTempDir, framesInput, framesOutput } = ensureTempDirs(jobId);

  const aiCheck = await checkAIAvailability();
  if (!aiCheck.available) {
    throw new Error(`AI upscaler not available: ${aiCheck.reason || 'Executable not found'}`);
  }

  try {
    // ── Step 1: Extract frames ──
    job.stage = 'Extracting frames from video...';
    job.progress = 2;
    console.log(`[AI] Extracting frames from: ${inputPath}`);

    const frameInfo = await extractFrames(inputPath, framesInput, null);
    console.log(`[AI] Extracted ${frameInfo.frameCount} frames at ${frameInfo.fps.toFixed(2)} FPS`);

    job.stage = `Extracted ${frameInfo.frameCount} frames`;
    job.progress = 10;

    // ── Step 2: AI enhancement ──
    const gpuInfo = detectedGpu || { id: 0, name: 'Default GPU' };
    job.stage = `Enhancing frames with AI on ${gpuInfo.name} (0/${frameInfo.frameCount})...`;
    console.log(`[AI] Starting Real-ESRGAN on GPU ${gpuInfo.id} (${gpuInfo.name}), Scale: ${scale}, ${frameInfo.frameCount} frames...`);

    const enhanceResult = await enhanceFrames(
      aiCheck.path,
      framesInput,
      framesOutput,
      scale,
      job,
      gpuInfo.id
    );
    console.log(`[AI] Enhanced ${enhanceResult.enhancedCount}/${enhanceResult.totalFrames} frames`);

    job.stage = 'Rebuilding video & muxing audio...';
    job.progress = 88;

    // ── Step 3: Rebuild video ──
    console.log(`[AI] Rebuilding video: ${outputPath}`);
    await rebuildVideo(framesOutput, inputPath, outputPath, frameInfo.fps, formatSettings);

    job.stage = 'Finalizing...';
    job.progress = 98;

    console.log(`[AI] ✅ AI upscale complete: ${outputPath}`);

  } finally {
    console.log(`[AI] Cleaning up temp files for job ${jobId}`);
    cleanupTemp(jobId);
  }
}

// ─── Initialize GPU detection on module load ─────────────────────────
(async () => {
  let exePath = null;
  for (const dir of getCandidateToolsDirs()) {
    exePath = findExe(dir);
    if (exePath) break;
  }
  if (exePath) {
    detectedGpu = await detectBestGpu(exePath);
  }
})();

// ─── Exports ────────────────────────────────────────────────────────
module.exports = {
  checkAIAvailability,
  extractFrames,
  enhanceFrames,
  rebuildVideo,
  processVideoWithAI,
  cleanupTemp,
  TEMP_DIR
};
