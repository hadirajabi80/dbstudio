// Generates the Rowlit app icon ("rows, lit up") without any image libraries: three rounded table rows on a deep
// navy rounded square, the middle row lit with an amber-to-coral gradient and a soft glow.
//
//   build/icons/rowlit.svg        master artwork (full bleed, 1024 grid): README, docs, design reference
//   build/icons/rowlit-macos.svg  macOS variant: artwork on Apple's 824/1024 icon grid with the standard drop shadow
//   build/icons/rowlit-small.svg  pixel-hinted 16 px variant (rows snapped to whole pixels, no glow)
//   build/icon.png                512x512 window/taskbar icon (resources/icon.png)
//   build/icon.ico                16, 24, 32, 48, 64, 128, 256 (BMP entries for small sizes, PNG for 256, as NSIS and
//                                 Windows expect)
//   build/icon.icns               16..1024 PNG entries (icp4..ic14) on the macOS grid
//   ../ui/public/favicon.svg      the in-browser favicon (the small, hinted artwork)
//
// The rasters are produced by evaluating the same shapes as the SVGs (signed distance functions) with supersampling.
// Small sizes snap the rows to whole pixels so the mark stays crisp at 16 px. Run: npm run icon (in desktop/).
// Optional: node build/make-icon.mjs --preview <dir> also writes preview PNGs (16/32/256/1024 and enlarged copies).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const buildDir = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(buildDir, 'icons');
const uiPublic = join(buildDir, '..', '..', 'ui', 'public');

// ---- palette (kept in step with the --brand-mark-* tokens in ui/src/theme/tokens.css) -------------------------------------
export const PALETTE = {
  bgTop: '#24345e',     // navy, top of the tile
  bgBottom: '#0b1430',  // deep navy, bottom of the tile
  row: '#4a5d8c',       // the two unlit rows
  rowSmall: '#5a6e9e',  // unlit rows at 16-32 px (a touch lighter so they read on a tiny tile)
  litStart: '#ffc54d',  // amber, left end of the lit row
  litEnd: '#ff6a5c',    // coral, right end of the lit row
  ambient: '#ff8a5c',   // warm light the lit row throws on the tile
};

// ---- geometry ---------------------------------------------------------------------------------------------------------
// Proportions of the tile (unit square). Rows: height 0.12, gap 0.07, horizontally 0.1875..0.8125, vertically centred.
const G = { radius: 0.225, rowH: 0.12, rowGap: 0.07, rowX: 0.1875, glow: 0.055, ambient: 0.42 };

/**
 * Pixel geometry of the icon at `size` px. variant 'full' fills the canvas (Windows, favicon, window icon);
 * 'mac' places the tile on Apple's 824/1024 grid. Sizes up to 48 px snap the rows to whole pixels.
 */
function geometry(size, variant) {
  const inset = variant === 'mac' ? (size * (1024 - 824)) / 2 / 1024 : size <= 32 ? 0 : Math.round(size * 0.015);
  const s = size - 2 * inset;
  const snap = size <= 48;
  let rowH = s * G.rowH, gap = s * G.rowGap, x0 = s * G.rowX;
  if (snap) {
    rowH = Math.max(2, Math.round(rowH));
    gap = Math.max(1, Math.round(gap));
    x0 = Math.round(x0);
  }
  const total = 3 * rowH + 2 * gap;
  let y0 = (s - total) / 2;
  if (snap) y0 = Math.round(y0);
  const rows = [0, 1, 2].map((i) => ({
    x0: inset + x0, x1: inset + s - x0,
    y0: inset + y0 + i * (rowH + gap), y1: inset + y0 + i * (rowH + gap) + rowH,
  }));
  return {
    size, variant, inset, s,
    tile: { x0: inset, y0: inset, x1: inset + s, y1: inset + s, r: s * (size <= 16 ? 0.2 : G.radius) },
    rows,
    rowR: rowH / 2,
    glow: size >= 48 ? s * G.glow : 0,
    detail: size >= 64, // highlight on the lit row, ambient light on the tile
    small: size <= 32,
  };
}

// ---- colour helpers ------------------------------------------------------------------------------------------------------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const C = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, hex(v)]));

/** Signed distance from (px,py) to a rounded rectangle (negative inside). */
function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const qx = Math.abs(px - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Premultiplied "over": dst = src over dst. Colours are [r,g,b] 0..1, alpha 0..1. */
function over(dst, rgb, a) {
  dst[0] = rgb[0] * a + dst[0] * (1 - a);
  dst[1] = rgb[1] * a + dst[1] * (1 - a);
  dst[2] = rgb[2] * a + dst[2] * (1 - a);
  dst[3] = a + dst[3] * (1 - a);
}

/** Premultiplied RGBA of the icon at pixel-space point (x,y). */
function sample(g, x, y) {
  const out = [0, 0, 0, 0];
  const t = g.tile;
  const dTile = sdRoundRect(x, y, t.x0, t.y0, t.x1, t.y1, t.r);

  // macOS drop shadow below the tile (Apple's template: soft, slightly offset downwards).
  if (g.variant === 'mac' && dTile > 0) {
    const sd = sdRoundRect(x, y - g.size * 0.012, t.x0, t.y0, t.x1, t.y1, t.r);
    const sigma = g.size * 0.016;
    const a = 0.24 * Math.exp(-((Math.max(sd, 0) / sigma) ** 2));
    if (a > 0.001) over(out, [0, 0, 0], a);
  }
  if (dTile > 0) return out;

  // tile: vertical navy gradient + the warm ambient light around the lit row
  const v = (y - t.y0) / (t.y1 - t.y0);
  let bg = mix(C.bgTop, C.bgBottom, v);
  const mid = g.rows[1];
  if (g.detail) {
    const cx = (mid.x0 + mid.x1) / 2, cy = (mid.y0 + mid.y1) / 2;
    const d = Math.hypot((x - cx) / 1.25, y - cy) / (g.s * G.ambient);
    bg = mix(bg, C.ambient, 0.16 * Math.max(0, 1 - d) ** 2);
  }
  over(out, bg, 1);

  // the lit row's glow (under the rows: it lights the tile, not the neighbouring rows)
  const u = Math.min(1, Math.max(0, (x - mid.x0) / (mid.x1 - mid.x0)));
  const lit = mix(C.litStart, C.litEnd, u);
  const dMid = sdRoundRect(x, y, mid.x0, mid.y0, mid.x1, mid.y1, g.rowR);
  if (dMid > 0 && g.glow > 0) {
    const a = 0.55 * Math.exp(-((dMid / g.glow) ** 2));
    if (a > 0.002) over(out, lit, a);
  }

  // unlit rows
  const rowColor = g.small ? C.rowSmall : C.row;
  for (const i of [0, 2]) {
    const r = g.rows[i];
    if (sdRoundRect(x, y, r.x0, r.y0, r.x1, r.y1, g.rowR) <= 0) over(out, rowColor, 1);
  }

  // the lit row: amber -> coral with a faint highlight on its upper half
  if (dMid <= 0) {
    let c = lit;
    if (g.detail) {
      const vy = (y - mid.y0) / (mid.y1 - mid.y0);
      if (vy < 0.5) c = mix(c, [1, 1, 1], 0.14 * (1 - vy / 0.5));
    }
    over(out, c, 1);
  }
  return out;
}

/** Renders `size` px RGBA (straight alpha, top-down). */
function render(size, variant = 'full') {
  const g = geometry(size, variant);
  const ss = size <= 64 ? 8 : size <= 256 ? 4 : 3;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0, gg = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(g, pxx + (sx + 0.5) / ss, py + (sy + 0.5) / ss);
          r += c[0]; gg += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = ss * ss;
      const o = (py * size + pxx) * 4;
      const alpha = a / n;
      if (alpha > 0) {
        px[o] = Math.round(Math.min(1, r / n / alpha) * 255);
        px[o + 1] = Math.round(Math.min(1, gg / n / alpha) * 255);
        px[o + 2] = Math.round(Math.min(1, b / n / alpha) * 255);
      }
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// ---- SVG masters (same geometry as the rasters) -------------------------------------------------------------------------
const f = (n) => String(Math.round(n * 100) / 100);
function svg(size, variant, { glow = true, detail = true } = {}) {
  const g = geometry(size, variant);
  const t = g.tile;
  const mid = g.rows[1];
  const rowColor = g.small ? PALETTE.rowSmall : PALETTE.row;
  const rect = (r, rx, fill, extra = '') =>
    `<rect x="${f(r.x0)}" y="${f(r.y0)}" width="${f(r.x1 - r.x0)}" height="${f(r.y1 - r.y0)}" rx="${f(rx)}" fill="${fill}"${extra}/>`;
  const defs = [
    `<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PALETTE.bgTop}"/><stop offset="1" stop-color="${PALETTE.bgBottom}"/></linearGradient>`,
    `<linearGradient id="lit" gradientUnits="userSpaceOnUse" x1="${f(mid.x0)}" y1="0" x2="${f(mid.x1)}" y2="0"><stop offset="0" stop-color="${PALETTE.litStart}"/><stop offset="1" stop-color="${PALETTE.litEnd}"/></linearGradient>`,
  ];
  const body = [];
  if (variant === 'mac') {
    defs.push(`<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${f(size * 0.011)}"/></filter>`);
    body.push(rect({ x0: t.x0, y0: t.y0 + size * 0.012, x1: t.x1, y1: t.y1 + size * 0.012 }, t.r, '#000', ` opacity="0.24" filter="url(#shadow)"`));
  }
  defs.push(`<clipPath id="clip">${rect(t, t.r, '#fff')}</clipPath>`);
  body.push(rect(t, t.r, 'url(#tile)'));
  const inner = [];
  if (detail && g.detail) {
    const cx = (mid.x0 + mid.x1) / 2, cy = (mid.y0 + mid.y1) / 2, rr = g.s * G.ambient;
    defs.push(`<radialGradient id="ambient" gradientUnits="userSpaceOnUse" cx="${f(cx)}" cy="${f(cy)}" r="${f(rr)}" gradientTransform="translate(${f(cx)} ${f(cy)}) scale(1.25 1) translate(${f(-cx)} ${f(-cy)})"><stop offset="0" stop-color="${PALETTE.ambient}" stop-opacity="0.16"/><stop offset="1" stop-color="${PALETTE.ambient}" stop-opacity="0"/></radialGradient>`);
    inner.push(`<rect x="${f(t.x0)}" y="${f(t.y0)}" width="${f(t.x1 - t.x0)}" height="${f(t.y1 - t.y0)}" fill="url(#ambient)"/>`);
  }
  if (glow && g.glow > 0) {
    defs.push(`<filter id="glow" x="-30%" y="-150%" width="160%" height="400%"><feGaussianBlur stdDeviation="${f(g.glow / Math.SQRT2)}"/></filter>`);
    inner.push(rect(mid, g.rowR, 'url(#lit)', ` opacity="0.8" filter="url(#glow)"`));
  }
  inner.push(rect(g.rows[0], g.rowR, rowColor), rect(g.rows[2], g.rowR, rowColor));
  inner.push(rect(mid, g.rowR, 'url(#lit)'));
  if (detail && g.detail) {
    defs.push(`<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.14"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>`);
    inner.push(rect(mid, g.rowR, 'url(#sheen)'));
  }
  body.push(`<g clip-path="url(#clip)">${inner.join('')}</g>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <title>Rowlit</title>
  <defs>${defs.join('')}</defs>
  ${body.join('\n  ')}
</svg>
`;
}

// ---- PNG ---------------------------------------------------------------------------------------------------------------
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
function png(w, rgba, h = w) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO (BMP/DIB entries + PNG for 256) --------------------------------------------------------------------------------
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
  const and = Buffer.alloc(andStride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rgba[((size - 1 - y) * size + x) * 4 + 3] === 0) and[y * andStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
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

// ---- ICNS (PNG payloads; one entry per OSType) --------------------------------------------------------------------------
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

/** Nearest-neighbour enlargement (previews of the pixel-hinted sizes). */
function enlarge(size, rgba, k, bg) {
  const w = size * k;
  const out = Buffer.alloc(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / k) * size + Math.floor(x / k)) * 4, d = (y * w + x) * 4;
      const a = rgba[s + 3] / 255;
      for (let i = 0; i < 3; i++) out[d + i] = Math.round(rgba[s + i] * a + bg[i] * (1 - a));
      out[d + 3] = 255;
    }
  }
  return png(w, out);
}

// ---- outputs ----------------------------------------------------------------------------------------------------------
mkdirSync(iconsDir, { recursive: true });
writeFileSync(join(iconsDir, 'rowlit.svg'), svg(1024, 'full'));
writeFileSync(join(iconsDir, 'rowlit-macos.svg'), svg(1024, 'mac'));
writeFileSync(join(iconsDir, 'rowlit-small.svg'), svg(16, 'full', { glow: false, detail: false }));
writeFileSync(join(uiPublic, 'favicon.svg'), svg(32, 'full', { detail: false }));

writeFileSync(join(buildDir, 'icon.png'), png(512, render(512)));
const entries = [16, 24, 32, 48, 64, 128, 256].map((size) => {
  const rgba = render(size);
  return { size, data: size === 256 ? png(size, rgba) : dib(size, rgba) };
});
writeFileSync(join(buildDir, 'icon.ico'), ico(entries));

const macPng = new Map();
const macAt = (size) => { if (!macPng.has(size)) macPng.set(size, png(size, render(size, 'mac'))); return macPng.get(size); };
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512], ['ic10', 1024],
];
writeFileSync(join(buildDir, 'icon.icns'), icns(ICNS_TYPES.map(([type, size]) => ({ type, data: macAt(size) }))));

const previewAt = process.argv.indexOf('--preview');
if (previewAt > 0 && process.argv[previewAt + 1]) {
  const dir = process.argv[previewAt + 1];
  mkdirSync(dir, { recursive: true });
  for (const size of [16, 32, 256, 1024]) writeFileSync(join(dir, `rowlit-${size}.png`), png(size, render(size)));
  writeFileSync(join(dir, 'rowlit-macos-1024.png'), macAt(1024));
  for (const [size, k] of [[16, 16], [24, 10], [32, 8], [48, 5]]) {
    const rgba = render(size);
    writeFileSync(join(dir, `rowlit-${size}-x${k}-on-light.png`), enlarge(size, rgba, k, [243, 244, 246]));
    writeFileSync(join(dir, `rowlit-${size}-x${k}-on-dark.png`), enlarge(size, rgba, k, [32, 33, 36]));
  }
  console.log(`icon: previews in ${dir}`);
}
console.log('icon: wrote build/icons/*.svg, build/icon.png (512), build/icon.ico (16-256), build/icon.icns (16-1024), ui/public/favicon.svg');
