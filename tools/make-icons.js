/* LokaChat - generates frontend/assets/icon-192.png and icon-512.png (white/sky-blue droplet on black).
   No dependencies:  node tools/make-icons.js   (run from D:\LokaChat) */
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const SKY = [56, 189, 248], WHITE = [255, 255, 255], BLACK = [0, 0, 0];

function crc32(buf) {
  let c, crc = ~0;
  for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(n, rgb) {
  const raw = Buffer.alloc((n * 3 + 1) * n);
  for (let y = 0; y < n; y++) { raw[y * (n * 3 + 1)] = 0; rgb.copy(raw, y * (n * 3 + 1) + 1, y * n * 3, (y + 1) * n * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
// shape in unit coordinates (0..1)
const cx = 0.5, cy = 0.6, r = 0.27, top = 0.16;
const dist = cy - top, halfAngle = Math.asin(r / dist);
function inDrop(x, y) {
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  if (y < top || y > cy - (r * r) / dist) return false;   // cone ends at the tangent points
  return Math.abs(x - cx) <= (y - top) * Math.tan(halfAngle);   // tangent lines from the apex to the circle
}
function inLine(x, y, x1, x2, ly, w) {
  const dx = Math.max(x1 - x, 0, x - x2), dy = y - ly;
  return dx * dx + dy * dy <= (w / 2) ** 2;
}
function colorAt(x, y) {
  if (inLine(x, y, cx - r * 0.55, cx + r * 0.55, cy - r * 0.1, 0.035) || inLine(x, y, cx - r * 0.55, cx + r * 0.1, cy + r * 0.35, 0.035)) return WHITE;
  return inDrop(x, y) ? SKY : BLACK;
}
function render(n) {
  const rgb = Buffer.alloc(n * n * 3), SS = 3;
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
    let R = 0, G = 0, B = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = colorAt((px + (sx + 0.5) / SS) / n, (py + (sy + 0.5) / SS) / n); R += c[0]; G += c[1]; B += c[2];
    }
    const o = (py * n + px) * 3; rgb[o] = R / (SS * SS); rgb[o + 1] = G / (SS * SS); rgb[o + 2] = B / (SS * SS);
  }
  return png(n, rgb);
}
const dir = path.join(__dirname, "..", "frontend", "assets");
fs.mkdirSync(dir, { recursive: true });
for (const n of [192, 512]) { fs.writeFileSync(path.join(dir, `icon-${n}.png`), render(n)); console.log("wrote assets/icon-" + n + ".png"); }
