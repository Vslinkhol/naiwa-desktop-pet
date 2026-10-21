'use strict';
/* ============================================================================
 * 奶蛙桌宠 · 工作模式无头冒烟测试（headless smoke harness）
 * ============================================================================
 *
 * 运行（在 naiwa-pet 目录下）：
 *
 *     npx electron --no-sandbox __smoke.work.js
 *
 * 本机（受限环境）实测需要 `--no-sandbox`：不带它 Chromium 的沙箱起不来，
 * electron 会直接崩掉（连 --version 都跑不出来）。这不是项目的问题。
 *
 * 它做什么：
 *   1. `require('./main.js')`，用**真实的**主进程 / IPC / preload / 窗口 / 渲染进程跑，
 *      不重写任何产品逻辑，也不改任何产品文件（唯一会动的文件是隔离的 userData）。
 *   2. 立刻 hide() 掉宠物窗口（透明置顶窗口留在桌面上很打扰），全程守着不让它显示。
 *   3. **CPU 是伪造的，但走的是真链路**：这里替换 `os.cpus()` 的返回值，
 *      让 `main.js` 的采样器算出指定的占用率 —— 采样、IPC 推送、app.js 分发、
 *      模式层判断全部是真的，只是数值由测试控制。否则「CPU ≥75 换图」这条
 *      根本没法在无人值守下验证。
 *   4. 按 docs/02-工作模式.md 第 8 节「验收清单」逐条断言（能从 DOM / IPC 观测到的部分）。
 *   5. 打印一张紧凑表格 + 一行机器可读的 SMOKE_RESULT {json}；
 *      有任何一项 FAIL 就非零退出（SKIP 不算失败）。
 *
 * 它不做什么：
 *   - 不调用模式层的内部函数伪造结果。所有判定只看 DOM、剪贴板、IPC 的真实效果。
 *     唯一的「观测插桩」是包一层 `Naiwa.Audio.play` 数音效、挂 error / unhandledrejection
 *     收集器、包 `requestAnimationFrame` / `setTimeout` 数定时器，都**不改变行为**。
 *   - 不把窗口显示出来。
 *
 * 判定原则：
 *   PASS = 真的观测到了；FAIL = 真的观测到不符合预期；
 *   SKIP = 前置条件不成立（必须写明原因）。绝不放宽断言去凑 PASS。
 *
 * 环境变量：
 *   SMOKE_TMP_DIR        隔离工作目录（默认 <工作区>/.naiwa-smoke-work）
 *                        ⚠️ 主轮开工前会**删掉这个目录里的数据文件**，好让冒烟测试
 *                        可以反复跑（W4/W7/W8 从空状态开始）。只动隔离目录，
 *                        永远碰不到用户真实的便签/剪贴板；三个补充轮是预置数据的，
 *                        不会删。
 *   SMOKE_WORK_CORRUPT=1 只跑「数据文件损坏」那一轮（需要同一个 SMOKE_TMP_DIR，
 *                        因为要复用上一轮留下的 localStorage 标记）
 *   SMOKE_DEBUG=1        打印每项检查的原始证据
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PROJECT = __dirname;
const WORKSPACE = path.dirname(PROJECT);
const SMOKE_TMP = process.env.SMOKE_TMP_DIR
  ? path.resolve(process.env.SMOKE_TMP_DIR)
  : path.join(WORKSPACE, '.naiwa-smoke-work');
const CORRUPT_RUN = process.env.SMOKE_WORK_CORRUPT === '1';
const BIGCLIPS_RUN = process.env.SMOKE_WORK_BIGCLIPS === '1';
const MISSING_RUN = process.env.SMOKE_WORK_MISSING === '1';
const DEBUG = process.env.SMOKE_DEBUG === '1';

const MANIFEST_WORK = path.join(PROJECT, 'assets', 'manifest.work.js');
/** 被「破坏并还原」的素材都登记在这里，任何异常路径下都要还原。 */
const BROKEN = [];

// ───────────────────────── 0. 环境适配（必须在 require('./main.js') 之前） ─────

for (const sub of ['temp', 'userdata', 'cache', 'crash']) {
  try { fs.mkdirSync(path.join(SMOKE_TMP, sub), { recursive: true }); } catch (e) { /* 忽略 */ }
}
process.env.TEMP = path.join(SMOKE_TMP, 'temp');
process.env.TMP = process.env.TEMP;
process.env.TMPDIR = process.env.TEMP;

const { app, BrowserWindow, clipboard } = require('electron');

try { app.setPath('temp', process.env.TEMP); } catch (e) { /* 忽略 */ }
try { app.setPath('userData', path.join(SMOKE_TMP, 'userdata')); } catch (e) { /* 忽略 */ }
try { app.setPath('crashDumps', path.join(SMOKE_TMP, 'crash')); } catch (e) { /* 忽略 */ }
try { app.setPath('sessionData', path.join(SMOKE_TMP, 'cache')); } catch (e) { /* 忽略 */ }
app.commandLine.appendSwitch('disk-cache-dir', path.join(SMOKE_TMP, 'cache'));
app.commandLine.appendSwitch('crash-dumps-dir', path.join(SMOKE_TMP, 'crash'));

const DATA_FILE = () => path.join(SMOKE_TMP, 'userdata', 'naiwa-data.json');

// ───────────────────────── 1. 伪造 CPU（但走真链路） ─────────────────────────

let fakeCpu = 8;
const CPU_COOL = 8, CPU_HOT = 88, CPU_DEADZONE = 68, CPU_COOL_LOW = 40;
const vtimes = { user: 5000, nice: 0, sys: 3000, idle: 200000, irq: 0 };

os.cpus = function fakeCpus() {
  const p = Math.max(0, Math.min(100, fakeCpu)) / 100;
  const T = 1000000;
  vtimes.idle += T * (1 - p);
  vtimes.user += T * p;
  return [{ model: 'smoke-fake', speed: 1000, times: { ...vtimes } }];
};

// ───────────────────────── 2. 报告管道 ─────────────────────────

const LOG_LINES = [];
function emit(line) {
  LOG_LINES.push(line);
  try { process.stdout.write(line + '\n'); } catch (e) { /* stdout 可能不可用 */ }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const CANON = [
  ['W0_boot', '渲染进程启动 + 工作模式模块就位', 'harness'],
  ['W1_idle_static_real_asset', '进入工作模式后静止，且基础图是真素材（不是占位卡通蛙）', 'docs/02 §8-1'],
  ['W2_panel_toggle_click', '点奶蛙 → 面板展开 + bubble；再点 → 收起 + pop', 'docs/02 §8-2'],
  ['W3_panel_hidden_display_none', '面板收起时是真的 display:none（点击穿透的前提）', 'docs/02 §5.2'],
  ['W4_notes_crud', '便签新增（Ctrl+Enter）/ 勾选 / 删除', 'docs/02 §8-3'],
  ['W5_note_edit_dblclick', '双击文字进入编辑态，Enter 保存', 'docs/02 §4.3'],
  ['W6_note_done_feedback', '勾选完成 → done 音效 + 奶蛙笑一下', 'docs/02 §8-3'],
  ['W7_clip_autorecord_dedupe', '剪贴板自动记录 + 重复内容只提前不新增', 'docs/02 §8-4'],
  ['W8_clip_copy_pin_clear', '点击复制 / 置顶 / 清空（二次确认 + 置顶保留）', 'docs/02 §8-4'],
  ['W9_clip_search_meta', '搜索命中 + 元信息（相对时间 / 大小）', 'docs/02 §4.4'],
  ['W10_xss_textcontent', '含 <script> 的剪贴板内容原样显示为文本、不执行', 'docs/02 §5.1'],
  ['W11_cpu_hysteresis', 'CPU 滞回：≥75 换图、62~75 维持、≤62 换回', 'docs/02 §4.5'],
  ['W12_sweat_is_full_swap', '流汗是「整只换成另一张真素材」，不是叠加层、不是占位蛙', 'docs/02 §3.2'],
  ['W13_mode_switch_resets_sweat', 'CPU 高位切模式 → 流汗状态复位（deactivate 的 stopLoop）', 'docs/02 §8-健壮性'],
  ['W14_panel_closed_on_mode_switch', '面板开着时切模式 → 面板收起、不留残留', 'docs/02 §8-健壮性'],
  ['W15_switch_20x_no_stacking', '来回切模式 20 次：不报错、行为不叠加', 'docs/00 §9.3'],
  ['W16_privacy_ui_and_switch', '面板内有「仅存本地」说明 + 能直接关掉剪贴板记录（真的不再记）', 'docs/02 §8-隐私'],
  ['W17_missing_work_assets', '素材没就位（路径写错 / 声明为 none）→ 照常启动、不挂占位蛙、CPU 高只播提示', 'docs/02 §8-健壮性'],
  ['W17b_assets_really_gone', 'assets/work 的素材真的没了（删/坏）→ 同上，且优雅降级', 'docs/02 §8-健壮性'],
  ['W18_missing_all_assets', '连共享待机图也没了 → 仍能启动、面板可用、无未捕获异常', 'docs/00 §9.2'],
  ['W19_long_list_chunked', '1000+ 条便签不全量渲染，滚到底部续一屏', 'docs/02 §5.3'],
  ['W20_no_uncaught_errors', '全程没有未捕获异常 / unhandled rejection / console.error', 'harness'],
  ['W21_data_corrupt_notice', '数据文件被改坏 → 能启动、不崩、面板有提示', 'docs/02 §8-健壮性'],
  ['W22_corrupt_still_usable', '数据损坏时功能照常可用（面板能开）', 'docs/02 §8-健壮性'],
  ['W23_corrupt_no_errors', '数据损坏时没有未捕获异常', 'harness'],
  ['W24_bigclips_chunked', '500 条剪贴板历史 → 一次只渲染一屏（≤60 节点）', 'docs/02 §8-健壮性'],
  ['W25_bigclips_scroll_more', '滚到底部续一屏，节点数增长但不全量渲染', 'docs/02 §5.3'],
  ['W26_bigclips_search_fast', '500 条里搜索命中且耗时可控（不卡）', 'docs/02 §4.4'],
  ['W27_bigclips_no_errors', '500 条历史下没有未捕获异常', 'harness'],
  ['W28_menu_in_work_mode', '工作模式：右键单击弹操作窗，「打开面板」项可见且能用', '第五次会话'],
];

const RESULTS = [];
function record(id, status, evidence, detail) {
  const meta = CANON.find((c) => c[0] === id) || [id, id, ''];
  RESULTS.push({ id, title: meta[1], source: meta[2], status, evidence, detail: detail || null });
  const tag = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  emit(`  [${tag}] ${id} — ${evidence}`);
  if (DEBUG && detail) emit('        ' + JSON.stringify(detail).slice(0, 2000));
}

// ──────────────────────── 2.5 两件必须在 whenReady 之前做完的事 ────────────────

// ① 「数据损坏」那一轮：把数据文件写坏。
//    必须在这里（同步顶层）做，不能等到 whenReady —— main.js 注册的 whenReady
//    回调排在前面，那时它已经 loadData() 过了，再写坏也没意义。
if (CORRUPT_RUN) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE()), { recursive: true });
    fs.writeFileSync(DATA_FILE(), '{ 这不是合法 JSON', 'utf8');
    emit(`[smoke.work] 已把 ${path.relative(SMOKE_TMP, DATA_FILE())} 改成非法 JSON`);
  } catch (e) {
    emit(`[smoke.work] 写坏数据文件失败：${e.message}`);
  }
}

// ② 「500 条剪贴板历史」那一轮：预置数据文件。
//    `main.js` 只在启动时读文件，所以要在这里写好。
//    （剪贴板上限 200 条是 main.js 的运行时策略；这里直接塞 500 条，
//      测的是**渲染层**在超大数据量下会不会一次性堆几千个 DOM 节点。）
if (BIGCLIPS_RUN) {
  try {
    const clips = [];
    for (let i = 0; i < 500; i++) {
      clips.push({
        id: 'seed' + String(i).padStart(4, '0'),
        text: `第 ${i} 条预置剪贴板内容 —— 用来验证长列表的渲染与滚动`,
        at: Date.now() - i * 60000,
        pinned: i % 50 === 0,
      });
    }
    fs.mkdirSync(path.dirname(DATA_FILE()), { recursive: true });
    fs.writeFileSync(DATA_FILE(), JSON.stringify({
      mode: 'work', notes: [], clips, settings: { clipboardWatch: false, cpuWatch: true, clipLimit: 200 },
    }, null, 2), 'utf8');
    emit(`[smoke.work] 已预置 ${clips.length} 条剪贴板历史（其中 ${clips.filter((c) => c.pinned).length} 条置顶）`);
  } catch (e) {
    emit(`[smoke.work] 预置数据失败：${e.message}`);
  }
}

// ③ 主轮：**清掉上一轮留下的数据文件**，让冒烟测试可以反复跑。
//
// 为什么必须做：W4 断言的是「空状态提示」、W7/W8 也从空剪贴板开始。
// 用同一个 SMOKE_TMP_DIR 跑第二遍时，上一轮的便签/剪贴板还在，
// 这三项就会**假失败**（实测第二遍：W4 报「已有 60 行」、W7 报「面板里 8 条」、
// W8 报「清空第一次点击没变成确认」——全是数据脏了，产品一点问题没有）。
// 冒烟测试不可重复跑就等于测一次就废。
//
// ⚠️ 三个补充轮都是**预置**数据文件的（corrupt / bigclips / missing），绝不能删；
//    而且只删这个**隔离目录**里的文件，永远碰不到用户真实的便签/剪贴板。
if (!CORRUPT_RUN && !BIGCLIPS_RUN && !MISSING_RUN) {
  try {
    fs.rmSync(DATA_FILE(), { force: true });
    emit('[smoke.work] 已清空隔离目录里的数据文件（保证 W4/W7/W8 从空状态开始）');
  } catch (e) {
    emit(`[smoke.work] 清空数据文件失败：${e.message}`);
  }
}

// ③ 启动**真实主进程**：窗口 / 托盘 / 剪贴板轮询 / CPU 采样 / IPC 全都跑起来，
//    和 `npm start` 完全一致——本文件只是驱动它，不替代它。
//    放在 os.cpus 替换之后，采样器才会读到伪造值。
require('./main.js');

// ───────────────────────── 3. 页面侧插桩 ─────────────────────────

const INSTRUMENT = `(() => {
  window.__W = window.__W || { errs: [], rejections: [], snd: [], loads: [] };
  if (!__W.installed) {
    __W.installed = true;
    window.addEventListener('error', (e) => __W.errs.push(String((e && e.message) || e)));
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      __W.rejections.push(String((r && r.message) || r));
    });
    window.addEventListener('error', (e) => {
      if (e && e.target && e.target.tagName) __W.loads.push(e.target.tagName + ':' + (e.target.src || ''));
    }, true);
  }
  // 数音效：包一层 Naiwa.Audio.play（只是记账，行为不变）
  if (window.Naiwa && window.Naiwa.Audio && !window.Naiwa.Audio.__smokeWrapped) {
    const orig = window.Naiwa.Audio.play;
    window.Naiwa.Audio.play = function (n) { __W.snd.push(String(n)); return orig.apply(this, arguments); };
    window.Naiwa.Audio.__smokeWrapped = true;
  }
  return true;
})()`;

const STATE_FN = `(() => {
  const pet = document.getElementById('pet');
  const base = document.getElementById('pet-base');
  const panel = document.getElementById('panel');
  const cs = (el) => el ? getComputedStyle(el) : null;
  const op = (el) => parseFloat(getComputedStyle(el).opacity || '1');
  const layers = [...base.children].map((h) => ({ anim: h.dataset.anim, op: op(h), tag: h.firstElementChild ? h.firstElementChild.tagName : null }));
  const visible = layers.filter((l) => l.op > 0.5);
  let visEl = null;
  for (const h of base.children) { if (op(h) > 0.5) { visEl = h.firstElementChild; break; } }
  const inPet = (el) => { let n = el; while (n && n !== pet) { const c = getComputedStyle(n); if (c.display === 'none' || parseFloat(c.opacity) < 0.05 || c.visibility === 'hidden') return false; n = n.parentElement; } return !!n; };
  const petAnims = document.getAnimations().filter((a) => { const t = a.effect && a.effect.target; return t && pet.contains(t); });
  const visAnims = petAnims.filter((a) => { const t = a.effect && a.effect.target; return t && inPet(t); });
  const inf = (a) => { try { return a.effect.getTiming().iterations === Infinity; } catch (e) { return false; } };
  const P = window.Naiwa && window.Naiwa.Panels;
  return {
    mode: window.Naiwa && window.Naiwa.App ? Naiwa.App.mode : null,
    visibleLayers: visible.map((l) => l.anim),
    layers,
    visTag: visEl ? visEl.tagName : null,
    visSrc: visEl && visEl.tagName === 'IMG' ? String(visEl.getAttribute('src')) : null,
    visNaturalW: visEl && 'naturalWidth' in visEl ? visEl.naturalWidth : null,
    visIsPlaceholder: !!(visEl && visEl.classList && visEl.classList.contains('ph-frog')),
    visInPetTree: !!(visEl && pet.contains(visEl)),
    panelHidden: panel ? panel.hidden : null,
    panelDisplay: panel ? getComputedStyle(panel).display : null,
    panesShown: [...document.querySelectorAll('#panel .pane')].filter((p) => getComputedStyle(p).display !== 'none').map((p) => p.dataset.pane),
    petInfiniteVisible: visAnims.filter((a) => inf(a) && a.playState === 'running').length,
    petInfiniteAll: petAnims.filter((a) => inf(a)).length,
    petTransform: getComputedStyle(pet).transform,
    sweatLayer: layers.filter((l) => l.anim === 'sweat'),
    snd: __W.snd.slice(),
    errs: __W.errs.slice(),
    rejections: __W.rejections.slice(),
    loadErrs: __W.loads.slice(),
    noteRows: document.querySelectorAll('#note-list .note-item').length,
    noteTexts: [...document.querySelectorAll('#note-list .note-item .text')].map((e) => e.textContent),
    noteDoneRows: document.querySelectorAll('#note-list .note-item.is-done').length,
    clipRows: document.querySelectorAll('#clip-list .clip-item').length,
    clipTexts: [...document.querySelectorAll('#clip-list .clip-item .text')].map((e) => e.textContent),
    clipMeta: [...document.querySelectorAll('#clip-list .clip-item .meta')].map((e) => e.textContent),
    clipPinned: document.querySelectorAll('#clip-list .clip-item.is-pinned').length,
    clipFoot: (document.getElementById('clip-foot') || {}).textContent || '',
    noteFoot: (document.getElementById('note-foot') || {}).textContent || '',
    noteEmptyHidden: (() => { const e = document.getElementById('note-empty'); return e ? e.hidden : null; })(),
    noteEmptyText: (document.getElementById('note-empty') || {}).textContent || '',
    clipLineClamp: (() => {
      const t = document.querySelector('#clip-list .clip-item .text');
      return t ? (getComputedStyle(t).webkitLineClamp || getComputedStyle(t).getPropertyValue('-webkit-line-clamp')) : null;
    })(),
    clearBtnText: (document.getElementById('clip-clear') || {}).textContent || '',
    warnShown: !!(document.querySelector('.data-warn') && !document.querySelector('.data-warn').hidden),
    warnText: (document.querySelector('.data-warn-text') || {}).textContent || '',
    privacyNote: (document.querySelector('.privacy-note') || {}).textContent || '',
    privacySwitch: !!(document.getElementById('clip-watch')),
    clipWatch: (document.getElementById('clip-watch') || {}).checked,
    footPrivacy: (document.querySelector('.privacy-tip') || {}).textContent || '',
    scriptInPanel: document.querySelectorAll('#panel script').length,
    panelsDebug: P ? P.debug : null,
    workState: window.Naiwa && Naiwa.Modes && Naiwa.Modes.work ? Naiwa.Modes.work.state : null,
    lsMarker: (() => { try { return localStorage.getItem('naiwa.panel.counts'); } catch (e) { return 'N/A'; } })(),
  };
})()`;

// ───────────────────────── 4. 主流程 ─────────────────────────

let win = null;
let consoleErrors = [];
let keepHiddenTimer = null;
/**
 * 「预期内的错误」。
 *
 * W17 / W18 会**故意**把素材移走再重载，那时 core/assets.js 一定会打出
 * 「素材加载失败，已退回占位素材」的 console.error，Chromium 也会报
 * ERR_FILE_NOT_FOUND。这些是测试自己制造的，不能算进「全程无错误」。
 * 只有白名单里的这类消息会被归到这里，别的仍然算失败。
 */
const expectedErrors = [];
const EXPECTED_ERR = /素材 ".*" 加载失败|实际请求：|Failed to load resource|ERR_FILE_NOT_FOUND|net::ERR_/;
function noteConsoleError(msg) {
  const m = String(msg).split('\n')[0].slice(0, 200);
  if (EXPECTED_ERR.test(m)) expectedErrors.push(m);
  else consoleErrors.push(m);
}

function findWin() {
  const all = BrowserWindow.getAllWindows();
  return all.length ? all[0] : null;
}

async function page(expr) {
  return win.webContents.executeJavaScript(expr, true);
}
async function state() { return page(STATE_FN); }
/**
 * 在页面里执行一段「函数源码」并取回结果。
 *
 * 两种写法都接受：`() => {...}` / `async () => {...}`（未调用），
 * 以及 `(() => {...})()`（已经调用过）。早期版本只会补一对括号，
 * 传已调用的写法就会变成「把结果当函数再调一次」→ TypeError。
 */
async function evalFn(fnStr) {
  return page(`(() => { const v = (${fnStr}); return typeof v === 'function' ? v() : v; })()`);
}

/**
 * 轮询直到条件成立（页面里求值），返回是否成立。
 *
 * ⚠️ `condFn` 必须是一个**已经调用过**的完整表达式，形如 `(() => ...)()`
 * （所有调用点都是这么写的）。早期版本在这里又补了一对括号，
 * 等于把求值结果当函数再调一次，每次轮询都抛 TypeError。
 */
async function waitFor(condFn, timeoutMs, stepMs) {
  const t0 = Date.now();
  const step = stepMs || 120;
  for (;;) {
    let ok = false;
    try { ok = await page(`(${condFn})`); } catch (e) { ok = false; }
    if (ok) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(step);
  }
}

/** 在页面里做一次「落点在奶蛙命中椭圆内」的真实点击（同一次求值里算点 + 派发）。 */
const CLICK_PET = `(() => {
  const pet = document.getElementById('pet');
  const r = pet.getBoundingClientRect();
  const hit = (window.NAIWA_MANIFEST && NAIWA_MANIFEST.hit) || { x: 0.5, y: 0.516 };
  const x = r.left + r.width * hit.x;
  const y = r.top + r.height * hit.y;
  const inside = window.Naiwa.Pet.containsPoint(x, y);
  const target = document.elementFromPoint(x, y) || document.body;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 };
  target.dispatchEvent(new MouseEvent('mousedown', opts));
  target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
  return { x, y, inside, tag: target.tagName };
})()`;

const RIGHT_CLICK = `(() => {
  const el = document.getElementById('stage');
  const fire = () => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  fire();
  // 右键**双击** = 切换模式（第五次会话改：单击右键让位给操作窗）。
  // 两次间隔 120ms，必须小于 app.js 的 MENU_DBL_MS（400ms）。
  return new Promise((res) => setTimeout(() => { fire(); res(true); }, 120));
})()`;

/** 右键**单击**（弹操作窗，W28 用）。 */
const RIGHT_CLICK_ONCE = `(() => {
  const el = document.getElementById('stage');
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  return true;
})()`;

async function setModeViaMain(mode) {
  await page(`window.naiwa.setMode(${JSON.stringify(mode)})`);
}

async function bootWait(label) {
  const ok = await waitFor(`(() => !!(window.Naiwa && Naiwa.App && Naiwa.Pet && Naiwa.Pet.root()
      && Naiwa.Modes.work && Naiwa.Panels && document.getElementById('panel')))()`, 15000);
  if (!ok) throw new Error(`${label}: 渲染进程没有完成启动`);
  await page(INSTRUMENT);
  await sleep(400);
}

async function reloadPage(mode) {
  await setModeViaMain(mode);
  // ⚠️ 必须显式 loadFile，不能用 webContents.reload()。
  // 用例里为了放开文件句柄会先导航到 about:blank，那时候 reload() 重载的是
  // 空白页——页面永远起不来，表现成「渲染进程没有完成启动」。
  win.loadFile(path.join(PROJECT, 'renderer', 'index.html'));
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 8000);
    win.webContents.once('did-finish-load', () => { clearTimeout(t); setTimeout(resolve, 300); });
  });
  await bootWait('重载');
  await sleep(500);
}

// ───────────────────────── 素材「缺失」怎么造 ─────────────────────────
//
// ⚠️ 本机实测：**不能靠改名 / 移动文件来模拟「素材被删」**。
//    在 `naiwa-pet/assets/**` 里做 rename 会被系统拒绝（EPERM，即使进程已经不受沙箱限制），
//    而且正在显示的图片很可能被渲染进程占着句柄。
//    所以这里用两条更稳的路子：
//      · **改清单**：把 `sweat` 的路径指到一个不存在的文件（这本身就是验收清单里的
//        「sweat 路径故意写错」），把 `idle_work` 改成 kind:'none'（等于没有这张素材）。
//      · **破坏文件再按内存里的原始字节还原**：删不掉就覆盖成垃圾字节，效果一样
//        （加载必然失败）；原始字节一直留在内存里，跑完一定还原，并校验 sha1。
//    两条路都只动**工作模式自己名下**的文件，且都在 finally 里还原 + 校验。

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

function fileInfo(rel) {
  const abs = path.join(PROJECT, rel);
  try {
    const buf = fs.readFileSync(abs);
    return { rel, exists: true, bytes: buf.length, sha: sha1(buf) };
  } catch (e) {
    return { rel, exists: false, bytes: 0, sha: null };
  }
}

/** 把某个素材文件弄成「加载不了」。返回还原所需的记录。 */
function breakFile(rel) {
  const abs = path.join(PROJECT, rel);
  const rec = { rel, abs, buf: null, method: null, err: null };
  try { rec.buf = fs.readFileSync(abs); } catch (e) { rec.err = '读原文件失败: ' + e.message; return rec; }
  try {
    fs.unlinkSync(abs);
    rec.method = 'delete';
    return rec;
  } catch (e1) {
    try {
      fs.writeFileSync(abs, Buffer.from('SMOKE: 这不是一张 PNG'), { flag: 'w' });
      rec.method = 'overwrite';
      return rec;
    } catch (e2) {
      rec.err = `删不掉(${e1.code}) 也覆盖不了(${e2.code})`;
      return rec;
    }
  }
}

function restoreBreak(rec) {
  if (!rec || !rec.buf) return false;
  try {
    fs.writeFileSync(rec.abs, rec.buf);
    return true;
  } catch (e) {
    rec.err = '还原失败: ' + e.message;
    return false;
  }
}

/** 让渲染进程先离开这个页面，释放它可能占着的文件句柄，再做文件操作。 */
async function navigateAway() {
  try {
    win.webContents.loadURL('about:blank');
    await sleep(400);
  } catch (e) { /* 忽略 */ }
}

// ── 改清单（「素材没就位」的另一条路子） ──

let manifestOriginal = null;

function patchManifestForMissing() {
  try { manifestOriginal = fs.readFileSync(MANIFEST_WORK, 'utf8'); }
  catch (e) { return { ok: false, err: '读不到 assets/manifest.work.js: ' + e.message }; }

  let n1 = 0, n2 = 0;
  const text = manifestOriginal
    .replace(/(idle_work:\s*\{\s*kind:\s*'file'[^}]*\})/, () => { n1++; return "idle_work: { kind: 'none' }"; })
    .replace(/(sweat:\s*\{\s*kind:\s*'file'[^}]*\})/, () => { n2++; return "sweat: { kind: 'file', src: 'work/__missing__sweat.png' }"; });

  // 替换次数不对就说明清单被改过样子了，宁可报错也不要写一份半吊子清单进去
  if (n1 !== 1 || n2 !== 1) return { ok: false, err: `清单里没找到预期的声明（idle_work 命中 ${n1} 次、sweat ${n2} 次）` };

  try { fs.writeFileSync(MANIFEST_WORK, text, 'utf8'); }
  catch (e) { return { ok: false, err: '写清单失败: ' + e.message }; }
  return { ok: true };
}

function restoreManifest() {
  if (manifestOriginal == null) return false;
  try { fs.writeFileSync(MANIFEST_WORK, manifestOriginal, 'utf8'); return true; }
  catch (e) { emit('[smoke] ! 还原清单失败：' + e.message); return false; }
}

// ───────────────────────── 5. 各项检查 ─────────────────────────

async function runCorruptRun() {
  // 只跑一轮：数据文件被手工改坏 → 能启动、不崩、有提示
  // （写坏文件这件事已经在 whenReady 之前做完了，这里只做断言）
  emit('\n[smoke] —— 数据文件损坏轮 ——');
  let sizeInfo = '（没读到）';
  try { sizeInfo = fs.statSync(DATA_FILE()).size + ' 字节'; } catch (e) { /* 忽略 */ }
  emit(`[smoke] ${path.relative(SMOKE_TMP, DATA_FILE())} 现在是非法 JSON，${sizeInfo}`);

  win = findWin();
  if (!win) { record('W21_data_corrupt_notice', 'FAIL', '没有找到窗口'); return; }
  win.hide();
  await bootWait('损坏数据轮');

  const st = await state();
  if (st.warnShown && /损坏|丢失/.test(st.warnText)) {
    record('W21_data_corrupt_notice', 'PASS',
      `数据文件非法 → 程序正常启动，面板顶部提示：「${st.warnText.slice(0, 52)}…」`,
      { warnText: st.warnText, consoleErrors });
  } else {
    record('W21_data_corrupt_notice', 'FAIL',
      `数据文件非法时没有给出提示（warnShown=${st.warnShown} text="${st.warnText}"）`,
      { st });
  }

  // 提示之外，功能必须照常。⚠️ 先切到工作模式：数据文件坏了之后 mode 回落到默认的
  // relax，点奶蛙走的是解压模式的逻辑（笑一下），根本不会开面板——这是测试自己的坑。
  await setModeViaMain('work');
  await sleep(900);
  const click = await page(CLICK_PET);
  const opened = await waitFor(`(() => !document.getElementById('panel').hidden)()`, 3000);
  const stOpen = await state();
  record('W22_corrupt_still_usable', opened ? 'PASS' : 'FAIL',
    `损坏数据下功能仍可用：切到工作模式后点击奶蛙（点 (${click.x.toFixed(0)},${click.y.toFixed(0)}) 命中=${click.inside}）` +
    `→ ${opened ? '面板展开成功' : '没能展开'}（display=${stOpen.panelDisplay}，可见层=${stOpen.visibleLayers.join('/')}）`,
    { click, opened, workState: stOpen.workState, consoleErrors });

  const finalState = await state();
  const bad = finalState.errs.length + finalState.rejections.length;
  record('W23_corrupt_no_errors', bad === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL',
    `损坏数据轮未捕获异常 ${finalState.errs.length} / rejection ${finalState.rejections.length} / console.error ${consoleErrors.length}`,
    { errs: finalState.errs, rejections: finalState.rejections });
}

async function runMain() {
  win = findWin();
  if (!win) throw new Error('没有找到窗口');
  win.hide();
  // 尽早装插桩：dom-ready 早于 DOMContentLoaded，能抓到启动期的异常
  win.webContents.on('dom-ready', () => { page(INSTRUMENT).catch(() => { /* 页面还没就绪 */ }); });
  const keepHidden = setInterval(() => {
    try { if (win && !win.isDestroyed() && win.isVisible()) win.hide(); } catch (e) { /* 忽略 */ }
  }, 200);

  emit('[smoke] ── 等待渲染进程启动 ──');
  await bootWait('主轮');
  await setModeViaMain('work');
  await sleep(900);

  // ── W0 启动 ──
  {
    const st = await state();
    // 面板有几块 DOM 是运行时补齐的（index.html 是冻结文件）——它们缺任何一个，
    // 都说明 panels.js 的初始化中途抛错了，而那种错在别的用例里很难看出来。
    const dom = await page(`(() => ({
      warn: !!document.querySelector('.data-warn'),
      warnText: !!document.querySelector('.data-warn-text'),
      noteFoot: !!document.getElementById('note-foot'),
      clipFoot: !!document.getElementById('clip-foot'),
      privacySwitch: !!document.getElementById('clip-watch'),
      privacyNote: !!document.querySelector('.privacy-note'),
    }))()`);
    const missing = Object.keys(dom).filter((k) => !dom[k]);
    const ok = st.mode === 'work' && !!st.workState && !!st.panelsDebug && missing.length === 0
      && st.panelsDebug.ipcFailures === 0;
    record('W0_boot', ok ? 'PASS' : 'FAIL',
      `模式=${st.mode}，工作模式模块=${st.workState ? '在' : '缺'}，面板=${st.panelsDebug ? '在' : '缺'}，` +
      `可见基础层=${st.visibleLayers.join('/') || '无'}；运行时补齐的 DOM ${missing.length ? '缺少 ' + missing.join('/') : '齐全'}；` +
      `IPC 降级次数=${st.panelsDebug ? st.panelsDebug.ipcFailures : '?'}`,
      { workState: st.workState, panels: st.panelsDebug, dom });
  }

  // ── W1 静止 + 真素材 ──
  {
    const st = await state();
    const realImg = st.visTag === 'IMG' && st.visSrc && /idle_work\.png$/.test(st.visSrc) && st.visNaturalW > 0;
    const idle = st.visibleLayers.length === 1 && st.visibleLayers[0] === 'idle_work';
    const still = st.petInfiniteVisible === 0;
    const transformOk = st.petTransform === 'none' || st.petTransform === 'matrix(1, 0, 0, 1, 0, 0)';
    const ok = realImg && idle && still && transformOk && !st.visIsPlaceholder;
    record('W1_idle_static_real_asset', ok ? 'PASS' : 'FAIL',
      `可见基础层=${st.visibleLayers.join('/') || '无'}（${st.visTag} src=${(st.visSrc || '').split('/').pop()} naturalWidth=${st.visNaturalW}）` +
      `；占位卡通蛙=${st.visIsPlaceholder ? '是（不该）' : '否'}；可见无限动画=${st.petInfiniteVisible}；#pet transform=${st.petTransform}`,
      { st });
  }

  // ── W2/W3 面板开合 ──
  {
    const before = await state();
    const click = await page(CLICK_PET);
    const opened = await waitFor(`(() => !document.getElementById('panel').hidden)()`, 3000);
    await sleep(500);
    const st = await state();
    const sndOpen = st.snd.slice(before.snd.length);
    const panes = st.panesShown.join(',');

    const click2 = await page(CLICK_PET);
    const closed = await waitFor(`(() => document.getElementById('panel').hidden)()`, 3000);
    await sleep(500);
    const st2 = await state();
    const sndClose = st2.snd.slice(st.snd.length);

    const openedOk = opened && st.panelDisplay === 'flex' && panes === 'notes';
    const closedOk = closed && st2.panelDisplay === 'none';
    record('W2_panel_toggle_click', openedOk && closedOk && sndOpen.includes('bubble') && sndClose.includes('pop') ? 'PASS' : 'FAIL',
      `点击奶蛙（命中=${click.inside}）→ 面板 ${opened ? '展开' : '没展开'}（display=${st.panelDisplay}，显示的页=${panes}，音效=[${sndOpen.join(',')}]）；` +
      `再点 → ${closed ? '收起' : '没收起'}（display=${st2.panelDisplay}，音效=[${sndClose.join(',')}]）`,
      { click, click2, sndOpen, sndClose });

    record('W3_panel_hidden_display_none', closedOk ? 'PASS' : 'FAIL',
      `收起后 #panel 的 computed display=${st2.panelDisplay}（必须是 none，否则 elementFromPoint 仍会命中它、窗口会在看不见的地方拦截鼠标）`,
      { panelHidden: st2.panelHidden, panelDisplay: st2.panelDisplay });
  }

  // ── W4 便签 CRUD ──
  let notesOk = false;
  {
    // 空状态：应该是引导文案，不是一片空白
    const stEmpty = await state();
    const emptyTip = stEmpty.noteEmptyHidden === false && /便签/.test(stEmpty.noteEmptyText);

    const added = await evalFn(`async () => {
      const ta = document.getElementById('note-text');
      ta.value = '冒烟测试便签 A';
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    }`);
    await waitFor(`(() => document.querySelectorAll('#note-list .note-item').length >= 1)()`, 4000);
    let st = await state();
    const hasA = st.noteTexts.includes('冒烟测试便签 A');
    const inputCleared = await page(`document.getElementById('note-text').value === ''`);

    // 再加两条
    for (const t of ['冒烟测试便签 B', '冒烟测试便签 C']) {
      await evalFn(`async () => {
        const ta = document.getElementById('note-text');
        ta.value = ${JSON.stringify(t)};
        document.getElementById('note-add').click();
        return true;
      }`);
      await sleep(260);
    }
    st = await state();
    const count3 = st.noteRows === 3;
    // 同组内按创建时间**倒序**：先加的 A 应该在最后，刚加的 C 在最前
    const newestFirst = st.noteTexts.join('|') === '冒烟测试便签 C|冒烟测试便签 B|冒烟测试便签 A';

    // 勾选 A（找到 A 那一行的复选框）
    const toggled = await evalFn(`(() => {
      const rows = [...document.querySelectorAll('#note-list .note-item')];
      const row = rows.find((r) => r.querySelector('.text').textContent === '冒烟测试便签 A');
      if (!row) return false;
      row.querySelector('input[type=checkbox]').click();
      return true;
    })()`);
    await sleep(600);
    const stDone = await state();
    const aDoneRow = await evalFn(`(() => {
      const row = [...document.querySelectorAll('#note-list .note-item')].find((r) => r.querySelector('.text').textContent === '冒烟测试便签 A');
      return row ? row.classList.contains('is-done') : null;
    })()`);
    const doneLast = (await evalFn(`(() => {
      const rows = [...document.querySelectorAll('#note-list .note-item')];
      return rows.length ? rows[rows.length - 1].querySelector('.text').textContent : null;
    })()`)) === '冒烟测试便签 A';

    // 删除 C
    const removed = await evalFn(`(() => {
      const row = [...document.querySelectorAll('#note-list .note-item')].find((r) => r.querySelector('.text').textContent === '冒烟测试便签 C');
      if (!row) return false;
      row.querySelector('.row-del').click();
      return true;
    })()`);
    await sleep(600);
    const stAfter = await state();

    notesOk = added && hasA && inputCleared && count3 && newestFirst && emptyTip
      && toggled && aDoneRow === true && doneLast && removed
      && !stAfter.noteTexts.includes('冒烟测试便签 C') && stAfter.noteRows === 2;
    record('W4_notes_crud', notesOk ? 'PASS' : 'FAIL',
      `空状态提示=${emptyTip}（「${stEmpty.noteEmptyText}」）；Ctrl+Enter 新增=${hasA ? '成功' : '失败'}（输入框已清空=${inputCleared}），` +
      `再加两条共 ${st.noteRows} 行、组内新的在最前=${newestFirst}；` +
      `勾选后该行 is-done=${aDoneRow} 且沉到末尾=${doneLast}；删除一行后剩 ${stAfter.noteRows} 行（C 还在=${stAfter.noteTexts.includes('冒烟测试便签 C')}）`,
      { hasA, inputCleared, count3, newestFirst, emptyTip, aDoneRow, doneLast, after: stAfter.noteTexts, debug: stAfter.panelsDebug });
  }

  // ── W5 双击编辑 ──
  {
    // 需要面板开着才好点（其实隐藏时也能派发事件，但这里按真实用法来）
    const wasOpen = await page(`window.Naiwa.Panels.isOpen()`);
    if (!wasOpen) {
      await page(CLICK_PET);
      await waitFor(`(() => !document.getElementById('panel').hidden)()`, 3000);
    }
    await sleep(400);
    const entered = await evalFn(`(() => {
      const row = [...document.querySelectorAll('#note-list .note-item')].find((r) => r.querySelector('.text') && r.querySelector('.text').textContent === '冒烟测试便签 B');
      if (!row) return false;
      row.querySelector('.text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return !!document.querySelector('#note-list .note-edit');
    })()`);
    const saved = await evalFn(`(() => {
      const ta = document.querySelector('#note-list .note-edit');
      if (!ta) return false;
      ta.value = '冒烟测试便签 B（已编辑）';
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(700);
    const st = await state();
    const edited = st.noteTexts.includes('冒烟测试便签 B（已编辑）') && !st.noteTexts.includes('冒烟测试便签 B');
    record('W5_note_edit_dblclick', entered && saved && edited ? 'PASS' : 'FAIL',
      `双击进入编辑态=${entered}，Enter 保存后文字变成「冒烟测试便签 B（已编辑）」=${edited}（当前 ${st.noteRows} 行）`,
      { entered, saved, texts: st.noteTexts });
  }

  // ── W6 勾选完成的反馈（done 音效 + 笑一下） ──
  {
    const st0 = await state();
    // 先把 B 勾上（它现在是未完成）
    await evalFn(`(() => {
      const row = [...document.querySelectorAll('#note-list .note-item')].find((r) => r.querySelector('.text').textContent === '冒烟测试便签 B（已编辑）');
      if (!row) return false;
      row.querySelector('input[type=checkbox]').click();
      return true;
    })()`);
    const laughed = await waitFor(`(() => {
      const base = document.getElementById('pet-base');
      for (const h of base.children) {
        if (parseFloat(getComputedStyle(h).opacity) > 0.5 && h.dataset.anim === 'laugh_short') return true;
      }
      return false;
    })()`, 2500, 80);
    const st = await state();
    const snd = st.snd.slice(st0.snd.length);
    const backToIdle = await waitFor(`(() => {
      const base = document.getElementById('pet-base');
      const vis = [...base.children].filter((h) => parseFloat(getComputedStyle(h).opacity) > 0.5).map((h) => h.dataset.anim);
      return vis.length === 1 && vis[0] === 'idle_work';
    })()`, 6000, 150);
    record('W6_note_done_feedback', laughed && snd.includes('done') && backToIdle ? 'PASS' : 'FAIL',
      `勾选完成 → done 音效=${snd.includes('done')}（本拍音效 [${snd.join(',')}]），奶蛙切到 laugh_short=${laughed}，` +
      `笑完回 idle_work=${backToIdle}`,
      { snd, laughed, backToIdle });
  }

  // ── W7 剪贴板自动记录 + 去重 ──
  {
    clipboard.writeText('冒烟测试剪贴板 第一条');
    await sleep(1400);
    clipboard.writeText('冒烟测试剪贴板 第二条');
    await sleep(1400);
    clipboard.writeText('冒烟测试剪贴板 第一条');   // 重复内容：应该只提前，不新增
    await sleep(1400);

    await page(`(() => { const t = document.querySelector('.tab[data-tab=clips]'); t.click(); return true; })()`);
    await sleep(500);
    const st = await state();
    const texts = st.clipTexts;
    const newFirst = texts[0] === '冒烟测试剪贴板 第一条';
    const dedup = texts.filter((t) => t === '冒烟测试剪贴板 第一条').length === 1;
    const two = texts.length === 2;
    record('W7_clip_autorecord_dedupe', newFirst && dedup && two ? 'PASS' : 'FAIL',
      `复制两条 → 面板里 ${texts.length} 条；重复复制第一条后它排到最前=${newFirst}，且没有出现重复条目=${dedup}`,
      { texts, debug: st.panelsDebug });
  }

  // ── W8 复制 / 置顶 / 清空 ──
  {
    // 再补一条，用来验证「清空只清未置顶」
    clipboard.writeText('冒烟测试剪贴板 第三条');
    await sleep(1400);
    let st = await state();
    // 置顶第二条
    await evalFn(`(() => {
      const row = [...document.querySelectorAll('#clip-list .clip-item')].find((r) => r.querySelector('.text').textContent === '冒烟测试剪贴板 第二条');
      if (!row) return false;
      row.querySelector('[data-act=pin]').click();
      return true;
    })()`);
    await sleep(600);
    const stPinned = await state();
    const pinnedCount = stPinned.clipPinned;
    const pinnedFirst = stPinned.clipTexts[0] === '冒烟测试剪贴板 第二条';

    // 点击第三条 → 复制回剪贴板
    const beforeCopy = stPinned.snd.length;
    await evalFn(`(() => {
      const row = [...document.querySelectorAll('#clip-list .clip-item')].find((r) => r.querySelector('.text').textContent === '冒烟测试剪贴板 第三条');
      if (!row) return false;
      row.querySelector('.text').click();
      return true;
    })()`);
    await sleep(700);
    const stCopied = await state();
    const back = clipboard.readText();
    const copySnd = stCopied.snd.slice(beforeCopy);

    // 清空：第一次点 → 要求确认；第二次点 → 真的清
    await page(`(() => { document.getElementById('clip-clear').click(); return true; })()`);
    await sleep(400);
    const stConfirm = await state();
    const confirmShown = /确认/.test(stConfirm.clearBtnText);
    const notClearedYet = stConfirm.clipRows === 3;

    await page(`(() => { document.getElementById('clip-clear').click(); return true; })()`);
    await sleep(700);
    const stCleared = await state();
    const keptPinned = stCleared.clipPinned === 1 && stCleared.clipTexts.length === 1
      && stCleared.clipTexts[0] === '冒烟测试剪贴板 第二条';

    const ok = pinnedCount === 1 && pinnedFirst && back === '冒烟测试剪贴板 第三条' && copySnd.includes('pop')
      && confirmShown && notClearedYet && keptPinned;
    record('W8_clip_copy_pin_clear', ok ? 'PASS' : 'FAIL',
      `置顶后置顶项跑到最前=${pinnedFirst}（置顶 ${pinnedCount} 条）；点条目 → 剪贴板内容变成「${back}」且播了 pop=${copySnd.includes('pop')}；` +
      `清空第一次点击→按钮变成「${stConfirm.clearBtnText.trim()}」且没删=${notClearedYet}；第二次点击→只剩置顶那条=${keptPinned}`,
      { pinnedCount, pinnedFirst, back, copySnd, stConfirm: { btn: stConfirm.clearBtnText, rows: stConfirm.clipRows }, cleared: stCleared.clipTexts });
  }

  // ── W9 搜索 + 元信息 ──
  {
    clipboard.writeText('冒烟测试 搜索用的苹果');
    await sleep(1300);
    clipboard.writeText('冒烟测试 搜索用的香蕉');
    await sleep(1300);
    const searched = await evalFn(`(() => {
      const el = document.getElementById('clip-search');
      el.value = '香蕉';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    const st = await state();
    const onlyMatch = st.clipRows === 1 && st.clipTexts[0].includes('香蕉');
    const metaHasTime = st.clipMeta.some((m) => /刚刚|分钟前|小时前|天前/.test(m));
    const metaHasSize = st.clipMeta.some((m) => /\d+(\.\d+)?\s?(B|KB|MB)/.test(m));
    const foot = /匹配/.test(st.clipFoot);
    const clamped = String(st.clipLineClamp) === '3';   // CONFIG.CLIP_PREVIEW_LINES 生效
    await evalFn(`(() => { const el = document.getElementById('clip-search'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);
    record('W9_clip_search_meta', searched && onlyMatch && metaHasTime && metaHasSize && clamped ? 'PASS' : 'FAIL',
      `搜索「香蕉」→ ${st.clipRows} 条且命中=${onlyMatch}；元信息含相对时间=${metaHasTime}、含大小=${metaHasSize}；` +
      `预览限制在 ${st.clipLineClamp} 行=${clamped}；页脚=${st.clipFoot || '（空）'}`,
      { st: { rows: st.clipRows, texts: st.clipTexts, meta: st.clipMeta, foot: st.clipFoot, clamp: st.clipLineClamp, footNote: foot } });
  }

  // ── W10 XSS ──
  {
    const payload = '<script>window.__XSS_FIRED = 1;alert(1)</script><img src=x onerror="window.__XSS_FIRED=1">';
    clipboard.writeText(payload);
    await sleep(1500);
    const st = await state();
    const shown = st.clipTexts.some((t) => t.includes('<script>'));
    const fired = await page(`window.__XSS_FIRED === undefined`);
    const strayEls = await page(`document.querySelectorAll('#panel script, #panel img[src="x"]').length`);
    const notExecuted = fired === true && strayEls === 0;
    record('W10_xss_textcontent', shown && notExecuted ? 'PASS' : 'FAIL',
      `含 <script> 的内容原样显示为文本=${shown}；脚本没有执行=${fired}；面板里没有多出 script/img 节点=${strayEls === 0}`,
      { firstText: st.clipTexts[0], fired, strayEls });
  }

  // ── W11/W12 CPU 滞回 + 换图 ──
  {
    const base = await state();
    // 「面板开着时 CPU 飙高 → 换图照常发生，两者不冲突」：这一段的实测前提就是面板开着
    const panelWasOpen = base.panelHidden === false;
    fakeCpu = CPU_HOT;
    const toSweat = await waitFor(`(() => {
      const b = document.getElementById('pet-base');
      const vis = [...b.children].filter((h) => parseFloat(getComputedStyle(h).opacity) > 0.5).map((h) => h.dataset.anim);
      return vis.length === 1 && vis[0] === 'sweat';
    })()`, 9000, 150);
    const stHot = await state();
    const sndHot = stHot.snd.slice(base.snd.length);

    // 盲区：68% 既不该开也不该关，必须维持流汗
    fakeCpu = CPU_DEADZONE;
    await sleep(5000);          // 至少两拍
    const stDead = await state();
    const stayed = stDead.visibleLayers.length === 1 && stDead.visibleLayers[0] === 'sweat';

    // 降到 ≤62 才换回待机
    fakeCpu = CPU_COOL_LOW;
    const backToIdle = await waitFor(`(() => {
      const b = document.getElementById('pet-base');
      const vis = [...b.children].filter((h) => parseFloat(getComputedStyle(h).opacity) > 0.5).map((h) => h.dataset.anim);
      return vis.length === 1 && vis[0] === 'idle_work';
    })()`, 9000, 150);
    const sndCool = (await state()).snd;

    record('W11_cpu_hysteresis', toSweat && stayed && backToIdle && panelWasOpen ? 'PASS' : 'FAIL',
      `${panelWasOpen ? '面板**开着**' : '面板是关着的（这条没测到）'}时 CPU→${CPU_HOT}% 后 ${toSweat ? '换成了' : '没能换成'}流汗状态图（滴声=${sndHot.includes('drip')}）；` +
      `降到盲区 ${CPU_DEADZONE}%（在 62~75 之间）维持流汗=${stayed}；降到 ${CPU_COOL_LOW}% 换回待机=${backToIdle}`,
      { panelWasOpen, toSweat, sndHot, stayed, backToIdle, sndCool: sndCool.slice(-6) });

    // W12：流汗时必须是真素材、整只换、不是叠加层
    fakeCpu = CPU_HOT;
    await waitFor(`(() => {
      const b = document.getElementById('pet-base');
      const vis = [...b.children].filter((h) => parseFloat(getComputedStyle(h).opacity) > 0.5).map((h) => h.dataset.anim);
      return vis.length === 1 && vis[0] === 'sweat';
    })()`, 9000, 150);
    await sleep(400);
    const stSweat = await state();
    const fx = await page(`(() => {
      const fx = document.getElementById('pet-fx');
      return [...fx.children].map((h) => ({ anim: h.dataset.anim, op: parseFloat(getComputedStyle(h).opacity) }));
    })()`);
    const realImg = stSweat.visTag === 'IMG' && /sweat\.png$/.test(stSweat.visSrc || '') && stSweat.visNaturalW > 0;
    const onlyOne = stSweat.visibleLayers.length === 1;
    const fxEmpty = !fx.some((f) => f.op > 0.05);
    const ok = realImg && onlyOne && fxEmpty && !stSweat.visIsPlaceholder;
    record('W12_sweat_is_full_swap', ok ? 'PASS' : 'FAIL',
      `流汗时可见基础层=${stSweat.visibleLayers.join('/')}（${stSweat.visTag} src=${(stSweat.visSrc || '').split('/').pop()} naturalWidth=${stSweat.visNaturalW}）；` +
      `同时只有一个基础层=${onlyOne}；特效叠加层是空的=${fxEmpty}（说明是换图不是叠一层汗）`,
      { stSweat: { visTag: stSweat.visTag, visSrc: stSweat.visSrc, visNaturalW: stSweat.visNaturalW, layers: stSweat.layers }, fx });
  }

  // ── W13 CPU 高位切模式 → 复位 ──
  {
    // 先确保处于流汗态
    fakeCpu = CPU_HOT;
    await waitFor(`(() => { const b = document.getElementById('pet-base'); const vis = [...b.children].filter((h) => parseFloat(getComputedStyle(h).opacity) > 0.5).map((h) => h.dataset.anim); return vis[0] === 'sweat'; })()`, 9000, 150);
    await page(RIGHT_CLICK);
    await sleep(900);
    const stRelax = await state();
    // 回到工作模式，并把 CPU 压到盲区：如果 hot 状态没被复位，就会又挂着流汗图
    fakeCpu = CPU_DEADZONE;
    await setModeViaMain('work');
    await sleep(1200);
    const stBack = await state();
    const stayedIdle = await waitFor(`(() => {
      const b = document.getElementById('pet-base');
      const vis = [...b.children].filter((h) => parseFloat(getComputedStyle(h).opacity) > 0.5).map((h) => h.dataset.anim);
      return vis.length === 1 && vis[0] === 'idle_work';
    })()`, 4000, 150);
    const sweatHidden = stBack.sweatLayer.every((l) => l.op < 0.05);
    const ok = stRelax.mode === 'relax' && stRelax.visibleLayers.includes('idle_relax') && stayedIdle && sweatHidden;
    record('W13_mode_switch_resets_sweat', ok ? 'PASS' : 'FAIL',
      `流汗中切到解压模式后可见层=${stRelax.visibleLayers.join('/')}；切回工作模式并把 CPU 压到盲区 ${CPU_DEADZONE}% 后` +
      `${stayedIdle ? '回到静态待机（没有残留流汗图）' : '仍然挂着 ' + stBack.visibleLayers.join('/')}；sweat 图层透明度=${JSON.stringify(stBack.sweatLayer)}`,
      { stRelax: { mode: stRelax.mode, layers: stRelax.visibleLayers }, stBack: { layers: stBack.visibleLayers, sweat: stBack.sweatLayer, work: stBack.workState } });
  }

  // ── W14 面板开着切模式 ──
  {
    await page(CLICK_PET);
    await waitFor(`(() => !document.getElementById('panel').hidden)()`, 3000);
    await sleep(400);
    await page(RIGHT_CLICK);
    await sleep(900);
    const st = await state();
    const ok = st.mode === 'relax' && st.panelHidden === true && st.panelDisplay === 'none';
    record('W14_panel_closed_on_mode_switch', ok ? 'PASS' : 'FAIL',
      `面板开着时切到${st.mode}模式 → panel.hidden=${st.panelHidden}，display=${st.panelDisplay}；面板里残留的编辑框=${await page(`document.querySelectorAll('.note-edit').length`)}`,
      { st: { mode: st.mode, hidden: st.panelHidden, display: st.panelDisplay } });
    await setModeViaMain('work');
    await sleep(600);
  }

  // ── W15 来回切 20 次 ──
  {
    const pre = await state();
    let fails = 0;
    for (let i = 0; i < 20; i++) {
      await page(RIGHT_CLICK);
      await sleep(130);
    }
    await sleep(1500);
    const post = await state();
    const errDelta = (post.errs.length - pre.errs.length) + (post.rejections.length - pre.rejections.length);
    // 20 次是偶数次，正常应该回到工作模式；但切换是异步串行的，
    // 万一刚好卡在中间就以 relaxation 模式也能接受——那几条不变量与模式无关。
    const hotOk = post.mode !== 'work' || (post.workState && post.workState.hot === false);
    const ok = errDelta === 0 && post.petInfiniteVisible === 0 && post.petTransform === 'none' && hotOk;
    const ev15 = `20 次右键**双击**切换（每次两击间隔 120ms，循环间隔 130ms）：未捕获异常 ${pre.errs.length}→${post.errs.length}、rejection ${pre.rejections.length}→${post.rejections.length}；` +
      `#pet 可见无限动画 ${pre.petInfiniteVisible}→${post.petInfiniteVisible}；位移 ${pre.petTransform}→${post.petTransform}；` +
      `最终模式=${post.mode}，工作模式内部状态 hot=${post.workState && post.workState.hot}`;
    record('W15_switch_20x_no_stacking', ok ? 'PASS' : 'FAIL', ev15,
      { pre: { errs: pre.errs.length, anim: pre.petInfiniteVisible, t: pre.petTransform }, post: { errs: post.errs.length, anim: post.petInfiniteVisible, t: post.petTransform, mode: post.mode }, fails });
    if (post.mode !== 'work') { await setModeViaMain('work'); await sleep(600); }
  }

  // ── W28 右键操作窗（工作模式：多一项「打开面板」且真的能用） ──
  {
    const menuState = () => page(`(() => {
      const el = document.getElementById('pet-menu');
      if (!el) return { exists: false };
      const items = [...el.querySelectorAll('.menu-item')].map((b) => ({ act: b.dataset.act, text: b.textContent, hidden: !!b.hidden }));
      return { exists: true, hidden: !!el.hidden, open: !!(window.Naiwa && Naiwa.App && Naiwa.App.menuOpen), items };
    })()`);

    // 先确保面板是收起的，这样菜单项应该显示「打开面板」
    await page(`(() => { if (window.Naiwa.Panels.isOpen()) window.Naiwa.Panels.close(); return true; })()`);
    await sleep(400);

    await page(RIGHT_CLICK_ONCE);
    await sleep(240);
    const opened = await menuState();
    const panelItem = (opened.items || []).filter((i) => i.act === 'panel')[0] || null;
    const quitItem = (opened.items || []).filter((i) => i.act === 'quit')[0] || null;
    const panelItemShown = !!panelItem && !panelItem.hidden && panelItem.text.indexOf('打开面板') >= 0;

    // 点「打开面板」这一项：面板必须真的展开
    if (panelItemShown) await page(`(() => { document.querySelector('#pet-menu [data-act="panel"]').click(); return true; })()`);
    await sleep(600);
    const afterClick = await state();
    const menuClosed = (await menuState()).hidden === true;
    const panelOpened = afterClick.panelHidden === false;

    // 收尾：收起面板，避免影响后面的用例
    await page(`(() => { window.Naiwa.Panels.close(); return true; })()`);
    await sleep(400);

    const ok = opened.exists && opened.open && !opened.hidden && panelItemShown
      && !!quitItem && !quitItem.hidden && panelOpened && menuClosed;
    record('W28_menu_in_work_mode', ok ? 'PASS' : 'FAIL',
      `右键单击 → 操作窗 hidden=${opened.hidden}、App.menuOpen=${opened.open}；` +
      `项=[${(opened.items || []).map((i) => `${i.text}${i.hidden ? '(隐藏)' : ''}`).join(' / ')}]；` +
      `点「打开面板」后面板 hidden=${afterClick.panelHidden}（应为 false）、菜单已收起=${menuClosed}`,
      { opened, afterClick: { panelHidden: afterClick.panelHidden }, menuClosed });
  }

  // ── W16 隐私 UI + 开关真的生效 ──
  {
    // ⚠️ 断言一律看**主进程里的真实数据**（clips.list()），不看面板 DOM：
    // 面板只在「开着且停在剪贴板页」时才重绘，用 DOM 判断会读到过期内容，
    // 把「关掉后确实没记」和「根本没刷新」混为一谈。
    const clipTexts = () => page(`window.naiwa.clips.list().then((l) => l.map((c) => c.text))`);

    const st = await state();
    const uiOk = st.privacySwitch && /仅存本机/.test(st.privacyNote) && st.footPrivacy.includes('仅存本地');

    // 关掉记录 → 复制新内容不应该被记下来
    await evalFn(`(() => { const cb = document.getElementById('clip-watch'); cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(700);
    const before = await clipTexts();
    clipboard.writeText('冒烟测试 关闭记录后不该出现的内容');
    await sleep(1800);
    const after = await clipTexts();
    const notRecorded = !after.some((t) => t.includes('关闭记录后不该出现'));

    // 再打开 → 复制新内容应该被记下来（正对照：证明上面那条不是因为链路坏了）
    await evalFn(`(() => { const cb = document.getElementById('clip-watch'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(700);
    clipboard.writeText('冒烟测试 重新打开后应该出现的内容');
    await sleep(1800);
    const after2 = await clipTexts();
    const recorded = after2.some((t) => t.includes('重新打开后应该出现'));

    record('W16_privacy_ui_and_switch', uiOk && notRecorded && recorded ? 'PASS' : 'FAIL',
      `面板内有开关=${st.privacySwitch}、说明「${st.privacyNote}」、页脚「${st.footPrivacy}」；` +
      `关掉后复制新内容没有被记录=${notRecorded}（主进程里仍是 ${after.length} 条）；重新打开后又能记录=${recorded}（正对照，共 ${after2.length} 条）`,
      { uiOk, notRecorded, recorded, before: before.length, after: after.length, after2: after2.length, debug: st.panelsDebug });
  }

  // ── W19 长列表分片渲染 ──
  {
    // 直接走 IPC 灌 300 条（比点 300 次快得多，一样是真实数据路径）
    const n = await evalFn(`async () => {
      for (let i = 0; i < 300; i++) await window.naiwa.notes.add('批量测试便签 ' + i);
      return (await window.naiwa.notes.list()).length;
    }`);
    await page(`(() => { const t = document.querySelector('.tab[data-tab=notes]'); t.click(); return true; })()`);
    await sleep(300);
    await page(`window.Naiwa.Panels.refresh()`);
    await sleep(600);
    const st = await state();
    const chunked = st.noteRows <= 60 && st.panelsDebug.notes >= 300;
    const footSays = /已显示 \d+ \/ \d+/.test(st.noteFoot);
    // 滚到底 → 续一屏
    await evalFn(`(() => {
      const l = document.getElementById('note-list');
      l.scrollTop = l.scrollHeight;
      l.dispatchEvent(new Event('scroll'));
      return true;
    })()`);
    await sleep(500);
    const st2 = await state();
    const grew = st2.noteRows > st.noteRows && st2.noteRows <= 120;
    const archiveTip = /归档/.test(st2.noteFoot);
    record('W19_long_list_chunked', chunked && footSays && grew && archiveTip ? 'PASS' : 'FAIL',
      `灌到 ${st.panelsDebug.notes} 条便签后一次只渲染 ${st.noteRows} 个节点（≤60）；页脚「${st.noteFoot}」；` +
      `滚到底续到 ${st2.noteRows} 条；归档提示=${archiveTip}`,
      { st: { rows: st.noteRows, debug: st.panelsDebug, foot: st.noteFoot }, st2: { rows: st2.noteRows, foot: st2.noteFoot } });
  }

  // ── W20 全局异常汇总 ──
  {
    const st = await state();
    // 那几张图加载失败是测试自己制造的（改清单指错路径 / 把文件弄坏），不算失败
    const unexpectedLoads = st.loadErrs.filter((l) => !/idle_work\.png|idle_relax\.png|sweat\.png|__missing__/.test(l));
    const total = st.errs.length + st.rejections.length + consoleErrors.length + unexpectedLoads.length;
    record('W20_no_uncaught_errors', total === 0 ? 'PASS' : 'FAIL',
      `未捕获异常 ${st.errs.length}、unhandled rejection ${st.rejections.length}、console.error ${consoleErrors.length}、` +
      `非预期的资源加载失败 ${unexpectedLoads.length}（另有 ${expectedErrors.length} 条是故意让素材加载失败产生的，不计入）`,
      { errs: st.errs, rejections: st.rejections, consoleErrors, unexpectedLoads, expectedErrors: expectedErrors.slice(0, 8) });
  }

  // 收尾：留下一些数据给「数据损坏」那一轮用（标记里要有条数）
  try {
    clipboard.writeText('冒烟测试 收尾留下的剪贴板记录');
    await sleep(1200);
    const st = await state();
    emit(`\n[smoke] 收尾：便签 ${st.panelsDebug.notes} 条、剪贴板 ${st.panelsDebug.clips} 条；localStorage 标记=${st.lsMarker}`);
  } catch (e) { /* 忽略 */ }

  clearInterval(keepHidden);
}

// ───────────────────────── 素材缺失那一轮（在项目的副本里跑） ─────────────────────────
//
// ⚠️ 为什么要在**副本**里跑：本机环境下，`<项目>/assets/**` 里做写入/删除/改名
//    会被系统拒绝（EPERM，即使进程不受沙箱限制也一样）。而在项目之外（比如
//    工作区里的 .naiwa-smoke-work/proj）一切正常。所以这一轮把整个项目复制一份，
//    在副本里随便破坏素材 —— 既测到了真实行为，也**完全没有动仓库里的文件**。
//
// 启动方式见交付文档第 5 节。

async function runMissingAssets() {
  emit('\n[smoke] —— 素材缺失轮（项目副本）——');
  emit(`[smoke] 项目=${PROJECT}`);

  win = findWin();
  if (!win) { record('W17_missing_work_assets', 'FAIL', '没有找到窗口'); return; }
  win.hide();
  win.webContents.on('dom-ready', () => { page(INSTRUMENT).catch(() => { /* 忽略 */ }); });
  keepHiddenTimer = setInterval(() => {
    try { if (win && !win.isDestroyed() && win.isVisible()) win.hide(); } catch (e) { /* 忽略 */ }
  }, 200);

  await bootWait('素材缺失轮');
  await setModeViaMain('work');
  await sleep(800);

  // ── 第一段：改清单，把 sweat 指到不存在的路径、idle_work 声明为 none ──
  {
    const patched = patchManifestForMissing();
    emit(`[smoke] 改清单：${patched.ok ? '成功' : '失败 ' + patched.err}`);
    await reloadPage('work');
    const st = await state();
    const realFallback = st.visTag === 'IMG' && /idle_relax\.png$/.test(st.visSrc || '') && st.visNaturalW > 0;
    const sweaty = st.workState ? st.workState.sweatUsable : null;

    const sndBefore = st.snd.length;
    fakeCpu = CPU_HOT;
    await sleep(4800);
    const st2 = await state();
    const sndHot = st2.snd.slice(sndBefore);
    const stillFallback = st2.visTag === 'IMG' && /idle_relax\.png$/.test(st2.visSrc || '');

    await page(CLICK_PET);
    const opened = await waitFor(`(() => !document.getElementById('panel').hidden)()`, 3000);
    await evalFn(`async () => {
      const ta = document.getElementById('note-text');
      ta.value = '没素材时也能记便签';
      document.getElementById('note-add').click();
      return true;
    }`);
    await sleep(700);
    const st3 = await state();
    const noteOk2 = st3.noteTexts.includes('没素材时也能记便签');

    const ok = patched.ok && realFallback && !st.visIsPlaceholder && sweaty === false
      && sndHot.includes('drip') && stillFallback && opened && noteOk2;
    record('W17_missing_work_assets', ok ? 'PASS' : 'FAIL',
      `sweat 路径指到不存在的文件 + idle_work 声明为 none（改清单=${patched.ok ? '成功' : '失败'}）：` +
      `基础图=${(st.visSrc || '').split('/').pop()}（真素材回落到 idle_relax=${realFallback}，占位蛙=${st.visIsPlaceholder ? '挂了（不该）' : '没挂'}）；` +
      `进入工作模式时 has('sweat')=${sweaty}；CPU→${CPU_HOT}% 时滴声=${sndHot.includes('drip')}、画面仍是待机图=${stillFallback}；` +
      `面板可开=${opened}、便签仍能加=${noteOk2}`,
      { patched, st: { src: st.visSrc, ph: st.visIsPlaceholder, work: st.workState }, st2: { src: st2.visSrc, snd: sndHot }, st3: { debug: st3.panelsDebug } });

    fakeCpu = CPU_COOL;
    restoreManifest();
  }

  // ── 第二段：真把 assets/work 的素材弄没（验收清单的原话就是「删掉 assets/work 下所有素材」）──
  {
    await navigateAway();
    const recSweat = breakFile(path.join('assets', 'work', 'sweat.png'));
    emit(`[smoke] 破坏素材：assets/work/sweat.png = ${recSweat.method || '失败(' + recSweat.err + ')'}`);
    await reloadPage('work');
    const st = await state();
    // ⚠️ 这一段的待机图**必须**还是真素材：删的只是 assets/work 下那张状态图，
    //    idle_work.png 还在。如果这里变成了占位卡通蛙，说明「素材没就位就乱挂」
    //    的毛病又回来了 —— 那正是这条验收要盯的东西。
    const realIdle = st.visTag === 'IMG' && /idle_work\.png$/.test(st.visSrc || '') && st.visNaturalW > 0;
    const sweaty = st.workState ? st.workState.sweatUsable : null;

    const sndBefore = st.snd.length;
    fakeCpu = CPU_HOT;
    await sleep(4800);
    const st2 = await state();
    const sndHot = st2.snd.slice(sndBefore);
    const noSweatSwap = !st2.visibleLayers.includes('sweat');
    const stillRealIdle = st2.visTag === 'IMG' && /idle_work\.png$/.test(st2.visSrc || '');

    await page(CLICK_PET);
    const opened = await waitFor(`(() => !document.getElementById('panel').hidden)()`, 3000);
    await evalFn(`async () => {
      const ta = document.getElementById('note-text');
      ta.value = '没 sweat 素材时也能记便签';
      document.getElementById('note-add').click();
      return true;
    }`);
    await sleep(700);
    const st3 = await state();
    const noteOk2 = st3.noteTexts.includes('没 sweat 素材时也能记便签');

    const broke = !!recSweat.method;
    const ok = broke && realIdle && !st.visIsPlaceholder && sweaty === false
      && sndHot.includes('drip') && noSweatSwap && stillRealIdle && opened && noteOk2;
    record('W17b_assets_really_gone', ok ? 'PASS' : 'FAIL',
      `assets/work/sweat.png 真的没了（${recSweat.method || recSweat.err}）之后：` +
      `待机图=${(st.visSrc || '').split('/').pop()}（仍是真素材=${realIdle}，占位蛙=${st.visIsPlaceholder ? '挂了（不该）' : '没挂'}）；` +
      `has('sweat')=${sweaty}；CPU→${CPU_HOT}% 时滴声=${sndHot.includes('drip')}、没有换上 sweat 层=${noSweatSwap}、画面仍是真待机图=${stillRealIdle}；` +
      `面板可开=${opened}、便签仍能加=${noteOk2}`,
      { recSweat: { method: recSweat.method, err: recSweat.err }, st: { src: st.visSrc, ph: st.visIsPlaceholder, work: st.workState }, st2: { layers: st2.visibleLayers, src: st2.visSrc, snd: sndHot }, st3: { debug: st3.panelsDebug } });
    fakeCpu = CPU_COOL;
  }

  // ── 第三段：连共享待机图也弄没 —— 一张素材都没有，仍然要能启动、能用 ──
  {
    await navigateAway();
    const recIdle = breakFile(path.join('assets', 'shared', 'idle_relax.png'));
    const recIdleWork = breakFile(path.join('assets', 'shared', 'idle_work.png'));
    emit(`[smoke] 再破坏共享待机图：idle_relax.png=${recIdle.method || '失败(' + recIdle.err + ')'}、idle_work.png=${recIdleWork.method || '失败(' + recIdleWork.err + ')'}`);
    await reloadPage('work');
    const st = await state();
    const bootOk = !!st.workState;
    // 一张素材都没有时，落到占位奶蛙是**核心层文档规定**的回落（docs/00 §9.2
    // 「每个槽位都退回内置占位奶蛙」）——这里要盯的是「不许白屏、不许崩、功能还在」。
    const placeholder = st.visIsPlaceholder;

    await page(CLICK_PET);
    const opened = await waitFor(`(() => !document.getElementById('panel').hidden)()`, 3000);
    await evalFn(`async () => {
      const ta = document.getElementById('note-text');
      ta.value = '零素材状态下的便签';
      document.getElementById('note-add').click();
      return true;
    }`);
    await sleep(700);
    const st2 = await state();
    const noteOk2 = st2.noteTexts.includes('零素材状态下的便签');
    const bad = st2.errs.length + st2.rejections.length;
    const ok = !!recIdle.method && !!recIdleWork.method && bootOk && placeholder && opened && noteOk2 && bad === 0;
    record('W18_missing_all_assets', ok ? 'PASS' : 'FAIL',
      `三张 PNG 全都没了（idle_relax=${recIdle.method}、idle_work=${recIdleWork.method}）之后：启动=${bootOk}（可见层=${st2.visibleLayers.join('/')}，` +
      `落到占位奶蛙=${placeholder} —— 这是 docs/00 §9.2 规定的回落），面板可开=${opened}，便签可加=${noteOk2}，未捕获异常/rejection=${bad}`,
      { recIdle: { method: recIdle.method, err: recIdle.err }, recIdleWork: { method: recIdleWork.method, err: recIdleWork.err }, st: { layers: st2.visibleLayers, ph: placeholder }, errs: st2.errs, rejections: st2.rejections });
  }

  clearInterval(keepHiddenTimer);
}

async function runBigClips() {
  // 只跑一轮：预置 500 条剪贴板历史（见文件顶部的预置代码），验证渲染层不卡
  emit('\n[smoke] —— 500 条剪贴板历史轮 ——');
  win = findWin();
  if (!win) { record('W24_bigclips_chunked', 'FAIL', '没有找到窗口'); return; }
  win.hide();
  win.webContents.on('dom-ready', () => { page(INSTRUMENT).catch(() => { /* 忽略 */ }); });
  await bootWait('大列表轮');

  // 切到剪贴板页
  await page(`(() => { const t = document.querySelector('.tab[data-tab=clips]'); t.click(); return true; })()`);
  await sleep(600);
  const st = await state();
  const chunked = st.clipRows > 0 && st.clipRows <= 60 && st.panelsDebug.clips === 500;
  record('W24_bigclips_chunked', chunked ? 'PASS' : 'FAIL',
    `面板里共 ${st.panelsDebug.clips} 条剪贴板历史，一次只渲染 ${st.clipRows} 个节点（≤60）；页脚「${st.clipFoot}」`,
    { rows: st.clipRows, debug: st.panelsDebug, foot: st.clipFoot });

  // 滚到底部续一屏（并量一下这次渲染耗時，确认不是一次性把 500 条全渲出来）
  const grow = await evalFn(`(() => {
    const l = document.getElementById('clip-list');
    const t0 = performance.now();
    l.scrollTop = l.scrollHeight;
    l.dispatchEvent(new Event('scroll'));
    return { ms: Math.round(performance.now() - t0), rows: l.children.length };
  })()`);
  await sleep(300);
  const st2 = await state();
  const grew = st2.clipRows > st.clipRows && st2.clipRows <= 120;
  record('W25_bigclips_scroll_more', grew ? 'PASS' : 'FAIL',
    `滚到底部后从 ${st.clipRows} 条续到 ${st2.clipRows} 条（仍然只有一屏多，没有全量渲染）；这一次滚动处理耗时约 ${grow.ms}ms`,
    { before: st.clipRows, after: st2.clipRows, grow });

  // 搜索：500 条里找一条特定的
  const search = await evalFn(`(() => {
    const el = document.getElementById('clip-search');
    const t0 = performance.now();
    el.value = '第 250 条';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const t1 = performance.now();
    const rows = document.querySelectorAll('#clip-list .clip-item').length;
    return { ms: Math.round(t1 - t0), rows, text: (document.querySelector('#clip-list .clip-item .text') || {}).textContent || '' };
  })()`);
  await sleep(300);
  const st3 = await state();
  const hit = st3.clipRows >= 1 && st3.clipTexts.every((t) => t.includes('第 250 条'));
  const fast = search.ms < 400;      // 500 条子串搜索应该远低于这个量级
  record('W26_bigclips_search_fast', hit && fast ? 'PASS' : 'FAIL',
    `在 500 条里搜「第 250 条」→ 命中 ${st3.clipRows} 条（都对=${hit}），同步处理耗时约 ${search.ms}ms`,
    { search, rows: st3.clipRows, texts: st3.clipTexts.slice(0, 3) });

  const bad = st3.errs.length + st3.rejections.length;
  record('W27_bigclips_no_errors', bad === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL',
    `500 条历史下未捕获异常 ${st3.errs.length} / rejection ${st3.rejections.length} / console.error ${consoleErrors.length}`,
    { errs: st3.errs, rejections: st3.rejections, consoleErrors });
}

// ───────────────────────── 6. 启动 ─────────────────────────

app.whenReady().then(async () => {
  await sleep(600);

  // 控制台错误收集（真实主进程的 console-message 事件）
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.on('console-message', (_e, level, message) => {
      // level: 0=verbose 1=info 2=warning 3=error
      if (level >= 3) noteConsoleError(message);
    });
    w.webContents.on('render-process-gone', (_e, d) => {
      consoleErrors.push('render-process-gone: ' + JSON.stringify(d));
    });
  }

  // 新窗口（一般不会有）也挂上
  app.on('browser-window-created', (_e, w) => {
    w.webContents.on('console-message', (_e2, level, message) => {
      if (level >= 3) noteConsoleError(message);
    });
  });

  emit(`[smoke.work] electron=${process.versions.electron} chrome=${process.versions.chrome} pid=${process.pid}`);
  emit(`[smoke.work] 隔离工作目录=${SMOKE_TMP}（不碰用户真实便签/剪贴板）`);
  emit(`[smoke.work] CPU 由测试伪造（替换 os.cpus），但采样→IPC→分发→模式层全是真的`);

  let fatal = null;
  try {
    if (CORRUPT_RUN) await runCorruptRun();
    else if (BIGCLIPS_RUN) await runBigClips();
    else if (MISSING_RUN) await runMissingAssets();
    else await runMain();
  } catch (e) {
    fatal = e;
    emit(`\n[smoke.work] 执行中断：${e && e.stack ? e.stack : e}`);
  }
  if (keepHiddenTimer) clearInterval(keepHiddenTimer);

  // 把这一轮没跑的用例补成 SKIP 并写明原因。
  // 不补的话，报告里只有跑到的那几项，看起来像「全都通过了」。
  {
    const done = new Set(RESULTS.map((r) => r.id));
    // 这些用例属于「另一轮」，不是漏做
    const OTHER_RUN = {
      W17_missing_work_assets: 'SMOKE_WORK_MISSING=1（项目副本）',
      W17b_assets_really_gone: 'SMOKE_WORK_MISSING=1（项目副本）',
      W18_missing_all_assets: 'SMOKE_WORK_MISSING=1（项目副本）',
      W21_data_corrupt_notice: 'SMOKE_WORK_CORRUPT=1',
      W22_corrupt_still_usable: 'SMOKE_WORK_CORRUPT=1',
      W23_corrupt_no_errors: 'SMOKE_WORK_CORRUPT=1',
      W24_bigclips_chunked: 'SMOKE_WORK_BIGCLIPS=1',
      W25_bigclips_scroll_more: 'SMOKE_WORK_BIGCLIPS=1',
      W26_bigclips_search_fast: 'SMOKE_WORK_BIGCLIPS=1',
      W27_bigclips_no_errors: 'SMOKE_WORK_BIGCLIPS=1',
    };
    for (const [id] of CANON) {
      if (done.has(id)) continue;
      if (OTHER_RUN[id] && !CORRUPT_RUN && !BIGCLIPS_RUN && !MISSING_RUN) {
        record(id, 'SKIP', `在另一轮里跑：${OTHER_RUN[id]}`);
      } else if (fatal) {
        record(id, 'SKIP', `未执行：前面的用例中断了（${fatal.message}）`);
      }
    }
  }

  // 确保素材一定还原（任何异常都不能让仓库缺文件 / 少内容）
  restoreManifest();
  let restoreBad = 0;
  for (const rec of BROKEN) {
    if (!restoreBreak(rec)) restoreBad++;
    const now = fileInfo(rec.rel);
    if (!now.exists || now.bytes !== (rec.buf ? rec.buf.length : -1)) restoreBad++;
  }
  if (BROKEN.length) {
    emit(`[smoke.work] 破坏过的素材已还原：${BROKEN.map((r) => `${r.rel}(${r.method}→${fileInfo(r.rel).bytes}B)`).join('、')}` +
      (restoreBad ? ` —— ⚠️ 有 ${restoreBad} 处没还原干净！` : ''));
  }
  // 最后再确认一次清单也还原了
  for (const rel of ['assets/manifest.work.js', 'assets/work/sweat.png', 'assets/shared/idle_work.png', 'assets/shared/idle_relax.png']) {
    const info = fileInfo(rel);
    emit(`[smoke.work]   ${rel} → ${info.exists ? info.bytes + ' 字节 sha1=' + info.sha : '缺失！⚠️'}`);
  }

  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  RESULTS.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });

  emit('\n' + '='.repeat(96));
  emit(CORRUPT_RUN ? ' 奶蛙桌宠 · 工作模式冒烟测试（数据损坏轮）' : ' 奶蛙桌宠 · 工作模式冒烟测试结果');
  emit('='.repeat(96));
  emit(' #  ID                                    状态   证据摘要');
  emit(' ' + '-'.repeat(94));
  RESULTS.forEach((r, i) => {
    emit(` ${String(i + 1).padStart(2)} ${r.id.padEnd(36)} ${r.status.padEnd(6)} ${r.evidence}`);
  });
  emit(' ' + '-'.repeat(94));
  emit(` 合计 PASS=${counts.PASS} FAIL=${counts.FAIL} SKIP=${counts.SKIP} TOTAL=${RESULTS.length}`);
  if (fatal) emit(` 执行中断：${fatal.message}`);
  emit(` 渲染进程 console.error=${consoleErrors.length}`);
  if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((m) => emit('   · ' + m));

  const payload = {
    harness: '__smoke.work.js',
    corruptRun: CORRUPT_RUN,
    startedAt: new Date().toISOString(),
    project: PROJECT,
    electron: process.versions.electron,
    counts,
    fatal: fatal ? String(fatal.message) : null,
    checks: RESULTS.map((r) => ({ id: r.id, title: r.title, source: r.source, status: r.status, evidence: r.evidence })),
    consoleErrors,
  };
  emit('\nSMOKE_WORK_RESULT ' + JSON.stringify(payload));

  try { fs.writeFileSync(path.join(SMOKE_TMP, CORRUPT_RUN ? 'report-corrupt.txt' : 'report.txt'), LOG_LINES.join('\n') + '\n', 'utf8'); } catch (e) { /* 忽略 */ }

  const bad = counts.FAIL > 0 || fatal;
  setTimeout(() => app.exit(bad ? 1 : 0), 200);
}).catch((e) => {
  emit('[smoke.work] 启动失败：' + (e && e.stack ? e.stack : e));
  app.exit(2);
});