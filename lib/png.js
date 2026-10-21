'use strict';
/**
 * 极简 PNG 编码器 —— 只为现场生成托盘图标。
 *
 * 为什么要自己写：托盘图标需要一个真实的位图，而这时候项目里还没有任何
 * 图片素材。用 Node 自带的 zlib 手搓一个 PNG，就能让程序在「零素材」状态下
 * 也正常跑起来，不需要你为了托盘先去准备一张 ico。
 *
 * 等你有正式图标了，把这个文件删掉，改成本地 png/ico 即可。
 */

const zlib = require('zlib');

// ── CRC32（PNG 每个 chunk 都要校验） ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, body])), 0);
  return Buffer.concat([len, t, body, crc]);
}

/**
 * 用 pixelFn(x, y, size) -> [r,g,b,a] 生成尺寸为 size×size 的 PNG Buffer。
 * 每行前加一个 0 字节是 PNG 的 filter 标记（0 = None）。
 */
function encodePNG(size, pixelFn) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const p = pixelFn(x, y, size);
      raw[o++] = p[0] & 0xff;
      raw[o++] = p[1] & 0xff;
      raw[o++] = p[2] & 0xff;
      raw[o++] = p[3] & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 6 = RGBA
  ihdr[10] = 0;  // 压缩方法
  ihdr[11] = 0;  // 滤波方法
  ihdr[12] = 0;  // 隔行扫描

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ───────────────────────── 奶蛙头像 ─────────────────────────

const COL = {
  outline: [74, 63, 53],
  body: [255, 244, 227],
  shade: [250, 228, 202],
  eye: [255, 255, 255],
  pupil: [58, 48, 40],
  blush: [255, 173, 158],
};

function ellipse(px, py, cx, cy, rx, ry) {
  const dx = (px - cx) / rx;
  const dy = (py - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

/** 在 0..1 归一化坐标里判断每个像素该涂什么颜色，返回 [r,g,b,a]。 */
function sampleFrog(px, py) {
  // 三段式：身体 + 头顶两个眼睛凸起（蛙类的标志性轮廓）
  const silhouette = (x, y, k) =>
    ellipse(x, y, 0.50, 0.62, 0.45 * k, 0.35 * k) ||
    ellipse(x, y, 0.29, 0.31, 0.180 * k, 0.180 * k) ||
    ellipse(x, y, 0.71, 0.31, 0.180 * k, 0.180 * k);

  if (!silhouette(px, py, 1.00)) return [0, 0, 0, 0];        // 完全透明
  if (!silhouette(px, py, 0.87)) return [...COL.outline, 255]; // 外描边

  // 眼睛
  const inEye = ellipse(px, py, 0.29, 0.31, 0.160, 0.160) || ellipse(px, py, 0.71, 0.31, 0.160, 0.160);
  if (inEye) {
    const inPupil = ellipse(px, py, 0.315, 0.345, 0.078, 0.078) || ellipse(px, py, 0.685, 0.345, 0.078, 0.078);
    if (inPupil) return [...COL.pupil, 255];
    const inGlint = ellipse(px, py, 0.272, 0.278, 0.034, 0.034) || ellipse(px, py, 0.642, 0.278, 0.034, 0.034);
    if (inGlint) return [255, 255, 255, 255];
    return [...COL.eye, 255];
  }

  // 腮红
  if (ellipse(px, py, 0.185, 0.635, 0.080, 0.055) || ellipse(px, py, 0.815, 0.635, 0.080, 0.055)) {
    return [...COL.blush, 255];
  }

  // 微笑：一条抛物线
  const mx = (px - 0.5) / 0.25;
  if (Math.abs(mx) <= 1) {
    const my = 0.665 + 0.115 * mx * mx;
    if (Math.abs(py - my) < 0.030) return [...COL.outline, 255];
  }

  // 身体，下半略深一点做出体积感
  return py > 0.68 ? [...COL.shade, 255] : [...COL.body, 255];
}

/**
 * 生成奶蛙托盘图标。
 * 用 3×3 超采样做抗锯齿 —— 托盘图标通常只有 16~32px，
 * 不抗锯齿的话边缘会很难看。
 */
function frogIconPNG(size = 32) {
  const SS = 3;
  const n = SS * SS;

  return encodePNG(size, (x, y) => {
    let r = 0, g = 0, b = 0, a = 0;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = (x + (sx + 0.5) / SS) / size;
        const py = (y + (sy + 0.5) / SS) / size;
        const c = sampleFrog(px, py);
        const al = c[3] / 255;
        r += c[0] * al;
        g += c[1] * al;
        b += c[2] * al;
        a += al;
      }
    }

    if (a <= 0.0001) return [0, 0, 0, 0];

    // a 是覆盖度之和，用它反解出未预乘的颜色，避免边缘发黑
    return [
      Math.round(r / a),
      Math.round(g / a),
      Math.round(b / a),
      Math.round((a / n) * 255),
    ];
  });
}

module.exports = { encodePNG, frogIconPNG };