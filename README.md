# 🎬 VideoForge

**A local-first video conversion and AI upscaling workstation, built for footage nothing else will open.**

Developed by **[Soubhik Sadhu](https://github.com/SoubhLance)**

![Version](https://img.shields.io/badge/version-1.0.0-orange)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-required-007808?logo=ffmpeg&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

---

## Why VideoForge

Old `.dat`, `.vob`, `.flv`, `.3gp`, and `.mpeg` files — VCD rips, DVD backups, early-2000s camcorder exports — routinely fail to import into modern NLEs like **Adobe Premiere Pro** and **After Effects**. Commercial converters that handle this reliably are usually paid, subscription-gated, or bundled with bloatware.

VideoForge was built to solve that specific problem after running into it firsthand: a free, local, open-source tool that transcodes legacy formats into edit-ready modern containers, with optional AI upscaling for recovering detail from low-resolution source footage.

No uploads, no cloud processing, no subscription — everything runs on your machine.

---

## Screenshots

**Workstation UI** — dark-themed desktop layout with format selection, encoder profile, deinterlacing, and neural upscaling controls in the inspector panel:

![VideoForge workstation UI](./screenshots/workstation.png)

**Launch splash screen:**

![VideoForge splash screen](./screenshots/splash.png)

---

## Features

- **Format Conversion** — MP4, AVI, MKV, MOV, WebM, FLV, 3GP, MPEG, GIF, and audio extraction (MP3, WAV, AAC, FLAC), including legacy DAT (VCD) and VOB (DVD) sources
- **AI Upscaling** — Neural super-resolution via Real-ESRGAN (2×, 4×, AI Enhance)
- **Enhancement Filters** — FFmpeg-powered noise reduction (`nlmeans`) and edge sharpening (`unsharp`)
- **Deinterlacing** — YADIF filter for fixing interlacing artifacts on old DAT/VOB/VHS-sourced video
- **Automatic Fallback** — High-quality Lanczos upscaling + sharpening when a Vulkan-compatible GPU isn't available
- **Live Preview** — Built-in player with timeline scrubbing and timecode display
- **Native-style File Browser** — Pick output directories without leaving the app
- **Encode Queue** — FIFO job queue with real-time progress via Server-Sent Events
- **One-click Presets** — Web (720p), High Quality (1080p), 4K Master, GIF, Archive, and Audio-only
- **Keyboard Shortcuts** — `Ctrl+O` Import, `Ctrl+E` Export, `Ctrl+N` Clear workspace
- **Metadata Probe** — FFprobe integration for codec, resolution, FPS, and bitrate inspection

---

## System Requirements

### 💻 Minimum (CPU only)

| Component | Requirement |
|---|---|
| OS | Windows 10 64-bit |
| CPU | Intel Core i3 / AMD Ryzen 3, 4 cores |
| RAM | 8 GB |
| Storage | 5 GB free space, plus space for input/output videos |
| GPU | Not required |
| Graphics | Integrated Intel/AMD graphics is sufficient for basic conversion |
| Display | 1280×720 |
| Internet | Not required |

> **⚠️ AI Upscaling on CPU-only systems:** VideoForge runs fine without a dedicated GPU for standard conversion, trimming, format conversion, and audio extraction. Real-ESRGAN AI upscaling will fall back to CPU processing, which is significantly slower — expect long encode times on larger files or high upscale factors.

### 🚀 Recommended

| Component | Recommended |
|---|---|
| OS | Windows 11 64-bit |
| CPU | Intel Core i7 (5th gen+) / AMD Ryzen 7 (3rd gen+) |
| RAM | 16 GB |
| Storage | SSD, 10 GB+ free |
| GPU | NVIDIA GTX 1660 or better |
| VRAM | 6–8 GB+ |
| Display | 1920×1080 |
| Internet | Not required |

### 🤖 AI Upscaling — GPU Requirements

| | Requirement |
|---|---|
| **Minimum** | Vulkan-compatible GPU, ~2–4 GB VRAM |
| **Recommended** | NVIDIA GTX 1660 or better, 6–8 GB VRAM |
| **Verified working** | NVIDIA GeForce RTX 4060 Laptop GPU |

Real-ESRGAN NCNN Vulkan requires a Vulkan-compatible GPU. Without one, VideoForge automatically falls back to FFmpeg's Lanczos upscaling on CPU — functional, but considerably slower and lower quality than the AI path.

---

## Prerequisites

| Tool | Required | Notes |
|---|---|---|
| **Node.js** | Yes — v18+ | [nodejs.org](https://nodejs.org/) |
| **FFmpeg** | Yes | Must be available on your system `PATH`. [ffmpeg.org](https://ffmpeg.org/download.html) |
| **Real-ESRGAN** | Optional | Enables AI upscaling. Installed via `node setup-tools.js` (Windows portable binary) |

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/SoubhLance/VideoForge.git
cd VideoForge

# 2. Install dependencies
npm install

# 3. (Optional) Install AI upscaling tools — Windows
node setup-tools.js

# 4. Start the server
npm run dev
```

Open **http://localhost:3000** in your browser.

> A packaged Windows installer (Electron + NSIS) is planned — see [Roadmap](#roadmap).

---

## Project Structure

```
VideoForge/
├── server.js              # Express server — API routes, FFmpeg pipeline, job queue
├── ai-upscaler.js         # Real-ESRGAN integration — frame extraction & reassembly
├── setup-tools.js         # Auto-installer for the Real-ESRGAN portable binary
├── package.json
├── public/
│   ├── index.html         # Main UI — desktop shell layout
│   ├── app.js             # Frontend logic — upload, preview, convert, folder browser
│   └── styles.css         # Dark theme, modals, animations
├── tools/                 # Real-ESRGAN binary + models (auto-installed)
├── uploads/                # Temporary uploaded files (auto-cleaned)
├── outputs/                # Default converted file output
└── temp/                    # AI pipeline temporary frames
```

---

## Configuration

**Environment variables**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |

**Output directory** — click **Choose…** in Export Settings to pick any writable directory. The server validates write permissions before accepting.

**Quality presets**

| Preset | CRF (H.264) | VP9 CRF | MPEG Quality | Audio Bitrate | Encode Speed |
|---|---|---|---|---|---|
| High | 18 | 25 | qscale: 2 | 192 kbps | Medium |
| Medium | 23 | 31 | qscale: 5 | 128 kbps | Fast |
| Low | 28 | 38 | qscale: 8 | 96 kbps | Very Fast |

---

## AI Upscaling & Enhancement

VideoForge integrates **Real-ESRGAN NCNN Vulkan** for GPU-accelerated upscaling:

1. Run `node setup-tools.js` to download the portable binary and models
2. Enable **Neural Super-Resolution** in Export Settings
3. Choose a mode:
   - **2× Scale** — Real-ESRGAN, double resolution
   - **4× Scale** — Real-ESRGAN, quadruple resolution
   - **AI Enhance** — 4× scale with enhanced detail recovery
   - **Denoise** — `nlmeans` noise reduction
   - **Sharpen** — `unsharp` mask filter

Requires a Vulkan-compatible GPU. If Real-ESRGAN is unavailable, VideoForge falls back to FFmpeg's Lanczos upscaling automatically.

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/upload` | Upload a video file |
| `GET` | `/api/probe/:id` | Get video metadata (FFprobe) |
| `GET` | `/api/stream/:id` | Stream uploaded video for preview |
| `POST` | `/api/convert` | Start a conversion/upscaling job |
| `GET` | `/api/progress/:id` | SSE stream for job progress |
| `GET` | `/api/download/:id` | Download the converted file |
| `GET` | `/api/ai-status` | Check Real-ESRGAN availability |
| `POST` | `/api/set-output-path` | Set a custom output directory |
| `GET` | `/api/browse-dirs` | Browse filesystem directories |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + O` | Import media file |
| `Ctrl + E` | Start export/conversion |
| `Ctrl + N` | Clear workspace |
| `Escape` | Close menus/dialogs |

---

## Supported Formats

**Input:** `.mp4` `.avi` `.mkv` `.mov` `.flv` `.webm` `.mpeg` `.mpg` `.3gp` `.dat` `.vob` `.mp3` `.wav` `.aac` `.flac`

**Output:** `MP4` `AVI` `MKV` `MOV` `WebM` `FLV` `3GP` `MPEG` `GIF` `MP3` `WAV` `AAC` `FLAC`

DAT and VOB files (VCD/DVD) are auto-detected and decoded as raw video/audio streams.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| `FFmpeg not found` | Install FFmpeg and add it to your system PATH |
| `AI upscaler unavailable` | Run `node setup-tools.js`, or install Real-ESRGAN manually into `tools/` |
| `Port already in use` | Run on a different port: `PORT=3001 npm run dev` |
| `Lost connection to server` | Check the terminal for errors; the server recovers from most crashes automatically |
| `Conversion fails` | Check the encode queue error message; try a different format or quality preset |

---

## Roadmap

- [ ] Electron + NSIS packaged installer for Windows
- [ ] Bundled FFmpeg/Real-ESRGAN binaries (no separate install step)
- [ ] Batch conversion queue improvements
- [ ] macOS / Linux packaging

---

## Contributing

VideoForge is free and open source, and contributions are genuinely welcome. If you hit a bug or want to add a feature:

1. Fork the repository
2. Create a branch (`git checkout -b fix/your-fix`)
3. Commit your changes with a clear message
4. Open a pull request describing what changed and why

Please open an issue first for larger changes so we can align on approach before you put in the work.

---

## License & Attribution

VideoForge is released under the **[MIT License](LICENSE)**. In short: you're free to use, modify, and distribute this software, including commercially, provided the original copyright notice and license text are retained in any copy or substantial portion of the code.

**On forks that misrepresent authorship:** the MIT license requires the original copyright notice to remain intact in any redistributed copy — removing it and claiming the work as your own is a license violation, not a legal gray area. If you come across a fork or republished copy that strips attribution:

- Git commit history and repository timestamps on the [original repo](https://github.com/SoubhLance/VideoForge) serve as evidence of authorship and are preserved by GitHub even after forking.
- Violations on GitHub can be reported through [GitHub's DMCA takedown process](https://github.com/contact/dmca), citing the original repository and commit history.
- Genuine forks that credit the original project are exactly what MIT licensing is meant to encourage — this only applies to copies that erase attribution entirely.

```
Copyright (c) 2026 Soubhik Sadhu
```

---

## Acknowledgments

Built on [FFmpeg](https://ffmpeg.org/) and [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN).