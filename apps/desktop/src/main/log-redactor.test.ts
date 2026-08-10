import { describe, expect, it } from 'vitest';
import { redactObject, redactString } from './log-redactor';

describe('redactObject', () => {
  it('redacts sensitive keys regardless of case', () => {
    const input = {
      user: 'alice',
      password: 'hunter2',
      Email_Password: 'mail',
      nested: { refresh_token: 'xyz', ok: 'visible' },
    };
    const out = redactObject(input) as Record<string, unknown>;
    expect(out.user).toBe('alice');
    expect(out.password).toBe('[REDACTED]');
    expect(out.Email_Password).toBe('[REDACTED]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.refresh_token).toBe('[REDACTED]');
    expect(nested.ok).toBe('visible');
  });

  it('does not false-match keys that merely contain sensitive substrings', () => {
    const input = { loginUrl: 'https://site.example/auth', passwordPolicy: 'strict' };
    const out = redactObject(input) as Record<string, unknown>;
    expect(out.loginUrl).toBe('https://site.example/auth');
    expect(out.passwordPolicy).toBe('strict');
  });

  it('handles arrays and stops at max depth without throwing', () => {
    const deep: { x?: unknown; password?: string } = {};
    let cur: Record<string, unknown> = deep;
    for (let i = 0; i < 10; i++) {
      const next: Record<string, unknown> = {};
      cur.x = next;
      cur = next;
    }
    cur.password = 'secret';
    expect(() => redactObject({ list: [deep, { password: 'x' }] })).not.toThrow();
  });
});

describe('redactString', () => {
  it('redacts JWT-shaped tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signatureXYZ_abcDEF';
    expect(redactString(`auth: ${jwt} done`)).toBe('auth: [REDACTED] done');
  });

  it('redacts Bearer <token>', () => {
    const out = redactString('Authorization: Bearer abc.def_GHI-12345678');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abc.def_GHI');
  });

  it('redacts key=value pairs for known keys', () => {
    const out = redactString('login attempted with user=bob password=hunter2 next');
    expect(out).toContain('password=[REDACTED]');
    expect(out).not.toContain('hunter2');
  });

  it('redacts JSON-style "key":"value"', () => {
    const out = redactString('{"user":"alice","password":"hunter2"}');
    expect(out).toContain('"password":"[REDACTED]"');
    expect(out).not.toContain('hunter2');
  });
});
