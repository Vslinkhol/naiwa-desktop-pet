'use strict';
/* ============================================================================
 * 奶蛙桌宠 · 验收探针（真实窗口 / 真实像素 / 真实心跳）
 * ============================================================================
 *
 * 运行：
 *     cd naiwa-pet
 *     npm run probe            （等价于 npx electron --no-sandbox __probe.js）
 *
 * 它验收四件事：
 *   #1/#3 静态待机图必须露出奶蛙全身，且与大笑时的位置、大小一致
 *   #2    大笑必须播**完整片段**（帧数×fps ≥ 源视频时长，且真的播完）
 *   #4    「闲置久了自动说话」必须已经不冒台词（含反向测试）
 *
 * 为什么需要它（而不是靠读 CSS/JS 下结论）：
 *   2026-10 用户报「静态待机图被裁成半身、且大小是大笑时的 2 倍」，
 *   根因是 core/style.css 里那条撑满规则写成了 `.pet-layer > img`（直接子元素），
 *   而真实 DOM 是 #pet-base(.pet-layer) → holder div → img，img 是**孙子**，
 *   规则从来没命中过。img 于是按原始 380x380 渲染进 190x190 的窗口，
 *   只露出左上四分之一。
 *   这种「样式选择器没命中」的 bug，读代码很容易看漏，**必须让机器量出来**。
 *
 * 它量什么：
 *   1. CSSOM 层面：img 到底匹不匹配 `.pet-layer > img` / `.pet-layer img`
 *   2. DOM 层面：素材元素的实际 rect 是否等于 #pet 的 190x190
 *   3. 像素层面：capturePage() 抓真实渲染结果，算奶蛙前景包围盒，
 *      再和「源素材里奶蛙的包围盒」按比例换算的理论值对比
 *
 * 判定（relax / work 两种模式各跑一遍）：
 *   · 素材元素必须正好铺满 #pet（190x190），且与 #pet 同原点
 *   · 奶蛙前景高度必须 ≈ 152 CSS px（= 304/380 × 190），误差 ≤ 6%
 *   · 脚底 y ≈ 174 CSS px（= 348/380 × 190）、水平中心 ≈ 95（#pet 中心），误差 ≤ 4px
 *   · 前景包围盒**必须完整落在 #pet 盒内** → 证明「没被裁掉」
 *   · 静态待机 vs 大笑首帧：高度差 ≤ 6%，脚底 / 中心差 ≤ 4px
 *
 * ⚠️ 一条踩过的坑：抓图前必须调 prep() 收掉启动 toast。不收起时前景包围盒会把
 * toast 和奶蛙**并成一个**（#toast 是深色实心药丸，顶边正好在 y≈412），
 * 于是「高度」「中心」全是错数 —— 而且错得看起来还挺像「有问题」，
 * 正反两个方向都可能得出错误结论。
 *
 * 环境事实（和 __smoke.js 相同，见 docs/04 第 3 节）：
 *   本机 Chromium 沙箱不可用，必须 --no-sandbox；%TEMP% 写入被拒，
 *   temp / userData / cache 必须改到工作区下，且要在 require('./main.js') 之前。
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const PROJECT = __dirname;
const WORKSPACE = path.dirname(PROJECT);
const TMP = process.env.PROBE_TMP_DIR
  ? path.resolve(process.env.PROBE_TMP_DIR)
  : path.join(WORKSPACE, '.naiwa-probe-tmp');

for (const sub of ['temp', 'userdata', 'cache', 'crash']) {
  try { fs.mkdirSync(path.join(TMP, sub), { recursive: true }); } catch (e) { /* 忽略 */ }
}
process.env.TEMP = path.join(TMP, 'temp');
process.env.TMP = process.env.TEMP;
process.env.TMPDIR = process.env.TEMP;

const { app, BrowserWindow } = require('electron');

try { app.setPath('temp', process.env.TEMP); } catch (e) { /* 忽略 */ }
try { app.setPath('userData', path.join(TMP, 'userdata')); } catch (e) { /* 忽略 */ }
try { app.setPath('crashDumps', path.join(TMP, 'crash')); } catch (e) { /* 忽略 */ }
try { app.setPath('sessionData', path.join(TMP, 'cache')); } catch (e) { /* 忽略 */ }
app.commandLine.appendSwitch('disk-cache-dir', path.join(TMP, 'cache'));
app.commandLine.appendSwitch('crash-dumps-dir', path.join(TMP, 'crash'));

// ───────────────────────── 期望值（由素材实测数据推出） ─────────────────────────
//
// 三个来源素材统一在 380x380 画布上，奶蛙站立高度 304px、脚底 y=348、中心 x=190
// （见 .assetwork/README.md「定标」一节）。显示区是 190x190，所以：
const SRC = 380;                 // 素材画布边长
const PET = 190;                 // 显示区边长（core/style.css 的 .pet）
const FROG_H = 304, FEET_Y = 348, CENTER_X = 190;
const K = PET / SRC;             // 380 → 190 的换算系数 = 0.5
const EXP = {
  frogH: FROG_H * K,             // 152   奶蛙前景应有的高度（CSS px）
  feetY: FEET_Y * K,             // 174   脚底相对 #pet 顶部的 y
  centerX: CENTER_X * K,         // 95    = #pet 的水平中心
};
const TOL_H = 0.06;              // 高度相对误差上限 6%
const TOL_POS = 4;               // 位置绝对误差上限 4 CSS px

// ───────────────────────── 输出 ─────────────────────────

let finished = false;
const results = [];
function check(name, ok, evidence) {
  results.push({ name, ok, evidence });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} — ${evidence}`);
}
function info(msg) { console.log('  ' + msg); }
function finish(code, keepAlive) {
  if (finished) return;
  finished = true;
  const fail = results.filter((r) => !r.ok).length;
  console.log('\n' + '='.repeat(78));
  console.log(` 布局探针结果：${results.length - fail}/${results.length} 通过，${fail} 失败`);
  console.log('='.repeat(78));
  try { fs.writeFileSync(path.join(TMP, 'probe-result.json'), JSON.stringify(results, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
  // keepAlive：不退出，留给「退出按钮」那一项去验证进程能不能自己结束
  if (keepAlive) return;
  app.exit(code == null ? (fail ? 1 : 0) : code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 前景包围盒是否完整落在 #pet 的 190x190 盒子里（四边各留 0.5px）。
 *
 * 这就是用户说的「露出全身、不裁成半身」的可判定形式：
 * 裁掉一半时包围盒必然贴住盒子边界，甚至越过。
 */
function insidePet(bb, petPos) {
  return bb.x0 >= petPos.x + 0.5 && bb.x1 <= petPos.x + PET - 0.5
      && bb.y0 >= petPos.y + 0.5 && bb.y1 <= petPos.y + PET - 0.5;
}

// ───────────────────────── 页面侧取数 ─────────────────────────

const PAGE_LIB = function () {
  const r2 = (v) => Math.round(v * 100) / 100;
  window.__PROBE__ = {
    /** 布局快照：素材元素 rect、CSSOM 命中情况、当前基础动画 */
    snapshot() {
      const pet = document.getElementById('pet');
      const pr = pet.getBoundingClientRect();
      const layers = [];
      document.querySelectorAll('#pet-base > *').forEach((holder) => {
        const child = holder.firstElementChild;
        if (!child) return;
        const cr = child.getBoundingClientRect();
        const cs = getComputedStyle(child);
        layers.push({
          anim: holder.dataset.anim,
          tag: child.tagName,
          opacity: holder.style.opacity,
          rect: { x: r2(cr.x - pr.x), y: r2(cr.y - pr.y), w: r2(cr.width), h: r2(cr.height) },
          css: { w: cs.width, h: cs.height, objectFit: cs.objectFit },
          natural: child.naturalWidth ? [child.naturalWidth, child.naturalHeight]
            : (child.width ? [child.width, child.height] : null),
        });
      });
      const img = document.querySelector('#pet-base img');
      const canvas = document.querySelector('#pet-base canvas');
      return {
        pet: { w: r2(pr.width), h: r2(pr.height) },
        active: window.Naiwa.Pet.currentAnim,
        isReacting: window.Naiwa.Pet.isReacting,
        layers,
        // ★ 直接问 CSSOM：这条规则到底命中了没有
        selHit: {
          child: img ? img.matches('.pet-layer > img') : null,
          descendant: img ? img.matches('.pet-layer img') : null,
        },
        canvasCss: canvas ? [getComputedStyle(canvas).width, getComputedStyle(canvas).height] : null,
        imgCss: img ? [getComputedStyle(img).width, getComputedStyle(img).height] : null,
      };
    },
    /** 当前窗口里 #pet 的矩形（客户端坐标），用来在奶蛙身上派发点击 */
    petRect() {
      const r = document.getElementById('pet').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    /**
     * 抓图前的清场：把**和奶蛙无关的**不透明元素收掉。
     *
     * ⚠️ 这条是踩出来的：不收起启动 toast（#toast 是深色实心药丸，
     * bottom:200px → 顶边正好在 y≈412）时，前景包围盒会把 toast 和奶蛙
     * **并成一个**，于是「高度」「中心」全是错数——而这种错数看起来还挺像
     * 「有问题」，很容易被当成修复失败的证据，反向也一样会假通过。
     */
    prep() {
      const t = document.getElementById('toast');
      if (t) t.hidden = true;
      const b = document.getElementById('pet-bubble');
      if (b) b.hidden = true;
      const p = document.getElementById('panel');
      if (p) p.hidden = true;
      return {
        toast: t ? t.hidden : null,
        bubble: b ? b.hidden : null,
        panel: p ? p.hidden : null,
        scrollY: window.scrollY,
      };
    },
    /** 直接播一次大笑（布局探针专用：工作模式的点击是开面板，不经过笑） */
    playLaugh() { return window.Naiwa.Pet.playOnce('laugh', {}); },

    // ── 右键操作窗 / 拖拽（第五次会话） ──

    /** 在奶蛙身上派发右键：double=false 弹操作窗，double=true 切模式。 */
    rightClick(double) {
      const r = document.getElementById('pet').getBoundingClientRect();
      const x = r.left + r.width * 0.5, y = r.top + r.height * 0.52;
      const fire = () => {
        const el = document.elementFromPoint(x, y) || document.body;
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
      };
      fire();
      if (!double) return { x: x, y: y, double: false };
      return new Promise((res) => setTimeout(() => { fire(); res({ x: x, y: y, double: true }); }, 120));
    },
    /** 操作窗状态。 */
    menuState() {
      const el = document.getElementById('pet-menu');
      if (!el) return { exists: false };
      const items = Array.prototype.map.call(el.querySelectorAll('.menu-item'), (b) => ({
        act: b.getAttribute('data-act'), text: b.textContent, hidden: !!b.hidden,
      }));
      const r = el.getBoundingClientRect();
      return {
        exists: true,
        hidden: !!el.hidden,
        open: !!(window.Naiwa && window.Naiwa.App && window.Naiwa.App.menuOpen),
        items: items,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        quitWired: typeof (window.naiwa && window.naiwa.quit) === 'function',
      };
    },
    /** 把光标（用真实事件）挪到窗口内某点。 */
    moveMouse(x, y) {
      const el = document.elementFromPoint(x, y) || document.body;
      ['pointermove', 'mousemove'].forEach((t) => {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      });
      return true;
    },
    /** 在奶蛙身上按住并拖出足够距离（>6px 才会被判定为拖拽）。 */
    dragBegin() {
      const r = document.getElementById('pet').getBoundingClientRect();
      const x = r.left + r.width * 0.5, y = r.top + r.height * 0.52;
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
      for (let i = 1; i <= 20; i++) {
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x + i * 3, clientY: y + i, button: 0, buttons: 1 }));
      }
      return { x: x, y: y };
    },
    dragEnd() {
      const r = document.getElementById('pet').getBoundingClientRect();
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, clientX: r.left + r.width * 0.5 + 60, clientY: r.top + r.height * 0.52 + 20, button: 0, buttons: 0,
      }));
      return true;
    },
    /** 派发一次真实点击（mousedown + mouseup 同点），app.js 会走完整 onClick 路径 */
    clickPet() {
      const r = document.getElementById('pet').getBoundingClientRect();
      const x = r.x + r.width * 0.5, y = r.y + r.height * 0.52;
      const mk = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      document.dispatchEvent(mk('mousedown'));
      document.dispatchEvent(mk('mouseup'));
      return { x: r2(x), y: r2(y) };
    },
    setMode(m) { return window.Naiwa.App.applyMode(m, { announce: false, silent: true }); },

    // ── 大笑「完整片段」用（#2） ──

    /** 读 manifest 里 laugh 的声明（帧数 / fps）。 */
    laughSpec() {
      const a = (window.NAIWA_MANIFEST && window.NAIWA_MANIFEST.animations
        && window.NAIWA_MANIFEST.animations.laugh) || null;
      return a ? { kind: a.kind, count: a.count || 0, fps: a.fps || 0, start: a.start || 1, loop: !!a.loop } : null;
    },
    /**
     * 播一次大笑，量两件事：
     *   ms     —— playOnce 返回的**预计**时长（内部用的就是素材自带时长）
     *   wallMs —— 从起播到 isReacting 变回 false 的**真实**耗时
     */
    async laughTiming() {
      const P = window.Naiwa.Pet;
      const t0 = performance.now();
      const ms = await P.playOnce('laugh', {});
      let wallMs = null;
      while (performance.now() - t0 < 40000) {
        if (!P.isReacting) { wallMs = performance.now() - t0; break; }
        await new Promise((r) => setTimeout(r, 60));
      }
      return { ms, wallMs: wallMs == null ? null : Math.round(wallMs) };
    },

    // ── 闲置自动说话用（#4） ──

    /**
     * 盯住气泡 ms 毫秒，返回期间有没有出现过台词。
     * 用轮询而不是 MutationObserver：气泡是切 hidden 属性，轮询足够且实现简单
     * （say 的展示时长是 2200ms 量级，100ms 粒度不会漏）。
     */
    async watchBubble(ms) {
      const b = document.getElementById('pet-bubble');
      const texts = [];
      let appeared = false;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        if (b && !b.hidden) {
          appeared = true;
          if (texts.indexOf(b.textContent) === -1) texts.push(b.textContent);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { appeared, texts, ms };
    },
    /**
     * 把「闲置自动说话」的触发条件调到**下一次空闲心跳必然触发**：阈值 0 + 概率 1。
     *
     * 为什么必须这样：原概率是 6%，随便跑一会儿很可能一次都不冒——
     * 那种检查既测不出「还开着」，也证明不了「已经关掉」，是典型的空检查。
     * 调到必然触发之后，开关关着就**一定**不冒、开着就**一定**冒。
     */
    armIdleTalk() {
      const C = window.Naiwa.Modes.relax.config;
      window.__PROBE__.cfgBackup = {
        on: C.IDLE_TALK_ENABLED, min: C.IDLE_LINE_MIN_MS, chance: C.IDLE_LINE_CHANCE,
      };
      C.IDLE_LINE_MIN_MS = 0;
      C.IDLE_LINE_CHANCE = 1;
      return { enabled: C.IDLE_TALK_ENABLED, min: C.IDLE_LINE_MIN_MS, chance: C.IDLE_LINE_CHANCE };
    },
    /** 反向测试用：把开关强行打开（退出前由 restoreIdleTalk 还原）。 */
    forceIdleTalk(on) {
      window.Naiwa.Modes.relax.config.IDLE_TALK_ENABLED = !!on;
      return window.Naiwa.Modes.relax.config.IDLE_TALK_ENABLED;
    },
    restoreIdleTalk() {
      const C = window.Naiwa.Modes.relax.config;
      const b = window.__PROBE__.cfgBackup;
      if (b) {
        C.IDLE_TALK_ENABLED = b.on;
        C.IDLE_LINE_MIN_MS = b.min;
        C.IDLE_LINE_CHANCE = b.chance;
      }
      const el = document.getElementById('pet-bubble');
      if (el) el.hidden = true;
      return { enabled: C.IDLE_TALK_ENABLED, min: C.IDLE_LINE_MIN_MS, chance: C.IDLE_LINE_CHANCE };
    },
  };
  return true;
};

// ───────────────────────── 像素测量 ─────────────────────────

/**
 * 抓一帧真实渲染结果，返回奶蛙前景包围盒（CSS px，相对窗口左上角）。
 *
 * 用 capturePage() + toBitmap()：拿到的就是**合成后的真实像素**，
 * 不经过任何我们自己写的测量代码，能看到「用户实际看到什么」。
 * toBitmap() 是 BGRA（预乘 alpha），透明处 alpha = 0。
 */
async function shoot(win, tag) {
  const img = await win.webContents.capturePage();
  const bmp = img.toBitmap();
  const size = img.getSize();
  const w = size.width, h = size.height;
  if (bmp.length < w * h * 4) return { err: `bitmap 尺寸不符 ${bmp.length} vs ${w}x${h}` };

  let x0 = w, y0 = h, x1 = -1, y1 = -1, opaque = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = bmp[(y * w + x) * 4 + 3];
      if (a > 8) {
        opaque++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  // 抓图是设备像素，转回 CSS px
  const wr = await win.webContents.executeJavaScript('window.innerWidth');
  const scale = w > 0 ? w / wr : 1;

  // 存一份下来，方便肉眼复核（PIL 不可用，这里只存 PNG 供人看）
  try { fs.writeFileSync(path.join(TMP, `shot-${tag}.png`), img.toPNG()); } catch (e) { /* 忽略 */ }

  if (x1 < 0) return { err: '抓到的画面全透明（窗口没渲染？）', w, h, scale };
  return {
    w, h, scale,
    bbox: { x0: x0 / scale, y0: y0 / scale, x1: x1 / scale, y1: y1 / scale, w: (x1 - x0 + 1) / scale, h: (y1 - y0 + 1) / scale },
    opaque,
    cssW: wr,
  };
}

// ───────────────────────── 主流程 ─────────────────────────

const js = (code) => {
  const ws = BrowserWindow.getAllWindows();
  if (!ws.length) return Promise.reject(new Error('no window'));
  return ws[0].webContents.executeJavaScript(code, true);
};

async function pollJs(expr, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await js('!!(' + expr + ')')) return true; } catch (e) { /* 还没就绪 */ }
    await sleep(150);
  }
  return false;
}

/** 等某个基础动画真正成为当前动画，并且它的 holder 不透明度为 1。 */
async function waitAnim(name, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const s = await js('window.__PROBE__.snapshot()');
      const cur = s.layers.find((l) => l.anim === name);
      if (s.active === name && cur && Number(cur.opacity) > 0.9) return s;
    } catch (e) { /* 忽略 */ }
    await sleep(120);
  }
  return null;
}

/** 量一种模式：静态待机 vs 大笑首帧。 */
async function probeMode(win, mode, idleSlot) {
  console.log(`\n[probe] ── ${mode} 模式（静态槽位 ${idleSlot}） ──`);

  await js(`window.__PROBE__.setMode('${mode}')`);
  const idleSnap = await waitAnim(idleSlot, 8000);
  if (!idleSnap) {
    check(`${mode}: 静态待机 ${idleSlot} 就位`, false, '8s 内没有成为当前动画');
    return;
  }

  const idleLayer = idleSnap.layers.find((l) => l.anim === idleSlot);
  info(`静态元素：<${idleLayer.tag}> rect=${JSON.stringify(idleLayer.rect)} css=${idleLayer.css.w}x${idleLayer.css.h} ` +
       `natural=${JSON.stringify(idleLayer.natural)} object-fit=${idleLayer.css.objectFit}`);
  info(`CSSOM 命中：.pet-layer > img = ${idleSnap.selHit.child}；.pet-layer img = ${idleSnap.selHit.descendant}`);

  // ① 元素必须正好铺满 #pet，且同原点
  const r = idleLayer.rect;
  const fits = Math.abs(r.x) < 0.6 && Math.abs(r.y) < 0.6
    && Math.abs(r.w - PET) < 1.2 && Math.abs(r.h - PET) < 1.2;
  check(`${mode}: 素材元素铺满 #pet（${PET}x${PET} 同原点）`, fits,
    `rect=${JSON.stringify(r)}（#pet=${idleSnap.pet.w}x${idleSnap.pet.h}）`);

  // ② 像素：静态待机的前景包围盒
  // 抓图前必须先清场（toast / 气泡 / 面板），否则会把它们和奶蛙并成一个包围盒
  await js('window.__PROBE__.prep()');
  const petPos = await js('window.__PROBE__.petRect()');
  const shotIdle = await shoot(win, `${mode}-idle`);
  if (shotIdle.err) { check(`${mode}: 抓到静态待机像素`, false, shotIdle.err); return; }

  const bbI = shotIdle.bbox;
  const idleFrog = { h: bbI.h, top: bbI.y0, feet: bbI.y1, cx: (bbI.x0 + bbI.x1) / 2 };

  info(`静态像素：窗口 ${shotIdle.cssW} CSS px / 抓图 ${shotIdle.w}x${shotIdle.h}（scale ${shotIdle.scale.toFixed(2)}）`);
  info(`静态奶蛙：高 ${idleFrog.h.toFixed(1)}px  顶 ${idleFrog.top.toFixed(1)}  底 ${idleFrog.feet.toFixed(1)}  中心x ${idleFrog.cx.toFixed(1)}`);

  // 高度 = 152 CSS px（±6%）
  check(`${mode}: 静态奶蛙高度 ≈ ${EXP.frogH}px`,
    Math.abs(idleFrog.h - EXP.frogH) / EXP.frogH <= TOL_H,
    `实测 ${idleFrog.h.toFixed(1)}px（期望 ${EXP.frogH}，误差 ${((idleFrog.h / EXP.frogH - 1) * 100).toFixed(1)}%）`);

  // 没被裁掉：整只奶蛙必须落在 #pet 的 190x190 盒子里，四边都留白
  check(`${mode}: 静态奶蛙完整落在 #pet 盒内（没被裁掉）`, insidePet(bbI, petPos),
    `bbox x ${bbI.x0.toFixed(1)}..${bbI.x1.toFixed(1)}  y ${bbI.y0.toFixed(1)}..${bbI.y1.toFixed(1)}` +
    `（#pet x ${petPos.x.toFixed(1)}..${(petPos.x + PET).toFixed(1)}  y ${petPos.y.toFixed(1)}..${(petPos.y + PET).toFixed(1)}）`);

  // ③ 触发大笑。
  //    解压模式走**真实鼠标事件**（顺带验证整条事件链）；
  //    工作模式的点击是「开面板」而不是笑，所以这里直接调 playOnce ——
  //    本探针要量的是**渲染对齐**，不该把工作模式的点击语义混进判定。
  let trigger;
  if (mode === 'relax') {
    const pt = await js('window.__PROBE__.clickPet()');
    trigger = `真实点击 (${pt.x.toFixed(0)},${pt.y.toFixed(0)})`;
  } else {
    await js('window.__PROBE__.playLaugh()');
    trigger = 'playOnce("laugh")';
  }
  const laughSnap = await waitAnim('laugh', 8000);
  if (!laughSnap) { check(`${mode}: 进入大笑`, false, trigger); return; }

  await js('window.__PROBE__.prep()');
  await sleep(260);        // 让序列帧画几帧（此段素材仍是大笑开头的站姿，和静态图同姿势）

  const laughLayer = laughSnap.layers.find((l) => l.anim === 'laugh');
  info(`大笑元素：<${laughLayer.tag}> rect=${JSON.stringify(laughLayer.rect)} css=${JSON.stringify(laughSnap.canvasCss)}`);

  const shotLaugh = await shoot(win, `${mode}-laugh`);
  if (shotLaugh.err) { check(`${mode}: 抓到大笑像素`, false, shotLaugh.err); return; }
  const bbL = shotLaugh.bbox;
  const laughFrog = { h: bbL.h, top: bbL.y0, feet: bbL.y1, cx: (bbL.x0 + bbL.x1) / 2 };
  info(`大笑奶蛙：高 ${laughFrog.h.toFixed(1)}px  顶 ${laughFrog.top.toFixed(1)}  底 ${laughFrog.feet.toFixed(1)}  中心x ${laughFrog.cx.toFixed(1)}`);

  // ④ 静态 vs 大笑：高度一致
  const dh = Math.abs(idleFrog.h - laughFrog.h) / laughFrog.h;
  check(`${mode}: 静态与大笑的奶蛙高度一致（差 ≤ ${(TOL_H * 100).toFixed(0)}%）`, dh <= TOL_H,
    `静态 ${idleFrog.h.toFixed(1)} vs 大笑 ${laughFrog.h.toFixed(1)}（差 ${(dh * 100).toFixed(1)}%）`);

  // ⑤ 静态 vs 大笑：脚底一致
  const dFeet = Math.abs(idleFrog.feet - laughFrog.feet);
  check(`${mode}: 静态与大笑的脚底对齐（差 ≤ ${TOL_POS}px）`, dFeet <= TOL_POS,
    `静态 ${idleFrog.feet.toFixed(1)} vs 大笑 ${laughFrog.feet.toFixed(1)}（差 ${dFeet.toFixed(1)}px）`);

  // ⑥ 静态 vs 大笑：水平中心一致
  const dCx = Math.abs(idleFrog.cx - laughFrog.cx);
  check(`${mode}: 静态与大笑的水平中心一致（差 ≤ ${TOL_POS}px）`, dCx <= TOL_POS,
    `静态 ${idleFrog.cx.toFixed(1)} vs 大笑 ${laughFrog.cx.toFixed(1)}（差 ${dCx.toFixed(1)}px）`);

  // ⑤ 大笑时也要完整落在 #pet 盒内（＝没有被裁）
  check(`${mode}: 大笑奶蛙完整落在 #pet 盒内`, insidePet(bbL, petPos),
    `bbox x ${bbL.x0.toFixed(1)}..${bbL.x1.toFixed(1)}  y ${bbL.y0.toFixed(1)}..${bbL.y1.toFixed(1)}`);

  // ⑥ 绝对位置：脚底应落在 #pet 顶部往下 174px（= 348/380 × 190），中心应在 #pet 中心
  const feetInPet = laughFrog.feet - petPos.y;
  check(`${mode}: 大笑脚底落在 #pet 内 ≈ ${EXP.feetY}px`, Math.abs(feetInPet - EXP.feetY) <= TOL_POS,
    `实测 ${feetInPet.toFixed(1)}px（#pet 顶部 y=${petPos.y.toFixed(1)}）`);

  const cxInPet = laughFrog.cx - petPos.x;
  check(`${mode}: 大笑水平中心 ≈ #pet 中心 ${PET / 2}px`, Math.abs(cxInPet - PET / 2) <= TOL_POS,
    `实测 ${cxInPet.toFixed(1)}px（#pet 左边界 x=${petPos.x.toFixed(1)}）`);

  // 收尾：回到静态待机，避免长笑影响下一种模式
  await js('window.Naiwa.Pet.setIdle()');
  await sleep(300);
}

/**
 * #2 大笑必须播**完整片段**。
 *
 * 用户原话：「奶蛙大笑要播放完整片段，不能只有一小段」。
 * 改之前是「取源视频 1.55s 起的 0.95 秒，正放完再倒放」的乒乓序列，共 26 帧
 * 1.73 秒——只占源片（15.4 秒）的 6%。
 *
 * 这里量三件事，缺一不可：
 *   ① manifest 声明的帧数 × fps 推出的时长 ≥ 源片长度（MIN_FULL_MS 下限）
 *   ② playOnce 返回的预计时长 == ①（运行时真的用了素材自带时长）
 *   ③ 真实墙钟耗时 ≈ ②（动画真的从头播到尾，不是被定时器提前掐掉）
 */
const MIN_FULL_MS = Number(process.env.PROBE_MIN_LAUGH_MS || 15000);   // 源视频 15.399s

async function probeLaughFull(win) {
  console.log('\n[probe] ── 大笑是否播完整片段（#2） ──');
  await js(`window.__PROBE__.setMode('relax')`);
  if (!await waitAnim('idle_relax', 8000)) { check('大笑时长：回到静态待机', false, '等不到 idle_relax'); return; }
  await js('window.__PROBE__.prep()');

  const spec = await js('window.__PROBE__.laughSpec()');
  if (!spec || spec.kind !== 'frames') {
    check('大笑素材是序列帧且声明了帧数', false, JSON.stringify(spec));
    return;
  }
  const declaredMs = spec.fps ? Math.round((spec.count / spec.fps) * 1000) : 0;
  info(`manifest: kind=${spec.kind} count=${spec.count} fps=${spec.fps} start=${spec.start} → 声明时长 ${declaredMs}ms`);

  check(`大笑声明时长 ≥ ${MIN_FULL_MS}ms（源视频 15.4 秒，不是一小段）`, declaredMs >= MIN_FULL_MS,
    `${spec.count} 帧 / ${spec.fps}fps = ${declaredMs}ms（占源片 ${(declaredMs / 15399 * 100).toFixed(0)}%）`);

  const t = await js('window.__PROBE__.laughTiming()');
  info(`运行时：playOnce 预计 ${t.ms}ms，真实播完耗时 ${t.wallMs}ms`);

  // 231 帧常驻的代价：量出来，而不是估（这是 #2 的已知副作用，写进报告供决策）
  try {
    // ⚠️ 用 app.getAppMetrics()：webContents 上没有 getProcessMemoryInfo()
    //（第一版写的就是它，只换来一行 "is not a function"）。
    const metrics = app.getAppMetrics();
    const totalMB = metrics.reduce((s, m) => s + (m.memory ? m.memory.workingSetSize : 0), 0) / 1024;
    const detail = metrics.map((m) => `${m.type}=${m.memory ? (m.memory.workingSetSize / 1024).toFixed(0) : '?'}MB`).join(' ');
    info(`进程内存（工作集）：合计 ${totalMB.toFixed(0)} MB  [${detail}]`);
    info(`  参考：${spec.count} 帧 × 380×380 RGBA 若全部解码 ≈ ${(spec.count * 380 * 380 * 4 / 1048576).toFixed(0)} MB（Chromium 按需解码/可回收，不等于实际占用）`);
  } catch (e) {
    info('读不到进程内存信息：' + (e && e.message));
  }

  check('运行时用的是素材自带时长（不是兜底值）', Math.abs(t.ms - declaredMs) <= 60,
    `playOnce 返回 ${t.ms}ms vs 声明 ${declaredMs}ms`);

  const wallOk = t.wallMs != null && Math.abs(t.wallMs - declaredMs) <= 1500;
  check('动画真的从头播到尾（墙钟耗时 ≈ 声明时长）', wallOk,
    t.wallMs == null ? '40s 内没有回到静态待机' : `真实 ${t.wallMs}ms vs 期望 ${declaredMs}ms（容差 ±1500ms）`);

  // ⑤ 笑声必须是**源视频的原生音轨**（第六次会话，用户要求），且与动画对齐。
  //    只读清单不够 —— 这里真的把音频文件加载一遍量时长，顺带证明文件存在且能解码。
  const snd = await js(`(function () {
    var url = window.Naiwa.Assets.soundSrc('laugh');
    if (!url) return Promise.resolve({ url: null });
    return new Promise(function (res) {
      var a = new Audio();
      a.preload = 'metadata';
      a.addEventListener('loadedmetadata', function () { res({ url: url, durationMs: Math.round(a.duration * 1000) }); });
      a.addEventListener('error', function () { res({ url: url, error: '加载失败' }); });
      a.src = url;
      setTimeout(function () { res({ url: url, durationMs: null, timeout: true }); }, 8000);
    });
  })()`);
  check('大笑用的是真实音频文件（源视频原生音轨）', !!snd.url,
    snd.url ? `soundSrc('laugh') → ${snd.url}` : '清单里没声明 laugh 音频，会退回内置合成笑声');
  if (snd.url) {
    const diff = snd.durationMs == null ? null : Math.abs(snd.durationMs - declaredMs);
    check('原生笑声时长与动画对齐（差 ≤ 300ms）', diff != null && diff <= 300,
      snd.durationMs == null
        ? `读不到音频时长（${snd.error || '超时'}）`
        : `音频 ${snd.durationMs}ms vs 动画 ${declaredMs}ms（差 ${diff}ms）`);
  }

  await js('window.Naiwa.Pet.setIdle()');
  await sleep(300);
}

/**
 * 把奶蛙挪到**真实光标**底下。
 *
 * ⚠️ 这一步是必需的，不是凑测试：探针是程序驱动的，真实光标并不在奶蛙身上。
 * 而产品的「光标离开奶蛙就收起操作窗」是由主进程 40ms 一次的光标推送触发的 ——
 * 菜单刚一弹出，下一拍推送就会发现「光标在奶蛙之外」并把它收掉。
 * 真实用户右键时**光标必然压在奶蛙上**（否则窗口还是穿透态，右键根本到不了窗口），
 * 所以产品行为没问题；缺的是「让探针里的光标也真的落在奶蛙上」。
 */
async function parkUnderCursor(win) {
  const { screen } = require('electron');
  const pt = screen.getCursorScreenPoint();
  const r = await js('window.__PROBE__.petRect()');
  win.setPosition(Math.round(pt.x - (r.x + r.w / 2)), Math.round(pt.y - (r.y + r.h * 0.52)));
  await sleep(340);   // 光标推送的心跳是 200ms，等它把「光标在奶蛙上」告诉渲染进程
  const b = win.getBounds();
  const clientX = pt.x - b.x, clientY = pt.y - b.y;
  const contains = await js(`window.Naiwa.Pet.containsPoint(${clientX}, ${clientY})`);
  return { cursor: pt, bounds: b, clientX, clientY, contains };
}

/**
 * 第五次会话：右键操作窗 + 拖拽保持静态图。
 *
 * 拖拽那一段是本探针里**最强的一条**：它不只读 DOM 状态，还抓两次真实像素
 * （静态待机 / 拖动中）比包围盒。旧实现会在这两者之间把整张图换成占位卡通蛙，
 * 包围盒必然差出几十像素；现在要求两者同框。
 */
async function probeMenuAndDrag(win) {
  console.log('\n[probe] ── 右键操作窗（第五次会话） ──');
  await js(`window.__PROBE__.setMode('relax')`);
  if (!await waitAnim('idle_relax', 8000)) { check('菜单：回到静态待机', false, '等不到 idle_relax'); return; }
  await js('window.__PROBE__.prep()');

  // 前置：真实光标必须落在奶蛙身上，否则菜单会被「光标移开」逻辑立刻收掉
  const parked = await parkUnderCursor(win);
  check('前置：真实光标落在奶蛙命中区内', parked.contains === true,
    `光标 (${parked.cursor.x},${parked.cursor.y}) → 窗口内 (${parked.clientX},${parked.clientY})，containsPoint=${parked.contains}`);

  // ① 右键单击 → 弹操作窗
  await js('window.__PROBE__.rightClick(false)');
  await sleep(220);
  const opened = await js('window.__PROBE__.menuState()');
  const texts = (opened.items || []).map((i) => i.text + (i.hidden ? '(隐藏)' : ''));
  const insideWin = !!opened.rect && opened.rect.x >= 0 && opened.rect.y >= 0
    && opened.rect.x + opened.rect.w <= 460 && opened.rect.y + opened.rect.h <= 640;
  const quitItem = (opened.items || []).filter((i) => i.act === 'quit' && !i.hidden)[0] || null;

  check('右键单击弹出操作窗', !!opened.open && !opened.hidden,
    `hidden=${opened.hidden}　Naiwa.App.menuOpen=${opened.open}`);
  check('操作窗里有「退出奶蛙」且 quit IPC 已暴露', !!quitItem && opened.quitWired,
    `项=[${texts.join(' / ')}]　quitWired=${opened.quitWired}`);
  check('操作窗完整落在窗口内（点得到）', insideWin,
    `rect=${opened.rect.x},${opened.rect.y} ${opened.rect.w}x${opened.rect.h}（窗口 460x640）`);

  // ② 光标移开 → 自动收起
  await js('window.__PROBE__.moveMouse(20, 20)');
  await sleep(280);
  const closed = await js('window.__PROBE__.menuState()');
  check('光标移开后操作窗自动收起', closed.hidden === true, `hidden=${closed.hidden}`);

  // ③ 右键双击 → 切模式（单击不再切模式）
  const modeBefore = await js('window.Naiwa.App.mode');
  await js('window.__PROBE__.rightClick(true)');
  await sleep(600);
  const modeAfter = await js('window.Naiwa.App.mode');
  check('右键双击切换模式', modeBefore !== modeAfter, `${modeBefore} → ${modeAfter}`);

  await js(`window.__PROBE__.setMode('relax')`);
  if (!await waitAnim('idle_relax', 8000)) { check('菜单：切回解压模式', false, '等不到 idle_relax'); return; }
  await js('window.__PROBE__.prep()');

  // ④ 拖拽：像素级证明「画面没变」
  console.log('\n[probe] ── 拖拽保持静态图（第五次会话） ──');
  const shotIdle = await shoot(win, 'drag-before');
  if (shotIdle.err) { check('拖拽：抓到拖动前的像素', false, shotIdle.err); return; }
  const bbIdle = shotIdle.bbox;

  await js('window.__PROBE__.dragBegin()');
  await sleep(320);
  const snapDrag = await js('window.__PROBE__.snapshot()');
  const dragLayer = (snapDrag.layers || []).filter((l) => l.anim === 'drag' && Number(l.opacity) > 0.5);
  const shotDrag = await shoot(win, 'drag-during');
  await js('window.__PROBE__.dragEnd()');
  await sleep(300);

  if (shotDrag.err) { check('拖拽：抓到拖动中的像素', false, shotDrag.err); return; }
  const bbDrag = shotDrag.bbox;

  info(`拖动前：高 ${bbIdle.h.toFixed(1)}  底 ${bbIdle.y1.toFixed(1)}  中心x ${((bbIdle.x0 + bbIdle.x1) / 2).toFixed(1)}`);
  info(`拖动中：高 ${bbDrag.h.toFixed(1)}  底 ${bbDrag.y1.toFixed(1)}  中心x ${((bbDrag.x0 + bbDrag.x1) / 2).toFixed(1)}`);

  check('拖拽没有换成占位卡通蛙（基础层仍是静态图）',
    snapDrag.active === 'idle_relax' && dragLayer.length === 0,
    `拖动中基础层=${snapDrag.active}，可见 drag 层=${dragLayer.length} 个`);

  const dh = Math.abs(bbIdle.h - bbDrag.h) / bbIdle.h;
  const dFeet = Math.abs(bbIdle.y1 - bbDrag.y1);
  const dCx = Math.abs((bbIdle.x0 + bbIdle.x1) / 2 - (bbDrag.x0 + bbDrag.x1) / 2);
  check('拖拽前后画面逐像素同框（高度差 ≤6%、脚底/中心差 ≤4px）',
    dh <= TOL_H && dFeet <= TOL_POS && dCx <= TOL_POS,
    `高度差 ${(dh * 100).toFixed(1)}%、脚底差 ${dFeet.toFixed(1)}px、中心差 ${dCx.toFixed(1)}px`);
}

/**
 * 最后一项：点「退出奶蛙」必须真的结束整个程序。
 *
 * ⚠️ 这一项**必须放在所有结果都打印完之后**：点下去进程就没了，
 * 之后连一行输出都写不出来。所以这里只负责「点一下」；
 * 外层（.assetwork/verify-final.ps1）看到进程在几秒内自己退出 = 通过，
 * 若 3 秒后还活着，本函数返回，主流程用退出码 9 报错。
 */
async function probeQuit() {
  console.log('\n[probe] ── 退出按钮是不是真能结束程序（第五次会话） ──');
  console.log('  点「退出奶蛙」…（点下去进程就应该消失，所以这行之后不该再有输出）');
  await js(`(function () {
    window.Naiwa.App.openMenu();
    var it = document.querySelector('#pet-menu [data-act="quit"]');
    if (!it) throw new Error('菜单里没有退出项');
    it.click();
    return true;
  })()`);
  await sleep(3000);      // 正常情况下进程在这之前就已经退出了
}

/**
 * #4 「闲置久了自动说话」必须已经取消。
 *
 * 关键在**让检查能失败**（见 docs/04 §8.5）：把触发条件调到「下一次空闲心跳
 * 必然触发」（阈值 0 + 概率 1），再等**真实**的空闲心跳（app.js 每 5s 一次）。
 * 这样：
 *   · 开关关着 → 一定不冒台词   → PASS 才有意义
 *   · 开关开着 → 一定冒台词     → 反向测试，证明上面那条不是空检查
 */
async function probeIdleTalk(win) {
  console.log('\n[probe] ── 闲置自动说话是否已取消（#4） ──');
  await js(`window.__PROBE__.setMode('relax')`);
  if (!await waitAnim('idle_relax', 8000)) { check('闲置台词：回到静态待机', false, '等不到 idle_relax'); return; }

  const armed = await js('window.__PROBE__.armIdleTalk()');
  info(`已把触发条件调到必然触发：IDLE_LINE_MIN_MS=${armed.min} IDLE_LINE_CHANCE=${armed.chance}`);

  check('闲置自动说话的开关处于关闭状态（IDLE_TALK_ENABLED=false）', armed.enabled === false,
    `IDLE_TALK_ENABLED=${armed.enabled}`);

  // 等 3 拍真实心跳（5s 一拍）
  const quiet = await js('window.__PROBE__.watchBubble(17000)');
  check('闲置心跳不再自动冒台词', !quiet.appeared,
    quiet.appeared ? `冒出了：${JSON.stringify(quiet.texts)}` : `盯了 ${quiet.ms}ms（≥3 拍心跳）没有出现气泡`);

  // 反向测试：强行打开开关，同样的条件下必须冒出台词
  await js('window.__PROBE__.forceIdleTalk(true)');
  const loud = await js('window.__PROBE__.watchBubble(7000)');
  check('反向测试：开关打开后确实会冒台词（证明上一条不是空检查）', loud.appeared,
    loud.appeared ? `冒出了：${JSON.stringify(loud.texts)}` : `盯了 ${loud.ms}ms（≥1 拍心跳）仍没有气泡`);

  const restored = await js('window.__PROBE__.restoreIdleTalk()');
  info(`已还原：IDLE_TALK_ENABLED=${restored.enabled} min=${restored.min} chance=${restored.chance}`);
}

app.whenReady().then(async () => {
  console.log('[probe] 启动真实 main.js …');
  require('./main.js');

  // 等窗口
  let win = null;
  for (let i = 0; i < 100 && !win; i++) {
    const ws = BrowserWindow.getAllWindows();
    if (ws.length) win = ws[0];
    else await sleep(200);
  }
  if (!win) {
    console.log('[probe] 20s 内没有创建任何 BrowserWindow —— main.js 大概走了单实例锁退出分支。');
    console.log('        换个隔离目录重跑：PROBE_TMP_DIR=.naiwa-probe-tmp2（见 docs/04 第 3.2 节）');
    return finish(3);
  }

  // 窗口要「对合成器可见」才拿得到帧，但绝不能让用户看到：opacity 0 + 不抢焦点
  try {
    win.setOpacity(0);
    win.showInactive();
    win.setIgnoreMouseEvents(true, { forward: true });
  } catch (e) { /* 忽略 */ }
  console.log('[probe] 窗口已点亮但全透明（opacity 0），仅用于抓帧');

  win.webContents.on('console-message', (...a) => {
    let msg = '';
    try {
      const d = a[1];
      msg = (d && typeof d === 'object') ? `[${d.level}] ${d.message}` : `[${a[1]}] ${a[2]}`;
    } catch (e) { /* 忽略 */ }
    if (/奶蛙/.test(msg)) console.log('   渲染进程：' + msg);
  });

  const ok = await pollJs('window.Naiwa && window.Naiwa.Pet && window.Naiwa.App && document.getElementById("pet-base")', 25000);
  if (!ok) { check('渲染进程启动', false, '25s 内 window.Naiwa.App 没就绪'); return finish(3); }
  await js('(' + PAGE_LIB.toString() + ')()');
  await sleep(600);
  check('渲染进程启动', true, 'window.Naiwa.App / #pet-base 就绪');

  await probeMode(win, 'relax', 'idle_relax');
  await probeMode(win, 'work', 'idle_work');
  await probeLaughFull(win);
  await probeIdleTalk(win);
  await probeMenuAndDrag(win);

  // 先把结果打出来（点退出之后再也写不出任何输出），再验证退出按钮。
  const fails = results.filter((r) => !r.ok).length;
  finish(fails ? 1 : 0, /* keepAlive */ true);
  await probeQuit();
  console.log('  [FAIL] 点了「退出奶蛙」3 秒后进程仍然活着 —— 主进程没有真的退出');
  app.exit(9);
}).catch((e) => {
  console.log('[probe] 异常：' + (e && e.stack || e));
  finish(4);
});