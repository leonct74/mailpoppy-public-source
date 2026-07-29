#!/usr/bin/env node
// Generate a 1024x1024 PNG "poppy" mark with no image deps (Node 22 zlib.crc32).
// Output feeds `tauri icon` to produce the platform icon set.
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 1024,
  H = 1024,
  cx = 512,
  cy = 512;
const raw = Buffer.alloc(H * (1 + W * 4));

for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // PNG filter: none
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cy);
    let r, g, b;
    if (d < 112) [r, g, b] = [0x26, 0x26, 0x2b]; // dark poppy center
    else if (d < 322) [r, g, b] = [0xff, 0xff, 0xff]; // white petal ring
    else [r, g, b] = [0xe5, 0x45, 0x3b]; // poppy red
    const o = y * (1 + W * 4) + 1 + x * 4;
    raw[o] = r;
    raw[o + 1] = g;
    raw[o + 2] = b;
    raw[o + 3] = 255;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type RGBA
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = process.argv[2] || "icon-source.png";
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
