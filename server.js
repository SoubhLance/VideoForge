const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const aiUpscaler = require('./ai-upscaler');

// Prevent server crashes from unhandled errors
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled Rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// AI availability status (set at startup)
let aiStatus = { available: false, path: null };

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const id = uuidv4();
        const ext = path.extname(file.originalname);
        cb(null, id + ext);
    }
});

const ALLOWED_EXTS = ['.dat', '.mp4', '.avi', '.mkv', '.mov', '.flv', '.webm', '.mpeg', '.mpg', '.3gp'];

const upload = multer({
    storage,
    limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4 GB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTS.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported format: ${ext}. Supported: ${ALLOWED_EXTS.join(', ')}`));
        }
    }
});

// In-memory job tracking
const jobs = new Map();

// ─── Simple FIFO Job Queue with Concurrency Limiter ──────────────────
class JobQueue {
    constructor(concurrencyLimit = 1) {
        this.concurrencyLimit = concurrencyLimit;
        this.activeCount = 0;
        this.queue = [];
    }

    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.next();
        });
    }

    next() {
        if (this.activeCount >= this.concurrencyLimit || this.queue.length === 0) {
            return;
        }

        const { task, resolve, reject } = this.queue.shift();
        this.activeCount++;

        task()
            .then(resolve)
            .catch(reject)
            .finally(() => {
                this.activeCount--;
                this.next();
            });
    }
}

// Concurrency limits: AI upscaling is extremely GPU/VRAM heavy, limit to 1.
// Standard conversions are CPU-bound, limit to 2.
const aiQueue = new JobQueue(1);
const standardQueue = new JobQueue(2);


// ─── Check FFmpeg availability ──────────────────────────────────────
function checkFFmpeg() {
    return new Promise((resolve) => {
        ffmpeg.getAvailableFormats((err) => {
            if (err) {
                console.error('⚠️  FFmpeg not found! Please install FFmpeg and ensure it is in your PATH.');
                console.error('   Download: https://ffmpeg.org/download.html');
                resolve(false);
            } else {
                console.log('✅ FFmpeg detected');
                resolve(true);
            }
        });
    });
}

// ─── POST /api/upload ───────────────────────────────────────────────
app.post('/api/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const fileId = path.basename(req.file.filename, path.extname(req.file.filename));
    const ext = path.extname(req.file.originalname).toLowerCase();

    jobs.set(fileId, {
        originalName: req.file.originalname,
        inputPath: req.file.path,
        inputExt: ext,
        status: 'uploaded',
        progress: 0,
        stage: '',
    });

    res.json({
        id: fileId,
        originalName: req.file.originalname,
        size: req.file.size,
        ext
    });
});

// ─── GET /api/stream/:id ────────────────────────────────────────────
// Stream the uploaded file back for video preview in the browser
app.get('/api/stream/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'File not found' });

    const filePath = job.inputPath;
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Determine MIME type
    const extToMime = {
        '.mp4': 'video/mp4',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.flv': 'video/x-flv',
        '.mpeg': 'video/mpeg',
        '.mpg': 'video/mpeg',
        '.3gp': 'video/3gpp',
        '.dat': 'video/mpeg',
    };
    const mime = extToMime[job.inputExt] || 'video/mp4';

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        const file = fs.createReadStream(filePath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mime,
        };

        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': mime,
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
});

// ─── GET /api/probe/:id ─────────────────────────────────────────────
app.get('/api/probe/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'File not found' });

    const inputPath = job.inputPath;

    // For .dat files, treat as MPEG stream
    const probeInput = job.inputExt === '.dat' ? inputPath : inputPath;

    ffmpeg.ffprobe(probeInput, (err, metadata) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to probe file', details: err.message });
        }

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

        // Safe FPS parser (replaces dangerous eval)
        function parseFps(fpsStr) {
            if (!fpsStr) return 'N/A';
            try {
                const parts = fpsStr.split('/');
                if (parts.length === 2) {
                    const num = parseInt(parts[0], 10);
                    const den = parseInt(parts[1], 10);
                    if (den > 0) return (num / den).toFixed(2);
                }
                const val = parseFloat(fpsStr);
                return isNaN(val) ? 'N/A' : val.toFixed(2);
            } catch (e) {
                return 'N/A';
            }
        }

        const info = {
            container: metadata.format.format_long_name || metadata.format.format_name || 'Unknown',
            duration: metadata.format.duration ? parseFloat(metadata.format.duration).toFixed(2) : 'N/A',
            bitrate: metadata.format.bit_rate ? Math.round(parseInt(metadata.format.bit_rate) / 1000) : 'N/A',
            size: metadata.format.size ? parseInt(metadata.format.size) : 0,
            video: videoStream ? {
                codec: videoStream.codec_long_name || videoStream.codec_name || 'Unknown',
                codecShort: videoStream.codec_name || 'Unknown',
                width: videoStream.width || 0,
                height: videoStream.height || 0,
                fps: parseFps(videoStream.r_frame_rate),
                pixelFormat: videoStream.pix_fmt || 'Unknown'
            } : null,
            audio: audioStream ? {
                codec: audioStream.codec_long_name || audioStream.codec_name || 'Unknown',
                codecShort: audioStream.codec_name || 'Unknown',
                sampleRate: audioStream.sample_rate || 'N/A',
                channels: audioStream.channels || 0
            } : null,
        };

        job.probeInfo = info;
        res.json(info);
    });
});

// ─── GET /api/ai-status ─────────────────────────────────────────────
app.get('/api/ai-status', (req, res) => {
    res.json(aiStatus);
});

// ─── Codec/format mappings ──────────────────────────────────────────
function getCodecSettings(format, quality) {
    const qualityMap = {
        high: { crf: 18, audioBitrate: '192k', preset: 'medium' },
        medium: { crf: 23, audioBitrate: '128k', preset: 'fast' },
        low: { crf: 28, audioBitrate: '96k', preset: 'veryfast' },
    };

    const q = qualityMap[quality] || qualityMap.medium;

    const formatSettings = {
        mp4: { vcodec: 'libx264', acodec: 'aac', ext: '.mp4', extraArgs: ['-movflags', '+faststart'] },
        avi: { vcodec: 'libx264', acodec: 'aac', ext: '.avi', extraArgs: [] },
        mkv: { vcodec: 'libx264', acodec: 'aac', ext: '.mkv', extraArgs: [] },
        mov: { vcodec: 'libx264', acodec: 'aac', ext: '.mov', extraArgs: ['-movflags', '+faststart'] },
        webm: { vcodec: 'libvpx-vp9', acodec: 'libopus', ext: '.webm', extraArgs: [] },
        flv: { vcodec: 'libx264', acodec: 'aac', ext: '.flv', extraArgs: [] },
        '3gp': { vcodec: 'libx264', acodec: 'aac', ext: '.3gp', extraArgs: [] },
        mpeg: { vcodec: 'mpeg2video', acodec: 'mp2', ext: '.mpeg', extraArgs: [] },
        gif: { vcodec: null, acodec: null, ext: '.gif', extraArgs: [] },
    };

    return { ...(formatSettings[format] || formatSettings.mp4), ...q };
}

// ─── POST /api/set-output-path ────────────────────────────────────────
app.post('/api/set-output-path', (req, res) => {
    const { outputDir } = req.body;
    if (!outputDir) return res.status(400).json({ error: 'No path provided' });

    // Resolve and validate path
    const resolved = path.resolve(outputDir);
    try {
        if (!fs.existsSync(resolved)) {
            fs.mkdirSync(resolved, { recursive: true });
        }
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            return res.status(400).json({ error: 'Path is not a directory' });
        }
        // Test write permission
        const testFile = path.join(resolved, '.vf_write_test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);

        customOutputDir = resolved;
        console.log(`[Config] Output directory set to: ${resolved}`);
        res.json({ path: resolved });
    } catch (e) {
        res.status(400).json({ error: `Cannot write to directory: ${e.message}` });
    }
});

// ─── GET /api/browse-dirs ─────────────────────────────────────────────
app.get('/api/browse-dirs', (req, res) => {
    const dirPath = req.query.path || (process.platform === 'win32' ? 'C:\\' : '/');
    const resolved = path.resolve(dirPath);

    try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            return res.status(400).json({ error: 'Invalid directory path' });
        }
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));

        // On Windows, list drive letters at root
        let drives = [];
        if (process.platform === 'win32' && (dirPath === 'C:\\' || dirPath === '/')) {
            const { execSync } = require('child_process');
            try {
                const result = execSync('wmic logicaldisk get name', { encoding: 'utf8' });
                drives = result.split('\n').map(l => l.trim()).filter(l => /^[A-Z]:$/.test(l)).map(d => ({ name: d, path: d + '\\' }));
            } catch (e) { /* ignore */ }
        }

        res.json({ current: resolved, parent: path.dirname(resolved), dirs, drives });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── POST /api/convert ──────────────────────────────────────────────
let customOutputDir = null;

app.post('/api/convert', (req, res) => {
    const {
        id,
        format = 'mp4',
        resolution = 'source',
        quality = 'medium',
        upscale = false,
        upscaleMode = '2x',
        aiUpscale = false,
        outputDir = null
    } = req.body;

    const job = jobs.get(id);
    if (!job) return res.status(404).json({ error: 'File not found' });
    if (job.status === 'converting' || job.status === 'queued') {
        return res.status(409).json({ error: 'Conversion already in progress or queued' });
    }

    const settings = getCodecSettings(format, quality);
    const baseName = path.basename(job.originalName, path.extname(job.originalName));
    const outputFileName = `${baseName}_converted${settings.ext}`;

    // Use custom output dir if set, otherwise default
    const effectiveOutputDir = outputDir || customOutputDir || OUTPUT_DIR;
    try {
        if (!fs.existsSync(effectiveOutputDir)) {
            fs.mkdirSync(effectiveOutputDir, { recursive: true });
        }
    } catch (e) {
        return res.status(400).json({ error: `Cannot create output directory: ${e.message}` });
    }

    const outputPath = path.join(effectiveOutputDir, `${id}${settings.ext}`);

    job.status = 'queued';
    job.progress = 0;
    job.stage = 'Queued...';
    job.warning = null;
    job.outputPath = outputPath;
    job.outputFileName = outputFileName;
    job.outputFormat = format;
    job.startTime = Date.now();

    // ─── Decide: AI pipeline or standard FFmpeg pipeline ────────
    const useAI = aiUpscale && (upscaleMode === '2x' || upscaleMode === '4x' || upscaleMode === 'ai-enhance');
    const effectiveScale = upscaleMode === 'ai-enhance' ? '4x' : upscaleMode;

    if (useAI && aiStatus.available) {
        console.log(`[Convert] Queuing AI upscale pipeline (${effectiveScale}) for job ${id}`);
        console.log(`[Convert] Output: ${outputPath}`);
        aiQueue.add(async () => {
            job.status = 'converting';
            job.stage = 'Starting AI pipeline...';
            try {
                await runAIPipeline(job, { format, quality, scale: effectiveScale, settings, outputPath });
            } catch (err) {
                console.error(`[Convert] AI pipeline error for job ${id}:`, err.message);
                job.status = 'error';
                job.error = err.message;
                job.stage = 'Error';
            }
        });
    } else {
        const isFallback = useAI && !aiStatus.available;
        if (isFallback) {
            console.log(`[Convert] AI requested but not available — queuing FFmpeg upscale fallback for job ${id}`);
            job.warning = 'AI upscaler (Real-ESRGAN) not installed. Used FFmpeg upscale instead. Run "node setup-tools.js" to install.';
        } else {
            console.log(`[Convert] Queuing standard FFmpeg pipeline for job ${id}`);
        }
        console.log(`[Convert] Output: ${outputPath}`);
        standardQueue.add(async () => {
            job.status = 'converting';
            job.stage = 'Starting FFmpeg pipeline...';
            try {
                await runFFmpegPipeline(job, { 
                    format, 
                    resolution, 
                    quality, 
                    upscale: isFallback ? true : upscale, 
                    upscaleMode: isFallback ? effectiveScale : upscaleMode, 
                    settings, 
                    outputPath 
                });
            } catch (err) {
                console.error(`[Convert] FFmpeg pipeline error for job ${id}:`, err.message);
                job.status = 'error';
                job.error = err.message;
                job.stage = 'Error';
            }
        });
    }

    res.json({ message: 'Conversion started', outputFileName });
});


// ─── AI Pipeline ────────────────────────────────────────────────────
async function runAIPipeline(job, options) {
    try {
        await aiUpscaler.processVideoWithAI(job, {
            inputPath: job.inputPath,
            outputPath: options.outputPath,
            format: options.format,
            quality: options.quality,
            scale: options.scale,
            formatSettings: options.settings
        });

        // Success — finalize job
        job.progress = 100;
        job.status = 'done';
        job.stage = 'Complete!';
        job.endTime = Date.now();
        job.conversionTime = ((job.endTime - job.startTime) / 1000).toFixed(1);

        // Get output file info
        try {
            const stat = fs.statSync(options.outputPath);
            job.outputSize = stat.size;
        } catch (e) {
            job.outputSize = 0;
        }

        // Probe output for metadata
        ffmpeg.ffprobe(options.outputPath, (err, metadata) => {
            if (!err) {
                const vs = metadata.streams.find(s => s.codec_type === 'video');
                job.outputInfo = {
                    container: metadata.format.format_long_name || options.format,
                    duration: metadata.format.duration ? parseFloat(metadata.format.duration).toFixed(2) : 'N/A',
                    bitrate: metadata.format.bit_rate ? Math.round(parseInt(metadata.format.bit_rate) / 1000) : 'N/A',
                    video: vs ? {
                        codec: vs.codec_long_name || vs.codec_name,
                        width: vs.width,
                        height: vs.height,
                    } : null
                };
            }
        });

    } catch (err) {
        console.error('[AI Pipeline] Error:', err.message);
        // Fallback to FFmpeg upscale
        console.log('[AI Pipeline] Falling back to FFmpeg upscale...');
        job.warning = `AI upscale failed: ${err.message}. Used FFmpeg upscale instead.`;
        job.progress = 0;
        job.stage = 'Falling back to FFmpeg upscale...';

        runFFmpegPipeline(job, {
            format: options.format,
            resolution: 'source',
            quality: options.quality,
            upscale: true,
            upscaleMode: options.scale,
            settings: options.settings,
            outputPath: options.outputPath
        });
    }
}

// ─── Standard FFmpeg Pipeline ───────────────────────────────────────
function runFFmpegPipeline(job, options) {
    return new Promise((resolve) => {
        const { format, resolution, quality, upscale, upscaleMode, settings, outputPath } = options;

        // Build FFmpeg command
        let cmd = ffmpeg(job.inputPath);

        // For .dat files, force MPEG input format
        if (job.inputExt === '.dat') {
            cmd = cmd.inputFormat('mpeg');
        }

        // Handle GIF separately
        if (format === 'gif') {
            cmd = cmd
                .outputOptions(['-vf', 'fps=10,scale=480:-1:flags=lanczos', '-loop', '0'])
                .toFormat('gif');
        } else {
            // Video codec
            cmd = cmd.videoCodec(settings.vcodec);

            // Audio codec
            cmd = cmd.audioCodec(settings.acodec).audioBitrate(settings.audioBitrate);

            // Quality (CRF for x264/x265) and speed Preset
            if (settings.vcodec === 'libx264' || settings.vcodec === 'libx265') {
                cmd = cmd.outputOptions([`-crf`, `${settings.crf}`, `-preset`, `${settings.preset || 'medium'}`]);
            } else if (settings.vcodec === 'libvpx-vp9') {
                cmd = cmd.outputOptions([`-crf`, `${settings.crf}`, '-b:v', '0']);
            }

            // Build video filter chain
            const vfFilters = [];

            // Resolution scaling
            if (resolution !== 'source') {
                const [w, h] = resolution.split('x');
                vfFilters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`);
            }

            // Upscale enhancements (FFmpeg fallback for when AI is off or unavailable)
            if (upscale) {
                if (upscaleMode === '2x' || upscaleMode === '4x') {
                    const scaleFactor = upscaleMode === '4x' ? 4 : 2;
                    // If no resolution set, scale relative to input
                    if (resolution === 'source') {
                        vfFilters.push(`scale=iw*${scaleFactor}:ih*${scaleFactor}:flags=lanczos`);
                    }
                    // Apply sharpening after upscale
                    vfFilters.push('unsharp=5:5:1.0:5:5:0.5');
                }
                if (upscaleMode === 'ai-enhance') {
                    // High-quality FFmpeg fallback for AI Enhance preset
                    if (resolution === 'source') {
                        vfFilters.push('scale=iw*4:ih*4:flags=lanczos');
                    }
                    vfFilters.push('unsharp=7:7:1.5:7:7:0.8');
                }
                if (upscaleMode === 'denoise') {
                    vfFilters.push('nlmeans=s=3:p=7:r=15');
                }
                if (upscaleMode === 'sharpen') {
                    vfFilters.push('unsharp=5:5:1.5:5:5:0.5');
                }
            }

            if (vfFilters.length > 0) {
                cmd = cmd.outputOptions(['-vf', vfFilters.join(',')]);
            }

            // Extra format-specific args
            if (settings.extraArgs.length > 0) {
                cmd = cmd.outputOptions(settings.extraArgs);
            }
        }

        job.stage = 'Encoding video...';

        // Progress tracking
        cmd.on('progress', (progress) => {
            const pct = Math.min(Math.round(progress.percent || 0), 99);
            job.progress = pct;
            job.status = 'converting';

            if (pct < 20) job.stage = 'Reading file...';
            else if (pct < 50) job.stage = 'Decoding & re-encoding...';
            else if (pct < 80) job.stage = upscale ? 'Applying enhancements...' : 'Optimizing...';
            else job.stage = 'Finalizing...';
        });

        cmd.on('end', () => {
            job.progress = 100;
            job.status = 'done';
            job.stage = 'Complete!';
            job.endTime = Date.now();
            job.conversionTime = ((job.endTime - job.startTime) / 1000).toFixed(1);

            // Get output file info
            try {
                const stat = fs.statSync(outputPath);
                job.outputSize = stat.size;
            } catch (e) {
                job.outputSize = 0;
            }

            // Probe output for metadata
            ffmpeg.ffprobe(outputPath, (err, metadata) => {
                if (!err) {
                    const vs = metadata.streams.find(s => s.codec_type === 'video');
                    job.outputInfo = {
                        container: metadata.format.format_long_name || format,
                        duration: metadata.format.duration ? parseFloat(metadata.format.duration).toFixed(2) : 'N/A',
                        bitrate: metadata.format.bit_rate ? Math.round(parseInt(metadata.format.bit_rate) / 1000) : 'N/A',
                        video: vs ? {
                            codec: vs.codec_long_name || vs.codec_name,
                            width: vs.width,
                            height: vs.height,
                        } : null
                    };
                }
                resolve();
            });
        });

        cmd.on('error', (err) => {
            console.error('FFmpeg error:', err.message);
            job.status = 'error';
            job.error = err.message;
            job.stage = 'Error';
            resolve();
        });

        cmd.save(outputPath);
    });
}


// ─── GET /api/progress/:id ──────────────────────────────────────────
app.get('/api/progress/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Server-Sent Events
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const interval = setInterval(() => {
        const data = {
            status: job.status,
            progress: job.progress,
            stage: job.stage || null,
            warning: job.warning || null,
            error: job.error || null,
        };

        if (job.status === 'done') {
            data.conversionTime = job.conversionTime;
            data.outputFileName = job.outputFileName;
            data.outputSize = job.outputSize;
            data.outputInfo = job.outputInfo || null;
        }

        res.write(`data: ${JSON.stringify(data)}\n\n`);

        if (job.status === 'done' || job.status === 'error') {
            clearInterval(interval);
            setTimeout(() => res.end(), 500);
        }
    }, 500);

    req.on('close', () => clearInterval(interval));
});

// ─── GET /api/download/:id ──────────────────────────────────────────
app.get('/api/download/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'File not found' });
    if (job.status !== 'done') return res.status(400).json({ error: 'Conversion not complete' });

    if (!fs.existsSync(job.outputPath)) {
        return res.status(404).json({ error: 'Output file not found' });
    }

    res.download(job.outputPath, job.outputFileName);
});

// ─── Error handling middleware ───────────────────────────────────────
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large. Maximum size: 4 GB' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
});

// ─── Cleanup old files (every 30 minutes) ───────────────────────────
setInterval(() => {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    // Clean up jobs map entries older than 1 hour and not active
    for (const [id, job] of jobs.entries()) {
        if (job.startTime && (now - job.startTime > maxAge) && job.status !== 'converting' && job.status !== 'queued') {
            jobs.delete(id);
        }
    }

    [UPLOAD_DIR, OUTPUT_DIR, aiUpscaler.TEMP_DIR].forEach(dir => {
        try {
            if (!fs.existsSync(dir)) return;
            fs.readdirSync(dir).forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > maxAge) {
                    if (stat.isDirectory()) {
                        fs.rmSync(filePath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(filePath);
                    }
                }
            });
        } catch (e) { /* ignore */ }
    });
}, 30 * 60 * 1000);


// ─── Start server ───────────────────────────────────────────────────
async function start() {
    await checkFFmpeg();

    // Check AI tool availability
    aiStatus = aiUpscaler.checkAIAvailability();
    if (aiStatus.available) {
        console.log(`✅ Real-ESRGAN detected at: ${aiStatus.path}`);
    } else {
        console.log(`⚠️  Real-ESRGAN not found (AI upscaling disabled)`);
        console.log(`   Run "node setup-tools.js" to install automatically`);
    }

    const server = app.listen(PORT, () => {
        console.log(`\n🎬 VideoForge server running at http://localhost:${PORT}\n`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\n❌ Port ${PORT} is already in use.`);
            console.error(`   Either stop the other process or use a different port:`);
            console.error(`   PORT=3001 node server.js\n`);
        } else {
            console.error('Server error:', err);
        }
        process.exit(1);
    });
}

start();
