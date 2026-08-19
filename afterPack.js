/**
 * electron-builder afterPack hook
 * 
 * Stamps the packaged VideoForge.exe with correct Windows PE metadata
 * (icon, FileDescription, ProductName, CompanyName, etc.) using rcedit.
 * 
 * This is necessary because signAndEditExecutable must be set to false
 * (the winCodeSign package extraction fails due to symlink permission
 * issues on Windows), which means electron-builder skips its built-in
 * rcedit step. We do it manually here instead.
 */
const path = require('path');
const { rcedit } = require('rcedit');

module.exports = async function afterPack(context) {
    // Only edit the exe on Windows builds
    if (context.electronPlatformName !== 'win32') {
        return;
    }

    const exePath = path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.exe`
    );

    const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');

    console.log(`  • branding executable with rcedit  path=${exePath}`);

    await rcedit(exePath, {
        icon: iconPath,
        'version-string': {
            FileDescription: 'VideoForge',
            ProductName: 'VideoForge',
            CompanyName: 'VideoForge',
            InternalName: 'VideoForge',
            OriginalFilename: 'VideoForge.exe',
            LegalCopyright: 'Copyright © 2024-2026 VideoForge. All rights reserved.',
        },
        'file-version': '1.0.0',
        'product-version': '1.0.0',
    });

    console.log('  • executable branding complete');
};
