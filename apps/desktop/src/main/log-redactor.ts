import log from 'electron-log/main.js';
import type { LogMessage } from 'electron-log';

/**
 * Keys whose values must never reach log files or remote logging.
 * Matched case-insensitively against object keys and against substrings in
 * formatted strings.
 */
const SENSITIVE_KEYS = [
  'password',
  'email_password',
  'email_login',
  'login', // account login is effectively sensitive here
  'shared_secret',
  'identity_secret',
  'revocation_code',
  'steam_mafile_plain',
  'refreshtoken',
  'accesstoken',
  'access_token',
  'refresh_token',
  'twofactorcode',
  'two_factor_code',
  'bearer',
  'authorization',
  'secret_1',
  'device_id',
];

const REDACTED = '[REDACTED]';

export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    // Exact-match the key-name against the allow-list so `loginUrl` is
    // NOT mistakenly redacted (prior version used substring match).
    if (SENSITIVE_KEYS.includes(lower)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactObject(v, depth + 1);
    }
  }
  return out;
}

// Any of these, when they appear as a key in `key=value`, `key:value`,
// or `"key":"value"` style strings, has its value wiped.
// `authorization` and `bearer` are intentionally absent: the Bearer regex
// below handles HTTP auth headers, and listing them here would cause the
// key=value regex to overwrite `Bearer [REDACTED]` with `authorization=[REDACTED]`
// and lose the recognisable shape.
const KEY_PATTERN = new RegExp(
  '\\b(' +
    [
      'password',
      'email_password',
      'email_login',
      'shared_secret',
      'identity_secret',
      'revocation_code',
      'steam_mafile_plain',
      'refresh_?token',
      'access_?token',
      'twofactor_?code',
      'two_factor_code',
      'secret_1',
      'device_id',
      'token_gid',
      'serial_number',
    ].join('|') +
    ')\\b',
  'i'
);

export function redactString(s: string): string {
  let out = s;
  // JWT-shaped tokens: eyJ... three base64url chunks.
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED);
  // Authorization: Bearer <opaque>
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ' + REDACTED);
  // JSON-like: "key":"value"  → "key":"[REDACTED]"
  out = out.replace(
    new RegExp(`"(${KEY_PATTERN.source.slice(2, -2)})"\\s*:\\s*"[^"]*"`, 'gi'),
    `"$1":"${REDACTED}"`
  );
  // key=value and key: value (query strings, log lines, stringified errors).
  out = out.replace(
    new RegExp(`(${KEY_PATTERN.source.slice(2, -2)})\\s*[=:]\\s*([^\\s&"',;}\\])]+)`, 'gi'),
    `$1=${REDACTED}`
  );
  return out;
}

/**
 * Installs a global hook on electron-log that redacts sensitive fields from
 * every message body before any transport writes it.
 * Call once from main bootstrap.
 */
export function installLogRedactor(): void {
  log.hooks.push((msg: LogMessage): LogMessage => {
    const out = msg.data.map((item: unknown) => {
      if (typeof item === 'string') return redactString(item);
      if (item && typeof item === 'object') return redactObject(item);
      return item;
    });
    return { ...msg, data: out };
  });
  // Remote transport must stay off regardless.
  log.transports.remote.level = false;
}
