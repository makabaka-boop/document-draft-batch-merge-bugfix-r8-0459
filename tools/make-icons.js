// 用 Node 内置 zlib 生成纯色 + 白色“存档”条纹的 PNG 图标，零依赖。
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgbaAt) {
  const w = size;
  const h = size;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = rgbaAt(x, y, size);
      const o = y * (1 + w * 4) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function rgba(x, y, s) {
  const bg = [15, 111, 255, 255];
  // 圆角
  const rad = s * 0.22;
  const inX = x < rad ? rad - x : x > s - 1 - rad ? x - (s - 1 - rad) : 0;
  const inY = y < rad ? rad - y : y > s - 1 - rad ? y - (s - 1 - rad) : 0;
  if (inX > 0 && inY > 0 && Math.hypot(inX, inY) > rad) return [0, 0, 0, 0];
  // 白色文档图形
  const pad = s * 0.22;
  if (x >= pad && x <= s - pad && y >= s * 0.16 && y <= s * 0.84) {
    const stripe = (y - s * 0.16) / (s * 0.68);
    if (
      stripe < 0.22 ||
      (stripe > 0.4 && stripe < 0.5) ||
      (stripe > 0.68 && stripe < 0.78)
    ) {
      // 横向条纹之间留白；本体做浅一点的蓝白
    }
    return [255, 255, 255, 235];
  }
  return bg;
}

const dir = path.join(__dirname, "..", "extension", "icons");
fs.mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, "icon" + s + ".png"), png(s, rgba));
  console.log("icon" + s + ".png");
}
