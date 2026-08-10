/**
 * Install Chrome / Edge Native Messaging host manifests on app start.
 *
 * Chrome looks for a JSON manifest under a per-OS, per-browser directory
 * (POSIX) or a registry key (Windows) and uses it to find + spawn a
 * launcher executable when the extension calls
 * `chrome.runtime.sendNativeMessage('com.steam_client.token', ...)`.
 *
 * Layout we install:
 *   - host.js (the actual node script) is shipped in extraResources at
 *     `<resources>/native-messaging-host/host.js`. In dev it lives at
 *     `apps/desktop/native-messaging-host/host.js` inside the repo.
 *   - We synthesize a tiny launcher next to host.js so the manifest's
 *     "path" can be a single executable: host.sh (POSIX) / host.bat
 *     (Windows). The launcher exec's Electron's bundled node-equivalent
 *     (process.execPath when ELECTRON_RUN_AS_NODE=1) on host.js.
 *   - Manifest is written per-browser (Chrome / Chromium / Edge) on
 *     POSIX; on Windows we drop a single manifest under userData and
 *     point Chrome+Edge registry keys at it.
 *
 * Allowed extension origins are hardcoded for known IDs and additionally
 * accept STEAM_CLIENT_EXT_IDS env (comma-separated) for unpacked dev
 * loads. Until we have a stable production extension ID baked into the
 * official build, this env override is the operator-facing knob.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import log from 'electron-log/main.js';

const execFileAsync = promisify(execFile);

export const HOST_NAME = 'com.steam_client.token';

interface BrowserTarget {
  id: string;
  manifestDir: string;
}

function browsersForPlatform(): BrowserTarget[] {
  const home = os.homedir();
  if (process.platform === 'linux') {
    return [
      { id: 'chrome', manifestDir: path.join(home, '.config/google-chrome/NativeMessagingHosts') },
      { id: 'chromium', manifestDir: path.join(home, '.config/chromium/NativeMessagingHosts') },
      { id: 'edge', manifestDir: path.join(home, '.config/microsoft-edge/NativeMessagingHosts') },
    ];
  }
  if (process.platform === 'darwin') {
    return [
      {
        id: 'chrome',
        manifestDir: path.join(
          home,
          'Library/Application Support/Google/Chrome/NativeMessagingHosts'
        ),
      },
      {
        id: 'chromium',
        manifestDir: path.join(
          home,
          'Library/Application Support/Chromium/NativeMessagingHosts'
        ),
      },
      {
        id: 'edge',
        manifestDir: path.join(
          home,
          'Library/Application Support/Microsoft Edge/NativeMessagingHosts'
        ),
      },
    ];
  }
  // Windows: registry-based; manifest dir is irrelevant.
  return [];
}

/**
 * Resolve the on-disk path of host.js for the current run mode.
 *   - Packaged app: copied via electron-builder extraResources to
 *     `<resources>/native-messaging-host/host.js`.
 *   - `pnpm dev`: `app.getAppPath()` already points at `apps/desktop` (that's
 *     where Electron is launched from in the monorepo), so we just join the
 *     relative path under it. The previous `apps/desktop/native-messaging-host/...`
 *     prefix produced a doubled segment in dev mode.
 */
export function hostScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'native-messaging-host', 'host.js');
  }
  return path.join(app.getAppPath(), 'native-messaging-host', 'host.js');
}

/**
 * Write a tiny launcher that exec's Electron's bundled node on host.js.
 * Returns the path of the launcher (which becomes `path` in the manifest).
 *
 * On POSIX we use `ELECTRON_RUN_AS_NODE=1 <execPath>` to coerce the
 * Electron binary into pure-node mode — this avoids depending on a
 * system-installed Node.js, which is not guaranteed on user machines.
 * On Windows the same trick works via .bat.
 */
/**
 * Write the per-platform launcher next to host.js. Returns null on
 * permission failure — packaged Windows builds extracted to a read-only
 * Program Files location can't write into resources/, and we'd rather
 * skip native-messaging install than crash whenReady. Caller treats null
 * as "skip the rest of the install".
 */
function writeLauncher(hostPath: string): string | null {
  const dir = path.dirname(hostPath);
  if (process.platform === 'win32') {
    const launcher = path.join(dir, 'host.bat');
    const content =
      `@echo off\r\n` +
      `set "ELECTRON_RUN_AS_NODE=1"\r\n` +
      `"${process.execPath}" "${hostPath}" %*\r\n`;
    try {
      fs.writeFileSync(launcher, content);
    } catch (err) {
      log.warn('[native-messaging] write launcher failed', launcher, (err as Error).message);
      return null;
    }
    return launcher;
  }
  const launcher = path.join(dir, 'host.sh');
  const content =
    `#!/bin/sh\n` +
    `ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${hostPath}" "$@"\n`;
  try {
    fs.writeFileSync(launcher, content, { mode: 0o755 });
  } catch (err) {
    log.warn('[native-messaging] write launcher failed', launcher, (err as Error).message);
    return null;
  }
  return launcher;
}

function resolveAllowedExtensionIds(extra: string[]): string[] {
  const fromEnv = (process.env.STEAM_CLIENT_EXT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const all = [...new Set([...extra, ...fromEnv])];
  if (all.length === 0) {
    log.warn(
      '[native-messaging] no extension IDs configured — manifest installed without allowed_origins. ' +
        'Set STEAM_CLIENT_EXT_IDS=<id1,id2> and restart to enable extension pairing.'
    );
  }
  return all;
}

/**
 * Idempotent: overwrites the manifest on every call. Safe to invoke at
 * every app start. Failures per-browser are logged, never thrown — a user
 * without Edge installed should still get the Chrome manifest.
 */
export async function installNativeMessagingManifests(
  extensionIds: string[] = []
): Promise<void> {
  const hostPath = hostScriptPath();
  if (!fs.existsSync(hostPath)) {
    log.error('[native-messaging] host script missing at', hostPath);
    return;
  }

  // POSIX: keep host.js +x. Defensive — extraResources copy preserves
  // mode but a manual zip extract may not.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(hostPath, 0o755);
    } catch (err) {
      log.warn('[native-messaging] chmod host.js failed', err);
    }
  }

  const launcherPath = writeLauncher(hostPath);
  if (!launcherPath) {
    log.warn('[native-messaging] launcher write failed; skipping manifest install');
    return;
  }
  const allowedIds = resolveAllowedExtensionIds(extensionIds);

  const manifest = {
    name: HOST_NAME,
    description: 'Steam Client token bridge',
    path: launcherPath,
    type: 'stdio' as const,
    allowed_origins: allowedIds.map((id) => `chrome-extension://${id}/`),
  };

  if (process.platform === 'win32') {
    // Stage manifest under userData. Registry value = full path. Mkdir +
    // write are wrapped: an EACCES here (corrupted ACL on userData before
    // the icacls reset finishes) would otherwise abort whenReady.
    const stagingDir = path.join(app.getPath('userData'), 'native-messaging');
    let manifestFile: string;
    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      manifestFile = path.join(stagingDir, `${HOST_NAME}.json`);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    } catch (err) {
      log.warn(
        '[native-messaging] failed to stage manifest under userData; skipping registry install',
        stagingDir,
        (err as Error).message
      );
      return;
    }

    const regKeys = [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
    ];
    for (const key of regKeys) {
      try {
        await execFileAsync('reg.exe', ['ADD', key, '/ve', '/d', manifestFile, '/f']);
      } catch (err) {
        log.warn('[native-messaging] reg.exe ADD failed for', key, (err as Error).message);
      }
    }
    log.info('[native-messaging] manifest installed (Windows)', manifestFile);
    return;
  }

  for (const browser of browsersForPlatform()) {
    try {
      fs.mkdirSync(browser.manifestDir, { recursive: true });
      fs.writeFileSync(
        path.join(browser.manifestDir, `${HOST_NAME}.json`),
        JSON.stringify(manifest, null, 2)
      );
      log.info(`[native-messaging] installed manifest for ${browser.id} →`, browser.manifestDir);
    } catch (err) {
      log.warn(`[native-messaging] manifest install for ${browser.id} failed`, err);
    }
  }
}

/**
 * Build the manifest object without writing — used by tests for shape
 * assertions. Kept public so we don't have to copy the construction
 * logic into the test file.
 */
export function buildManifest(launcherPath: string, extensionIds: string[]) {
  return {
    name: HOST_NAME,
    description: 'Steam Client token bridge',
    path: launcherPath,
    type: 'stdio' as const,
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
}
