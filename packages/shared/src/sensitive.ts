/**
 * Branded wrapper for values that must never be serialised, logged, or sent
 * to the renderer. Redacts on every path we can control (JSON.stringify,
 * template-string coercion, util.inspect). Does NOT protect against direct
 * property access — that is by design: `withAccount(id, fn)` grants scoped
 * access, the wrapper only stops accidental leakage.
 */

const REDACTED = '[REDACTED]';

// Symbol.for is used instead of require('util').inspect.custom so this module
// stays usable in renderer / preload bundles (where 'util' isn't available).
const NODE_INSPECT = Symbol.for('nodejs.util.inspect.custom');

export interface Sensitive<T> {
  /** Read the underlying value. Call sites MUST be short-lived. */
  readonly value: T;
  /** Best-effort zeroing. For strings this only drops the reference. */
  wipe(): void;
}

class SensitiveImpl<T> implements Sensitive<T> {
  private _value: T | null;

  constructor(v: T) {
    this._value = v;
  }

  get value(): T {
    if (this._value === null) {
      throw new Error('Sensitive value already wiped');
    }
    return this._value;
  }

  wipe(): void {
    const v = this._value as unknown;
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v as object)) {
        try {
          (v as Record<string, unknown>)[k] = null;
        } catch {
          // frozen / getter-only — best effort
        }
      }
    }
    this._value = null;
  }

  toJSON(): string {
    return REDACTED;
  }
  toString(): string {
    return REDACTED;
  }
  [NODE_INSPECT](): string {
    return REDACTED;
  }
}

export function sensitive<T>(v: T): Sensitive<T> {
  return new SensitiveImpl(v);
}

/**
 * Scoped access pattern: guarantees wipe() runs even if fn throws.
 * Use this anywhere a plaintext credential temporarily leaves the vault.
 */
export async function withSensitive<T, R>(
  v: T,
  fn: (value: T) => Promise<R> | R
): Promise<R> {
  const s = sensitive(v);
  try {
    return await fn(s.value);
  } finally {
    s.wipe();
  }
}
