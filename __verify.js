'use strict';
/**
 * 自检工具  ——  npm run check
 *
 * 做三件事：
 *   1. 验证 lib/png.js 这个手写 PNG 编码器输出合法（它坏了托盘图标就起不来）
 *   2. 检查拆分后的**三份**素材清单合并结果，把常见错误提前挑出来
 *   3. 检查结构完整性：index.html 的加载顺序、模式模块的方法签名
 *
 * 第 2 项在你往清单里加图片的时候特别有用——它能抓住几类不看文档就会踩的坑，
 * 比如把 MP4 放进需要透明通道的槽位、动图忘了填 duration 等等。
 *
 * 本脚本只读不写。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const ASSETS_DIR = path.join(ROOT, 'assets');
const RENDERER_DIR = path.join(ROOT, 'renderer');

let problems = 0;
let warnings = 0;

const bad = (msg) => { problems++; console.log('  ✗ ' + msg); };
const warn = (msg) => { warnings++; console.log('  ! ' + msg); };
const good = (msg) => console.log('  ✓ ' + msg);

/** 用一个假的 window 把浏览器风格的脚本接下来执行。 */
function evalInFakeWindow(file) {
  const fakeWindow = {};
  new Function('window', fs.readFileSync(file, 'utf8'))(fakeWindow);
  return fakeWindow;
}

// ═══════════════════════════════════════════════════════════
//  第一部分：PNG 编码器
// ═══════════════════════════════════════════════════════════

function checkPng() {
  console.log('\n[1/3] PNG 编码器自检（托盘图标依赖它）\n');

  const { frogIconPNG } = require('./lib/png');

  // 用独立实现的 CRC32 交叉验证，而不是复用被测代码
  function refCrc32(buf) {
    let c, crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c = (crc ^ buf[i]) & 0xFF;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const SIZE = 32;
  const png = frogIconPNG(SIZE);

  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(SIG)) return bad('PNG 签名不正确');
  good('PNG 签名正确');

  let off = 8, crcOk = true;
  const types = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    const crc = png.readUInt32BE(off + 8 + len);
    if (crc !== refCrc32(png.subarray(off + 4, off + 8 + len))) crcOk = false;
    types.push(type);
    off += 12 + len;
  }
  if (!crcOk) bad('有 chunk 的 CRC 校验不通过');
  else good(`chunk 结构正常：${types.join(' → ')}（CRC 全部正确）`);

  if (off !== png.length) bad(`文件长度不自洽（${off} vs ${png.length}）`);
  else good('文件长度自洽');

  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  if (w !== SIZE || h !== SIZE || png[24] !== 8 || png[25] !== 6) {
    bad(`IHDR 异常：${w}×${h} 位深=${png[24]} 颜色类型=${png[25]}（应为 ${SIZE}×${SIZE} 位深=8 类型=6）`);
  } else {
    good(`IHDR 正确：${w}×${h}，位深 8，颜色类型 6 (RGBA)`);
  }

  // 解压像素数据，确认真的画出了内容而不是一片空白
  const idatPos = png.indexOf(Buffer.from('IDAT'));
  const idatLen = png.readUInt32BE(idatPos - 4);
  const raw = zlib.inflateSync(png.subarray(idatPos + 4, idatPos + 4 + idatLen));

  const stride = 1 + SIZE * 4;   // 每行开头有一个 filter 字节
  let opaque = 0, semi = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const a = raw[y * stride + 1 + x * 4 + 3];
      if (a > 250) opaque++;
      else if (a > 5) semi++;
    }
  }
  const total = SIZE * SIZE;
  if (opaque < 200) bad(`几乎没画出内容（不透明像素仅 ${opaque}/${total}）`);
  else good(`像素内容正常：不透明 ${opaque}/${total}，半透明边缘 ${semi} 像素（抗锯齿生效）`);
}

// ═══════════════════════════════════════════════════════════
//  第二部分：素材清单（三份合并）
// ═══════════════════════════════════════════════════════════

/**
 * 少数槽位「没有素材」时的实际行为**不是**退回占位奶蛙，这里说明一句免得误导。
 * 其余的 kind:'none' 都是真的会用占位素材。
 */
const NO_ASSET_NOTE = {
  run: '未提供素材 —— ⏸ 跑步功能已暂时取消（RUN_ENABLED=false），不会触发',
};

/**
 * 已知的叠加层槽位。
 *
 * 当前方案里**一个都没有**：打盹已取消，流汗改成了「换基础图」而不是叠加层。
 * 留空不影响检查——下面第二个循环会把所有实际声明的叠加层都送去体检。
 */
const OVERLAY_SLOTS = [];

/**
 * 按 index.html 约定的顺序加载三份清单。
 * 顺序错了合并结果就是错的，所以这里顺带把它变成一个「错误」而不是静默失效。
 */
function loadManifests() {
  const files = ['manifest.relax.js', 'manifest.work.js', 'manifest.js'];
  const perFile = {};
  const fakeWindow = {};

  for (const f of files) {
    const full = path.join(ASSETS_DIR, f);
    if (!fs.existsSync(full)) {
      bad(`缺少 assets/${f}`);
      return null;
    }
    try {
      // 三份共享同一个 fakeWindow，后一份能看到前一份挂上去的东西
      new Function('window', fs.readFileSync(full, 'utf8'))(fakeWindow);
      perFile[f] = fakeWindow;
    } catch (e) {
      bad(`assets/${f} 读取或解析失败：${e.message}`);
      return null;
    }
  }

  if (!fakeWindow.NAIWA_MANIFEST) {
    bad('assets/manifest.js 没有定义 window.NAIWA_MANIFEST（合并器没跑起来？）');
    return null;
  }
  return { merged: fakeWindow.NAIWA_MANIFEST, perFile };
}

/**
 * 某个槽位是在哪份清单里声明的。
 * 排查「我明明改了怎么没生效」时非常有用——一眼看出自己是不是改错了文件。
 */
function ownerOf(perFile, key, layer) {
  const bucketOf = (vars) => (layer === 'overlay' ? vars.overlays
    : layer === 'sound' ? vars.sounds : vars.animations);

  for (const [file, varName] of [
    ['manifest.relax.js', 'NAIWA_MANIFEST_RELAX'],
    ['manifest.work.js', 'NAIWA_MANIFEST_WORK'],
  ]) {
    const w = perFile[file];
    const vars = w && w[varName];
    if (!vars) continue;
    const bucket = bucketOf(vars);
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, key)) return file;
  }
  return 'manifest.js（共享）';
}

function checkManifest() {
  console.log('\n[2/3] 素材清单检查（三份合并）\n');

  const loaded = loadManifests();
  if (!loaded) return;
  const { merged: M, perFile } = loaded;

  good('三份清单（manifest.relax.js → manifest.work.js → manifest.js）合并成功');

  const anims = M.animations || {};
  const overlays = M.overlays || {};
  const sounds = M.sounds || {};

  const resolve = (p) => path.join(ASSETS_DIR, String(p).replace(/^\/+/, ''));

  /** 检查一个槽位的声明 */
  function checkSlot(name, s, layer) {
    const isOverlay = layer === 'overlay';
    const from = `  [${ownerOf(perFile, name, layer)}]`;

    if (!s || !s.kind || s.kind === 'none') {
      console.log(`  ·  ${name.padEnd(12)} ${NO_ASSET_NOTE[name] || ('使用内置占位素材' + from)}`);
      return;
    }

    if (s.kind === 'file') {
      if (!s.src) return bad(`${name}: kind 是 file 但没写 src`);
      const full = resolve(s.src);
      if (!fs.existsSync(full)) return bad(`${name}: 文件不存在 → assets/${s.src}`);

      const ext = path.extname(s.src).toLowerCase();
      const isVideo = ['.webm', '.mp4', '.mov', '.m4v', '.ogv'].includes(ext);

      // 坑 1：MP4 没有透明通道，放进透明窗口会显示成黑框
      if (ext === '.mp4' || ext === '.mov' || ext === '.m4v') {
        bad(`${name}: ${ext} 不支持透明通道，桌面上会显示成黑框或白框。` +
            `请转成 WebM (VP9+alpha) 或 PNG 序列帧，见 ASSETS.md 第 4 节`);
      }

      // 坑 2：循环动画用视频，白耗解码开销
      if (isVideo && s.loop) {
        warn(`${name}: 循环动画用视频比较费资源，GIF / 动画 WebP 更划算`);
      }

      const maybeAnimated = ext === '.gif' || ext === '.webp' || ext === '.apng';

      // 坑 3：单次播放的动图没填 duration，动画会和音效对不上
      if (!isVideo && maybeAnimated && !s.loop && !s.duration) {
        warn(`${name}: 单次播放的动图没填 duration。浏览器不暴露 GIF/WebP 时长，` +
             `代码不知道该何时算播完，动画会拖到默认时长。建议改用 WebM/序列帧，或手动填 duration`);
      }

      const kb = (fs.statSync(full).size / 1024).toFixed(0);
      const label = isVideo ? (s.loop ? '视频·循环' : '视频·单次')
                  : maybeAnimated ? (s.loop ? '动图·循环' : '动图·单次')
                  : '静态图';
      good(`${name.padEnd(12)} file  ${s.src}  (${kb} KB, ${label})${from}`);

      // 叠加层体检：中间区域必须是透明的，否则会把待机图整个盖住
      if (isOverlay) checkOverlayTransparency(name, full);

      // 命中区体检：声明的椭圆和实际轮廓对不对得上（换姿势忘改命中区就靠它抓）
      checkHitAgainstArt(name, s, M.hit);
      return;
    }

    if (s.kind === 'frames') {
      if (!s.dir || !s.count) return bad(`${name}: frames 需要 dir 和 count`);

      const dir = resolve(s.dir);
      if (!fs.existsSync(dir)) return bad(`${name}: 目录不存在 → assets/${s.dir}`);

      const pad = s.pad == null ? 4 : s.pad;
      const start = s.start == null ? 1 : s.start;
      const pattern = String(s.pattern || 'frame_{n}.png');

      let found = 0, bytes = 0;
      const missing = [];
      for (let i = 0; i < s.count; i++) {
        const n = String(start + i).padStart(pad, '0');
        const f = path.join(dir, pattern.replace('{n}', n));
        if (fs.existsSync(f)) { found++; bytes += fs.statSync(f).size; }
        else if (missing.length < 3) missing.push(path.basename(f));
      }

      if (found === 0) {
        bad(`${name}: 一张都没找到。检查 pattern / pad / start 和文件名编号是否对得上`);
      } else if (found < s.count) {
        warn(`${name}: 只找到 ${found}/${s.count} 张，缺 ${missing.join(', ')}${missing.length >= 3 ? ' …' : ''}`);
      } else {
        const mb = bytes / 1024 / 1024;
        const secs = (s.count / (s.fps || 12)).toFixed(2);

        // ── 体积提醒看的是**解码后的位图**，不是磁盘字节数 ──
        //
        // 序列帧每一张都会被挂成常驻 <img>（core/assets.js 的 framesLoader），
        // 真正吃资源的是 count × 单帧像素 × 4B 的位图；PNG 压得好不好不影响内存。
        //
        // 早先这里只比「磁盘总字节 > 2MB」。那是在大笑只有 26 帧（1.24MB）时定的，
        // 2026-10 大笑改成源片**整段 15.4 秒**（231 帧 / 10.86MB）之后必然被踩到，
        // 而它并不代表任何真实的资源问题 —— 一条永远亮着的提醒只会训练人忽略提醒。
        // 所以改成按位图给判断：200MB 以上才提醒（那条线是真的会拖慢桌宠的量级）。
        const f0 = path.join(dir, pattern.replace('{n}', String(start).padStart(pad, '0')));
        const info = fs.existsSync(f0) ? readPngInfo(f0) : null;
        const memMB = info ? (s.count * info.w * info.h * 4) / 1048576 : 0;

        good(`${name.padEnd(12)} frames  ${s.count} 张 @ ${s.fps || 12}fps` +
             `${s.loop ? ', 循环' : ', 单次'}  ${mb.toFixed(2)} MB / ${secs}s` +
             (memMB ? `，解码后约 ${memMB.toFixed(0)} MB` : '') + from);
        if (memMB > 200) {
          warn(`${name}: 序列帧解码后约 ${memMB.toFixed(0)} MB 位图` +
               `（${s.count} 帧 × ${info.w}×${info.h}），常驻成本偏高，考虑降帧数或降分辨率`);
        }
        if (mb > 24) {
          warn(`${name}: 序列帧磁盘总大小 ${mb.toFixed(2)} MB，超过建议的 24 MB`);
        }
        if (isOverlay) {
          const n0 = String(start).padStart(pad, '0');
          const f0 = path.join(dir, pattern.replace('{n}', n0));
          if (fs.existsSync(f0)) checkOverlayTransparency(name, f0);
        }
      }
      return;
    }

    if (s.kind === 'sheet') {
      if (!s.src) return bad(`${name}: sheet 需要 src`);
      const full = resolve(s.src);
      if (!fs.existsSync(full)) return bad(`${name}: 文件不存在 → assets/${s.src}`);
      const kb = (fs.statSync(full).size / 1024).toFixed(0);
      good(`${name.padEnd(12)} sheet  ${s.src}  (${kb} KB, ${s.count || '?'} 帧)${from}`);
      return;
    }

    bad(`${name}: 未识别的 kind「${s.kind}」，只能是 file / frames / sheet / none`);
  }

  /** 叠加层体检：中心区域必须是透明的，否则会把待机图整个盖住。 */
  function checkOverlayTransparency(name, file) {
    if (path.extname(file).toLowerCase() !== '.png') return;  // 只有 PNG 能便宜地读像素
    try {
      const stat = readPngInfo(file);
      if (!stat) return;
      const pct = (stat.centerOpaqueRatio * 100).toFixed(0);
      if (stat.centerOpaqueRatio > 0.35) {
        warn(`${name}: 中心区域有 ${pct}% 的像素不透明。叠加层应该是「只画特效本身、` +
             `其余全透明」，画一整只奶蛙会把待机图盖住`);
      } else {
        good(`${name.padEnd(12)} 叠加层中心透明度过关（不透明像素 ${pct}%）`);
      }
    } catch { /* 读不动就算了，不因为这个报错 */ }
  }

  /**
   * 命中区体检：把**声明的椭圆**和**素材实际的轮廓**对一下。
   *
   * 这是唯一能自动抓住「换了姿势但忘了改命中区」的检查。
   * 那个缺口的表现是「看得见点不到」，但用户只会以为是自己没点准——
   * 所以必须由工具来发现，不能指望人肉量。
   *
   * 实测会命中的例子：`idle_work` 宽 262px，而共享的命中椭圆换算到画布只有 152px，
   * 两侧各约 27.5 CSS px 点不到。
   */
  function checkHitAgainstArt(slotName, s, fallbackHit) {
    if (!s || s.kind !== 'file') return;
    if (path.extname(String(s.src || '')).toLowerCase() !== '.png') return;

    const full = resolve(s.src);
    if (!fs.existsSync(full)) return;

    const hit = s.hit || fallbackHit;
    if (!hit || hit.type !== 'ellipse') return;

    let info;
    try { info = readPngInfo(full); } catch { return; }
    if (!info || !info.bbox) return;

    // 都归一化成「相对显示区宽度的比例」
    const artW = (info.bbox.x2 - info.bbox.x1 + 1) / info.w;
    const hitW = hit.rx * 2;
    if (!hitW || !artW) return;

    const ratio = artW / hitW;   // >1 = 主体比椭圆宽

    if (ratio > 1.15) {
      const suggest = `hit: { type:'ellipse', x:${hit.x}, y:${hit.y}, ` +
                      `rx:${(artW / 2).toFixed(2)}, ry:${hit.ry} }`;
      warn(`${slotName}: 命中椭圆比主体窄约 ${((1 - 1 / ratio) * 100).toFixed(0)}%` +
           `（主体占显示区宽 ${(artW * 100).toFixed(0)}%，椭圆只有 ${(hitW * 100).toFixed(0)}%）。` +
           `两侧会「看得见点不到」，点到的是桌面。可以在这个槽位里加 ${suggest}`);
    } else if (ratio < 0.8) {
      warn(`${slotName}: 命中椭圆比主体宽约 ${((1 / ratio - 1) * 100).toFixed(0)}%，` +
           `多出来的透明区域会挡住桌面点击。建议调小 rx`);
    } else {
      good(`${slotName.padEnd(12)} 命中椭圆与主体宽度匹配` +
           `（主体 ${(artW * 100).toFixed(0)}% / 椭圆 ${(hitW * 100).toFixed(0)}%）` +
           (s.hit ? '' : '  ← 用的是共享 hit'));
    }
  }

  console.log('  基础动画：');
  Object.keys(anims).forEach((k) => checkSlot(k, anims[k], 'anim'));

  console.log('\n  叠加特效：');
  OVERLAY_SLOTS.forEach((k) => { if (overlays[k]) checkSlot(k, overlays[k], 'overlay'); });
  Object.keys(overlays).forEach((k) => {
    if (!OVERLAY_SLOTS.includes(k)) checkSlot(k, overlays[k], 'overlay');
  });

  // 必需槽位是否齐全
  console.log('');
  const REQUIRED = ['idle_relax', 'idle_work', 'laugh'];
  const absent = REQUIRED.filter((k) => !anims[k]);
  if (absent.length) warn(`清单里没有这些必需槽位：${absent.join(', ')}（会一直用占位素材）`);

  // 音频
  const soundKeys = Object.keys(sounds);
  if (!soundKeys.length) {
    console.log('  ·  音效          全部使用内置合成音效（无需素材）');
  } else {
    soundKeys.forEach((k) => {
      const full = resolve(sounds[k]);
      if (!fs.existsSync(full)) bad(`音效 ${k}: 文件不存在 → assets/${sounds[k]}`);
      else good(`音效 ${k}  ${sounds[k]}  [${ownerOf(perFile, k, 'sound')}]`);
    });
  }

  // 命中区域体检
  const hit = M.hit;
  if (hit && hit.type === 'ellipse') {
    // rx / ry 是相对显示区宽高的比例，所以归一化到 [0,1]² 后
    // 椭圆面积就是 π·rx·ry，而显示区面积是 1
    const cover = Math.PI * hit.rx * hit.ry;
    if (cover > 0.80) {
      warn(`命中椭圆覆盖了显示区约 ${(cover * 100).toFixed(0)}%，偏大，` +
           `透明区域可能会挡住桌面点击。建议调小 rx / ry`);
    } else if (cover < 0.20) {
      warn(`命中椭圆只覆盖显示区约 ${(cover * 100).toFixed(0)}%，偏小，奶蛙会不好点中`);
    } else {
      good(`命中椭圆覆盖显示区约 ${(cover * 100).toFixed(0)}%，合理`);
    }
    good(`命中椭圆：中心 (${hit.x}, ${hit.y})，半径 (${hit.rx}, ${hit.ry})`);
  } else if (hit && hit.type === 'rect') {
    warn('命中区域用矩形的话，窗口四角的透明区也会挡住桌面点击，建议改成 ellipse');
  }
}

/**
 * PNG 行反滤波。
 *
 * ⚠️ 这一步**不能省**。PNG 每行开头有一个 filter 字节，像素存的是**滤波后的增量**，
 * 不是真实值。早期版本直接跳过那个字节当像素读——碰到 filter≠0 的行读出来的全是垃圾。
 * 而实测这三张素材用的就是自适应滤波（0/1/2/4 四种都有），所以那个版本一直在产出
 * **错误的数字**。之所以一直没暴露，是因为当时没有任何槽位声明为叠加层，
 * 依赖它的那条体检从来没真正跑过。
 *
 * 教训：一个从没被执行过的检查，等于没有检查。
 */
function unfilterPng(raw, w, h, bpp) {
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);   // 第一行「上面」按全 0 处理

  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);   // 视图，写它就是写 out

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;    // 左
      const b = prev[i];                        // 上
      const c = i >= bpp ? prev[i - bpp] : 0;   // 左上
      let v = src[i];
      switch (ft) {
        case 0: break;                                    // None
        case 1: v = (v + a) & 0xff; break;                // Sub
        case 2: v = (v + b) & 0xff; break;                // Up
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;   // Average
        case 4: {                                         // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 0xff;
          break;
        }
        default: throw new Error('未知的 PNG 滤波类型: ' + ft);
      }
      cur[i] = v;
    }
    prev = cur;
  }
  return out;
}

/**
 * 读 PNG 的尺寸、中心区不透明比例、以及**非透明像素的包围盒**。
 * 只支持 8 位 RGBA / 灰度+alpha；其余返回 null。
 */
function readPngInfo(file) {
  const buf = fs.readFileSync(file);
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) return null;

  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idats = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h || bitDepth !== 8 || (colorType !== 6 && colorType !== 4)) return null;

  const raw = zlib.inflateSync(Buffer.concat(idats));
  const bpp = colorType === 6 ? 4 : 2;
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) return null;

  const px = unfilterPng(raw, w, h, bpp);

  const cx0 = Math.floor(w / 3), cx1 = Math.floor(w * 2 / 3);
  const cy0 = Math.floor(h / 3), cy1 = Math.floor(h * 2 / 3);
  let centerOpaque = 0, centerTotal = 0;
  let bx1 = w, bx2 = -1, by1 = h, by2 = -1;

  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const inCenterRow = (y >= cy0 && y < cy1);
    for (let x = 0; x < w; x++) {
      const a = px[row + x * bpp + (bpp - 1)];

      if (inCenterRow && x >= cx0 && x < cx1) {
        centerTotal++;
        if (a > 40) centerOpaque++;
      }
      if (a > 40) {
        if (x < bx1) bx1 = x;
        if (x > bx2) bx2 = x;
        if (y < by1) by1 = y;
        if (y > by2) by2 = y;
      }
    }
  }

  return {
    w, h,
    centerOpaqueRatio: centerTotal ? centerOpaque / centerTotal : 0,
    bbox: bx2 >= 0 ? { x1: bx1, x2: bx2, y1: by1, y2: by2 } : null,
  };
}

// ═══════════════════════════════════════════════════════════
//  第三部分：结构完整性
// ═══════════════════════════════════════════════════════════

/** index.html 里脚本的必需顺序（前面必须在后面之前）。 */
const REQUIRED_SCRIPT_ORDER = [
  '../assets/manifest.relax.js',
  '../assets/manifest.work.js',
  '../assets/manifest.js',
  'core/audio.js',
  'core/assets.js',
  'core/pet.js',
  'panels.js',
  'modes/relax.js',
  'modes/work.js',
  'app.js',
];

/** 模式模块必须实现的成员（00-协作约定.md 第 3 节）。 */
const MODE_MEMBERS = [
  'id', 'label', 'activate', 'deactivate',
  'onClick', 'onPointerMove', 'onCpu', 'onIdleTick', 'onPanelToggled', 'assetSlots',
];

function checkStructure() {
  console.log('\n[3/3] 结构完整性\n');

  // ── 分层文件是否都在 ──
  const REQUIRED_FILES = [
    'main.js', 'preload.js', 'lib/png.js', '__verify.js',
    'renderer/index.html', 'renderer/app.js', 'renderer/panels.js',
    'renderer/core/style.css', 'renderer/core/assets.js',
    'renderer/core/audio.js', 'renderer/core/pet.js',
    'renderer/modes/relax.js', 'renderer/modes/relax.css',
    'renderer/modes/work.js', 'renderer/modes/work.css',
    'assets/manifest.js', 'assets/manifest.relax.js', 'assets/manifest.work.js',
  ];
  const missingFiles = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missingFiles.length) bad(`缺少这些文件：${missingFiles.join(', ')}`);
  else good('分层结构齐全（core / modes / 三份清单 都在）');

  // 拆分前的旧位置不该再留着
  const LEGACY = ['renderer/style.css', 'renderer/assets.js', 'renderer/audio.js', 'renderer/pet.js'];
  const leftovers = LEGACY.filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (leftovers.length) {
    warn(`这些是拆分前的旧位置，应该已经搬进 core/ 了：${leftovers.join(', ')}`);
  }

  // ── index.html 加载顺序 ──
  let html = '';
  try {
    html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  } catch (e) {
    return bad(`renderer/index.html 读不了：${e.message}`);
  }

  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const positions = REQUIRED_SCRIPT_ORDER.map((s) => ({ s, i: scripts.indexOf(s) }));

  const absent = positions.filter((p) => p.i < 0);
  if (absent.length) {
    bad(`index.html 里没有加载：${absent.map((p) => p.s).join(', ')}`);
  } else {
    let ordered = true;
    for (let i = 1; i < positions.length; i++) {
      if (positions[i].i < positions[i - 1].i) {
        bad(`index.html 加载顺序错了：${positions[i].s} 必须排在 ${positions[i - 1].s} 之前`);
        ordered = false;
      }
    }
    if (ordered) good('index.html 加载顺序正确（分清单 → 合并器 → core → panels → modes → app）');
  }

  // 样式表也该分三层
  const links = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map((m) => m[1]);
  for (const css of ['core/style.css', 'modes/relax.css', 'modes/work.css']) {
    if (!links.includes(css)) bad(`index.html 没有引入样式表 ${css}`);
  }
  if (links.includes('core/style.css') && links.includes('modes/relax.css')) {
    good('三份样式表都引入了（core / relax / work）');
  }

  // ── 模式模块的签名 ──
  const modeMods = {};
  for (const id of ['relax', 'work']) {
    const file = path.join(RENDERER_DIR, 'modes', `${id}.js`);
    let w;
    try {
      w = evalInFakeWindow(file);
    } catch (e) {
      bad(`renderer/modes/${id}.js 解析失败：${e.message}`);
      continue;
    }
    const mod = w.Naiwa && w.Naiwa.Modes && w.Naiwa.Modes[id];
    if (!mod) { bad(`renderer/modes/${id}.js 没有挂出 window.Naiwa.Modes.${id}`); continue; }
    modeMods[id] = mod;

    if (mod.id !== id) bad(`modes/${id}.js 的 id 是「${mod.id}」，应为「${id}」`);
    const lacks = MODE_MEMBERS.filter((m) => mod[m] === undefined);
    if (lacks.length) bad(`modes/${id}.js 缺少成员：${lacks.join(', ')}`);
    else good(`modes/${id}.js 方法签名齐全（${MODE_MEMBERS.length} 项）`);

    if (!Array.isArray(mod.assetSlots) || !mod.assetSlots.length) {
      warn(`modes/${id}.js 的 assetSlots 是空的，自检工具没法核对它要哪些素材`);
    }
  }

  // ── 模式声明的素材槽位有没有在清单里出现 ──
  const loaded = loadManifests();
  if (loaded) {
    const known = new Set([
      ...Object.keys(loaded.merged.animations || {}),
      ...Object.keys(loaded.merged.overlays || {}),
    ]);
    for (const id of Object.keys(modeMods)) {
      const slots = modeMods[id].assetSlots;
      if (!Array.isArray(slots)) continue;
      const unknown = slots.filter((k) => !known.has(k));
      if (unknown.length) {
        warn(`modes/${id}.js 声明了槽位 ${unknown.join(', ')}，但清单里没有这些键（会一直用占位素材）`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════

console.log('奶蛙桌宠 · 自检');
console.log('='.repeat(56));

checkPng();
checkManifest();
checkStructure();

console.log('\n' + '='.repeat(56));
if (problems) {
  console.log(`结果：${problems} 个错误，${warnings} 个提醒 —— 错误需要修掉`);
  process.exit(1);
} else if (warnings) {
  console.log(`结果：全部通过，${warnings} 个提醒 —— 不影响运行，有空再看`);
} else {
  console.log('结果：全部通过 ✓');
}