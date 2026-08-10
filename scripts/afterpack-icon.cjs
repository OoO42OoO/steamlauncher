#!/usr/bin/env node
// afterpack-icon.cjs — electron-builder `afterPack` hook that stamps the
// app icon, per-monitor DPI manifest, and version info into
// Steam Client.exe.
//
// Why a hook and not a post-build script: afterPack runs after
// electron-builder lays out dist/win-unpacked but BEFORE it packs that
// directory into the NSIS installer and the portable zip. Patching the
// exe here means every artifact ships the branded executable. (The old
// scripts/postbuild-icon.ps1 ran after packaging, so the installer and
// zip kept the stock Electron icon — and running rcedit directly on the
// NSIS installer stripped its appended payload, corrupting it.)
//
// Why rcedit from tools/ and not electron-builder's own resource edit:
// `signAndEditExecutable` drives the edit through winCodeSign, whose 7z
// archive is full of POSIX symlinks that fail to unpack on Windows dev
// accounts without SeCreateSymbolicLinkPrivilege / Dev Mode.

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const repoRoot = resolve(__dirname, '..');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  if (process.platform !== 'win32') {
    // rcedit only ships a Windows binary. A cross-build from Linux would
    // ship the default Electron icon — make that loud, not silent.
    console.warn(
      '[afterpack-icon] WARNING: non-Windows host — cannot run rcedit, ' +
        'the packaged exe keeps the default Electron icon',
    );
    return;
  }

  const rcedit = join(repoRoot, 'tools', 'rcedit-x64.exe');
  if (!existsSync(rcedit)) {
    console.log('[afterpack-icon] rcedit missing, fetching via scripts/fetch-rcedit.ps1');
    const fetch = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts', 'fetch-rcedit.ps1')],
      { stdio: 'inherit' },
    );
    if (fetch.status !== 0 || !existsSync(rcedit)) {
      throw new Error(`[afterpack-icon] rcedit not available at ${rcedit}`);
    }
  }

  const iconPath = join(repoRoot, 'apps', 'desktop', 'build', 'icon.ico');
  const manifestPath = join(repoRoot, 'apps', 'desktop', 'build', 'app.manifest');
  for (const p of [iconPath, manifestPath]) {
    if (!existsSync(p)) throw new Error(`[afterpack-icon] missing: ${p}`);
  }

  const appInfo = context.packager.appInfo;
  const exePath = join(context.appOutDir, `${appInfo.productFilename}.exe`);
  if (!existsSync(exePath)) {
    throw new Error(`[afterpack-icon] executable not found: ${exePath}`);
  }

  console.log(`[afterpack-icon] stamping icon + manifest + version -> ${exePath}`);
  const result = spawnSync(
    rcedit,
    [
      exePath,
      '--set-icon', iconPath,
      '--application-manifest', manifestPath,
      // Brand the exe version-info (Windows: Properties → Details) as
      // "Steam Launcher" regardless of the internal productName, which stays
      // "Steam Client" so the install dir / appId / auto-update identity are
      // untouched. No the API anywhere in what the user sees.
      '--set-version-string', 'ProductName', 'Steam Launcher',
      '--set-version-string', 'FileDescription', 'Steam Launcher',
      '--set-version-string', 'CompanyName', 'Steam Launcher',
      '--set-version-string', 'LegalCopyright', '© Steam Launcher',
      '--set-file-version', appInfo.buildVersion,
      '--set-product-version', appInfo.version,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`[afterpack-icon] rcedit failed (exit ${result.status})`);
  }
};
