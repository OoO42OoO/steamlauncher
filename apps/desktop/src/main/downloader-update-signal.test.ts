/**
 * The launch update-check asks DepotDownloader "has this game changed?" and
 * used to read the answer off the wrong line.
 *
 * DD prints `Downloading depot N` for every depot it processes, on every run,
 * before it has looked at a single file. Reading that as "an update exists"
 * meant the confirmation dialog appeared on every launch of every game —
 * including immediately after the user had accepted an update.
 *
 * The transcripts below are real lines from this project's own logs. The
 * accounting across them is exact: every processed depot either reports its
 * manifest is already cached, or fetches a new one. That is the signal.
 */
import { describe, expect, it } from 'vitest';

/** Kept in step with downloader.ts by the transcript tests below. */
const MANIFEST_FETCH_RE = /^\s*Downloading depot \d+\s+manifest/i;

/** What the update-check would conclude from a run's output. */
function updateDetected(transcript: string[]): boolean {
  return transcript.some((line) => MANIFEST_FETCH_RE.test(line));
}

// Left 4 Dead 2, already current. The middle line is why this game must not
// prompt; the last line is why it used to.
const UP_TO_DATE = [
  'Using app branch: public.',
  'Processing depot 475552',
  'Already have manifest 4580279904639415577 for depot 475552.',
  'Downloading depot 475552',
  'Validating d:\\launcher\\475550\\game.exe',
  'Depot 475552 - Downloaded 0 bytes (0 bytes uncompressed)',
  'Total downloaded: 0 bytes (0 bytes uncompressed) from 1 depots',
];

// The same game when Steam has actually shipped something.
const HAS_UPDATE = [
  'Using app branch: public.',
  'Processing depot 475552',
  'Downloading depot 475552 manifest',
  'Downloading depot 475552',
  'Pre-allocating d:\\launcher\\475550\\game.exe',
  'Depot 475552 - Downloaded 81421 bytes (204800 bytes uncompressed)',
  'Total downloaded: 81421 bytes (204800 bytes uncompressed) from 1 depots',
];

describe('update-check signal', () => {
  it('says no update when every depot manifest is already cached', () => {
    expect(updateDetected(UP_TO_DATE)).toBe(false);
  });

  it('says update when a depot manifest has to be fetched', () => {
    expect(updateDetected(HAS_UPDATE)).toBe(true);
  });

  it('is not fooled by the bare per-depot header', () => {
    // The exact line the old rule matched. On its own it means nothing.
    expect(updateDetected(['Downloading depot 475552'])).toBe(false);
  });

  it('fires before any file is touched, so the user can still be asked', () => {
    const fetchAt = HAS_UPDATE.findIndex((l) => MANIFEST_FETCH_RE.test(l));
    const firstFileWrite = HAS_UPDATE.findIndex((l) => /^Pre-allocating/i.test(l));
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeLessThan(firstFileWrite);
  });

  it('accounts for every processed depot in a multi-depot run', () => {
    // Arma 3: some depots unchanged, one updated. Nothing falls between the
    // two cases — which is what makes the signal trustworthy.
    const transcript = [
      'Processing depot 107411',
      'Already have manifest 8681622824861525347 for depot 107411.',
      'Downloading depot 107411',
      'Processing depot 107413',
      'Downloading depot 107413 manifest',
      'Downloading depot 107413',
      'Processing depot 228990',
      'Already have manifest 1829726630299308803 for depot 228990.',
      'Downloading depot 228990',
    ];
    const processed = transcript.filter((l) => /^Processing depot/i.test(l)).length;
    const cached = transcript.filter((l) => /^Already have manifest/i.test(l)).length;
    const fetched = transcript.filter((l) => MANIFEST_FETCH_RE.test(l)).length;
    expect(cached + fetched).toBe(processed);
    expect(updateDetected(transcript)).toBe(true);
  });

  it('matches the regex the downloader actually uses', async () => {
    // Guards against the two drifting apart — the whole bug was a rule that
    // no longer meant what its name said.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('./downloader.ts', import.meta.url),
      'utf8'
    );
    expect(src).toContain('const MANIFEST_FETCH_RE = ' + MANIFEST_FETCH_RE.toString());
  });
});
