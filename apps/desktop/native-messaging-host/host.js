#!/usr/bin/env node
/**
 * Chrome Native Messaging host for the steam-client extension token bridge.
 *
 * Spawned by Chrome on demand when the extension calls
 *   chrome.runtime.sendNativeMessage('com.steam_client.token', { cmd: 'get_token' })
 *
 * Protocol (Chrome native messaging):
 *   - stdin/stdout exchange length-prefixed JSON: 4-byte little-endian
 *     uint32 length, then UTF-8 payload of that length.
 *   - One request, one response, then exit.
 *
 * On receiving { cmd: 'get_token' } we connect to the Electron main
 * process's IPC socket / Named Pipe (path computed exactly the way main
 * does in `server-token.ts`) and forward the live token back to Chrome.
 *
 * This file is plain JS so it runs under whatever `node` binary the
 * launcher script (host.sh on POSIX, host.bat on Windows) feeds it.
 */
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');

function ipcSocketPath() {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME || 'default';
    return `\\\\.\\pipe\\steam-client.token.${user}`;
  }
  const user = (os.userInfo().username) || 'default';
  return path.join(os.tmpdir(), `steam-client.token.${user}.sock`);
}

function readMessage() {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let bodyLen = -1;

    function tryParse() {
      if (bodyLen < 0 && buf.length >= 4) {
        bodyLen = buf.readUInt32LE(0);
        buf = buf.slice(4);
      }
      if (bodyLen >= 0 && buf.length >= bodyLen) {
        const body = buf.slice(0, bodyLen).toString('utf8');
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
        return true;
      }
      return false;
    }

    process.stdin.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      tryParse();
    });
    process.stdin.on('end', () => {
      if (bodyLen < 0) reject(new Error('no message on stdin'));
    });
    process.stdin.on('error', reject);
  });
}

function writeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function fetchToken() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(ipcSocketPath());
    let buf = '';
    sock.setTimeout(5000);
    sock.on('connect', () => {
      // Single-shot: send any byte, server replies once.
      sock.write('get');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    sock.on('end', () => {
      try {
        const parsed = JSON.parse(buf.trim());
        if (!parsed || typeof parsed.token !== 'string') {
          reject(new Error('malformed ipc response'));
          return;
        }
        resolve(parsed.token);
      } catch (err) {
        reject(err);
      }
    });
    sock.on('timeout', () => {
      try { sock.destroy(); } catch {}
      reject(new Error('ipc timeout'));
    });
    sock.on('error', reject);
  });
}

(async () => {
  try {
    const msg = await readMessage();
    if (msg && msg.cmd === 'get_token') {
      const token = await fetchToken();
      writeMessage({ ok: true, token });
    } else {
      writeMessage({ ok: false, error: 'unknown_cmd' });
    }
  } catch (err) {
    writeMessage({ ok: false, error: String((err && err.message) || err) });
  } finally {
    // Give stdout a tick to flush before exiting. Without this, very
    // small payloads may be lost when Chrome reads.
    setTimeout(() => process.exit(0), 10);
  }
})();
