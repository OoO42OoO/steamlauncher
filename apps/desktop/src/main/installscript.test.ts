import { describe, expect, it } from 'vitest';
import { parseVdf, extractRunProcesses } from './installscript';

// Verbatim from D:/launcher/6060/_CommonRedist/vcredist/2013/installscript.vdf
const VCREDIST_2013 = `"InstallScript"
{
	"Run Process"
	{
		"x86 12.0.30501"
		{
			"HasRunKey"		"HKEY_LOCAL_MACHINE\\\\Software\\\\Valve\\\\Steam\\\\Apps\\\\CommonRedist\\\\vcredist\\\\2013"
			"process 1"		"%INSTALLDIR%\\\\_CommonRedist\\\\vcredist\\\\2013\\\\vcredist_x86.exe"
			"command 1"		"/quiet /norestart"
			"NoCleanUp"		"1"
		}
		"x64 12.0.30501"
		{
			"process 1"		"%INSTALLDIR%\\\\_CommonRedist\\\\vcredist\\\\2013\\\\vcredist_x64.exe"
			"command 1"		"/quiet /norestart"
			"Requirement_OS"
			{
				"Is64BitWindows"		"1"
			}
		}
	}
}`;

const DIRECTX = `"installscript"
{
	"Run Process"
	{
		"dxsetup"
		{
			"process 1"		"%INSTALLDIR%\\\\_CommonRedist\\\\DirectX\\\\Jun2010\\\\DXSETUP.exe"
			"command 1"		"/silent"
		}
	}
}`;

describe('parseVdf', () => {
  it('parses nested blocks and lowercases keys', () => {
    const v = parseVdf(VCREDIST_2013);
    expect(typeof v['installscript']).toBe('object');
    const script = v['installscript'] as Record<string, unknown>;
    expect(typeof script['run process']).toBe('object');
  });

  it('reads leaf key/value pairs', () => {
    const v = parseVdf('"root" { "key" "value" "num" "1" }');
    expect(v['root']).toEqual({ key: 'value', num: '1' });
  });

  it('skips // line comments', () => {
    const v = parseVdf('"root"\n{\n// a comment\n"k" "v"\n}');
    expect(v['root']).toEqual({ k: 'v' });
  });

  it('throws on an unterminated object', () => {
    expect(() => parseVdf('"root" { "k" "v"')).toThrow();
  });
});

describe('extractRunProcesses', () => {
  it('resolves %INSTALLDIR% and splits the command line (64-bit host)', () => {
    const procs = extractRunProcesses(parseVdf(VCREDIST_2013), 'D:\\g', true);
    expect(procs).toEqual([
      {
        name: 'x86 12.0.30501',
        process: 'D:\\g\\_CommonRedist\\vcredist\\2013\\vcredist_x86.exe',
        args: ['/quiet', '/norestart'],
      },
      {
        name: 'x64 12.0.30501',
        process: 'D:\\g\\_CommonRedist\\vcredist\\2013\\vcredist_x64.exe',
        args: ['/quiet', '/norestart'],
      },
    ]);
  });

  it('drops the x64 entry on a 32-bit host (Requirement_OS gate)', () => {
    const procs = extractRunProcesses(parseVdf(VCREDIST_2013), 'D:\\g', false);
    expect(procs.map((p) => p.name)).toEqual(['x86 12.0.30501']);
  });

  it('handles the lowercase DirectX installscript', () => {
    const procs = extractRunProcesses(parseVdf(DIRECTX), 'C:\\game', true);
    expect(procs).toEqual([
      {
        name: 'dxsetup',
        process: 'C:\\game\\_CommonRedist\\DirectX\\Jun2010\\DXSETUP.exe',
        args: ['/silent'],
      },
    ]);
  });

  it('returns [] for a game-level installscript with no Run Process (only registry)', () => {
    const registryOnly = parseVdf('"installscript" { "registry" { "hk" { "string" { "a" "b" } } } }');
    expect(extractRunProcesses(registryOnly, 'D:\\g', true)).toEqual([]);
  });

  it('returns [] for a tree with no installscript key', () => {
    expect(extractRunProcesses(parseVdf('"other" { "k" "v" }'), 'D:\\g', true)).toEqual([]);
  });
});
