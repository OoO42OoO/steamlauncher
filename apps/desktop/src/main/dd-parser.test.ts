import { describe, expect, it } from 'vitest';
import { makeDdState, parseDdLine } from './dd-parser';

describe('parseDdLine', () => {
  it('starts in connecting phase', () => {
    const s = makeDdState();
    expect(s.phase).toBe('connecting');
  });

  it('transitions to authenticating on Steam connect line', () => {
    const s = makeDdState();
    const ev = parseDdLine("Logging 'foo' into Steam...", s);
    expect(ev).toEqual({
      type: 'stage',
      stage: { phase: 'authenticating' },
    });
    expect(s.phase).toBe('authenticating');
  });

  it('emits password_prompt for the DD password line', () => {
    const s = makeDdState();
    const ev = parseDdLine('Enter account password for foo:', s);
    expect(ev).toEqual({ type: 'password_prompt' });
  });

  it('emits guard_prompt for two-factor lines', () => {
    const s = makeDdState();
    const ev = parseDdLine('Please enter your Steam Guard code:', s);
    expect(ev).toEqual({ type: 'guard_prompt' });
  });

  it('classifies invalid_credentials fatal', () => {
    const s = makeDdState();
    expect(parseDdLine('InvalidPassword', s)).toEqual({
      type: 'fatal',
      code: 'invalid_credentials',
    });
    expect(
      parseDdLine(
        'The account name or password that you have entered is incorrect',
        s
      )
    ).toEqual({ type: 'fatal', code: 'invalid_credentials' });
  });

  it('classifies rate_limited fatal', () => {
    const s = makeDdState();
    expect(parseDdLine('RateLimitExceeded', s)).toEqual({
      type: 'fatal',
      code: 'rate_limited',
    });
  });

  it('classifies no_license fatal', () => {
    const s = makeDdState();
    expect(parseDdLine("You don't own this app", s)).toEqual({
      type: 'fatal',
      code: 'no_license',
    });
  });

  it('classifies disk_full fatal from Windows and POSIX phrasings', () => {
    const s = makeDdState();
    // Steam's .NET runtime message on Windows when the install drive
    // runs out of space mid-download.
    expect(
      parseDdLine(
        'System.IO.IOException: There is not enough space on the disk.',
        s
      )
    ).toEqual({ type: 'fatal', code: 'disk_full' });
    // Mono / .NET Core on Linux/macOS uses the POSIX wording instead.
    expect(
      parseDdLine('IOException: No space left on device', s)
    ).toEqual({ type: 'fatal', code: 'disk_full' });
    // DD may surface this from a logger without the IOException prefix.
    expect(parseDdLine('disk full', s)).toEqual({
      type: 'fatal',
      code: 'disk_full',
    });
  });

  it('moves to fetching_manifest on Got N licenses', () => {
    const s = makeDdState();
    parseDdLine("Logging 'foo' into Steam...", s);
    const ev = parseDdLine('Got 1 licenses for app 8930...', s);
    expect(ev).toEqual({
      type: 'stage',
      stage: { phase: 'fetching_manifest' },
    });
  });

  it('counts depot keys silently and uses them as total later', () => {
    const s = makeDdState();
    parseDdLine('Got 1 licenses for app 8930...', s);
    expect(parseDdLine('Got depot key for 8930 result OK', s)).toBeNull();
    expect(parseDdLine('Got depot key for 8931 result OK', s)).toBeNull();
    expect(parseDdLine('Got depot key for 8932 result OK', s)).toBeNull();
    expect(s.knownDepots.size).toBe(3);

    const ev = parseDdLine(
      "Processing depot 8930 - Sid Meier's Civilization V Content",
      s
    );
    expect(ev).toEqual({
      type: 'depot_transition',
      stage: {
        phase: 'downloading',
        label: "Sid Meier's Civilization V Content",
        current: 1,
        total: 3,
      },
    });
  });

  it('emits depot_transition with current/total even without prior keys', () => {
    const s = makeDdState();
    const ev = parseDdLine('Processing depot 8930 - Civ V', s);
    expect(ev).toEqual({
      type: 'depot_transition',
      stage: {
        phase: 'downloading',
        label: 'Civ V',
        current: 1,
        total: 1,
      },
    });
  });

  it('increments current on each new Processing depot line', () => {
    const s = makeDdState();
    s.knownDepots.add(8930);
    s.knownDepots.add(8931);
    s.knownDepots.add(8932);
    parseDdLine('Processing depot 8930 - A', s);
    parseDdLine('Processing depot 8931 - B', s);
    const ev = parseDdLine('Processing depot 8932 - C', s);
    expect(ev).toEqual({
      type: 'depot_transition',
      stage: {
        phase: 'downloading',
        label: 'C',
        current: 3,
        total: 3,
      },
    });
  });

  it('parses percent lines as percent events with no stage info', () => {
    const s = makeDdState();
    s.phase = 'downloading';
    expect(parseDdLine(' 47.32% done', s)).toEqual({
      type: 'percent',
      percent: 47.32,
    });
  });

  it('clamps percent to 0..100', () => {
    const s = makeDdState();
    s.phase = 'downloading';
    expect(parseDdLine(' 250.0%', s)).toEqual({ type: 'percent', percent: 100 });
    expect(parseDdLine('-5%', s)).toEqual({ type: 'percent', percent: 5 });
    // ^ regex matches digits only, so the leading minus is ignored. Document
    // the actual behaviour here so a future change doesn't accidentally allow
    // negatives via a different path.
  });

  it('moves to validating phase when Validating line appears', () => {
    const s = makeDdState();
    s.knownDepots.add(8930);
    parseDdLine('Processing depot 8930 - Civ V Content', s);
    const ev = parseDdLine('Validating Civ V Content', s);
    expect(ev?.type).toBe('depot_transition');
    if (ev?.type === 'depot_transition') {
      expect(ev.stage.phase).toBe('validating');
      expect(ev.stage.label).toBe('Civ V Content');
    }
  });

  it('classifies "Validating depot N" as validating, not downloading', () => {
    // The launch-time update check depends on this distinction: DD with
    // -validate emits percent during chunk verification under the
    // "Validating" header, and treating that as "real download" used to
    // false-positive an update prompt on every launch (5b75798 follow-up).
    const s = makeDdState();
    const ev = parseDdLine('Validating depot 8930', s);
    expect(ev?.type).toBe('depot_transition');
    if (ev?.type === 'depot_transition') {
      expect(ev.stage.phase).toBe('validating');
    }
    // A subsequent percent line must NOT flip the phase back to downloading.
    parseDdLine(' 50% done', s);
    expect(s.phase).toBe('validating');
  });

  it('classifies "Downloading depot N - name" as downloading (delta pull)', () => {
    const s = makeDdState();
    // Simulate the realistic -validate sequence: chunks are checked first,
    // then DD prints the literal "Downloading depot" line when it decides
    // to fetch delta. The launch flow keys off this exact wording.
    parseDdLine('Validating depot 8930', s);
    const ev = parseDdLine('Downloading depot 8930 - Civ V', s);
    expect(ev?.type).toBe('depot_transition');
    if (ev?.type === 'depot_transition') {
      expect(ev.stage.phase).toBe('downloading');
    }
  });

  it('moves to finalizing on Total downloaded line', () => {
    const s = makeDdState();
    s.phase = 'downloading';
    const ev = parseDdLine('Total downloaded: 4.2 GB', s);
    expect(ev).toEqual({ type: 'stage', stage: { phase: 'finalizing' } });
  });

  it('returns null for unrecognised decorative lines', () => {
    const s = makeDdState();
    expect(parseDdLine('---', s)).toBeNull();
    expect(parseDdLine('STEAM_DUMMY_LINE_THAT_DOES_NOT_EXIST', s)).toBeNull();
  });

  it('does not double-emit stage events for repeated fetching_manifest lines', () => {
    const s = makeDdState();
    parseDdLine('Got 1 licenses for app 8930', s);
    expect(parseDdLine('Got app info for 8930', s)).toBeNull();
    expect(parseDdLine('Loading depot config for 8930', s)).toBeNull();
  });

  it('full Civ V style sequence: connecting → auth → manifest → 3 depots → finalize', () => {
    const s = makeDdState();
    const events: string[] = [];
    const lines = [
      "Logging 'civ_user' into Steam...",
      'Got 1 licenses for app 8930...',
      'Got depot key for 8930 result OK',
      'Got depot key for 8929 result OK',
      'Got depot key for 8931 result OK',
      'Processing depot 8930 - Sid Meier\'s Civilization V Content',
      ' 50% done',
      ' 100% done',
      'Processing depot 8929 - Civilization V - Gods and Kings',
      ' 25% done',
      ' 100% done',
      'Processing depot 8931 - Civilization V - Brave New World',
      ' 100% done',
      'Total downloaded: 7.4 GB',
    ];
    for (const line of lines) {
      const ev = parseDdLine(line, s);
      if (ev) events.push(ev.type);
    }
    // We expect: stage(authenticating), stage(fetching_manifest),
    // depot_transition x3, percent x5, stage(finalizing).
    // depot_keys are silent.
    expect(events.filter((e) => e === 'depot_transition')).toHaveLength(3);
    expect(events).toContain('stage'); // at least one stage event
    expect(s.processedDepots).toBe(3);
    expect(s.knownDepots.size).toBe(3);
    expect(s.phase).toBe('finalizing');
  });
});
