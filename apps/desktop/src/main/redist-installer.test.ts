import { describe, expect, it, vi } from 'vitest';
import {
  classifyRedist,
  scanRedists,
  installRedists,
  unwrapCmdInstaller,
  type RedistItem,
  type ScanDeps,
  type InstallDeps,
} from './redist-installer';

vi.mock('electron-log/main.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

describe('classifyRedist', () => {
  it('maps VC++ 2013 x86 to the WiX silent flags', () => {
    const r = classifyRedist('D:/g/_CommonRedist/vcredist/2013/vcredist_x86.exe');
    expect(r).toEqual({
      path: 'D:/g/_CommonRedist/vcredist/2013/vcredist_x86.exe',
      label: 'vcredist 2013 x86',
      args: ['/install', '/quiet', '/norestart'],
    });
  });

  it('uses InstallShield /q for 2005 and 2008', () => {
    expect(classifyRedist('x/vcredist/2008/vcredist_x64.exe')?.args).toEqual(['/q']);
    expect(classifyRedist('x/vcredist/2005/vcredist_x86.exe')?.args).toEqual(['/q']);
  });

  it('uses /passive /norestart for the 2010 MSI wrapper', () => {
    expect(classifyRedist('x/vcredist/2010/vcredist_x86.exe')?.args).toEqual([
      '/passive',
      '/norestart',
    ]);
  });

  it('recognises DXSETUP.exe regardless of case', () => {
    const r = classifyRedist('D:/g/_CommonRedist/DirectX/Jun2010/DXSETUP.exe');
    expect(r?.label).toBe('DirectX runtime');
    expect(r?.args).toEqual(['/silent']);
  });

  it('recognises .NET NDP installers', () => {
    const r = classifyRedist(
      'D:/g/_CommonRedist/DotNet/4.5.2/NDP452-KB2901907-x86-x64-AllOS-ENU.exe'
    );
    expect(r?.label).toBe('.NET 4.5.2');
    expect(r?.args).toEqual(['/q', '/norestart']);
  });

  it('backslash Windows paths are handled', () => {
    const r = classifyRedist('D:\\g\\_CommonRedist\\vcredist\\2015\\vcredist_x64.exe');
    expect(r?.label).toBe('vcredist 2015 x64');
    expect(r?.args).toEqual(['/install', '/quiet', '/norestart']);
  });

  it('returns null for unrecognised executables (never guesses)', () => {
    expect(classifyRedist('D:/g/_CommonRedist/weird/setup.exe')).toBeNull();
    expect(classifyRedist('D:/g/GameData/BattlefrontII.exe')).toBeNull();
  });
});

describe('unwrapCmdInstaller', () => {
  const dir = '/g/_CommonRedist/vcredist/2015';

  it('repairs Valve VC++ 2015 x86 missing-.exe typo', () => {
    // Valve's wrapper points at `vc_redist.x86` (no extension); only
    // `vc_redist.x86.exe` is on disk.
    const text =
      '@ECHO OFF\r\nstart /w "" "%~dp0\\vc_redist.x86" /q /norestart\r\n' +
      'IF %ERRORLEVEL% == 3010 EXIT /B 0\r\nEXIT /B %ERRORLEVEL%\r\n';
    const exists = (p: string) => p === `${dir}/vc_redist.x86.exe`;
    expect(unwrapCmdInstaller(`${dir}/vc2015_x86.cmd`, text, exists)).toEqual({
      process: `${dir}/vc_redist.x86.exe`,
      args: ['/q', '/norestart'],
    });
  });

  it('uses the wrapped target verbatim when it already exists', () => {
    const text = '@ECHO OFF\r\nstart /w "" "%~dp0\\vc_redist.x64.exe" /q /norestart\r\n';
    const exists = (p: string) => p === `${dir}/vc_redist.x64.exe`;
    expect(unwrapCmdInstaller(`${dir}/vc2015_x64.cmd`, text, exists)).toEqual({
      process: `${dir}/vc_redist.x64.exe`,
      args: ['/q', '/norestart'],
    });
  });

  it('handles backslash wrapper paths and returns [] args when none given', () => {
    const bdir = 'D:\\g\\_CommonRedist\\vcredist\\2015';
    const text = 'start /w "" "%~dp0\\vc_redist.x64.exe"\r\n';
    const exists = (p: string) => p === `${bdir}\\vc_redist.x64.exe`;
    expect(unwrapCmdInstaller(`${bdir}\\wrap.cmd`, text, exists)).toEqual({
      process: `${bdir}\\vc_redist.x64.exe`,
      args: [],
    });
  });

  it('returns null when the wrapper does not match the expected shape', () => {
    expect(unwrapCmdInstaller(`${dir}/x.cmd`, '@echo hello world\r\n', () => true)).toBeNull();
  });

  it('returns null when neither the target nor target.exe is on disk', () => {
    const text = 'start /w "" "%~dp0\\missing.thing" /q\r\n';
    expect(unwrapCmdInstaller(`${dir}/x.cmd`, text, () => false)).toBeNull();
  });
});

// ── scanRedists over a virtual _CommonRedist tree ─────────────────────────

// A file is either 'file' (empty) or a string literal holding its content.
type Node = { [name: string]: Node | 'file' | { __content: string } };

function fsFrom(tree: Record<string, Node>): ScanDeps {
  const dirs = new Map<string, Array<{ name: string; isDir: boolean }>>();
  const files = new Map<string, string>();
  const isFile = (c: unknown): boolean =>
    c === 'file' || (typeof c === 'object' && c !== null && '__content' in (c as object));
  const build = (path: string, node: Node) => {
    const entries: Array<{ name: string; isDir: boolean }> = [];
    for (const [name, child] of Object.entries(node)) {
      const dir = !isFile(child);
      entries.push({ name, isDir: dir });
      const full = `${path}/${name}`;
      if (dir) build(full, child as Node);
      else if (typeof child === 'object') files.set(full, (child as { __content: string }).__content);
      else files.set(full, '');
    }
    dirs.set(path, entries);
  };
  for (const [root, node] of Object.entries(tree)) build(root, node);
  const norm = (p: string) => p.replace(/\\/g, '/');
  return {
    readDir: (dir) => dirs.get(norm(dir)) ?? [],
    readFile: (p) => files.get(norm(p)) ?? null,
    exists: (p) => files.has(norm(p)) || dirs.has(norm(p)),
    join: (...parts) => parts.join('/'),
    is64BitWindows: true,
  };
}

// Minimal installscript.vdf for one vcredist entry pointing at `exeRel`.
const script = (exeRel: string, cmd: string) =>
  `"installscript"{"Run Process"{"e"{"process 1" "%INSTALLDIR%/${exeRel}" "command 1" "${cmd}"}}}`;

describe('scanRedists — installscript-driven (authoritative)', () => {
  it('uses installscript.vdf: exact process path + Valve command line', () => {
    const deps = fsFrom({
      '/game': {
        _CommonRedist: {
          vcredist: {
            '2013': {
              'vcredist_x86.exe': 'file',
              'installscript.vdf': {
                __content: script('_CommonRedist/vcredist/2013/vcredist_x86.exe', '/quiet /norestart'),
              },
            },
          },
        },
      },
    });
    const items = scanRedists('/game', deps);
    expect(items).toEqual([
      {
        path: '/game/_CommonRedist/vcredist/2013/vcredist_x86.exe',
        label: 'e',
        args: ['/quiet', '/norestart'],
      },
    ]);
  });

  it('skips installscript entries whose target exe is not on disk', () => {
    const deps = fsFrom({
      '/game': {
        _CommonRedist: {
          vcredist: {
            '2013': {
              // installscript points at an exe that was never downloaded
              'installscript.vdf': {
                __content: script('_CommonRedist/vcredist/2013/vcredist_x86.exe', '/quiet'),
              },
            },
          },
        },
      },
    });
    expect(scanRedists('/game', deps)).toEqual([]);
  });

  it('falls back to filename classification when no installscript is present', () => {
    const deps = fsFrom({
      '/game': {
        _CommonRedist: {
          DirectX: { Jun2010: { 'DXSETUP.exe': 'file' } },
          vcredist: {
            '2013': { 'vcredist_x86.exe': 'file', 'vcredist_x64.exe': 'file' },
          },
        },
      },
    });
    const items = scanRedists('/game', deps);
    expect(items.map((i) => i.label)).toEqual([
      'vcredist 2013 x64',
      'vcredist 2013 x86',
      'DirectX runtime',
    ]);
  });

  it('matches the legacy CommonRedist folder name too', () => {
    const deps = fsFrom({
      '/game': {
        CommonRedist: { vcredist: { '2012': { 'vcredist_x86.exe': 'file' } } },
      },
    });
    expect(scanRedists('/game', deps)).toHaveLength(1);
  });

  it('returns [] when there is no redist folder', () => {
    const deps = fsFrom({ '/game': { GameData: { 'game.exe': 'file' } } });
    expect(scanRedists('/game', deps)).toEqual([]);
  });

  it('ignores unrecognised exes inside the redist tree', () => {
    const deps = fsFrom({
      '/game': {
        _CommonRedist: {
          misc: { 'randomtool.exe': 'file' },
          vcredist: { '2013': { 'vcredist_x86.exe': 'file' } },
        },
      },
    });
    const items = scanRedists('/game', deps);
    expect(items.map((i) => i.label)).toEqual(['vcredist 2013 x86']);
  });

  it('unwraps .cmd installer wrappers, fixing the VC++ 2015 x86 typo (Tropico 6)', () => {
    // Real Tropico 6 shape: installscript points at .cmd wrappers with no
    // `command N`; the x86 wrapper's target drops the `.exe`.
    const wrapperX86 =
      '@ECHO OFF\r\nstart /w "" "%~dp0\\vc_redist.x86" /q /norestart\r\nEXIT /B %ERRORLEVEL%\r\n';
    const wrapperX64 =
      '@ECHO OFF\r\nstart /w "" "%~dp0\\vc_redist.x64.exe" /q /norestart\r\nEXIT /B %ERRORLEVEL%\r\n';
    const vdf =
      '"InstallScript"{"Run Process"{' +
      '"x86 14.0"{"process 1" "%INSTALLDIR%/_CommonRedist/vcredist/2015/vc2015_x86.cmd"}' +
      '"x64 14.0"{"process 1" "%INSTALLDIR%/_CommonRedist/vcredist/2015/vc2015_x64.cmd" ' +
      '"Requirement_OS"{"Is64BitWindows" "1"}}' +
      '}}';
    const deps = fsFrom({
      '/game': {
        _CommonRedist: {
          vcredist: {
            '2015': {
              'installscript.vdf': { __content: vdf },
              'vc2015_x86.cmd': { __content: wrapperX86 },
              'vc2015_x64.cmd': { __content: wrapperX64 },
              'vc_redist.x86.exe': 'file',
              'vc_redist.x64.exe': 'file',
            },
          },
        },
      },
    });
    expect(scanRedists('/game', deps)).toEqual([
      {
        path: '/game/_CommonRedist/vcredist/2015/vc_redist.x86.exe',
        label: 'x86 14.0',
        args: ['/q', '/norestart'],
      },
      {
        path: '/game/_CommonRedist/vcredist/2015/vc_redist.x64.exe',
        label: 'x64 14.0',
        args: ['/q', '/norestart'],
      },
    ]);
  });
});

// ── installRedists orchestration via stubbed deps ─────────────────────────

function baseDeps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    scan: () => [{ path: 'v.exe', label: 'vcredist 2013 x86', args: ['/install'] }],
    pathExists: () => false,
    writeMarker: () => {},
    markerPath: (dir) => `${dir}/.redists_done`,
    runElevated: async () => {},
    platform: 'win32',
    ...over,
  };
}

describe('installRedists', () => {
  it('runs the installers and writes the done-marker on success', async () => {
    const runElevated = vi.fn(async () => {});
    const writeMarker = vi.fn();
    const res = await installRedists('/game', baseDeps({ runElevated, writeMarker }));
    expect(res).toEqual({ ran: true, count: 1 });
    expect(runElevated).toHaveBeenCalledOnce();
    expect(writeMarker).toHaveBeenCalledWith('/game/.redists_done');
  });

  it('no-ops on non-Windows without touching the disk', async () => {
    const runElevated = vi.fn(async () => {});
    const res = await installRedists('/game', baseDeps({ platform: 'linux', runElevated }));
    expect(res).toEqual({ ran: false, reason: 'platform' });
    expect(runElevated).not.toHaveBeenCalled();
  });

  it('skips when the marker already exists (no re-prompt on relaunch)', async () => {
    const runElevated = vi.fn(async () => {});
    const res = await installRedists(
      '/game',
      baseDeps({ pathExists: () => true, runElevated })
    );
    expect(res).toEqual({ ran: false, reason: 'already_done' });
    expect(runElevated).not.toHaveBeenCalled();
  });

  it('writes the marker even when nothing is found (avoids rescanning)', async () => {
    const writeMarker = vi.fn();
    const res = await installRedists('/game', baseDeps({ scan: () => [], writeMarker }));
    expect(res).toEqual({ ran: false, reason: 'none_found' });
    expect(writeMarker).toHaveBeenCalledOnce();
  });

  it('does NOT write the marker when the elevated run fails (retries next launch)', async () => {
    const writeMarker = vi.fn();
    const res = await installRedists(
      '/game',
      baseDeps({
        runElevated: async () => {
          throw new Error('user declined UAC');
        },
        writeMarker,
      })
    );
    expect(res).toEqual({ ran: false, reason: 'error' });
    expect(writeMarker).not.toHaveBeenCalled();
  });
});
