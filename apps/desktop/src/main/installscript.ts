/**
 * Steam `installscript.vdf` parsing.
 *
 * DepotDownloader pulls the per-redist `installscript.vdf` Valve ships in
 * every `_CommonRedist/<family>/<version>/` folder. It's the authoritative
 * description of what to run and how — the exact process path, the exact
 * silent command line, and OS requirements — so we drive redist install
 * from it instead of guessing flags from the installer filename.
 *
 * Example (VC++ 2013):
 *   "InstallScript"
 *   {
 *     "Run Process"
 *     {
 *       "x64 12.0.30501"
 *       {
 *         "process 1" "%INSTALLDIR%\\_CommonRedist\\vcredist\\2013\\vcredist_x64.exe"
 *         "command 1" "/quiet /norestart"
 *         "Requirement_OS" { "Is64BitWindows" "1" }
 *       }
 *     }
 *   }
 *
 * We implement a small VDF (KeyValues) reader rather than pull a dep — the
 * format is a handful of token types and we only read a few keys.
 */

/** A parsed KeyValues node: string leaf or nested map. Keys are lowercased
 *  for case-insensitive access (Valve mixes "InstallScript"/"installscript",
 *  "Run Process"/"run process"). */
export type VdfNode = string | { [key: string]: VdfNode };

/**
 * Parse VDF/KeyValues text into a nested object. Quoted keys/values,
 * `{}` nesting, `//` line comments. Duplicate keys: last wins (installscript
 * numbers its repeats — "process 1", "process 2" — so real collisions don't
 * occur in the subset we read). Throws on malformed input.
 */
export function parseVdf(text: string): { [key: string]: VdfNode } {
  let i = 0;
  const n = text.length;

  const skipWs = (): void => {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        i++;
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else {
        break;
      }
    }
  };

  const readQuoted = (): string => {
    // assumes text[i] === '"'
    i++; // opening quote
    let out = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < n) {
        // VDF escapes: \\ \" \n \t — keep it simple, pass through common ones.
        const next = text[i + 1];
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        i += 2;
      } else {
        out += text[i];
        i++;
      }
    }
    i++; // closing quote
    return out;
  };

  const readToken = (): string => {
    // Unquoted bareword (rare in installscript, but tolerate it).
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '{' || c === '}' || c === '"') break;
      out += c;
      i++;
    }
    return out;
  };

  const parseObject = (isRoot: boolean): { [key: string]: VdfNode } => {
    const obj: { [key: string]: VdfNode } = {};
    for (;;) {
      skipWs();
      if (i >= n) {
        if (isRoot) break;
        throw new Error('unexpected EOF inside object');
      }
      if (text[i] === '}') {
        i++;
        break;
      }
      // Read key.
      const key = (text[i] === '"' ? readQuoted() : readToken()).toLowerCase();
      if (key === '') throw new Error(`empty key at ${i}`);
      skipWs();
      if (i >= n) throw new Error('unexpected EOF after key');
      if (text[i] === '{') {
        i++;
        obj[key] = parseObject(false);
      } else {
        obj[key] = text[i] === '"' ? readQuoted() : readToken();
      }
    }
    return obj;
  };

  return parseObject(true);
}

export interface RunProcess {
  /** Sub-block name, e.g. "x64 12.0.30501" / "dxsetup" — used for logs. */
  name: string;
  /** Absolute installer path, with %INSTALLDIR% already substituted. */
  process: string;
  /** Silent command line, split into argv. */
  args: string[];
}

/**
 * Extract the runnable processes from a parsed installscript, resolving
 * `%INSTALLDIR%` and filtering by OS requirement.
 *
 * `is64BitWindows` gates blocks carrying `Requirement_OS/Is64BitWindows=1`
 * (the x64 redist entries) — on a 32-bit host they're skipped, matching
 * what Steam itself does.
 */
export function extractRunProcesses(
  root: { [key: string]: VdfNode },
  installDir: string,
  is64BitWindows: boolean
): RunProcess[] {
  // Top key is "installscript" (any case). Descend into it, then "run process".
  const script = root['installscript'];
  if (!script || typeof script === 'string') return [];
  const runProc = script['run process'];
  if (!runProc || typeof runProc === 'string') return [];

  const out: RunProcess[] = [];
  for (const [name, block] of Object.entries(runProc)) {
    if (typeof block !== 'object') continue;

    // OS gate: skip x64-only entries on a 32-bit host.
    const req = block['requirement_os'];
    if (req && typeof req === 'object') {
      const needs64 = req['is64bitwindows'];
      if (needs64 === '1' && !is64BitWindows) continue;
    }

    // Collect "process N" + matching "command N" pairs (N starts at 1).
    for (let idx = 1; ; idx++) {
      const proc = block[`process ${idx}`];
      if (typeof proc !== 'string') break;
      const cmd = block[`command ${idx}`];
      const resolved = proc.replace(/%INSTALLDIR%/gi, installDir);
      out.push({
        name,
        process: resolved,
        args: typeof cmd === 'string' ? splitArgs(cmd) : [],
      });
    }
  }
  return out;
}

/** Split a command line into argv on whitespace. installscript command
 *  lines are simple flag strings ("/quiet /norestart") — no quoting to
 *  worry about in practice, but we drop empty runs defensively. */
function splitArgs(cmd: string): string[] {
  return cmd
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}
