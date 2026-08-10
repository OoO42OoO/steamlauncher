import { describe, expect, it } from 'vitest';
import { detectExeArch } from './exe-arch';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Build a minimal valid PE header for the requested machine. Returns a
 * Buffer ready to write to disk. The COFF header is filled with zeroes
 * past the Machine word — we only sniff it, not parse optional headers.
 */
function makePe(machine: number): Buffer {
  const buf = Buffer.alloc(512);
  buf[0] = 0x4d; // 'M'
  buf[1] = 0x5a; // 'Z'
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew → offset of PE signature
  buf[0x80] = 0x50; // 'P'
  buf[0x81] = 0x45; // 'E'
  buf[0x82] = 0x00;
  buf[0x83] = 0x00;
  buf.writeUInt16LE(machine, 0x84); // COFF FileHeader.Machine
  return buf;
}

describe('detectExeArch', () => {
  const cases: Array<{ arch: 'x86' | 'x64' | 'arm64'; machine: number }> = [
    { arch: 'x86', machine: 0x014c },
    { arch: 'x64', machine: 0x8664 },
    { arch: 'arm64', machine: 0xaa64 },
  ];

  for (const { arch, machine } of cases) {
    it(`returns ${arch} for machine=0x${machine.toString(16)}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'exe-arch-'));
      const file = join(dir, 'fake.exe');
      try {
        writeFileSync(file, makePe(machine));
        expect(detectExeArch(file)).toBe(arch);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('returns null for a file without an MZ header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exe-arch-'));
    const file = join(dir, 'not-an-exe.bin');
    try {
      writeFileSync(file, Buffer.from('hello world'));
      expect(detectExeArch(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing file', () => {
    expect(detectExeArch('Z:/does/not/exist.exe')).toBeNull();
  });

  it('returns null for a file too small to contain a PE header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exe-arch-'));
    const file = join(dir, 'tiny.exe');
    try {
      writeFileSync(file, Buffer.from([0x4d, 0x5a]));
      expect(detectExeArch(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the MZ magic points past end of file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exe-arch-'));
    const file = join(dir, 'bad-pe.exe');
    try {
      const buf = Buffer.alloc(64);
      buf[0] = 0x4d;
      buf[1] = 0x5a;
      buf.writeUInt32LE(0xffff, 0x3c); // offset way past EOF
      writeFileSync(file, buf);
      expect(detectExeArch(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for an unknown machine value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exe-arch-'));
    const file = join(dir, 'unknown-arch.exe');
    try {
      writeFileSync(file, makePe(0x1234)); // IA64, not supported
      expect(detectExeArch(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the PE signature is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exe-arch-'));
    const file = join(dir, 'no-pe-sig.exe');
    try {
      const buf = Buffer.alloc(512);
      buf[0] = 0x4d;
      buf[1] = 0x5a;
      buf.writeUInt32LE(0x80, 0x3c);
      // bytes 0x80-0x83 stay zero — not 'PE\0\0'
      writeFileSync(file, buf);
      expect(detectExeArch(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});