// Generates the DbStudio app icon without any image libraries:
//   build/icon.svg  (vector source, for docs/README)
//   build/icon.png  (512x512, window/taskbar icon)
//   build/icon.ico  (16..256; BMP entries for small sizes, PNG for 256, as NSIS and Windows expect)
//   build/icon.icns (16..1024 PNG entries; artwork inset to the macOS 824/1024 grid so it matches Dock icons)
// The raster is produced by evaluating the same shapes as the SVG with 4x4 supersampling.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = dirname(fileURLToPath(import.meta.url));

// ---- design (unit square 0..1) -------------------------------------------------------------
const BG_A = [0x4f, 0x46, 0xe5]; // indigo-600 (top-left)
const BG_B = [0x08, 0x91, 0xb2]; // cyan-600 (bottom-right)
const BODY = [0xf8, 0xfa, 0xfc]; // cylinder body
const TOP = [0xc7, 0xd2, 0xfe];  // cylinder top face (indigo-200)
const LINE = [0x43, 0x38, 0xca]; // band lines (indigo-700)
const CX = 0.5, RX = 0.26, RY = 0.075, TOP_Y = 0.30, BOT_Y = 0.70;
const BANDS = [0.4333, 0.5667];
const STROKE = 0.018;
const CORNER = 0.22;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#0891b2"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="${CORNER * 512 - 16}" fill="url(#g)"/>
  <path d="M${(CX - RX) * 512} ${TOP_Y * 512} V${BOT_Y * 512} A${RX * 512} ${RY * 512} 0 0 0 ${(CX + RX) * 512} ${BOT_Y * 512} V${TOP_Y * 512} Z" fill="#f8fafc"/>
  ${BANDS.map((y) => `<path d="M${(CX - RX) * 512} ${y * 512} A${RX * 512} ${RY * 512} 0 0 0 ${(CX + RX) * 512} ${y * 512}" fill="none" stroke="#4338ca" stroke-width="${STROKE * 512}"/>`).join('\n  ')}
  <ellipse cx="${CX * 512}" cy="${TOP_Y * 512}" rx="${RX * 512}" ry="${RY * 512}" fill="#c7d2fe" stroke="#4338ca" stroke-width="${STROKE * 512}"/>
</svg>
`;

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Approximate distance from (x,y) to the ellipse outline centred at (cx,cy). */
function ellipseDist(x, y, cx, cy, rx, ry) {
  const dx = x - cx, dy = y - cy;
  const f = (dx / rx) ** 2 + (dy / ry) ** 2 - 1;
  const g = Math.hypot((2 * dx) / (rx * rx), (2 * dy) / (ry * ry)) || 1e-9;
  return f / g; // <0 inside
}

/** Colour (rgba 0..1 alpha) of the icon at a point in the unit square. */
function sample(x, y) {
  const m = 0.03; // margin
  if (!inRoundedRect(x, y, m, m, 1 - m, 1 - m, CORNER - m)) return null;
  const t = (x + y) / 2;
  let c = BG_A.map((a, i) => a + (BG_B[i] - a) * t);

  const inBody = Math.abs(x - CX) <= RX && y >= TOP_Y && y <= BOT_Y;
  const inBottom = ellipseDist(x, y, CX, BOT_Y, RX, RY) <= 0 && y >= BOT_Y;
  if (inBody || inBottom) {
    c = BODY;
    for (const by of BANDS) {
      if (y >= by && Math.abs(ellipseDist(x, y, CX, by, RX, RY)) <= STROKE / 2) c = LINE;
    }
  }
  const dTop = ellipseDist(x, y, CX, TOP_Y, RX, RY);
  if (dTop <= STROKE / 2) c = dTop < -STROKE / 2 ? TOP : LINE;
  return c;
}

/** inset: fraction of the canvas left empty on each side (macOS icon grid). */
function render(size, inset = 0) {
  const ss = 4;
  const scale = 1 - 2 * inset;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((pxx + (sx + 0.5) / ss) / size - inset) / scale;
          const v = ((py + (sy + 0.5) / ss) / size - inset) / scale;
          const c = u < 0 || u > 1 || v < 0 || v > 1 ? null : sample(u, v);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const o = (py * size + pxx) * 4;
      if (a > 0) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
      px[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return px; // RGBA, top-down
}

// ---- PNG -------------------------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO (BMP/DIB entries + PNG for 256) ------------------------------------------------------
function dib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4; // bottom-up
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]; xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3];
    }
  }
  const andStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(andStride * size); // all zero: alpha channel decides
  return Buffer.concat([header, xor, and]);
}

function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...images.map((i) => i.data)]);
}

writeFileSync(join(outDir, 'icon.svg'), svg);
writeFileSync(join(outDir, 'icon.png'), png(512, render(512)));
const entries = [16, 24, 32, 48, 64, 128, 256].map((size) => {
  const rgba = render(size);
  return { size, data: size === 256 ? png(size, rgba) : dib(size, rgba) };
});
writeFileSync(join(outDir, 'icon.ico'), ico(entries));

// ---- ICNS (PNG payloads; one entry per OSType) ------------------------------------------------
function icns(items) {
  const chunks = items.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}
const MAC_INSET = (1024 - 824) / 2 / 1024; // Apple's macOS 11+ app icon grid
const macPng = new Map();
const macAt = (size) => { if (!macPng.has(size)) macPng.set(size, png(size, render(size, MAC_INSET))); return macPng.get(size); };
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512], ['ic10', 1024],
];
writeFileSync(join(outDir, 'icon.icns'), icns(ICNS_TYPES.map(([type, size]) => ({ type, data: macAt(size) }))));
console.log('icon: wrote build/icon.svg, build/icon.png (512), build/icon.ico (16-256), build/icon.icns (16-1024)');
