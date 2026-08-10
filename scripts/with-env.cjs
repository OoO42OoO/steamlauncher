#!/usr/bin/env node
/**
 * Run a command with the repository's .env loaded.
 *
 * The service endpoints are deployment configuration and are not written down
 * in the tree; the build takes them from the environment. electron-vite reads
 * .env itself, but electron-builder expands `${env.X}` from the real process
 * environment and fails the build outright if a referenced variable is
 * missing — so packaging has to be launched with the file already loaded.
 *
 * Values already exported win, so CI can override the file without editing it.
 *
 * Usage: node scripts/with-env.cjs <command> [args...]
 */
const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');

/** Minimal .env reader: KEY=value, `#` comments, optional surrounding quotes. */
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = match[2].trim().replace(/^["']|["']$/g, '');
  }
}

loadEnvFile(resolve(ROOT, 'apps/desktop/.env'));
loadEnvFile(resolve(ROOT, '.env'));

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('with-env: nothing to run');
  process.exit(2);
}

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('with-env: failed to start', command, '-', err.message);
  process.exit(1);
});
