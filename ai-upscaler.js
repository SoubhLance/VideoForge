/**
 * ai-upscaler.js — Real-ESRGAN CLI integration for video upscaling
 * 
 * Pipeline:
 *   1. Extract frames from video (FFmpeg)
 *   2. Enhance frames with Real-ESRGAN CLI (child_process.spawn)
 *   3. Reconstruct video from enhanced frames (FFmpeg)
 *   4. Mux original audio back in (FFmpeg)
 *   5. Cleanup temp files
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

const TOOLS_DIR = path.join(__dirname, 'tools');
const TEMP_DIR = path.join(__dirname, 'temp');
const EXE_NAME = 'realesrgan-ncnn-vulkan.exe';

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

// ─── Check if AI upscaler is available ──────────────────────────────
function checkAIAvailability() {
  const exePath = findExe(TOOLS_DIR);
  if (!exePath) {
    return { available: false, path: null, reason: 'Real-ESRGAN executable not found in tools/' };
  }

  // Quick verification
  try {
    execSync(`"${exePath}" -h`, { stdio: 'pipe', timeout: 10000 });
  } catch (err) {
    // realesrgan-ncnn-vulkan exits non-zero for -h but still works
    const output = (err.stderr || '').toString() + (err.stdout || '').toString();
    if (!output.includes('Usage') && !output.includes('scale') && !output.includes('input')) {
      return { available: false, path: exePath, reason: 'Executable found but failed verification' };
    }
  }

  return { available: true, path: exePath };
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
    fs.rmSync(jobTempDir, { recursive: true, force: true });
  }
}

// ─── Step 1: Extract frames from video ──────────────────────────────
function extractFrames(inputPath, framesDir, fps) {
  return new Promise((resolve, reject) => {
    // Get frame count estimate first
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(new Error(`Probe failed: ${err.message}`));

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const duration = parseFloat(metadata.format.duration || 0);
      const sourceFps = videoStream && videoStream.r_frame_rate
        ? eval(videoStream.r_frame_rate)
        : 30;

      // Use source FPS if not specified
      const targetFps = fps || sourceFps;
      const estimatedFrames = Math.ceil(duration * targetFps);

      const outputPattern = path.join(framesDir, 'frame_%06d.jpg');

      const cmd = ffmpeg(inputPath)
        .outputOptions([
          '-vf', `fps=${targetFps}`,
          '-q:v', '2'  // High-quality JPEG for 90% size reduction and faster I/O
        ])
        .output(outputPattern);

      cmd.on('end', () => {
        // Count actual frames extracted
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

// ─── Step 2: Extract audio track ────────────────────────────────────
function extractAudio(inputPath, audioOutputPath) {
  return new Promise((resolve, reject) => {
    // Check if input has audio
    ffmpeg.ffprobe(inputPath, (probeErr, metadata) => {
      if (probeErr) return reject(new Error(`Audio probe failed: ${probeErr.message}`));

      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      if (!audioStream) {
        return resolve({ hasAudio: false });
      }

      const cmd = ffmpeg(inputPath)
        .outputOptions(['-vn', '-acodec', 'copy'])
        .output(audioOutputPath);

      cmd.on('end', () => resolve({ hasAudio: true, path: audioOutputPath }));
      cmd.on('error', (err) => {
        // If audio extraction fails, continue without audio
        console.warn('Audio extraction failed, continuing without audio:', err.message);
        resolve({ hasAudio: false });
      });
      cmd.run();
    });
  });
}

// ─── Step 3: Enhance frames with Real-ESRGAN ───────────────────────
function enhanceFrames(exePath, framesInputDir, framesOutputDir, scale, job) {
  return new Promise((resolve, reject) => {
    const totalFrames = fs.readdirSync(framesInputDir).filter(f => f.endsWith('.jpg')).length;
    if (totalFrames === 0) {
      return reject(new Error('No frames to enhance'));
    }

    // Determine model name based on scale
    // realesrgan-x4plus works for both 2x and 4x (the tool handles scale param)
    const modelName = 'realesrgan-x4plus';
    const scaleNum = scale === '4x' ? 4 : 2;

    // Build args — process entire directory at once
    const args = [
      '-i', framesInputDir,
      '-o', framesOutputDir,
      '-s', String(scaleNum),
      '-n', modelName,
      '-f', 'jpg',
      '-j', '1:2:2'  // Thread config: load:proc:save — conservative to avoid OOM
    ];

    job.stage = `Enhancing frames with AI (0/${totalFrames})...`;
    job.progress = 10; // Base progress after frame extraction

    // Progressive cleanup: delete input frames as soon as their enhanced version exists
    const cleanInterval = setInterval(() => {
      try {
        if (!fs.existsSync(framesOutputDir)) return;
        const outFiles = fs.readdirSync(framesOutputDir);
        for (const file of outFiles) {
          if (file.endsWith('.jpg')) {
            const inputFilePath = path.join(framesInputDir, file);
            if (fs.existsSync(inputFilePath)) {
              fs.unlinkSync(inputFilePath);
            }
          }
        }
      } catch (e) {
        // Ignore deletion errors
      }
    }, 1000);

    const proc = spawn(exePath, args, {
      cwd: path.dirname(exePath), // Run from tools dir so models are found
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderrBuffer = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      // Real-ESRGAN outputs progress like "XX.XX%" 
      updateProgressFromOutput(text, totalFrames, job);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;
      // Real-ESRGAN also outputs progress to stderr
      updateProgressFromOutput(text, totalFrames, job);
    });

    proc.on('close', (code) => {
      clearInterval(cleanInterval);
      if (code !== 0) {
        // Check if any output frames exist despite error code
        const outputFrames = fs.existsSync(framesOutputDir)
          ? fs.readdirSync(framesOutputDir).filter(f => f.endsWith('.jpg'))
          : [];

        if (outputFrames.length >= totalFrames * 0.9) {
          // Most frames processed, consider it success
          console.warn(`Real-ESRGAN exited with code ${code} but ${outputFrames.length}/${totalFrames} frames enhanced`);
          resolve({ enhancedCount: outputFrames.length, totalFrames });
        } else {
          reject(new Error(
            `Real-ESRGAN failed (exit code ${code}). ` +
            `Processed ${outputFrames.length}/${totalFrames} frames. ` +
            `Error: ${stderrBuffer.slice(-500)}`
          ));
        }
      } else {
        const outputFrames = fs.readdirSync(framesOutputDir).filter(f => f.endsWith('.jpg'));
        resolve({ enhancedCount: outputFrames.length, totalFrames });
      }
    });

    proc.on('error', (err) => {
      clearInterval(cleanInterval);
      reject(new Error(`Failed to spawn Real-ESRGAN: ${err.message}`));
    });
  });
}

function updateProgressFromOutput(text, totalFrames, job) {
  // Real-ESRGAN outputs percentage per frame
  const percentMatch = text.match(/([\d.]+)%/);
  if (percentMatch) {
    const rawPct = parseFloat(percentMatch[1]);
    // Map 0-100% of AI processing to the 10-85% range of overall job progress
    const mappedProgress = Math.round(10 + (rawPct / 100) * 75);
    job.progress = Math.min(mappedProgress, 85);
  }

  // Also try to count completed frames by checking output dir
  const frameMatch = text.match(/(\d+)\/(\d+)/);
  if (frameMatch) {
    const done = parseInt(frameMatch[1]);
    const total = parseInt(frameMatch[2]);
    job.stage = `Enhancing frames with AI (${done}/${total})...`;
    const mappedProgress = Math.round(10 + (done / total) * 75);
    job.progress = Math.min(mappedProgress, 85);
  }
}

// ─── Step 4: Rebuild video from enhanced frames ─────────────────────
function rebuildVideo(framesDir, audioInfo, outputPath, fps, formatSettings) {
  return new Promise((resolve, reject) => {
    const framePattern = path.join(framesDir, 'frame_%06d.jpg');

    // Check that frames exist
    const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
    if (frameFiles.length === 0) {
      return reject(new Error('No enhanced frames found for video reconstruction'));
    }

    let cmd = ffmpeg()
      .input(framePattern)
      .inputFPS(fps);

    // Add audio if available
    if (audioInfo.hasAudio) {
      cmd = cmd.input(audioInfo.path);
    }

    // Video encoding
    if (formatSettings.vcodec) {
      cmd = cmd.videoCodec(formatSettings.vcodec);
    }

    // Build output options
    const outputOpts = [];

    if (formatSettings.crf !== undefined) {
      outputOpts.push('-crf', String(formatSettings.crf));
    }

    // Fast transcode preset for rebuild to speed up reconstruction
    if (formatSettings.vcodec === 'libx264' || formatSettings.vcodec === 'libx265') {
      if (formatSettings.preset) {
        outputOpts.push('-preset', formatSettings.preset);
      }
    }

    if (formatSettings.vcodec === 'libvpx-vp9') {
      outputOpts.push('-b:v', '0');
    }

    // Pixel format for compatibility
    outputOpts.push('-pix_fmt', 'yuv420p');

    if (formatSettings.extraArgs && formatSettings.extraArgs.length > 0) {
      outputOpts.push(...formatSettings.extraArgs);
    }

    if (outputOpts.length > 0) {
      cmd = cmd.outputOptions(outputOpts);
    }

    // Audio encoding
    if (audioInfo.hasAudio) {
      if (formatSettings.acodec) {
        cmd = cmd.audioCodec(formatSettings.acodec);
      }
      if (formatSettings.audioBitrate) {
        cmd = cmd.audioBitrate(formatSettings.audioBitrate);
      }
      // Map streams: video from frames, audio from audio file
      cmd = cmd.outputOptions(['-map', '0:v', '-map', '1:a', '-shortest']);
    }

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
    scale,      // '2x' or '4x'
    formatSettings
  } = options;

  const jobId = path.basename(inputPath, path.extname(inputPath));
  const { jobTempDir, framesInput, framesOutput } = ensureTempDirs(jobId);
  const audioPath = path.join(jobTempDir, 'audio.aac');

  const aiCheck = checkAIAvailability();
  if (!aiCheck.available) {
    throw new Error(`AI upscaler not available: ${aiCheck.reason}`);
  }

  try {
    // ── Step 1: Extract frames ──
    job.stage = 'Extracting frames from video...';
    job.progress = 2;
    console.log(`[AI] Extracting frames from: ${inputPath}`);

    const frameInfo = await extractFrames(inputPath, framesInput, null);
    console.log(`[AI] Extracted ${frameInfo.frameCount} frames at ${frameInfo.fps.toFixed(1)} FPS`);

    job.stage = `Extracted ${frameInfo.frameCount} frames`;
    job.progress = 8;

    // ── Step 2: Extract audio ──
    job.stage = 'Extracting audio track...';
    const audioInfo = await extractAudio(inputPath, audioPath);
    console.log(`[AI] Audio: ${audioInfo.hasAudio ? 'extracted' : 'no audio track'}`);

    job.progress = 10;

    // ── Step 3: AI enhancement ──
    job.stage = `Enhancing frames with AI (0/${frameInfo.frameCount})...`;
    console.log(`[AI] Starting Real-ESRGAN enhancement (${scale}, ${frameInfo.frameCount} frames)...`);

    const enhanceResult = await enhanceFrames(
      aiCheck.path,
      framesInput,
      framesOutput,
      scale,
      job
    );
    console.log(`[AI] Enhanced ${enhanceResult.enhancedCount}/${enhanceResult.totalFrames} frames`);

    job.stage = 'Rebuilding video from enhanced frames...';
    job.progress = 88;

    // ── Step 4: Rebuild video ──
    console.log(`[AI] Rebuilding video: ${outputPath}`);
    await rebuildVideo(framesOutput, audioInfo, outputPath, frameInfo.fps, formatSettings);

    job.stage = 'Finalizing...';
    job.progress = 98;

    console.log(`[AI] ✅ AI upscale complete: ${outputPath}`);

  } finally {
    // ── Step 5: Cleanup ──
    console.log(`[AI] Cleaning up temp files for job ${jobId}`);
    cleanupTemp(jobId);
  }
}

// ─── Exports ────────────────────────────────────────────────────────
module.exports = {
  checkAIAvailability,
  extractFrames,
  extractAudio,
  enhanceFrames,
  rebuildVideo,
  processVideoWithAI,
  cleanupTemp,
  TEMP_DIR
};
