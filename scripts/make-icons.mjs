// Generates simple PNG app icons (blue background with an "odometer" strip). Run once: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x1f, 0x4e, 0x79], WHITE = [255, 255, 255], DARK = [0x22, 0x22, 0x22];

function colorAt(u, v) {
  const inRect = (x0, y0, x1, y1, r = 0) => {
    if (u < x0 || u > x1 || v < y0 || v > y1) return false;
    const cx = Math.min(Math.max(u, x0 + r), x1 - r), cy = Math.min(Math.max(v, y0 + r), y1 - r);
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
  };
  if (inRect(0.16, 0.36, 0.84, 0.64, 0.04)) {
    for (let i = 0; i < 5; i++) {
      const x0 = 0.2 + i * 0.124;
      if (inRect(x0, 0.40, x0 + 0.1, 0.60, 0.015)) return DARK;
    }
    return WHITE;
  }
  return BG;
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const c = colorAt((x + 0.5) / size, (y + 0.5) / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync('public/icon-192.png', png(192));
writeFileSync('public/icon-512.png', png(512));
writeFileSync('public/apple-touch-icon.png', png(180));
console.log('icons written');
