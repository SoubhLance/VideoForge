const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const serverModule = require('./server');

// Set Windows App User Model ID so Task Manager / Taskbar shows "VideoForge"
app.setAppUserModelId('com.videoforge.app');

let mainWindow = null;
let serverInstance = null;

async function createWindow() {
    let port = process.env.PORT || 3000;
    try {
        serverInstance = await serverModule.start(port);
    } catch (err) {
        console.error('Failed to start embedded server:', err);
    }

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        minWidth: 900,
        minHeight: 650,
        title: 'VideoForge — Video Converter & Upscaler',
        icon: path.join(__dirname, 'build', 'icon.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Remove the extra native Electron top navbar (VideoForge has its own HTML UI navbar)
    mainWindow.setMenu(null);

    // Load web interface from embedded Express server
    mainWindow.loadURL(`http://localhost:${port}`);

    // Open external links in system browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (serverInstance && typeof serverInstance.close === 'function') {
            serverInstance.close();
        }
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
