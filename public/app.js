/* ═══════════════════════════════════════════════════════════════
   VideoForge — Client Application (with AI Upscale support)
   Fixed: file import, video preview, menu items, conversion
   ═══════════════════════════════════════════════════════════════ */

const API = '';

// State
let currentFileId = null;
let selectedFormat = 'mp4';
let upscaleOn = false;
let selectedScale = '2x';
let probeData = null;
let aiAvailable = false;
let currentObjectUrl = null; // For video preview blob URL

// DOM refs
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfoPanel = document.getElementById('fileInfoPanel');
const fileNameEl = document.getElementById('fileName');
const fileSizeEl = document.getElementById('fileSize');
const probeInfoEl = document.getElementById('probeInfo');
const convertBtn = document.getElementById('convertBtn');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressPct = document.getElementById('progressPct');
const progressStatus = document.getElementById('progressStatus');
const progressStage = document.getElementById('progressStage');
const errorBox = document.getElementById('errorBox');
const errorText = document.getElementById('errorText');
const doneBox = document.getElementById('doneBox');
const timeBadge = document.getElementById('timeBadge');
const reportInput = document.getElementById('reportInput');
const reportOutput = document.getElementById('reportOutput');
const dlBtn = document.getElementById('dlBtn');
const newBtn = document.getElementById('newBtn');
const upscaleRow = document.getElementById('upscaleRow');
const upscaleOptions = document.getElementById('upscaleOptions');
const warningNotice = document.getElementById('warningNotice');
const warningText = document.getElementById('warningText');
const aiBadge = document.getElementById('aiBadge');

// Video preview elements
const videoPlayer = document.getElementById('videoPlayer');
const monitorOverlay = document.getElementById('monitorOverlay');
const monitorPlayBtn = document.getElementById('monitorPlayBtn');
const monitorPauseBtn = document.getElementById('monitorPauseBtn');
const timelineBar = document.getElementById('timelineBar');
const timelineScrub = document.getElementById('timelineScrub');
const timelineHead = document.getElementById('timelineHead');
const timecodeEl = document.getElementById('timecodeEl');

// ─── Check AI availability on load ─────────────────────────────
async function checkAIStatus() {
    try {
        const res = await fetch(`${API}/api/ai-status`);
        const data = await res.json();
        aiAvailable = data.available;
        if (aiBadge) {
            const gpuName = data.gpu ? data.gpu.name : 'GPU';
            aiBadge.textContent = aiAvailable ? `AI Ready (${gpuName})` : 'AI Unavailable';
            aiBadge.classList.toggle('ai-ready', aiAvailable);
            aiBadge.classList.toggle('ai-off', !aiAvailable);
        }
    } catch (e) {
        aiAvailable = false;
    }
}
checkAIStatus();

// ─── Drag & Drop & Import Handler ──────────────────────────
if (dropZone) {
    dropZone.addEventListener('dragover', e => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
    });

    // Make the entire drop zone clickable to open file dialog
    dropZone.addEventListener('click', () => {
        fileInput.click();
    });
}

const importBtn = document.getElementById('importBtn');
if (importBtn) {
    importBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });
}

if (fileInput) {
    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) uploadFile(fileInput.files[0]);
    });
}

// ─── History & Recent Asset Persistence ────────────────────
function saveToHistory(jobData) {
    try {
        const history = JSON.parse(localStorage.getItem('vf_history') || '[]');
        const record = {
            id: currentFileId,
            name: fileNameEl ? fileNameEl.textContent : 'Asset',
            format: selectedFormat.toUpperCase(),
            outputSize: jobData.outputSize || 0,
            conversionTime: jobData.conversionTime || '0',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            date: new Date().toLocaleDateString()
        };
        history.unshift(record);
        if (history.length > 30) history.pop();
        localStorage.setItem('vf_history', JSON.stringify(history));
    } catch (e) {
        console.error('Failed to save history', e);
    }
}

function getHistory() {
    try {
        return JSON.parse(localStorage.getItem('vf_history') || '[]');
    } catch (e) {
        return [];
    }
}

function clearHistory() {
    localStorage.removeItem('vf_history');
}

async function clearServerCache() {
    try {
        showToast('Purging temp cache and clearing disk space…');
        const res = await fetch(`${API}/api/clear-cache`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed to purge cache');
        const data = await res.json();
        clearHistory();
        clearRecent();
        showToast(`Cache purged! Freed ${formatBytes(data.freedBytes)} of disk storage.`);
        closeActiveModal();
    } catch (err) {
        showToast(`Error purging cache: ${err.message}`);
    }
}

function saveToRecent(fileData) {
    try {
        const recent = JSON.parse(localStorage.getItem('vf_recent') || '[]');
        const record = {
            id: fileData.id,
            name: fileData.originalName,
            size: fileData.size,
            ext: fileData.ext,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        const filtered = recent.filter(r => r.id !== record.id);
        filtered.unshift(record);
        if (filtered.length > 20) filtered.pop();
        localStorage.setItem('vf_recent', JSON.stringify(filtered));
    } catch (e) {
        console.error('Failed to save recent', e);
    }
}

function getRecent() {
    try {
        return JSON.parse(localStorage.getItem('vf_recent') || '[]');
    } catch (e) {
        return [];
    }
}

function clearRecent() {
    localStorage.removeItem('vf_recent');
}

// ─── Format buttons ─────────────────────────────────────────
document.querySelectorAll('.fmt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedFormat = btn.dataset.fmt;
    });
});

// ─── Upscale toggle ─────────────────────────────────────────
if (upscaleRow) {
    upscaleRow.addEventListener('click', () => {
        upscaleOn = !upscaleOn;
        upscaleRow.classList.toggle('on', upscaleOn);
        if (upscaleOptions) upscaleOptions.classList.toggle('show', upscaleOn);
    });
}

document.querySelectorAll('.scale-btn').forEach(btn => {
    btn.addEventListener('click', e => {
        e.stopPropagation();
        document.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedScale = btn.dataset.scale;

        // Auto-enable upscaling when any scale preset button is clicked
        upscaleOn = true;
        if (upscaleRow) upscaleRow.classList.add('on');
        if (upscaleOptions) upscaleOptions.classList.add('show');
    });
});

// ─── Remove file ────────────────────────────────────────────
const removeBtn = document.getElementById('fileRemoveBtn');
if (removeBtn) removeBtn.addEventListener('click', resetAll);

// ─── New file ───────────────────────────────────────────────
if (newBtn) newBtn.addEventListener('click', resetAll);

// ─── Convert ────────────────────────────────────────────────
if (convertBtn) convertBtn.addEventListener('click', startConvert);

// ─── Download ───────────────────────────────────────────────
if (dlBtn) {
    dlBtn.addEventListener('click', () => {
        if (!currentFileId) return;
        window.location.href = `${API}/api/download/${currentFileId}`;
    });
}

// ─── Menu bar functionality ─────────────────────────────────
(function setupMenus() {
    const menuItems = document.querySelectorAll('.menu-item');
    let activeMenu = null;
    let activeDropdown = null;

    const menuConfigs = {
        'File': [
            { label: 'Import Media...', icon: '📂', action: () => fileInput.click() },
            { label: 'Clear Cache & Temp Files', icon: '🧹', action: clearServerCache },
            { label: 'separator' },
            { label: 'Clear Workspace', icon: '🗑️', action: resetAll },
        ],
        'Edit': [
            { label: 'Reset Export Settings', icon: '↩️', action: resetExportSettings },
            { label: 'separator' },
            { label: 'Select All Formats', icon: '☑️', action: () => { /* placeholder */ } },
        ],
        'Queue': [
            { label: 'View Active Jobs', icon: '📋', action: () => { /* scroll to queue */ document.querySelector('.footer-bar')?.scrollIntoView({behavior: 'smooth'}); } },
            { label: 'Clear Completed', icon: '🧹', action: () => { if(doneBox) doneBox.classList.remove('show'); } },
        ],
        'Presets': [
            { label: 'Web Optimized (MP4 720p)', icon: '🌐', action: () => applyPreset('mp4', '1280x720', 'medium') },
            { label: 'High Quality (MP4 1080p)', icon: '🎬', action: () => applyPreset('mp4', '1920x1080', 'high') },
            { label: '4K Master (MP4 4K)', icon: '📺', action: () => applyPreset('mp4', '3840x2160', 'high') },
            { label: 'separator' },
            { label: 'Quick GIF', icon: '🖼️', action: () => applyPreset('gif', 'source', 'medium') },
            { label: 'Archive (MKV Lossless)', icon: '📦', action: () => applyPreset('mkv', 'source', 'high') },
        ],
        'Help': [
            { label: 'About VideoForge', icon: 'ℹ️', action: showAboutDialog },
            { label: 'General FAQ & Guide', icon: '❓', action: openFaqModal },
            { label: 'separator' },
            { label: 'Keyboard Shortcuts', icon: '⌨️', action: () => showToast('Ctrl+O: Import | Ctrl+E: Export | Ctrl+N: New') },
        ],
    };

    function closeActiveMenu() {
        if (activeDropdown) {
            activeDropdown.remove();
            activeDropdown = null;
        }
        if (activeMenu) {
            activeMenu.classList.remove('menu-active');
            activeMenu = null;
        }
    }

    menuItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const label = item.textContent.trim();
            const config = menuConfigs[label];
            if (!config) return;

            if (activeMenu === item) {
                closeActiveMenu();
                return;
            }

            closeActiveMenu();

            activeMenu = item;
            item.classList.add('menu-active');

            const dropdown = document.createElement('div');
            dropdown.className = 'menu-dropdown';

            config.forEach(entry => {
                if (entry.label === 'separator') {
                    const sep = document.createElement('div');
                    sep.className = 'menu-separator';
                    dropdown.appendChild(sep);
                    return;
                }

                const menuBtn = document.createElement('div');
                menuBtn.className = 'menu-dropdown-item';
                if (entry.disabled && entry.disabled()) menuBtn.classList.add('disabled');

                menuBtn.innerHTML = `<span class="menu-dropdown-icon">${entry.icon || ''}</span><span>${entry.label}</span>`;
                menuBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    if (entry.disabled && entry.disabled()) return;
                    closeActiveMenu();
                    entry.action();
                });
                dropdown.appendChild(menuBtn);
            });

            const rect = item.getBoundingClientRect();
            dropdown.style.position = 'fixed';
            dropdown.style.top = (rect.bottom + 2) + 'px';
            dropdown.style.left = rect.left + 'px';
            document.body.appendChild(dropdown);
            activeDropdown = dropdown;
        });
    });

    document.addEventListener('click', () => closeActiveMenu());
})();

// ─── Optimized Video Preview Player (Big Files & Legacy Codecs) ───
let isNativeBrowserFormat = false;

function setupVideoPreview(file) {
    if (!videoPlayer) return;

    // Revoke old blob URL
    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
    }

    const ext = file.name.split('.').pop().toLowerCase();
    isNativeBrowserFormat = ['mp4', 'webm'].includes(ext) && file.size < 300 * 1024 * 1024;

    if (isNativeBrowserFormat) {
        currentObjectUrl = URL.createObjectURL(file);
        videoPlayer.src = currentObjectUrl;
        videoPlayer.preload = 'metadata';
        videoPlayer.style.display = 'block';
        if (monitorOverlay) monitorOverlay.style.display = 'none';
    } else {
        videoPlayer.style.display = 'none';
        if (monitorOverlay) {
            monitorOverlay.style.display = 'flex';
            monitorOverlay.style.flexDirection = 'column';
            monitorOverlay.style.gap = '8px';
            monitorOverlay.style.padding = '20px';
            monitorOverlay.style.textAlign = 'center';
            monitorOverlay.innerHTML = `
                <div style="font-size: 28px; margin-bottom: 2px;">🎬</div>
                <div style="font-size: 14px; font-weight: 700; color: #f39c12;">LEGACY MEDIA CONTAINER (.${ext.toUpperCase()})</div>
                <div style="font-size: 12px; color: var(--text-secondary); max-width: 520px; line-height: 1.5;">
                    If video preview is not loading, it's because the browser cannot natively render legacy file formats.<br>
                    <strong style="color: var(--accent);">Don't force the app! You may proceed directly to convert or upscale your video to make it better!</strong>
                </div>
            `;
        }
    }

    videoPlayer.onerror = () => {
        console.warn('[Player] HTML5 browser cannot render raw legacy video container');
        videoPlayer.style.display = 'none';
        if (monitorOverlay) {
            monitorOverlay.style.display = 'flex';
            monitorOverlay.style.flexDirection = 'column';
            monitorOverlay.style.gap = '8px';
            monitorOverlay.style.padding = '20px';
            monitorOverlay.style.textAlign = 'center';
            monitorOverlay.innerHTML = `
                <div style="font-size: 28px; margin-bottom: 2px;">🎬</div>
                <div style="font-size: 14px; font-weight: 700; color: #f39c12;">LEGACY MEDIA CONTAINER (.${ext.toUpperCase()})</div>
                <div style="font-size: 12px; color: var(--text-secondary); max-width: 520px; line-height: 1.5;">
                    If video preview is not loading, it's because the browser cannot natively render legacy file formats.<br>
                    <strong style="color: var(--accent);">Don't force the app! You may proceed directly to convert or upscale your video to make it better!</strong>
                </div>
            `;
        }
    };

    videoPlayer.onloadedmetadata = () => {
        updateTimecode(0, videoPlayer.duration);
    };

    videoPlayer.ontimeupdate = () => {
        if (!videoPlayer.duration) return;
        const pct = (videoPlayer.currentTime / videoPlayer.duration) * 100;
        if (timelineScrub) timelineScrub.style.width = pct + '%';
        if (timelineHead) timelineHead.style.left = pct + '%';
        updateTimecode(videoPlayer.currentTime, videoPlayer.duration);
    };

    videoPlayer.onended = () => {
        if (monitorPlayBtn) monitorPlayBtn.style.display = '';
        if (monitorPauseBtn) monitorPauseBtn.style.display = 'none';
    };
}

if (monitorPlayBtn) {
    monitorPlayBtn.addEventListener('click', () => {
        if (videoPlayer && videoPlayer.src && videoPlayer.readyState >= 1) {
            videoPlayer.play();
            monitorPlayBtn.style.display = 'none';
            if (monitorPauseBtn) monitorPauseBtn.style.display = '';
        }
    });
}

if (monitorPauseBtn) {
    monitorPauseBtn.addEventListener('click', () => {
        if (videoPlayer) {
            videoPlayer.pause();
            monitorPauseBtn.style.display = 'none';
            if (monitorPlayBtn) monitorPlayBtn.style.display = '';
        }
    });
}

// Timeline seek
if (timelineBar) {
    timelineBar.addEventListener('click', (e) => {
        if (!videoPlayer || !videoPlayer.duration) return;
        const rect = timelineBar.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        videoPlayer.currentTime = pct * videoPlayer.duration;
    });
}

function updateTimecode(current, total) {
    if (!timecodeEl) return;
    timecodeEl.textContent = `${formatTimecode(current)} / ${formatTimecode(total)}`;
}

function formatTimecode(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + units[i];
}

function formatDuration(seconds) {
    if (!seconds || seconds === 'N/A') return 'N/A';
    const s = parseFloat(seconds);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

// ─── Upload File ────────────────────────────────────────────
async function uploadFile(file) {
    resetUI();
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatBytes(file.size);
    fileInfoPanel.classList.add('show');
    dropZone.style.display = 'none';

    // Setup video preview with the local file
    setupVideoPreview(file);

    // Show loading state
    probeInfoEl.innerHTML = '<div class="probe-loading"><span class="spinner"></span> Uploading & analyzing…</div>';

    showToast('Uploading file…');

    try {
        const formData = new FormData();
        formData.append('video', file);

        const uploadRes = await fetch(`${API}/api/upload`, { method: 'POST', body: formData });
        if (!uploadRes.ok) {
            const err = await uploadRes.json();
            throw new Error(err.error || 'Upload failed');
        }

        const data = await uploadRes.json();
        currentFileId = data.id;
        saveToRecent(data);

        // Probe file
        probeInfoEl.innerHTML = '<div class="probe-loading"><span class="spinner"></span> Analyzing video metadata…</div>';

        const probeRes = await fetch(`${API}/api/probe/${data.id}`);
        if (!probeRes.ok) {
            const err = await probeRes.json();
            throw new Error(err.error || 'Failed to analyze file');
        }

        probeData = await probeRes.json();
        renderProbeInfo(probeData);

        // Fast H.264 preview setup for legacy browser formats (.dat, .vob, .avi, .flv, .3gp)
        if (videoPlayer && !isNativeBrowserFormat) {
            videoPlayer.src = `${API}/api/preview/${data.id}`;
            videoPlayer.preload = 'metadata';
            videoPlayer.style.display = 'block';
            if (monitorOverlay) monitorOverlay.style.display = 'none';
        }

        convertBtn.disabled = false;
        showToast('File ready for conversion');

    } catch (err) {
        showError(err.message);
        probeInfoEl.innerHTML = '';
    }
}

function renderProbeInfo(info) {
    let html = '<div class="probe-grid">';

    html += probeItem('Container', info.container);
    html += probeItem('Duration', formatDuration(info.duration));
    html += probeItem('Bitrate', info.bitrate !== 'N/A' ? info.bitrate + ' kbps' : 'N/A');
    html += probeItem('File Size', formatBytes(info.size));

    if (info.video) {
        html += probeItem('Video Codec', info.video.codecShort);
        html += probeItem('Resolution', info.video.width + '×' + info.video.height);
        html += probeItem('FPS', info.video.fps);
        html += probeItem('Pixel Fmt', info.video.pixelFormat);
    }

    if (info.audio) {
        html += probeItem('Audio Codec', info.audio.codecShort);
        html += probeItem('Sample Rate', info.audio.sampleRate + ' Hz');
        html += probeItem('Channels', info.audio.channels);
    }

    html += '</div>';

    if (!isNativeBrowserFormat) {
        html += `<div style="margin-top: 12px; background: rgba(243, 156, 18, 0.12); border: 1px solid rgba(243, 156, 18, 0.35); border-radius: var(--radius); padding: 10px 14px; font-size: 12px; color: var(--text-primary); line-height: 1.4;">
            <strong>💡 Legacy Format Notice:</strong> If video preview is not loading, it's because the browser cannot natively access raw legacy codecs. <strong>Don't force the app preview — you may proceed directly to convert or upscale your video to make it better!</strong>
        </div>`;
    }

    html += `<div style="margin-top: 10px; display: flex; justify-content: flex-end;">
        <button class="vf-mini-btn" id="copyProbeBtn" type="button">📋 Copy Stream Data</button>
    </div>`;
    probeInfoEl.innerHTML = html;

    const copyBtn = document.getElementById('copyProbeBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const summary = `Asset: ${fileNameEl ? fileNameEl.textContent : 'File'}\nContainer: ${info.container}\nDuration: ${formatDuration(info.duration)}\nSize: ${formatBytes(info.size)}\nVideo: ${info.video ? info.video.codecShort + ' ' + info.video.width + 'x' + info.video.height + ' @ ' + info.video.fps + 'fps' : 'N/A'}\nAudio: ${info.audio ? info.audio.codecShort + ' ' + info.audio.sampleRate + 'Hz' : 'N/A'}`;
            navigator.clipboard.writeText(summary);
            showToast('Technical stream data copied to clipboard!');
        });
    }
}

function probeItem(label, value) {
    return `<div class="probe-item"><div class="probe-label">${label}</div><div class="probe-value">${value}</div></div>`;
}

// Global window drag-and-drop handler
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        uploadFile(e.dataTransfer.files[0]);
    }
});

// ─── Start Conversion ───────────────────────────────────────
async function startConvert() {
    if (!currentFileId) return;

    hideError();
    hideWarning();
    convertBtn.style.display = 'none';
    doneBox.classList.remove('show');
    progressWrap.classList.add('show');
    progressBar.style.width = '0%';
    progressPct.textContent = '0%';
    progressStatus.textContent = 'Starting conversion…';
    if (progressStage) progressStage.textContent = '';

    // Determine if this is an AI upscale request
    const isAIUpscale = upscaleOn && (selectedScale === '2x' || selectedScale === '4x' || selectedScale === 'ai-enhance');
    const deinterlaceChecked = document.getElementById('deinterlaceCheck')?.checked || false;

    try {
        const body = {
            id: currentFileId,
            format: selectedFormat,
            resolution: document.getElementById('resSelect').value,
            quality: document.getElementById('qualSelect').value,
            upscale: upscaleOn,
            upscaleMode: selectedScale,
            aiUpscale: isAIUpscale,
            deinterlace: deinterlaceChecked,
        };

        const res = await fetch(`${API}/api/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Conversion failed');
        }

        showToast('Conversion started…');

        // Listen for progress via SSE
        listenProgress(currentFileId);

    } catch (err) {
        progressWrap.classList.remove('show');
        convertBtn.style.display = '';
        showError(err.message);
    }
}

let conversionStartTime = null;

function listenProgress(fileId) {
    conversionStartTime = Date.now();
    const evtSource = new EventSource(`${API}/api/progress/${fileId}`);

    evtSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.status === 'queued' || data.status === 'converting') {
            const pct = data.progress || 0;
            progressBar.style.width = pct + '%';

            // Calculate Remaining Time (ETA)
            let etaText = '';
            if (pct > 2 && pct < 100 && conversionStartTime) {
                const elapsedSec = (Date.now() - conversionStartTime) / 1000;
                const totalEstSec = (elapsedSec / pct) * 100;
                const remainingSec = Math.max(0, Math.round(totalEstSec - elapsedSec));
                const rmMin = Math.floor(remainingSec / 60);
                const rmSec = remainingSec % 60;
                if (rmMin > 0) {
                    etaText = ` • ETA: ${rmMin}m ${rmSec.toString().padStart(2, '0')}s`;
                } else {
                    etaText = ` • ETA: ${rmSec}s`;
                }
            }

            progressPct.textContent = `${pct}%${etaText}`;

            // Use server-provided stage message if available
            if (data.stage) {
                progressStatus.textContent = data.stage;
            } else if (data.status === 'queued') {
                progressStatus.textContent = 'Waiting in queue...';
            } else {
                if (pct < 20) progressStatus.textContent = 'Reading file…';
                else if (pct < 50) progressStatus.textContent = 'Decoding & re-encoding…';
                else if (pct < 80) progressStatus.textContent = upscaleOn ? 'Applying enhancements…' : 'Optimizing…';
                else progressStatus.textContent = 'Finalizing…';
            }
        }

        if (data.status === 'done') {
            evtSource.close();
            progressBar.style.width = '100%';
            progressPct.textContent = '100%';
            progressStatus.textContent = 'Complete!';

            setTimeout(() => {
                progressWrap.classList.remove('show');
                showDoneBox(data);
                showToast('Conversion complete! Ready to download.');
            }, 500);
        }

        if (data.status === 'error') {
            evtSource.close();
            progressWrap.classList.remove('show');
            convertBtn.style.display = '';
            showError(data.error || 'Conversion failed');
        }
    };

    evtSource.onerror = () => {
        evtSource.close();
        progressWrap.classList.remove('show');
        convertBtn.style.display = '';
        showError('Lost connection to server');
    };
}

// ─── Show Done Box ──────────────────────────────────────────
function showDoneBox(data) {
    timeBadge.textContent = `Completed in ${data.conversionTime || '?'}s`;

    // Show warning if present (e.g., AI fallback)
    if (data.warning) {
        showWarning(data.warning);
    }

    // Build input report
    let inputHtml = '';
    if (probeData) {
        inputHtml += reportRow('Format', probeData.container);
        inputHtml += reportRow('Duration', formatDuration(probeData.duration));
        if (probeData.video) {
            inputHtml += reportRow('Resolution', probeData.video.width + '×' + probeData.video.height);
            inputHtml += reportRow('Codec', probeData.video.codecShort);
        }
        inputHtml += reportRow('Size', formatBytes(probeData.size));
    }
    reportInput.innerHTML = inputHtml;

    // Build output report
    let outHtml = '';
    outHtml += reportRow('Format', selectedFormat.toUpperCase());
    if (data.outputInfo) {
        outHtml += reportRow('Duration', formatDuration(data.outputInfo.duration));
        if (data.outputInfo.video) {
            outHtml += reportRow('Resolution', data.outputInfo.video.width + '×' + data.outputInfo.video.height);
            outHtml += reportRow('Codec', data.outputInfo.video.codec);
        }
        outHtml += reportRow('Bitrate', (data.outputInfo.bitrate || 'N/A') + ' kbps');
    }
    outHtml += reportRow('Size', formatBytes(data.outputSize));
    reportOutput.innerHTML = outHtml;

    doneBox.classList.add('show');
    saveToHistory(data);
}

function reportRow(label, value) {
    return `<div class="report-item"><span class="rl">${label}</span><span class="rv">${value}</span></div>`;
}

// ─── Warning notice ─────────────────────────────────────────
function showWarning(msg) {
    if (warningNotice && warningText) {
        warningText.textContent = msg;
        warningNotice.classList.add('show');
    }
}

function hideWarning() {
    if (warningNotice) {
        warningNotice.classList.remove('show');
    }
}

// ─── Toast notifications ────────────────────────────────────
function showToast(msg) {
    // Remove existing toast
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = msg;
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ─── Preset application ────────────────────────────────────
function applyPreset(format, resolution, quality, deinterlace = false) {
    // Set format
    document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
    const fmtBtn = document.querySelector(`.fmt-btn[data-fmt="${format}"]`);
    if (fmtBtn) { fmtBtn.classList.add('active'); selectedFormat = format; }

    // Set resolution
    const resSelect = document.getElementById('resSelect');
    if (resSelect) resSelect.value = resolution;

    // Set quality
    const qualSelect = document.getElementById('qualSelect');
    if (qualSelect) qualSelect.value = quality;

    // Set deinterlace
    const deinterlaceCheck = document.getElementById('deinterlaceCheck');
    if (deinterlaceCheck) deinterlaceCheck.checked = !!deinterlace;

    showToast(`Preset applied: ${format.toUpperCase()} ${resolution === 'source' ? '' : resolution} ${quality}`);
}

function resetExportSettings() {
    applyPreset('mp4', 'source', 'medium');
    if (upscaleOn) {
        upscaleOn = false;
        if (upscaleRow) upscaleRow.classList.remove('on');
        if (upscaleOptions) upscaleOptions.classList.remove('show');
    }
    showToast('Export settings reset to defaults');
}

function showAboutDialog() {
    openAboutModal();
}

function openAboutModal() {
    closeActiveModal();

    const modal = document.createElement('div');
    modal.className = 'vf-modal-overlay';
    modal.id = 'vfActiveModal';

    modal.innerHTML = `
        <div class="vf-modal vf-modal-md">
            <div class="vf-modal-header">
                <div class="vf-modal-title">ℹ️ About VideoForge</div>
                <button class="vf-modal-close" type="button">✕</button>
            </div>
            <div class="vf-modal-body" style="text-align: center; padding: 28px 24px;">
                <div style="width: 56px; height: 56px; background: var(--accent-surface); border: 1px solid var(--accent); border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--accent); margin-bottom: 12px;">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                </div>
                <h3 style="font-size: 20px; font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">VideoForge <span style="font-size: 12px; font-family: var(--font-mono); color: var(--accent); font-weight: 600; vertical-align: middle;">v1.0.0</span></h3>
                <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">Professional Video Processing & AI Upscaling Workstation</p>

                <div style="background: var(--bg-panel-dark); border: 1px solid var(--border-default); border-radius: var(--radius); padding: 16px; text-align: left; margin-bottom: 20px; font-size: 12px; line-height: 1.6; color: var(--text-secondary);">
                    <p style="margin-bottom: 10px;">
                        <strong style="color: var(--text-primary);">👨‍💻 Developed By:</strong> <span style="color: var(--accent); font-weight: 600;">Soubhik Sadhu</span>
                    </p>
                    <p style="margin-bottom: 10px;">
                        <strong style="color: var(--text-primary);">🎬 Built For Legacy Media:</strong> Specifically designed to transcode and recover <strong>old/legacy video files</strong> (such as <code>.dat</code>, <code>.vob</code>, <code>.flv</code>, <code>.3gp</code>, <code>.avi</code>, <code>.mpeg</code>) that are not supported or fail to open in modern editors like <strong>Adobe Premiere Pro</strong> or <strong>After Effects</strong>.
                    </p>
                    <p style="margin-bottom: 0;">
                        <strong style="color: var(--text-primary);">💖 Free & Open Source:</strong> VideoForge is completely free to use! If you encounter any bugs or want to enhance functionality, feel free to create a pull request or contribute to the project.
                    </p>
                </div>

                <div style="display: flex; align-items: center; justify-content: center; gap: 10px;">
                    <a href="https://github.com/SoubhLance/VideoForge" target="_blank" rel="noopener noreferrer" class="vf-btn vf-btn-primary" style="display: inline-flex; align-items: center; gap: 8px; text-decoration: none; padding: 9px 20px; font-size: 13px;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
                        GitHub: SoubhLance/VideoForge
                    </a>
                </div>
            </div>
            <div class="vf-modal-footer">
                <button class="vf-btn vf-btn-secondary vf-modal-cancel" type="button">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.vf-modal-close').addEventListener('click', closeActiveModal);
    modal.querySelector('.vf-modal-cancel').addEventListener('click', closeActiveModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeActiveModal(); });
}

// ─── Helpers ────────────────────────────────────────────────
function showError(msg) {
    if (errorText) errorText.textContent = msg;
    if (errorBox) errorBox.classList.add('show');
}

function hideError() {
    if (errorBox) errorBox.classList.remove('show');
}

function resetUI() {
    hideError();
    hideWarning();
    if (doneBox) doneBox.classList.remove('show');
    if (progressWrap) progressWrap.classList.remove('show');
    if (convertBtn) { convertBtn.style.display = ''; convertBtn.disabled = true; }
    probeData = null;
}

function resetAll() {
    currentFileId = null;
    resetUI();
    if (fileInfoPanel) fileInfoPanel.classList.remove('show');
    if (dropZone) dropZone.style.display = '';
    if (fileInput) fileInput.value = '';

    // Reset video preview
    if (videoPlayer) {
        videoPlayer.pause();
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
        videoPlayer.style.display = 'none';
    }
    if (monitorOverlay) monitorOverlay.style.display = '';
    if (monitorPlayBtn) monitorPlayBtn.style.display = '';
    if (monitorPauseBtn) monitorPauseBtn.style.display = 'none';
    if (timelineScrub) timelineScrub.style.width = '0%';
    if (timelineHead) timelineHead.style.left = '0%';
    if (timecodeEl) timecodeEl.textContent = '00:00:00 / 00:00:00';

    // Revoke object URL
    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
    }
}

// ─── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', (e) => {
    // Ctrl+O => Import
    if (e.ctrlKey && e.key === 'o') {
        e.preventDefault();
        fileInput.click();
    }
    // Ctrl+E => Export/Convert
    if (e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        if (convertBtn && !convertBtn.disabled) startConvert();
    }
    // Ctrl+N => New/Clear
    if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        resetAll();
    }
    // Escape => close menus & active modals
    if (e.key === 'Escape') {
        document.dispatchEvent(new Event('click'));
        closeFolderBrowser();
        closeActiveModal();
    }
});

// ─── Sidebar navigation & Actions ──────────────────────────
document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        const action = item.dataset.action || item.textContent.trim().toLowerCase();
        handleSidebarAction(action);
    });
});

function handleSidebarAction(action) {
    switch (action) {
        case 'media':
            if (fileInfoPanel && fileInfoPanel.classList.contains('show')) {
                fileInfoPanel.scrollIntoView({ behavior: 'smooth' });
                showToast('Viewing active media workstation');
            } else {
                if (dropZone) dropZone.scrollIntoView({ behavior: 'smooth' });
                fileInput.click();
            }
            break;

        case 'queue':
            const queueEl = document.querySelector('.footer-bar');
            if (queueEl) {
                queueEl.scrollIntoView({ behavior: 'smooth' });
                queueEl.classList.add('glow-pulse');
                setTimeout(() => queueEl.classList.remove('glow-pulse'), 1500);
            }
            showToast('Encode Queue monitor focused');
            break;

        case 'presets':
            openPresetsModal();
            break;

        case 'convert':
            const inspector = document.querySelector('.inspector');
            if (inspector) inspector.scrollIntoView({ behavior: 'smooth' });
            if (currentFileId) {
                if (convertBtn) {
                    convertBtn.classList.add('glow-pulse');
                    setTimeout(() => convertBtn.classList.remove('glow-pulse'), 1500);
                }
                showToast('Export Settings focused. Click START EXPORT to process.');
            } else {
                showToast('Please import a media asset first to start conversion');
                if (dropZone) dropZone.classList.add('glow-pulse');
                setTimeout(() => dropZone && dropZone.classList.remove('glow-pulse'), 1500);
            }
            break;

        case 'upscale':
            upscaleOn = true;
            if (upscaleRow) upscaleRow.classList.add('on');
            if (upscaleOptions) upscaleOptions.classList.add('show');
            const upscaleEl = document.getElementById('upscaleRow');
            if (upscaleEl) {
                upscaleEl.scrollIntoView({ behavior: 'smooth' });
                upscaleEl.classList.add('glow-pulse');
                setTimeout(() => upscaleEl.classList.remove('glow-pulse'), 1500);
            }
            showToast('Neural Super-Resolution AI enabled');
            break;

        case 'history':
            openHistoryModal();
            break;

        case 'recent':
            openRecentModal();
            break;

        case 'settings':
            openSettingsModal();
            break;

        default:
            break;
    }
}

// ─── Workspace Modal Dialogs ────────────────────────────────
function closeActiveModal() {
    const activeModal = document.getElementById('vfActiveModal');
    if (activeModal) activeModal.remove();
}

function openPresetsModal() {
    closeActiveModal();

    const modal = document.createElement('div');
    modal.className = 'vf-modal-overlay';
    modal.id = 'vfActiveModal';

    modal.innerHTML = `
        <div class="vf-modal vf-modal-md">
            <div class="vf-modal-header">
                <div class="vf-modal-title">⚡ Quick Presets Library</div>
                <button class="vf-modal-close" type="button">✕</button>
            </div>
            <div class="vf-modal-body">
                <p class="vf-modal-desc">Choose a pre-configured production preset to instantly optimize export settings:</p>
                <div class="vf-preset-grid">
                    <div class="vf-preset-card" data-fmt="mp4" data-res="1920x1080" data-qual="high" data-deinterlace="true">
                        <div class="preset-badge master">PREMIERE PRO</div>
                        <div class="preset-name">🎬 Premiere / After Effects Ready</div>
                        <div class="preset-desc">MP4 H.264 • 1080p • YADIF Deinterlaced • Fixes legacy VCD/DAT/VOB for Adobe timeline</div>
                    </div>
                    <div class="vf-preset-card" data-fmt="mp4" data-res="1280x720" data-qual="medium">
                        <div class="preset-badge">FAST</div>
                        <div class="preset-name">🌐 Web Optimized</div>
                        <div class="preset-desc">MP4 H.264 • 720p • Balanced bitrate for web streaming</div>
                    </div>
                    <div class="vf-preset-card" data-fmt="mp4" data-res="3840x2160" data-qual="high">
                        <div class="preset-badge ultra">4K ULTRA</div>
                        <div class="preset-name">📺 4K UHD Workstation</div>
                        <div class="preset-desc">MP4 H.264 • 3840x2160 • Pristine 4K resolution master</div>
                    </div>
                    <div class="vf-preset-card" data-fmt="mp3" data-res="source" data-qual="high">
                        <div class="preset-badge">AUDIO</div>
                        <div class="preset-name">🎵 Extract 320k MP3 Audio</div>
                        <div class="preset-desc">MP3 Audio • 320 kbps High Bitrate • Fast audio extraction</div>
                    </div>
                    <div class="vf-preset-card" data-fmt="wav" data-res="source" data-qual="high">
                        <div class="preset-badge">STUDIO</div>
                        <div class="preset-name">🔊 Extract Lossless WAV Audio</div>
                        <div class="preset-desc">WAV Audio • 16-bit PCM Uncompressed • Studio master audio</div>
                    </div>
                    <div class="vf-preset-card" data-fmt="gif" data-res="source" data-qual="medium">
                        <div class="preset-badge">ANIMATION</div>
                        <div class="preset-name">🖼️ High-FPS GIF</div>
                        <div class="preset-desc">Animated GIF • Lanczos palette • Loopable playback</div>
                    </div>
                    <div class="vf-preset-card" data-fmt="mkv" data-res="source" data-qual="high">
                        <div class="preset-badge">ARCHIVE</div>
                        <div class="preset-name">📦 MKV Lossless Container</div>
                        <div class="preset-desc">Matroska MKV • Source Resolution • Uncompressed multi-track</div>
                    </div>
                </div>
            </div>
            <div class="vf-modal-footer">
                <button class="vf-btn vf-btn-secondary vf-modal-cancel" type="button">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.vf-modal-close').addEventListener('click', closeActiveModal);
    modal.querySelector('.vf-modal-cancel').addEventListener('click', closeActiveModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeActiveModal(); });

    modal.querySelectorAll('.vf-preset-card').forEach(card => {
        card.addEventListener('click', () => {
            applyPreset(card.dataset.fmt, card.dataset.res, card.dataset.qual, card.dataset.deinterlace === 'true');
            closeActiveModal();
        });
    });
}

function openHistoryModal() {
    closeActiveModal();

    const history = getHistory();
    const modal = document.createElement('div');
    modal.className = 'vf-modal-overlay';
    modal.id = 'vfActiveModal';

    let historyRows = '';
    if (history.length === 0) {
        historyRows = `<tr><td colspan="6" class="vf-empty-cell">No past conversion history recorded yet.</td></tr>`;
    } else {
        historyRows = history.map((item) => `
            <tr>
                <td class="vf-cell-name"><strong>${item.name}</strong></td>
                <td><span class="status-tag status-ready">${item.format}</span></td>
                <td>${formatBytes(item.outputSize)}</td>
                <td>${item.conversionTime}s</td>
                <td>${item.date} ${item.timestamp}</td>
                <td>
                    ${item.id ? `<button class="vf-mini-btn" onclick="window.location.href='${API}/api/download/${item.id}'">⬇ Download</button>` : '—'}
                </td>
            </tr>
        `).join('');
    }

    modal.innerHTML = `
        <div class="vf-modal vf-modal-lg">
            <div class="vf-modal-header">
                <div class="vf-modal-title">📜 Conversion History</div>
                <button class="vf-modal-close" type="button">✕</button>
            </div>
            <div class="vf-modal-body">
                <div class="vf-table-wrap">
                    <table class="vf-table">
                        <thead>
                            <tr>
                                <th>Asset Name</th>
                                <th>Format</th>
                                <th>Export Size</th>
                                <th>Time</th>
                                <th>Completed</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${historyRows}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="vf-modal-footer">
                <button class="vf-btn vf-btn-danger" id="vfPurgeCacheBtn" type="button" style="background: var(--warning); border-color: var(--warning); color: #000; font-weight: 600;">🧹 Clear Cache & Free Space</button>
                ${history.length > 0 ? `<button class="vf-btn vf-btn-danger" id="vfClearHistBtn" type="button">Clear History</button>` : ''}
                <button class="vf-btn vf-btn-secondary vf-modal-cancel" type="button">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.vf-modal-close').addEventListener('click', closeActiveModal);
    modal.querySelector('.vf-modal-cancel').addEventListener('click', closeActiveModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeActiveModal(); });

    const clearBtn = modal.querySelector('#vfClearHistBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearHistory();
            openHistoryModal();
            showToast('Conversion history cleared');
        });
    }

    const purgeCacheBtn = modal.querySelector('#vfPurgeCacheBtn');
    if (purgeCacheBtn) {
        purgeCacheBtn.addEventListener('click', () => {
            clearServerCache();
        });
    }
}

function openRecentModal() {
    closeActiveModal();

    const recent = getRecent();
    const modal = document.createElement('div');
    modal.className = 'vf-modal-overlay';
    modal.id = 'vfActiveModal';

    let recentRows = '';
    if (recent.length === 0) {
        recentRows = `<tr><td colspan="4" class="vf-empty-cell">No recent imported media assets found.</td></tr>`;
    } else {
        recentRows = recent.map(item => `
            <tr>
                <td class="vf-cell-name"><strong>${item.name}</strong></td>
                <td>${formatBytes(item.size)}</td>
                <td>${item.timestamp}</td>
                <td>
                    <span class="status-tag status-ready">LOADED</span>
                </td>
            </tr>
        `).join('');
    }

    modal.innerHTML = `
        <div class="vf-modal vf-modal-md">
            <div class="vf-modal-header">
                <div class="vf-modal-title">📂 Recent Assets</div>
                <button class="vf-modal-close" type="button">✕</button>
            </div>
            <div class="vf-modal-body">
                <div class="vf-table-wrap">
                    <table class="vf-table">
                        <thead>
                            <tr>
                                <th>File Name</th>
                                <th>Size</th>
                                <th>Imported At</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${recentRows}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="vf-modal-footer">
                ${recent.length > 0 ? `<button class="vf-btn vf-btn-danger" id="vfClearRecentBtn" type="button">Clear Recent</button>` : ''}
                <button class="vf-btn vf-btn-primary" id="vfImportNewBtn" type="button">Import New Media</button>
                <button class="vf-btn vf-btn-secondary vf-modal-cancel" type="button">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.vf-modal-close').addEventListener('click', closeActiveModal);
    modal.querySelector('.vf-modal-cancel').addEventListener('click', closeActiveModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeActiveModal(); });

    const importNew = modal.querySelector('#vfImportNewBtn');
    if (importNew) {
        importNew.addEventListener('click', () => {
            closeActiveModal();
            fileInput.click();
        });
    }

    const clearBtn = modal.querySelector('#vfClearRecentBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearRecent();
            openRecentModal();
            showToast('Recent assets cleared');
        });
    }
}

function openSettingsModal() {
    closeActiveModal();

    const currentPath = customOutputDir || (pathTextEl ? pathTextEl.textContent : '/outputs/exports');
    const modal = document.createElement('div');
    modal.className = 'vf-modal-overlay';
    modal.id = 'vfActiveModal';

    modal.innerHTML = `
        <div class="vf-modal vf-modal-md">
            <div class="vf-modal-header">
                <div class="vf-modal-title">⚙️ System & Workspace Settings</div>
                <button class="vf-modal-close" type="button">✕</button>
            </div>
            <div class="vf-modal-body">
                <div class="vf-settings-group">
                    <label class="control-label">EXPORT OUTPUT DIRECTORY</label>
                    <div class="path-selection-box">
                        <span class="path-text" id="settingPathText">${currentPath}</span>
                        <button class="path-browse-btn" id="settingBrowseBtn" type="button">Choose…</button>
                    </div>
                </div>

                <div class="vf-settings-group">
                    <label class="control-label">HARDWARE ACCELERATION & AI STATUS</label>
                    <div class="vf-status-box">
                        <div class="vf-status-line">
                            <span>FFmpeg Engine:</span>
                            <span class="status-tag status-ready">DETECTED & READY</span>
                        </div>
                        <div class="vf-status-line" style="margin-top: 6px;">
                            <span>Real-ESRGAN AI Acceleration:</span>
                            <span class="status-tag ${aiAvailable ? 'status-ready' : 'status-off'}">${aiAvailable ? 'GPU ACCELERATED' : 'UNAVAILABLE (FFmpeg Fallback Active)'}</span>
                        </div>
                    </div>
                </div>

                <div class="vf-settings-group">
                    <label class="control-label">WORKFLOW PREFERENCES</label>
                    <div class="vf-checkbox-row">
                        <input type="checkbox" id="prefAutoPlay" checked>
                        <label for="prefAutoPlay">Automatically load video into monitor preview on import</label>
                    </div>
                </div>
            </div>
            <div class="vf-modal-footer">
                <button class="vf-btn vf-btn-primary" id="vfSaveSettingsBtn" type="button">Save Settings</button>
                <button class="vf-btn vf-btn-secondary vf-modal-cancel" type="button">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.vf-modal-close').addEventListener('click', closeActiveModal);
    modal.querySelector('.vf-modal-cancel').addEventListener('click', closeActiveModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeActiveModal(); });

    modal.querySelector('#settingBrowseBtn').addEventListener('click', () => {
        openFolderBrowser();
    });

    modal.querySelector('#vfSaveSettingsBtn').addEventListener('click', () => {
        closeActiveModal();
        showToast('Settings saved successfully');
    });
}

// ─── Output Path / Folder Browser ──────────────────────────
let customOutputDir = null;
const pathTextEl = document.querySelector('.path-text');
const pathBrowseBtn = document.querySelector('.path-browse-btn');

if (pathBrowseBtn) {
    pathBrowseBtn.addEventListener('click', openFolderBrowser);
}

function openFolderBrowser() {
    // Remove existing modal
    closeFolderBrowser();

    const modal = document.createElement('div');
    modal.className = 'folder-browser-overlay';
    modal.id = 'folderBrowserModal';

    modal.innerHTML = `
        <div class="folder-browser-modal">
            <div class="fb-header">
                <span class="fb-title">Select Output Directory</span>
                <button class="fb-close-btn" type="button">✕</button>
            </div>
            <div class="fb-path-bar">
                <button class="fb-up-btn" type="button" title="Go up">⬆</button>
                <input class="fb-path-input" type="text" spellcheck="false" />
                <button class="fb-go-btn" type="button">Go</button>
            </div>
            <div class="fb-drives-bar" id="fbDrivesBar"></div>
            <div class="fb-dir-list" id="fbDirList">
                <div class="fb-loading">Loading...</div>
            </div>
            <div class="fb-footer">
                <button class="fb-select-btn" type="button">Select This Folder</button>
                <button class="fb-cancel-btn" type="button">Cancel</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Wire up events
    modal.querySelector('.fb-close-btn').addEventListener('click', closeFolderBrowser);
    modal.querySelector('.fb-cancel-btn').addEventListener('click', closeFolderBrowser);
    modal.querySelector('.fb-select-btn').addEventListener('click', selectCurrentFolder);
    modal.querySelector('.fb-up-btn').addEventListener('click', goUpFolder);
    modal.querySelector('.fb-go-btn').addEventListener('click', () => {
        const input = modal.querySelector('.fb-path-input');
        browseTo(input.value);
    });
    modal.querySelector('.fb-path-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') browseTo(e.target.value);
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeFolderBrowser();
    });

    // Start browsing at current output path or default
    const startPath = customOutputDir || (navigator.platform.includes('Win') ? 'D:\\' : '/');
    browseTo(startPath);
}

let currentBrowsePath = '';

async function browseTo(dirPath) {
    const modal = document.getElementById('folderBrowserModal');
    if (!modal) return;

    const dirList = modal.querySelector('#fbDirList');
    const pathInput = modal.querySelector('.fb-path-input');
    const drivesBar = modal.querySelector('#fbDrivesBar');

    dirList.innerHTML = '<div class="fb-loading"><span class="spinner"></span> Loading...</div>';

    try {
        const res = await fetch(`${API}/api/browse-dirs?path=${encodeURIComponent(dirPath)}`);
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to browse');
        }
        const data = await res.json();

        currentBrowsePath = data.current;
        pathInput.value = data.current;

        // Render drives bar
        if (data.drives && data.drives.length > 0) {
            drivesBar.innerHTML = data.drives.map(d =>
                `<button class="fb-drive-btn" data-path="${d.path}">${d.name}</button>`
            ).join('');
            drivesBar.querySelectorAll('.fb-drive-btn').forEach(btn => {
                btn.addEventListener('click', () => browseTo(btn.dataset.path));
            });
            drivesBar.style.display = 'flex';
        } else {
            drivesBar.style.display = 'none';
        }

        // Render dirs
        if (data.current === 'This PC' || data.current === 'ROOT') {
            if (data.drives && data.drives.length > 0) {
                dirList.innerHTML = data.drives.map(d =>
                    `<div class="fb-dir-item" data-path="${d.path.replace(/\\/g, '\\\\')}">
                        <span class="fb-dir-icon">💽</span>
                        <span class="fb-dir-name">${d.name} (${d.path})</span>
                    </div>`
                ).join('');

                dirList.querySelectorAll('.fb-dir-item').forEach(item => {
                    item.addEventListener('dblclick', () => browseTo(item.dataset.path));
                    item.addEventListener('click', () => {
                        dirList.querySelectorAll('.fb-dir-item').forEach(i => i.classList.remove('selected'));
                        item.classList.add('selected');
                        pathInput.value = item.dataset.path;
                        currentBrowsePath = item.dataset.path;
                    });
                });
            } else {
                dirList.innerHTML = '<div class="fb-empty">No system drives found</div>';
            }
        } else if (data.dirs.length === 0) {
            dirList.innerHTML = '<div class="fb-empty">No subdirectories</div>';
        } else {
            dirList.innerHTML = data.dirs.map(d =>
                `<div class="fb-dir-item" data-path="${d.path.replace(/\\/g, '\\\\')}">
                    <span class="fb-dir-icon">📁</span>
                    <span class="fb-dir-name">${d.name}</span>
                </div>`
            ).join('');

            dirList.querySelectorAll('.fb-dir-item').forEach(item => {
                item.addEventListener('dblclick', () => browseTo(item.dataset.path));
                item.addEventListener('click', () => {
                    dirList.querySelectorAll('.fb-dir-item').forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    pathInput.value = item.dataset.path;
                    currentBrowsePath = item.dataset.path;
                });
            });
        }

    } catch (err) {
        dirList.innerHTML = `<div class="fb-error">Error: ${err.message}</div>`;
    }
}

function goUpFolder() {
    const modal = document.getElementById('folderBrowserModal');
    if (!modal) return;
    const pathInput = modal.querySelector('.fb-path-input');
    const current = pathInput.value;

    if (!current || current === 'This PC' || current === 'ROOT') {
        return;
    }

    // Check if current is root drive like 'D:\' or 'D:' or 'C:\'
    if (navigator.platform.includes('Win') && /^[A-Z]:[\\/]?$/i.test(current.trim())) {
        browseTo('ROOT');
        return;
    }

    // Go up one level
    const parent = current.replace(/[\\/][^\\/]+[\\/]?$/, '');
    if (!parent || parent === current || /^[A-Z]:$/i.test(parent)) {
        browseTo('ROOT');
    } else {
        browseTo(parent.endsWith(':') ? parent + '\\' : parent);
    }
}

async function selectCurrentFolder() {
    if (!currentBrowsePath || currentBrowsePath === 'This PC' || currentBrowsePath === 'ROOT') {
        showToast('Please select a valid drive or directory');
        return;
    }

    try {
        const res = await fetch(`${API}/api/set-output-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outputDir: currentBrowsePath })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to set output path');
        }

        const data = await res.json();
        customOutputDir = data.path;
        if (pathTextEl) pathTextEl.textContent = data.path;
        showToast(`Output directory set: ${data.path}`);
        closeFolderBrowser();

    } catch (err) {
        showToast(`Error: ${err.message}`);
    }
}

function closeFolderBrowser() {
    const modal = document.getElementById('folderBrowserModal');
    if (modal) modal.remove();
}

function openFaqModal() {
    closeActiveModal();

    const modal = document.createElement('div');
    modal.className = 'vf-modal-overlay';
    modal.id = 'vfActiveModal';

    modal.innerHTML = `
        <div class="vf-modal vf-modal-lg">
            <div class="vf-modal-header">
                <div class="vf-modal-title">❓ General FAQ & Troubleshooting Guide</div>
                <button class="vf-modal-close" type="button">✕</button>
            </div>
            <div class="vf-modal-body" style="padding: 24px;">
                <div class="vf-faq-list" style="display: flex; flex-direction: column; gap: 16px;">
                    <div class="vf-faq-item" style="background: var(--bg-panel-dark); border: 1px solid var(--border-default); border-radius: var(--radius); padding: 16px;">
                        <h4 style="color: var(--accent); font-size: 14px; font-weight: 700; margin-bottom: 6px;">Q: Why won't .dat / .vob files open in Adobe Premiere Pro or After Effects?</h4>
                        <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.5;">
                            Modern Adobe software dropped native support for legacy MPEG-1/2 formats (.dat, .vob, .3gp, .flv). VideoForge transcodes these raw video streams into standardized H.264 MP4 with Rec.709 color profile, making them 100% timeline compatible!
                        </p>
                    </div>

                    <div class="vf-faq-item" style="background: var(--bg-panel-dark); border: 1px solid var(--border-default); border-radius: var(--radius); padding: 16px;">
                        <h4 style="color: var(--accent); font-size: 14px; font-weight: 700; margin-bottom: 6px;">Q: How does Neural Super-Resolution AI Upscaling work?</h4>
                        <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.5;">
                            VideoForge utilizes Real-ESRGAN NCNN Vulkan running directly on your dedicated GPU (NVIDIA / AMD). It extracts video frames, reconstructs missing high-frequency details, sharpens edges, and upscales 352x288 / 480p videos to crisp 1080p or 4K resolution.
                        </p>
                    </div>

                    <div class="vf-faq-item" style="background: var(--bg-panel-dark); border: 1px solid var(--border-default); border-radius: var(--radius); padding: 16px;">
                        <h4 style="color: var(--accent); font-size: 14px; font-weight: 700; margin-bottom: 6px;">Q: What is YADIF Deinterlacing and when should I use it?</h4>
                        <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.5;">
                            YADIF (Yet Another Deinterlacing Filter) removes horizontal comb lines found in old VHS tapes, VCDs (.dat), and DVDs (.vob). Enable the <strong>Deinterlace (YADIF 60fps)</strong> checkbox whenever processing interlaced video rips.
                        </p>
                    </div>

                    <div class="vf-faq-item" style="background: var(--bg-panel-dark); border: 1px solid var(--border-default); border-radius: var(--radius); padding: 16px;">
                        <h4 style="color: var(--accent); font-size: 14px; font-weight: 700; margin-bottom: 6px;">Q: How do I extract audio without video?</h4>
                        <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.5;">
                            Select <strong>MP3</strong>, <strong>WAV</strong>, <strong>AAC</strong>, or <strong>FLAC</strong> in the CONTAINER / FORMAT section. VideoForge will instantly extract the audio track without re-encoding video.
                        </p>
                    </div>

                    <div class="vf-faq-item" style="background: var(--bg-panel-dark); border: 1px solid var(--border-default); border-radius: var(--radius); padding: 16px;">
                        <h4 style="color: var(--accent); font-size: 14px; font-weight: 700; margin-bottom: 6px;">Q: How do I back out of drive D:\ in the folder browser?</h4>
                        <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.5;">
                            Click the <strong>⬆ (Go up)</strong> button at the root of drive D:\ to return to <strong>This PC</strong>, which lists all available drive letters (C:\, D:\, E:\, etc.). You can also use the drive shortcut buttons at the top.
                        </p>
                    </div>
                </div>
            </div>
            <div class="vf-modal-footer">
                <button class="vf-btn vf-btn-secondary vf-modal-cancel" type="button">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.vf-modal-close').addEventListener('click', closeActiveModal);
    modal.querySelector('.vf-modal-cancel').addEventListener('click', closeActiveModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeActiveModal(); });
}

