/**
 * Pure parser for DepotDownloader stdout. Kept free of subprocess/IO so it
 * can be unit-tested without spawning DD.
 *
 * For multi-depot apps (Civilization V, etc.) DepotDownloader prints depots
 * sequentially, and percent resets to 0 between them. Without classifying
 * lines into stages the UI shows a percent that "jumps backwards" with no
 * explanation. This parser turns each line into a typed event the caller
 * can apply to its progress state.
 */
import type { DownloadStage } from '@steam-client/shared';

export interface DdParserState {
  phase: DownloadStage['phase'];
  /** Set of depot ids we've seen `Got depot key for X` for — gives total. */
  knownDepots: Set<number>;
  /** How many depots have started processing so far (1-based current). */
  processedDepots: number;
  /** Latest depot label (last `Processing depot N - <name>` we observed). */
  currentLabel: string | undefined;
  /** Total advertised by DD if it printed `N depots` somewhere. */
  hintTotal: number | undefined;
}

export function makeDdState(): DdParserState {
  return {
    phase: 'connecting',
    knownDepots: new Set(),
    processedDepots: 0,
    currentLabel: undefined,
    hintTotal: undefined,
  };
}

export type DdEvent =
  /** Stage changed; caller should forward this in onProgress. */
  | { type: 'stage'; stage: DownloadStage }
  /** A new depot just started — reset percent throttle so 0% reaches the UI. */
  | { type: 'depot_transition'; stage: DownloadStage }
  /** Percent line for the current depot. */
  | { type: 'percent'; percent: number }
  /** DD asked for the password — caller should write it to stdin. */
  | { type: 'password_prompt' }
  /** DD asked for Steam Guard — caller should generate a TOTP. */
  | { type: 'guard_prompt' }
  /** Recognised fatal error in the line — kill DD with this code. */
  | { type: 'fatal'; code: string };

/**
 * Inspect a single trimmed stdout line and return what it means. Mutates
 * `state` for cumulative info (depot keys seen, current label, etc.).
 *
 * Multiple events from one line aren't supported — DD lines are atomic.
 * Unknown / decorative lines return null.
 */
export function parseDdLine(line: string, state: DdParserState): DdEvent | null {
  // ── Fatal patterns first (we want to short-circuit before anything else). ──

  if (/InvalidPassword|Logon failed|Invalid login|invalid account/i.test(line)) {
    return { type: 'fatal', code: 'invalid_credentials' };
  }
  if (/RateLimit|too many login attempts|rate[ _-]?limit/i.test(line)) {
    return { type: 'fatal', code: 'rate_limited' };
  }
  if (/account name or password that you have entered is incorrect/i.test(line)) {
    return { type: 'fatal', code: 'invalid_credentials' };
  }
  if (/no licenses|You don.?t own this/i.test(line)) {
    return { type: 'fatal', code: 'no_license' };
  }
  // DD surfaces ENOSPC as "There is not enough space on the disk." (Steam's
  // .NET runtime message) on Windows, and as `IOException: No space left
  // on device` on Linux/macOS. We match both phrasings so the renderer
  // can surface the dedicated `disk_full` label instead of the generic
  // "Download failed" line.
  if (
    /not enough space on the disk|no space left on(?: the)? device|disk full/i.test(
      line
    )
  ) {
    return { type: 'fatal', code: 'disk_full' };
  }

  // ── Interactive prompts. ──

  if (/Enter account password/i.test(line)) {
    return { type: 'password_prompt' };
  }
  if (
    /Steam Guard code required|TwoFactor|Steam Guard|two-factor|enter the current code|authenticator/i.test(
      line
    )
  ) {
    return { type: 'guard_prompt' };
  }

  // ── Stage transitions. ──

  // "Logging 'username' into Steam..." or similar — login phase begins.
  if (/Logging .+ into Steam|Connecting to Steam|Connecting to Steam servers/i.test(line)) {
    if (state.phase === 'connecting') {
      state.phase = 'authenticating';
      return { type: 'stage', stage: snapshot(state) };
    }
    return null;
  }

  // "Got <N> licenses for app ..." — logged in, manifest fetch starts.
  // Also "Got app info for X" / "Loading depot config" land here.
  if (/Got \d+ licenses?|Got app info|Loading depot config|Got (?:CDN|app) info/i.test(line)) {
    if (state.phase !== 'fetching_manifest' && state.phase !== 'downloading') {
      state.phase = 'fetching_manifest';
      return { type: 'stage', stage: snapshot(state) };
    }
    return null;
  }

  // "Got depot key for 8930 result OK" — count depots so we can show "1 / 5".
  // No event, just bookkeeping. Total reaches the UI on the next stage event.
  const keyMatch = /Got depot key for (\d+)/i.exec(line);
  if (keyMatch && keyMatch[1]) {
    state.knownDepots.add(Number(keyMatch[1]));
    return null;
  }

  // "Processing depot 8930 - Sid Meier's Civilization V Content"
  //                           ^name optional, sometimes just the id appears.
  const procMatch = /^\s*Processing depot (\d+)(?:\s*[-:]\s*(.+?))?\s*$/i.exec(line);
  if (procMatch) {
    state.processedDepots += 1;
    state.currentLabel = procMatch[2]?.trim() || undefined;
    state.phase = 'downloading';
    return { type: 'depot_transition', stage: snapshot(state) };
  }

  // "Downloading depot 8930 - Civ V Content" — alternative wording from
  // different DD versions. Treat as transition if we haven't already seen
  // a Processing line for it.
  const dlMatch = /^\s*Downloading depot (\d+)(?:\s*[-:]\s*(.+?))?\s*$/i.exec(line);
  if (dlMatch) {
    if (state.phase !== 'downloading') {
      state.processedDepots = Math.max(state.processedDepots, 1);
      state.currentLabel = dlMatch[2]?.trim() || state.currentLabel;
      state.phase = 'downloading';
      return { type: 'depot_transition', stage: snapshot(state) };
    }
    return null;
  }

  // "Validating Sid Meier's Civilization V Content" — verification of an
  // already-downloaded depot. Percent will reset for this stage.
  const valMatch = /^\s*Validating(?:\s+depot)?\s+(.+?)\s*$/i.exec(line);
  if (valMatch && valMatch[1] && !/^\.{2,}$/.test(valMatch[1])) {
    const label = valMatch[1].trim();
    state.currentLabel = label;
    state.phase = 'validating';
    return { type: 'depot_transition', stage: snapshot(state) };
  }

  // "Total downloaded: 4.2 GB ..." — last line; about to exit.
  if (/Total downloaded|Total bytes downloaded|Depot download(?:\s+complete)?\s*:/i.test(line)) {
    if (state.phase !== 'finalizing') {
      state.phase = 'finalizing';
      return { type: 'stage', stage: snapshot(state) };
    }
    return null;
  }

  // ── Percent lines. Recognise both "12.3%" and " 12% done" shapes. ──
  const pctMatch = /(\d+(?:\.\d+)?)\s*%/.exec(line);
  if (pctMatch && pctMatch[1]) {
    const percent = Math.max(0, Math.min(100, parseFloat(pctMatch[1])));
    return { type: 'percent', percent };
  }

  return null;
}

function snapshot(state: DdParserState): DownloadStage {
  // Only include current/total when we're in a per-depot phase.
  const inDepotPhase = state.phase === 'downloading' || state.phase === 'validating';
  if (!inDepotPhase) {
    return { phase: state.phase };
  }
  const total =
    state.knownDepots.size > 0
      ? Math.max(state.knownDepots.size, state.processedDepots)
      : state.hintTotal ?? state.processedDepots;
  const stage: DownloadStage = { phase: state.phase };
  if (state.currentLabel) stage.label = state.currentLabel;
  if (state.processedDepots >= 1) stage.current = state.processedDepots;
  if (total >= 1) stage.total = total;
  return stage;
}
