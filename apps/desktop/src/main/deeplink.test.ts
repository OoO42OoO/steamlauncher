import { describe, expect, it } from 'vitest';
import { parseDeeplink, extractDeeplinkFromArgv } from './deeplink';

describe('parseDeeplink', () => {
  it('extracts code from steam-client://redeem?code=...', () => {
    expect(parseDeeplink('steam-client://redeem?code=ABCDEF')).toBe('ABCDEF');
  });

  it('trims whitespace around the code', () => {
    expect(parseDeeplink('steam-client://redeem?code=%20ABCD%20')).toBe('ABCD');
  });

  it('rejects the legacy password-bearing form', () => {
    expect(
      parseDeeplink('steam-client://login?username=bob&password=aHVudGVyMg==')
    ).toBeNull();
  });

  it('rejects unsupported protocols', () => {
    expect(parseDeeplink('https://example.com/redeem?code=X')).toBeNull();
  });

  it('rejects missing code param', () => {
    expect(parseDeeplink('steam-client://redeem')).toBeNull();
  });

  it('rejects codes longer than 64 chars', () => {
    const code = 'A'.repeat(65);
    expect(parseDeeplink(`steam-client://redeem?code=${code}`)).toBeNull();
  });
});

describe('extractDeeplinkFromArgv', () => {
  it('finds the steam-client:// arg in argv', () => {
    const argv = ['electron', '/path/to/app', 'steam-client://redeem?code=X'];
    expect(extractDeeplinkFromArgv(argv)).toBe('steam-client://redeem?code=X');
  });

  it('returns null when no deeplink arg is present', () => {
    expect(extractDeeplinkFromArgv(['electron', '/app', '--flag'])).toBeNull();
  });
});
