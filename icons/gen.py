# Generates simple PNG icons without any third-party dependency.
import struct, zlib, os
def png(size):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            pad = max(1, size // 10)
            inside = pad <= x < size - pad and pad <= y < size - pad
            if not inside:
                row += bytes([0, 0, 0, 0]); continue
            # two overlapping "version" blocks: green on the left, dark on the right
            split = size // 2
            diag = (x + y) > size
            if diag: row += bytes([0x1f, 0x2a, 0x37, 255])
            else: row += bytes([0x00, 0x8a, 0x5c, 255])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
here = os.path.dirname(os.path.abspath(__file__))
for s in (16, 32, 48, 128):
    open(os.path.join(here, f'{s}.png'), 'wb').write(png(s))
print('icons ok')
