import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import log from 'electron-log/main.js';

/**
 * Synchronous shadow log: every electron-log write is mirrored to a
 * dedicated `main-sync.log` via `appendFileSync` so the trail survives a
 * hard native crash (SIGKILL, segfault, OOM) where the in-memory queue
 * of `electron-log`'s file transport is lost. The two writes are made in
 * the same tick; if the sync append throws (disk full, ACL) we swallow
 * it — losing the mirror entry is strictly better than losing the
 * process trying to recover logging.
 *
 * The monkey-patch is installed once at module load; subsequent calls
 * to `log.info/warn/error/debug` go through the wrapped functions
 * transparently.
 */
let shadowPath: string | null = null;
let installed = false;

function safeStringify(data: unknown): string {
  if (data === undefined) return '';
  if (data instanceof Error) return ` ${data.message}${data.stack ? `\n${data.stack}` : ''}`;
  if (typeof data === 'string') return ` ${data}`;
  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ` [unstringifiable]`;
  }
}

function formatLine(level: string, args: unknown[]): string {
  const ts = new Date().toISOString();
  // electron-log signature: log.<level>(message, ...args). Some call sites
  // pass multiple positional args (e.g. log.info('foo', someObj, 'bar')) —
  // mirror the same shape: textual args joined, last object kept as data.
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean') return String(a);
    if (a === null || a === undefined) return '';
    return safeStringify(a).trimStart();
  });
  const msg = parts.join(' ').trimEnd();
  return `[${ts}] [${level}] ${msg}\n`;
}

function writeShadow(level: string, args: unknown[]): void {
  if (!shadowPath) return;
  try {
    appendFileSync(shadowPath, formatLine(level, args), 'utf8');
  } catch {
    // Don't let a logging failure cascade into another crash.
  }
}

export function installSyncLog(logsDir: string): void {
  if (installed) return;
  installed = true;
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    // Best-effort; if mkdir fails, syncPath stays null and we no-op.
  }
  shadowPath = join(logsDir, 'main-sync.log');

  // Pre-pend a session marker so post-mortem analysis can split crashes
  // by run without parsing timestamps.
  try {
    appendFileSync(
      shadowPath,
      `\n=== session start pid=${process.pid} v=${process.versions.electron} node=${process.versions.node} ${new Date().toISOString()} ===\n`,
      'utf8'
    );
  } catch {
    // ignore
  }

  const wrap = (level: 'info' | 'warn' | 'error' | 'debug' | 'verbose' | 'silly') => {
    const original = log[level].bind(log);
    (log as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
      writeShadow(level, args);
      return original(...args);
    };
  };

  wrap('info');
  wrap('warn');
  wrap('error');
  wrap('debug');
  wrap('verbose');
  wrap('silly');
}

/** Direct synchronous write that bypasses electron-log entirely — useful
 * for points where we want a guaranteed-on-disk breadcrumb even before
 * `installSyncLog` runs (early init, pre-app-ready hooks). */
export function syncBreadcrumb(msg: string, data?: unknown): void {
  if (!shadowPath) return;
  try {
    appendFileSync(shadowPath, formatLine('breadcrumb', [msg, data]), 'utf8');
  } catch {
    // ignore
  }
}