import { describe, expect, it } from 'vitest';
import type { PublicAccount } from '@steam-client/shared';
import { dedupeByAppid } from './library-dedupe';

/**
 * Build a minimal PublicAccount row for tests. We only need fields the
 * dedupe function inspects (id, appid) plus a couple of fillers so the
 * object satisfies the type — anything else would be noise.
 */
function acct(id: string, appid: number): PublicAccount {
  return {
    id,
    appid,
    game_name: `Game ${appid}`,
    iconUrl: null,
    logoUrl: null,
    min_trust_level: 0,
    locked: false,
    status: 'not_installed',
    downloadPercent: null,
    downloadStage: null,
    guardHint: null,
    downloadError: null,
    downloadErrorPlatforms: null,
    downloadBytesDownloaded: null,
    downloadBytesTotal: null,
  };
}

describe('dedupeByAppid', () => {
  it('returns an empty array unchanged', () => {
    expect(dedupeByAppid([])).toEqual([]);
  });

  it('returns a single-entry array unchanged', () => {
    const one = [acct('acc-1', 420560)];
    expect(dedupeByAppid(one)).toEqual(one);
  });

  it('keeps the first occurrence when several accounts share the same appid', () => {
    // Real case: Arma III owned by an old account (lost access) AND
    // a fresh replacement account (bought again on recovery). The
    // backend returns one row per pool account, so the response has
    // two entries with the same appid. The dedupe must keep exactly
    // one so the catalog and search show a single row.
    const entries = [
      acct('acc-original', 420560),
      acct('acc-replacement', 420560),
    ];
    const result = dedupeByAppid(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('acc-original');
  });

  it('preserves the original order across unique and duplicate appids', () => {
    // Mixed list: three distinct appids plus one duplicate pair.
    // The output must come back in the input's order minus the
    // dropped extras, so any upstream sort that already runs
    // continues to see a stable sequence.
    const entries = [
      acct('a', 100),
      acct('b', 200),
      acct('c', 100), // dup of a
      acct('d', 300),
      acct('e', 200), // dup of b
    ];
    const result = dedupeByAppid(entries);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'd']);
  });

  it('keeps every row when there are no duplicates', () => {
    const entries = [
      acct('a', 100),
      acct('b', 200),
      acct('c', 300),
    ];
    expect(dedupeByAppid(entries)).toHaveLength(3);
  });

  it('collapses three-of-a-kind down to one', () => {
    // If three pool accounts all own Arma III, the result must
    // still be a single row (the first).
    const entries = [
      acct('first', 420560),
      acct('second', 420560),
      acct('third', 420560),
    ];
    const result = dedupeByAppid(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('first');
  });
});
