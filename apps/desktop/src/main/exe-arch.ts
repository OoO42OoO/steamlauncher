import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import log from 'electron-log/main.js';

export type ExeArch = 'x86' | 'x64' | 'arm64';

const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

/**
 * Detect the bitness of a Windows .exe by sniffing its PE header. Reads
 * only the first ~1 KiB of the file (we need the DOS stub pointer at
 * 0x3C, then the 4-byte PE signature, then the COFF file header that
 * carries the Machine word at +4).
 *
 * Returns null when the file doesn't look like a PE (missing MZ magic,
 * truncated, or non-EXE — we treat "unknown" as "don't make arch-aware
 * decisions" so callers fall back to the legacy dual-arch pipeline
 * instead of wrongly assuming x64).
 */
export function detectExeArch(exePath: string): ExeArch | null {
  let fd: number | null = null;
  try {
    fd = openSync(exePath, 'r');
    const size = fstatSync(fd).size;
    if (size < 0x40) return null;
    const head = Buffer.alloc(Math.min(size, 1024));
    let read = 0;
    while (read < head.length) {
      const n = readSync(fd, head, read, head.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    if (read < 0x40) return null;
    // DOS header: 'MZ' at offset 0, e_lfanew at 0x3C is a 32-bit little-endian
    // pointer to the PE signature.
    if (head[0] !== 0x4d || head[1] !== 0x5a) return null;
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset + 6 > read) return null;
    if (
      head[peOffset] !== 0x50 ||
      head[peOffset + 1] !== 0x45 ||
      head[peOffset + 2] !== 0x00 ||
      head[peOffset + 3] !== 0x00
    ) {
      return null;
    }
    // COFF file header: Machine is a 16-bit little-endian word at +4.
    const machine = head.readUInt16LE(peOffset + 4);
    switch (machine) {
      case IMAGE_FILE_MACHINE_I386:
        return 'x86';
      case IMAGE_FILE_MACHINE_AMD64:
        return 'x64';
      case IMAGE_FILE_MACHINE_ARM64:
        return 'arm64';
      default:
        return null;
    }
  } catch (err) {
    log.warn('[exe-arch] detect failed', {
      exePath,
      err: (err as Error).message,
    });
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}