// One-shot icon generator for Astra Browser Control.
// Renders a rounded-square indigo tile with an "A" glyph to
// astra-16/32/48/128.png using only Node's zlib (unbreakable, no deps).
// Delete this file after regenerating if you prefer a designer-supplied set.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// 5x7 bitmap "A" scaled by integer factor per size.
// Rows top→bottom, 1 = filled.
const GLYPH = [
  "01110",
  "10001",
  "10001",
  "11111",
  "10001",
  "10001",
  "10001",
];

function png(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw);
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    chunks.push(len, body, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  chunk("IHDR", ihdr);
  chunk("IDAT", idat);
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

let table;
function crc32(buf) {
  table ??= (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return ~crc;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [43, 108, 176, 255];      // indigo blue
  const fg = [255, 255, 255, 255];     // white glyph
  const radius = Math.max(2, Math.round(size * 0.2));
  const glyphScale = size >= 48 ? 4 : size >= 32 ? 3 : 2;
  const gw = GLYPH[0].length * glyphScale;
  const gh = GLYPH.length * glyphScale;
  const gx = Math.round((size - gw) / 2);
  const gy = Math.round((size - gh) / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rounded-corner mask.
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      const inCornerX = dx < radius, inCornerY = dy < radius;
      let on = true;
      if (inCornerX && inCornerY) {
        const ox = radius - dx, oy = radius - dy;
        on = ox * ox + oy * oy <= radius * radius;
      }
      if (!on) { rgba.fill(0, i, i + 4); continue; }
      // Glyph lookup.
      const col = Math.floor((x - gx) / glyphScale);
      const row = Math.floor((y - gy) / glyphScale);
      const inGlyph = col >= 0 && col < GLYPH[0].length && row >= 0 && row < GLYPH.length && GLYPH[row][col] === "1";
      const color = inGlyph ? fg : bg;
      rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = color[3];
    }
  }
  return png(size, size, rgba);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(here, `astra-${size}.png`), render(size));
  console.log(`astra-${size}.png written`);
}
