// Generates app-icon.png (1024x1024) — a stylized newspaper front page.
// Pure Node: raw RGBA -> zlib -> PNG chunks. Run via `npm run icon`.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 1024;
const H = 1024;
const px = new Uint8Array(W * H * 4);

const PAPER = [242, 232, 213, 255];
const INK = [43, 33, 23, 255];
const ACCENT = [122, 46, 29, 255];
const SOFT = [138, 124, 99, 255];

function fill(x0, y0, w, h, c) {
  const x1 = Math.min(W, x0 + w);
  const y1 = Math.min(H, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) {
      const i = (y * W + x) * 4;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = c[3];
    }
  }
}

// Background
fill(0, 0, W, H, PAPER);

// Masthead double rule
fill(128, 200, 768, 14, INK);
fill(128, 228, 768, 5, INK);

// Masthead "lettering" — blocky small-caps suggestion
for (let i = 0; i < 7; i++) {
  fill(160 + i * 106, 120, 70, 56, INK);
}

// Headline block
fill(128, 292, 768, 92, INK);

// Subhead lines
fill(128, 420, 620, 16, SOFT);
fill(128, 452, 500, 16, SOFT);

// Three columns of body text
const colXs = [128, 400, 672];
const colW = 224;
for (let c = 0; c < 3; c++) {
  let y = 520;
  if (c === 1) {
    // middle column opens with a "photo"
    fill(colXs[c], y, colW, 150, ACCENT);
    y += 174;
  }
  while (y < 880) {
    const w = y + 12 >= 880 ? colW * 0.6 : colW;
    fill(colXs[c], y, Math.round(w), 12, INK.map((v, i) => (i < 3 ? v + 60 : v)));
    y += 26;
  }
}

// Bottom rule
fill(128, 912, 768, 6, INK);

// ---- PNG encoding ----------------------------------------------------------

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter: none
  Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (1 + W * 4) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log("wrote app-icon.png");
