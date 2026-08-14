# 🎬 VideoForge v1.0.0 — Professional Video Processing Workstation

> Developed by **Soubhik Sadhu** • [GitHub Repository](https://github.com/SoubhLance/VideoForge)

A local-first video conversion and AI upscaling workstation powered by **FFmpeg** and **Real-ESRGAN**. 

VideoForge is specifically designed to transcode and recover **legacy/old video files** (such as `.dat`, `.vob`, `.flv`, `.3gp`, `.avi`, `.mpeg`) that are not natively supported or fail to open in modern video editors like **Adobe Premiere Pro** or **After Effects**. 

VideoForge is completely **free to use** and open source. If you encounter any bugs or want to enhance functionality, feel free to create a pull request or contribute to the project!

![Version](https://img.shields.io/badge/version-1.0.0-orange)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-required-007808?logo=ffmpeg&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## ✨ Features

- **Format Conversion** — Convert between MP4, AVI, MKV, MOV, WebM, FLV, 3GP, MPEG, GIF, audio extractions (MP3, WAV, AAC, FLAC), and legacy DAT (VCD) / VOB (DVD) files
- **AI Upscaling** — Neural super-resolution via Real-ESRGAN (2×, 4×, AI Enhance)
- **Enhancement Filters** — FFmpeg-powered noise reduction (`nlmeans`) and edge sharpening (`unsharp`)
- **FFmpeg Fallback** — Lanczos upscaling + sharpening when AI tools are unavailable
- **Video Preview** — Built-in video player with timeline scrubbing and timecode display
- **File Browser** — Native-style folder browser to choose output directories
- **Encode Queue** — FIFO job queue with real-time SSE progress tracking
- **Presets** — One-click presets for Web (720p), High Quality (1080p), 4K Master, GIF, Archive, and Audio extractions
- **Keyboard Shortcuts** — `Ctrl+O` Import, `Ctrl+E` Export, `Ctrl+N` Clear workspace
- **Metadata Probe** — FFprobe integration showing codec, resolution, FPS, bitrate, and more
- **Professional UI** — Dark-themed desktop application layout with sidebar, inspector panel, and encode queue monitor

---

## 📋 Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| **Node.js** | ✅ v18+ | [Download](https://nodejs.org/) |
| **FFmpeg** | ✅ | Must be in your system `PATH`. [Download](https://ffmpeg.org/download.html) |
| **Real-ESRGAN** | Optional | For AI upscaling. Portable binary setup via `node setup-tools.js` (Windows) |

---

## 🚀 Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-username/VideoForge.git
cd VideoForge

# 2. Install dependencies
npm install

# 3. (Optional) Install AI upscaling tools (Windows)
node setup-tools.js

# 4. Start the server
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## 📁 Project Structure

```
VideoForge/
├── server.js              # Express server — API routes, FFmpeg pipeline, job queue
├── ai-upscaler.js         # Real-ESRGAN integration — frame extraction & reassembly
├── setup-tools.js         # Auto-installer for Real-ESRGAN portable binary
├── package.json
├── public/
│   ├── index.html         # Main UI — desktop shell layout
│   ├── app.js             # Frontend logic — upload, preview, convert, folder browser
│   └── styles.css         # Full UI stylesheet — dark theme, modals, animations
├── tools/                 # Real-ESRGAN binary + models (auto-installed)
├── uploads/               # Temporary uploaded files (auto-cleaned)
├── outputs/               # Default converted file output
└── temp/                  # AI pipeline temporary frames
```

---

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

### Output Directory

Click **Choose…** in the Export Settings panel to browse and select any output directory on your system. The server validates write permissions before accepting.

### Quality Presets

| Preset | CRF (H.264) | VP9 CRF | MPEG Quality | Audio Bitrate | Encode Speed |
|--------|-------------|---------|--------------|---------------|--------------|
| **High** | 18 | 25 | qscale: 2 | 192 kbps | Medium |
| **Medium** | 23 | 31 | qscale: 5 | 128 kbps | Fast |
| **Low** | 28 | 38 | qscale: 8 | 96 kbps | Very Fast |

---

## 🤖 AI Upscaling & Enhancement

VideoForge supports GPU-accelerated upscaling via **Real-ESRGAN NCNN Vulkan**:

1. Run `node setup-tools.js` to download the portable binary and models
2. Enable **Neural Super-Resolution** in the Export Settings panel
3. Choose a mode:
   - **2× Scale** — Double resolution (Real-ESRGAN)
   - **4× Scale** — Quadruple resolution (Real-ESRGAN)
   - **AI Enhance** — 4× scale with enhanced detail recovery (Real-ESRGAN)
   - **Denoise** — Optimized noise reduction filter (`nlmeans`)
   - **Sharpen** — Unsharp mask filter (`unsharp`)

> **Note:** AI upscaling requires a Vulkan-compatible GPU. If Real-ESRGAN is unavailable, VideoForge automatically falls back to high-quality FFmpeg Lanczos upscaling.

---

## 📡 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload` | Upload a video file |
| `GET` | `/api/probe/:id` | Get video metadata (FFprobe) |
| `GET` | `/api/stream/:id` | Stream uploaded video for preview |
| `POST` | `/api/convert` | Start conversion/upscaling job |
| `GET` | `/api/progress/:id` | SSE stream for job progress |
| `GET` | `/api/download/:id` | Download converted file |
| `GET` | `/api/ai-status` | Check Real-ESRGAN availability |
| `POST` | `/api/set-output-path` | Set custom output directory |
| `GET` | `/api/browse-dirs` | Browse filesystem directories |

---

## 🎮 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + O` | Import media file |
| `Ctrl + E` | Start export/conversion |
| `Ctrl + N` | Clear workspace |
| `Escape` | Close menus/dialogs |

---

## 📝 Supported Formats

### Input
`.mp4` `.avi` `.mkv` `.mov` `.flv` `.webm` `.mpeg` `.mpg` `.3gp` `.dat` `.vob` `.mp3` `.wav` `.aac` `.flac`

### Output
`MP4` `AVI` `MKV` `MOV` `WebM` `FLV` `3GP` `MPEG` `GIF` `MP3` `WAV` `AAC` `FLAC`

> **DAT / VOB files** (VCD/DVD) are auto-detected and decoded as raw video/audio streams.

---

## 🛠️ Troubleshooting

| Issue | Solution |
|-------|----------|
| `FFmpeg not found` | Install FFmpeg and add to system PATH |
| `AI upscaler unavailable` | Run `node setup-tools.js` or install Real-ESRGAN manually in `tools/` |
| `Port already in use` | Set a different port: `PORT=3001 npm run dev` |
| `Lost connection to server` | Check terminal for server errors; the server auto-recovers from most crashes |
| `Conversion fails` | Check the encode queue error message; try a different format or quality preset |

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
