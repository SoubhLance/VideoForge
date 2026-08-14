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

const ALLOWED_EXTS = ['.dat', '.mp4', '.avi', '.mkv', '.mov', '.flv', '.webm', '.mpeg', '.mpg', '.3gp', '.vob', '.mp3', '.wav', '.aac', '.flac'];

const upload = multer({
    storage,
    limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4 GB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXTS.includes(ext)) {
            return cb(new Error(`Unsupported format: ${ext}. Supported: ${ALLOWED_EXTS.join(', ')}`));
        }

        // Validate basic MIME type prefix if present
        if (file.mimetype) {
            const isVideo = file.mimetype.startsWith('video/');
            const isAudio = file.mimetype.startsWith('audio/');
            const isOctet = file.mimetype === 'application/octet-stream'; // Common for .dat / raw formats
            if (!isVideo && !isAudio && !isOctet) {
                return cb(new Error(`Invalid MIME type '${file.mimetype}' for file '${file.originalname}'`));
            }
        }

        cb(null, true);
    }
});

// In-memory job tracking
const jobs = new Map();

// Helper to check if a file path is associated with any active or queued job
function isFileInActiveJob(filePath) {
    for (const job of jobs.values()) {
        if ((job.status === 'converting' || job.status === 'queued' || job.status === 'uploaded') &&
            (job.inputPath === filePath || job.outputPath === filePath)) {
            return true;
        }
    }
    return false;
}

// Helper to recover job state from disk if server restarted
function getOrCreateJob(id) {
    if (!id) return null;
    let job = jobs.get(id);
    if (job) return job;

    try {
        if (fs.existsSync(UPLOAD_DIR)) {
            const files = fs.readdirSync(UPLOAD_DIR);
            const match = files.find(f => path.basename(f, path.extname(f)) === id);
            if (match) {
                const inputPath = path.join(UPLOAD_DIR, match);
                const ext = path.extname(match).toLowerCase();
                job = {
                    originalName: match,
                    inputPath: inputPath,
                    inputExt: ext,
                    status: 'uploaded',
                    progress: 0,
                    stage: '',
                };
                jobs.set(id, job);
                console.log(`[JobRecovery] Restored job state from disk for ID: ${id}`);
                return job;
            }
        }
    } catch (e) {
        console.error('[JobRecovery] Failed to recover job from disk:', e.message);
    }
    return null;
}

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
    const job = getOrCreateJob(req.params.id);
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

// ─── GET /api/preview/:id (Fast H.264 preview stream for legacy .DAT / .VOB / .AVI) ───
app.get('/api/preview/:id', (req, res) => {
    const job = getOrCreateJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'File not found' });

    const tempDir = aiUpscaler.TEMP_DIR || path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const previewPath = path.join(tempDir, `preview_${req.params.id}.mp4`);

    // If preview MP4 already exists, serve directly
    if (fs.existsSync(previewPath)) {
        return res.sendFile(previewPath);
    }

    // For standard web MP4/WebM files, stream source directly
    if (job.inputExt === '.mp4' || job.inputExt === '.webm') {
        return res.redirect(`/api/stream/${req.params.id}`);
    }

    // For legacy formats (.dat, .vob, .avi, .flv, .3gp, .mpeg), generate a fast 15-second H.264 MP4 preview clip
    console.log(`[Preview] Generating fast preview clip for legacy asset ${req.params.id} (${job.inputExt})...`);

    let cmd = ffmpeg(job.inputPath);
    if (job.inputExt === '.dat') {
        cmd = cmd.inputFormat('mpeg');
    }

    cmd.outputOptions([
        '-ss', '0',
        '-t', '15',
        '-vf', 'scale=640:-2:flags=fast_bilinear',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart'
    ])
    .output(previewPath)
    .on('end', () => {
        console.log(`[Preview] Fast MP4 preview clip generated: ${previewPath}`);
        res.sendFile(previewPath);
    })
    .on('error', (err) => {
        console.error('[Preview] Fast preview error, falling back to direct stream:', err.message);
        res.redirect(`/api/stream/${req.params.id}`);
    })
    .run();
});

// ─── POST /api/clear-cache (Purge uploaded temp files & freed disk space) ───
app.post('/api/clear-cache', (req, res) => {
    let freedBytes = 0;
    let fileCount = 0;

    const tempDir = aiUpscaler.TEMP_DIR || path.join(__dirname, 'temp');
    [UPLOAD_DIR, OUTPUT_DIR, tempDir].forEach(dir => {
        try {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                const fullPath = path.join(dir, entry);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        freedBytes += getDirectorySize(fullPath);
                        fs.rmSync(fullPath, { recursive: true, force: true });
                        fileCount++;
                    } else {
                        freedBytes += stat.size;
                        fs.unlinkSync(fullPath);
                        fileCount++;
                    }
                } catch (e) { /* ignore locked files */ }
            }
        } catch (e) { /* ignore */ }
    });

    // Clear jobs map
    jobs.clear();

    console.log(`[Cache] Cleared ${fileCount} files/folders, freed ${freedBytes} bytes`);
    res.json({ message: 'Cache cleared successfully', freedBytes, fileCount });
});

function getDirectorySize(dirPath) {
    let size = 0;
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) size += getDirectorySize(filePath);
            else size += stat.size;
        }
    } catch (e) {}
    return size;
}

// ─── GET /api/probe/:id ─────────────────────────────────────────────
app.get('/api/probe/:id', (req, res) => {
    const job = getOrCreateJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'File not found' });

    const inputPath = job.inputPath;

    ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
            console.error(`[ProbeError] Failed to probe file ${req.params.id}:`, err.message);
            return res.status(500).json({ error: 'Failed to analyze video file metadata.' });
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
app.get('/api/ai-status', async (req, res) => {
    aiStatus = await aiUpscaler.checkAIAvailability();
    res.json(aiStatus);
});

// ─── Codec/format mappings ──────────────────────────────────────────
function getCodecSettings(format, quality) {
    const qualityMap = {
        high: { crf: 18, vp9Crf: 25, mpegQ: 2, audioBitrate: '192k', preset: 'medium' },
        medium: { crf: 23, vp9Crf: 31, mpegQ: 5, audioBitrate: '128k', preset: 'fast' },
        low: { crf: 28, vp9Crf: 38, mpegQ: 8, audioBitrate: '96k', preset: 'veryfast' },
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
        mp3: { vcodec: null, acodec: 'libmp3lame', ext: '.mp3', extraArgs: ['-b:a', '320k', '-vn'] },
        wav: { vcodec: null, acodec: 'pcm_s16le', ext: '.wav', extraArgs: ['-vn'] },
        aac: { vcodec: null, acodec: 'aac', ext: '.aac', extraArgs: ['-b:a', '256k', '-vn'] },
        flac: { vcodec: null, acodec: 'flac', ext: '.flac', extraArgs: ['-vn'] },
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

// Helper to discover all available Windows system drives (C:\, D:\, E:\, etc.)
function getSystemDrives() {
    if (process.platform !== 'win32') return [];
    const drives = [];
    for (let i = 65; i <= 90; i++) {
        const letter = String.fromCharCode(i);
        const drivePath = `${letter}:\\`;
        try {
            if (fs.existsSync(drivePath)) {
                drives.push({ name: `${letter}:`, path: drivePath });
            }
        } catch (e) {
            // Ignore inaccessible drive letters
        }
    }
    return drives;
}

// Restricted system paths that shouldn't be browsable
const RESTRICTED_SYSTEM_DIRS = [
    'windows', 'system32', 'syswow64', 'program files', 'program files (x86)',
    '$recycle.bin', 'system volume information'
];

// ─── GET /api/browse-dirs ─────────────────────────────────────────────
app.get('/api/browse-dirs', (req, res) => {
    let dirPath = req.query.path || (process.platform === 'win32' ? 'D:\\' : '/');

    // Handle "ROOT" virtual path for listing drives
    if (dirPath === 'ROOT' || dirPath === 'COMPUTER' || dirPath === 'This PC') {
        const drives = getSystemDrives();
        return res.json({ current: 'This PC', parent: 'ROOT', dirs: [], drives });
    }

    // Normalize Windows drive paths (e.g. 'D:' -> 'D:\')
    if (process.platform === 'win32' && /^[A-Z]:$/i.test(dirPath)) {
        dirPath = dirPath.toUpperCase() + '\\';
    }

    let resolved = path.resolve(dirPath);
    if (process.platform === 'win32' && /^[A-Z]:$/i.test(resolved)) {
        resolved = resolved.toUpperCase() + '\\';
    }

    // Check system directory restrictions
    const baseDirName = path.basename(resolved).toLowerCase();
    if (RESTRICTED_SYSTEM_DIRS.includes(baseDirName)) {
        return res.status(403).json({ error: 'Access to system directories is restricted for safety' });
    }

    try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            return res.status(400).json({ error: 'Invalid directory path' });
        }

        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const dirs = entries
            .filter(e => {
                try {
                    const lowName = e.name.toLowerCase();
                    return e.isDirectory() && 
                           !e.name.startsWith('$') && 
                           !e.name.startsWith('.') &&
                           !RESTRICTED_SYSTEM_DIRS.includes(lowName);
                } catch (err) {
                    return false;
                }
            })
            .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        const drives = getSystemDrives();

        // Calculate parent. On Windows, if resolved is a root drive like 'D:\', parent is 'ROOT'
        let parent = path.dirname(resolved);
        if (process.platform === 'win32' && (resolved === parent || /^[A-Z]:\\$/i.test(resolved))) {
            parent = 'ROOT';
        }

        res.json({ current: resolved, parent, dirs, drives });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── POST /api/convert ──────────────────────────────────────────────
let customOutputDir = null;

const VALID_FORMATS = ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', '3gp', 'mpeg', 'gif', 'mp3', 'wav', 'aac', 'flac'];
const VALID_QUALITIES = ['high', 'medium', 'low'];
const VALID_RESOLUTIONS = ['source', '3840x2160', '2560x1440', '1920x1080', '1280x720', '854x480'];
const VALID_UPSCALE_MODES = ['2x', '4x', 'ai-enhance', 'denoise', 'sharpen'];

function sanitizeFilename(name, fallback) {
    if (!name || typeof name !== 'string') return fallback;
    let clean = name.replace(/[\\/:*?"<>|]/g, '_').trim();
    clean = clean.replace(/^[.\s]+|[.\s]+$/g, '');
    return clean || fallback;
}

app.post('/api/convert', (req, res) => {
    const {
        id,
        format = 'mp4',
        outputName = null,
        resolution = 'source',
        quality = 'medium',
        upscale = false,
        upscaleMode = '2x',
        aiUpscale = false,
        deinterlace = false,
        outputDir = null
    } = req.body;

    // Validate parameters
    if (!VALID_FORMATS.includes(format)) {
        return res.status(400).json({ error: `Invalid format '${format}'. Valid: ${VALID_FORMATS.join(', ')}` });
    }
    if (!VALID_QUALITIES.includes(quality)) {
        return res.status(400).json({ error: `Invalid quality '${quality}'` });
    }
    if (!VALID_RESOLUTIONS.includes(resolution)) {
        return res.status(400).json({ error: `Invalid resolution '${resolution}'` });
    }
    if (!VALID_UPSCALE_MODES.includes(upscaleMode)) {
        return res.status(400).json({ error: `Invalid upscale mode '${upscaleMode}'` });
    }

    const job = getOrCreateJob(id);
    if (!job) return res.status(404).json({ error: 'File not found' });
    if (job.status === 'converting' || job.status === 'queued') {
        return res.status(409).json({ error: 'Conversion already in progress or queued' });
    }

    const settings = getCodecSettings(format, quality);
    const defaultBaseName = path.basename(job.originalName, path.extname(job.originalName));
    const finalBaseName = sanitizeFilename(outputName, defaultBaseName);

    // Use custom output dir if set, otherwise default
    const effectiveOutputDir = outputDir || customOutputDir || OUTPUT_DIR;
    try {
        if (!fs.existsSync(effectiveOutputDir)) {
            fs.mkdirSync(effectiveOutputDir, { recursive: true });
        }
    } catch (e) {
        return res.status(400).json({ error: `Cannot create output directory: ${e.message}` });
    }

    let outputFileName = `${finalBaseName}${settings.ext}`;
    let outputPath = path.join(effectiveOutputDir, outputFileName);

    let counter = 1;
    while (fs.existsSync(outputPath) && isFileInActiveJob(outputPath)) {
        outputFileName = `${finalBaseName}_${counter}${settings.ext}`;
        outputPath = path.join(effectiveOutputDir, outputFileName);
        counter++;
    }

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
                job.error = job.error || err.message || 'AI upscaling encountered an error during processing.';
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
                    deinterlace,
                    settings, 
                    outputPath 
                });
            } catch (err) {
                console.error(`[Convert] FFmpeg pipeline error for job ${id}:`, err.message);
                job.status = 'error';
                job.error = job.error || err.message || 'Video processing failed during encoding.';
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
        job.warning = `AI upscale process encountered an issue. Used FFmpeg high-quality upscale fallback instead.`;
        job.progress = 0;
        job.stage = 'Falling back to FFmpeg upscale...';

        try {
            await runFFmpegPipeline(job, {
                format: options.format,
                resolution: 'source',
                quality: options.quality,
                upscale: true,
                upscaleMode: options.scale,
                settings: options.settings,
                outputPath: options.outputPath
            });
        } catch (fallbackErr) {
            console.error('[AI Pipeline Fallback] Error:', fallbackErr.message);
            job.status = 'error';
            job.error = 'Both AI upscale and FFmpeg fallback pipeline failed.';
            job.stage = 'Error';
        }
    }
}

// ─── Standard FFmpeg Pipeline ───────────────────────────────────────
function runFFmpegPipeline(job, options) {
    return new Promise((resolve) => {
        const { format, resolution, quality, upscale, upscaleMode, settings, outputPath } = options;

        // Build FFmpeg command
        let cmd = ffmpeg(job.inputPath).outputOptions('-y');

        // For .dat files, force MPEG input format
        if (job.inputExt === '.dat') {
            cmd = cmd.inputFormat('mpeg');
        }

        // Handle Audio Extraction or GIF separately
        if (format === 'gif') {
            cmd = cmd
                .outputOptions(['-vf', 'fps=10,scale=480:-1:flags=lanczos', '-loop', '0'])
                .toFormat('gif');
        } else if (settings.vcodec === null) {
            // Audio extraction mode
            if (settings.acodec) cmd = cmd.audioCodec(settings.acodec);
            if (settings.extraArgs.length > 0) cmd = cmd.outputOptions(settings.extraArgs);
        } else {
            // Video codec
            cmd = cmd.videoCodec(settings.vcodec);

            // Audio codec
            cmd = cmd.audioCodec(settings.acodec);
            if (settings.audioBitrate && format !== '3gp') {
                cmd = cmd.audioBitrate(settings.audioBitrate);
            }

            // Quality options
            if (settings.vcodec === 'libx264' || settings.vcodec === 'libx265') {
                cmd = cmd.outputOptions([`-crf`, `${settings.crf}`, `-preset`, `${settings.preset || 'medium'}`]);
            } else if (settings.vcodec === 'libvpx-vp9') {
                cmd = cmd.outputOptions([`-crf`, `${settings.vp9Crf || 31}`, '-b:v', '0']);
            } else if (settings.vcodec === 'mpeg2video') {
                cmd = cmd.outputOptions([`-q:v`, `${settings.mpegQ || 5}`]);
            }

            // Build video filter chain
            const vfFilters = [];

            // Deinterlacing filter for old VCD/DVD/VHS rips
            if (options.deinterlace) {
                vfFilters.push('yadif=0:-1:0');
            }

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
                    vfFilters.push('hqdn3d=4:3:6:4.5');
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
            console.error('[FFmpeg Error]:', err.message);
            job.status = 'error';
            job.error = err.message || 'Encoding process encountered an error.';
            job.stage = 'Error';
            resolve();
        });

        cmd.save(outputPath);
    });
}


// ─── GET /api/progress/:id ──────────────────────────────────────────
app.get('/api/progress/:id', (req, res) => {
    const job = getOrCreateJob(req.params.id);
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
    const job = getOrCreateJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'File not found' });

    // Ensure output file exists, or locate on disk
    if (!job.outputPath || !fs.existsSync(job.outputPath)) {
        const searchDirs = [customOutputDir, OUTPUT_DIR].filter(Boolean);
        for (const dir of searchDirs) {
            try {
                if (fs.existsSync(dir)) {
                    const files = fs.readdirSync(dir);
                    const match = files.find(f => path.basename(f, path.extname(f)) === req.params.id);
                    if (match) {
                        job.outputPath = path.join(dir, match);
                        job.outputFileName = job.outputFileName || match;
                        job.status = 'done';
                        break;
                    }
                }
            } catch (e) { /* ignore */ }
        }
    }

    if (!job.outputPath || !fs.existsSync(job.outputPath)) {
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
                
                // Do not delete files that belong to an active or queued job
                if (isFileInActiveJob(filePath)) return;

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
    aiStatus = await aiUpscaler.checkAIAvailability();
    if (aiStatus.available) {
        const gpuName = aiStatus.gpu ? aiStatus.gpu.name : 'Default GPU';
        console.log(`✅ Real-ESRGAN detected at: ${aiStatus.path}`);
        console.log(`🚀 GPU Acceleration Enabled: "${gpuName}"`);
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
