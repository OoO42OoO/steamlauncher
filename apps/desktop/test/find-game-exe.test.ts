import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findGameExe } from '../src/main/find-game-exe';

let dir: string;

function writeExe(path: string, sizeMB: number): void {
  writeFileSync(path, Buffer.alloc(sizeMB * 1024 * 1024));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'find-game-exe-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('findGameExe', () => {
  it('picks UE Shipping exe over Steam DRM bootstrap stub at install root', () => {
    // Layout that triggers the bug:
    //   FG/FG.exe                                       (1 MB Steam DRM stub)
    //   FG/FG/Binaries/Win64/FG-Win64-Shipping.exe      (50 MB real UE exe)
    writeExe(join(dir, 'FG.exe'), 1);
    const shipDir = join(dir, 'FG', 'Binaries', 'Win64');
    mkdirSync(shipDir, { recursive: true });
    const ship = join(shipDir, 'FG-Win64-Shipping.exe');
    writeExe(ship, 50);

    const result = findGameExe(dir, 'FG');

    expect(result.path).toBe(ship);
    expect(result.reason).toContain('UE Shipping');
    // Stub must still be visible in the ranked candidate list (for logging)
    // but flagged as a likely stub and ranked below the Shipping exe.
    const stub = result.candidates.find((c) => c.path === join(dir, 'FG.exe'));
    expect(stub?.isLikelyStub).toBe(true);
    expect(result.candidates[0]!.path).toBe(ship);
  });

  it('falls back to UE Test build when no Shipping exe present', () => {
    writeExe(join(dir, 'Game.exe'), 1);
    const binDir = join(dir, 'Game', 'Binaries', 'Win64');
    mkdirSync(binDir, { recursive: true });
    const testExe = join(binDir, 'Game-Win64-Test.exe');
    writeExe(testExe, 40);

    const result = findGameExe(dir, 'Game');
    expect(result.path).toBe(testExe);
    expect(result.reason).toContain('UE Test');
  });

  it('picks suffix-less UE exe inside Binaries/Win64 over root stub', () => {
    writeExe(join(dir, 'Game.exe'), 1);
    const binDir = join(dir, 'Game', 'Binaries', 'Win64');
    mkdirSync(binDir, { recursive: true });
    const ueExe = join(binDir, 'Game.exe');
    writeExe(ueExe, 30);

    const result = findGameExe(dir, 'Game');
    expect(result.path).toBe(ueExe);
    expect(result.reason).toContain('UE plain');
  });

  it('skips known Steam helper binaries (steam.exe et al)', () => {
    writeExe(join(dir, 'steam.exe'), 5);
    writeExe(join(dir, 'steamwebhelper.exe'), 8);
    writeExe(join(dir, 'realgame.exe'), 30);

    const result = findGameExe(dir, 'realgame');
    expect(result.path).toBe(join(dir, 'realgame.exe'));
  });

  it('applies the generic anti-stub heuristic (root <2MB, deeper >10MB)', () => {
    // No UE pattern — just a generic small-root + large-subdir setup.
    writeExe(join(dir, 'BootStub.exe'), 1);
    const subDir = join(dir, 'bin');
    mkdirSync(subDir, { recursive: true });
    const real = join(subDir, 'BootStub.exe');
    writeExe(real, 30);

    const result = findGameExe(dir, 'BootStub');
    expect(result.path).toBe(real);
    const stub = result.candidates.find(
      (c) => c.path === join(dir, 'BootStub.exe'),
    );
    expect(stub?.isLikelyStub).toBe(true);
  });

  it('throws when no .exe found in the install dir', () => {
    expect(() => findGameExe(dir)).toThrow(/no \.exe found/);
  });

  it('picks arma3_x64.exe over arma3.exe when both sit in install root', () => {
    // Arma III layout: the 32-bit exe is the legacy default Steam ships,
    // but our launcher spawns the 64-bit ColdClientLoader which then
    // refuses a 32-bit target with "Arch of loader and requested exe are
    // different". Picking the x64 sibling keeps loader arch and exe arch
    // in sync.
    writeExe(join(dir, 'arma3.exe'), 8);
    const x64 = join(dir, 'arma3_x64.exe');
    writeExe(x64, 60);

    const result = findGameExe(dir, 'Arma 3');

    expect(result.path).toBe(x64);
    expect(result.reason).toContain('x64 sibling');
    const x86 = result.candidates.find((c) => c.path === join(dir, 'arma3.exe'));
    expect(x86?.x64Dominant).toBe(false);
    expect(result.candidates[0]!.path).toBe(x64);
  });

  it('does NOT promote _x64 sibling when it is too small to be a real exe', () => {
    // Two small stubs side by side — neither is large enough to count as
    // a packaged binary, so the x64 promotion must stay disabled. We use
    // a game name that does NOT substring-match either basename so the
    // name-score tiebreaker doesn't kick in; the larger of the two wins
    // by the normal size tiebreaker instead.
    writeExe(join(dir, 'game.exe'), 5);
    const x64 = join(dir, 'game_x64.exe');
    writeExe(x64, 6);

    const result = findGameExe(dir, 'something');

    expect(result.path).toBe(x64);
    const chosen = result.candidates[0]!;
    expect(chosen.x64Dominant).toBe(false);
  });

  it('does NOT promote _x64 sibling when it is not larger than the x86 twin', () => {
    // x64 is large enough to be real, but smaller than the x86 exe.
    // We only promote when the x64 sibling is strictly larger, so this
    // stays as plain size-tiebreaker territory.
    writeExe(join(dir, 'game.exe'), 80);
    writeExe(join(dir, 'game_x64.exe'), 30);

    const result = findGameExe(dir, 'game');

    expect(result.path).toBe(join(dir, 'game.exe'));
    const x64 = result.candidates.find(
      (c) => c.path === join(dir, 'game_x64.exe'),
    );
    expect(x64?.x64Dominant).toBe(false);
  });

  it('lets UE-Shipping still beat an x64 sibling at the install root', () => {
    // UE pattern stays the top discriminator: even when the x64 rule
    // would promote a sibling, an actual UE-Win64-Shipping.exe wins
    // because it scores higher in the ranker. The root-level x64 exe
    // is what the bare `findGameExe` would otherwise pick (and would
    // even be marked x64Dominant).
    writeExe(join(dir, 'game.exe'), 5);
    const x64Root = join(dir, 'game_x64.exe');
    writeExe(x64Root, 70);
    const binDir = join(dir, 'game', 'Binaries', 'Win64');
    mkdirSync(binDir, { recursive: true });
    const shipping = join(binDir, 'game-Win64-Shipping.exe');
    writeExe(shipping, 120);

    const result = findGameExe(dir, 'game');

    expect(result.path).toBe(shipping);
    expect(result.reason).toContain('UE Shipping');
  });

  it('treats -x64 suffix the same as _x64 (Windows-on-ARM64 sibling shape)', () => {
    writeExe(join(dir, 'MyGame.exe'), 6);
    const x64 = join(dir, 'MyGame-x64.exe');
    writeExe(x64, 50);

    const result = findGameExe(dir, 'MyGame');

    expect(result.path).toBe(x64);
    expect(result.reason).toContain('x64 sibling');
  });

  it('prefers the Steamless .unpacked.exe over the original when both sit side by side', () => {
    // Mirrors the real-world Arma III state: Steamless was run, the
    // unpacked file is on disk, but the original (with SteamStub) is
    // still next to it because the drm-patcher swap never finished.
    // Without the unpacked-shadow demotion the launcher picks the
    // SteamStub-wrapped binary, which dials steam://run/<appid> and
    // triggers a Steam-side re-launch loop. The .unpacked.exe has no
    // stub, so it must win.
    const orig = join(dir, 'arma3_x64.exe');
    writeExe(orig, 390);
    const unpacked = join(dir, 'arma3_x64.exe.unpacked.exe');
    writeExe(unpacked, 391);

    const result = findGameExe(dir, 'Arma 3');

    expect(result.path).toBe(unpacked);
    const shadowed = result.candidates.find((c) => c.path === orig);
    expect(shadowed?.unpackedShadowed).toBe(true);
    expect(result.candidates[0]!.path).toBe(unpacked);
  });

  it('does NOT shadow the original when a .bak marks a completed swap', () => {
    // After a successful swap, the original slot now holds the
    // Steamless-stripped binary and `.bak` is the pre-swap copy. The
    // leftover `.unpacked.exe` is just output from the run that did
    // the swap; the current `arma3_x64.exe` is the clean one. The
    // launcher must NOT demote it as "shadowed" in that case.
    const cleaned = join(dir, 'arma3_x64.exe');
    writeExe(cleaned, 390);
    const unpackedLeftover = join(dir, 'arma3_x64.exe.unpacked.exe');
    writeExe(unpackedLeftover, 391);
    writeFileSync(join(dir, 'arma3_x64.exe.bak'), '');

    const result = findGameExe(dir, 'Arma 3');

    expect(result.path).toBe(cleaned);
    const chosen = result.candidates.find((c) => c.path === cleaned);
    expect(chosen?.unpackedShadowed).toBe(false);
  });

  it('shadowed original stays in the candidate list for log diagnostics', () => {
    // The shadowed exe is demoted in the ranker, not filtered out —
    // we want it visible in `result.candidates` so the [launch] log
    // can show why it was rejected, instead of leaving the user to
    // wonder why the launcher picked an exe they didn't expect.
    const orig = join(dir, 'arma3_x64.exe');
    writeExe(orig, 390);
    writeExe(join(dir, 'arma3_x64.exe.unpacked.exe'), 391);

    const result = findGameExe(dir, 'Arma 3');

    expect(result.candidates.map((c) => c.path)).toContain(orig);
    expect(result.candidates[0]!.path).not.toBe(orig);
  });
});
