"""
Regenerate build/icon.ico as a proper multi-resolution Windows icon.

The committed `icon.ico` previously contained only a single 256x256
frame, so Windows fell back to the default Electron icon for
smaller shell contexts (16x16 taskbar, 32x32 Alt-Tab, 48x48
Explorer-large, etc.) — even though build/icon.png (the source
artwork, 1000x1000) was correct and complete. electron-builder
had no way to recover the missing frames; it just embedded the
single-frame .ico as-is.

Pillow 12.x's ICO writer is broken in both the PNG-in-ICO and
BMP-with-append_images code paths (it only emits the first
provided frame regardless of `sizes=[...]` or `append_images=[...]`).
So we build the .ico by hand: ICONDIR header + N x ICONDIRENTRY
+ N x PNG payload per frame (Vista+ format, which is what
electron-builder and Windows both prefer).

Source: build/icon.png (1000x1000 RGBA).
Output: build/icon.ico with frames at 16, 24, 32, 48, 64, 128, 256.
Re-run after any icon.png change; commit the regenerated .ico.
"""
from PIL import Image
import struct
import os
import io

# Resolve paths relative to this script so the helper runs from
# anywhere (CI, manual invocation, post-merge hook, etc.).
_here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(_here, 'icon.png')
dst = os.path.join(_here, 'icon.ico')

sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
master = Image.open(src).convert('RGBA')

# Render each frame from the master and emit a true 32-bit BMP DIB
# (BITMAPINFOHEADER + pixel array + AND mask) per size. We use the
# classic BMP-in-ICO codepath because the tools that apply the icon
# to a Windows executable (electron-builder -> rcedit) only honour
# the classic DIB format; the Vista+ PNG-in-ICO format is read
# fine by Explorer but silently dropped during the executable
# resource update, leaving the original Electron default icon in
# place. Embedding BMP means rcedit always sees a format it
# understands.
def dib_bytes(img: Image.Image, w: int, h: int) -> bytes:
    """32-bit BGRA DIB (no file header) with a 1-bit AND mask.
    Required layout for a 32bpp ARGB icon frame."""
    pixels = img.tobytes('raw', 'BGRA')  # top-down row-major, 4 bytes/px
    # XOR mask: pixel data, padded to 4 bytes per scanline
    row_size = w * 4
    # AND mask: 1 bit per pixel, padded to 4 bytes per scanline
    and_row_size = ((w + 31) // 32) * 4
    # BITMAPINFOHEADER
    # biSize, biWidth, biHeight (doubled to include AND mask),
    # biPlanes, biBitCount, biCompression, biSizeImage, biXPelsPerMeter,
    # biYPelsPerMeter, biClrUsed, biClrImportant
    info_header = struct.pack(
        '<IiiHHIIiiII',
        40,             # biSize
        w,              # biWidth
        h * 2,          # biHeight (XOR + AND masks stacked)
        1,              # biPlanes
        32,             # biBitCount
        0,              # biCompression (BI_RGB)
        row_size * h,   # biSizeImage
        0,              # biXPelsPerMeter
        0,              # biYPelsPerMeter
        0,              # biClrUsed
        0,              # biClrImportant
    )
    # Flip rows: BMP stores bottom-up
    rows = [pixels[r * row_size:(r + 1) * row_size] for r in range(h - 1, -1, -1)]
    xor_mask = b''.join(rows)
    # AND mask: all zeros (alpha is in the XOR channel for 32bpp,
    # so the AND mask is technically unused; rcedit still expects
    # the bytes to be present and zeroed).
    and_mask = b'\x00' * (and_row_size * h)
    return info_header + xor_mask + and_mask


frames_ico = []
for s in sizes:
    frame = master.resize(s, Image.LANCZOS)
    payload = dib_bytes(frame, s[0], s[1])
    frames_ico.append((s, payload))

# ICONDIR: 6 bytes
# ICONDIRENTRY: 16 bytes per icon
header_size = 6 + 16 * len(frames_ico)
offset = header_size

entries = []
payloads = []
for (w, h), dib in frames_ico:
    byte_w = 0 if w == 256 else w
    byte_h = 0 if h == 256 else h
    entry = struct.pack(
        '<BBBBHHII',
        byte_w, byte_h,
        0,    # colorCount (0 when >256)
        0,    # reserved
        1,    # planes
        32,   # bitCount
        len(dib),
        offset,
    )
    entries.append(entry)
    payloads.append(dib)
    offset += len(dib)

with open(dst, 'wb') as f:
    f.write(struct.pack('<HHH', 0, 1, len(frames_ico)))
    for e in entries:
        f.write(e)
    for p in payloads:
        f.write(p)

print(f'Wrote {dst} ({os.path.getsize(dst)} bytes, {len(frames_ico)} frames, BMP-encoded)')
