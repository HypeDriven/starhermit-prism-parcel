// Bakes the browser build's frosted noise textures (src/render.js
// noiseTexture: a seeded LCG, grey 150 ± 35 per pixel) into grey PNGs:
// assets/noise-table-{128,256,512}.png (seed 7) and
// assets/noise-socket-{64,128,256}.png (seed 11), the sizes the four graphics
// tiers use. Per-pixel canvas work is far too slow in the native interpreter,
// so the client loads these instead (same pixels). Run once:
//   node tools/bake-noise.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, grey) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size + 1)] = 0; grey.copy(raw, y * (size + 1) + 1, y * size, (y + 1) * size); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** render.js noiseTexture(size, seed, 0). */
function noise(size, seed) {
  const out = Buffer.alloc(size * size);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < size * size; i++) out[i] = Math.round(150 + (rnd() - 0.5) * 70);
  return out;
}
const root = new URL('../assets/', import.meta.url);
for (const n of [128, 256, 512]) writeFileSync(new URL(`noise-table-${n}.png`, root), png(n, noise(n, 7)));
for (const n of [64, 128, 256]) writeFileSync(new URL(`noise-socket-${n}.png`, root), png(n, noise(n, 11)));
console.log('baked noise textures');
