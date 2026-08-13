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
            aiBadge.textContent = aiAvailable ? 'AI Ready' : 'AI Unavailable';
            aiBadge.classList.toggle('ai-ready', aiAvailable);
            aiBadge.classList.toggle('ai-off', !aiAvailable);
        }
    } catch (e) {
        aiAvailable = false;
    }
}
checkAIStatus();

// ─── Drag & Drop ────────────────────────────────────────────
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
    dropZone.addEventListener('click', (e) => {
        // Don't trigger if clicking the Import Media button (it handles itself)
        if (e.target.classList.contains('import-btn')) return;
        fileInput.click();
    });
}

if (fileInput) {
    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) uploadFile(fileInput.files[0]);
    });
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
            { label: 'Import Media…', icon: '📂', action: () => fileInput.click() },
            { label: 'separator' },
            { label: 'Export Current Job', icon: '💾', action: () => { if (convertBtn && !convertBtn.disabled) startConvert(); }, disabled: () => !currentFileId },
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

// ─── Video Preview Player ───────────────────────────────────
function setupVideoPreview(file) {
    if (!videoPlayer) return;

    // Revoke old blob URL
    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
    }

    currentObjectUrl = URL.createObjectURL(file);
    videoPlayer.src = currentObjectUrl;
    videoPlayer.style.display = 'block';
    if (monitorOverlay) monitorOverlay.style.display = 'none';

    videoPlayer.addEventListener('loadedmetadata', () => {
        updateTimecode(0, videoPlayer.duration);
    });

    videoPlayer.addEventListener('timeupdate', () => {
        const pct = (videoPlayer.currentTime / videoPlayer.duration) * 100;
        if (timelineScrub) timelineScrub.style.width = pct + '%';
        if (timelineHead) timelineHead.style.left = pct + '%';
        updateTimecode(videoPlayer.currentTime, videoPlayer.duration);
    });

    videoPlayer.addEventListener('ended', () => {
        if (monitorPlayBtn) monitorPlayBtn.style.display = '';
        if (monitorPauseBtn) monitorPauseBtn.style.display = 'none';
    });
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

        // Probe file
        probeInfoEl.innerHTML = '<div class="probe-loading"><span class="spinner"></span> Analyzing video metadata…</div>';

        const probeRes = await fetch(`${API}/api/probe/${data.id}`);
        if (!probeRes.ok) {
            const err = await probeRes.json();
            throw new Error(err.error || 'Failed to analyze file');
        }

        probeData = await probeRes.json();
        renderProbeInfo(probeData);

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
    probeInfoEl.innerHTML = html;
}

function probeItem(label, value) {
    return `<div class="probe-item"><div class="probe-label">${label}</div><div class="probe-value">${value}</div></div>`;
}

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

    try {
        const body = {
            id: currentFileId,
            format: selectedFormat,
            resolution: document.getElementById('resSelect').value,
            quality: document.getElementById('qualSelect').value,
            upscale: upscaleOn,
            upscaleMode: selectedScale,
            aiUpscale: isAIUpscale,
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

function listenProgress(fileId) {
    const evtSource = new EventSource(`${API}/api/progress/${fileId}`);

    evtSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.status === 'queued' || data.status === 'converting') {
            const pct = data.progress || 0;
            progressBar.style.width = pct + '%';
            progressPct.textContent = pct + '%';

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
function applyPreset(format, resolution, quality) {
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
    showToast('VideoForge v2.1.0 — Professional Video Processing Workstation');
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
    // Escape => close menus
    if (e.key === 'Escape') {
        document.dispatchEvent(new Event('click'));
        closeFolderBrowser();
    }
});

// ─── Sidebar navigation ────────────────────────────────────
document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
    });
});

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

        // Render drives
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
        if (data.dirs.length === 0) {
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
    // Go up one level
    const parent = current.replace(/[\\/][^\\/]+[\\/]?$/, '') || (navigator.platform.includes('Win') ? 'C:\\' : '/');
    browseTo(parent);
}

async function selectCurrentFolder() {
    if (!currentBrowsePath) return;

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

