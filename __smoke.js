'use strict';
/* ============================================================================
 * 奶蛙桌宠 · 无头自动化冒烟测试（headless smoke harness）
 * ============================================================================
 *
 * 运行：
 *     cd naiwa-pet
 *     npx electron __smoke.js
 *
 *   本机（受限环境）实测需要额外两个前提，见下面【环境适配】：
 *     npx electron --no-sandbox __smoke.js
 *
 * 它做什么：
 *   1. require('./main.js')，用**真实的**主进程、IPC、preload、窗口、渲染进程跑，
 *      不重写任何产品逻辑。
 *   2. 立刻 hide() 掉宠物窗口（透明 + 置顶窗口留在桌面上很打扰），
 *      并且全程守着：任何时刻窗口被 show 出来都会在下一拍藏回去。
 *   3. 等渲染进程异步启动完成，然后用 executeJavaScript 派发**真实**的
 *      mousedown / mouseup / contextmenu / mousemove 事件，坐标从
 *      #pet.getBoundingClientRect() + manifest 的命中椭圆算出来，不写死。
 *   4. 按 docs/01-解压模式.md §8「验收清单」逐条断言（能从 DOM 观测到的部分），
 *      外加 docs/00-协作约定.md 里那条「来回切模式 20 次」的健壮性检查。
 *   5. 打印一张紧凑表格 + 一行机器可读的 SMOKE_RESULT {json}；
 *      有任何一项 FAIL 就非零退出（SKIP 不算失败）。
 *
 * 它不做什么：
 *   - 不改任何产品文件（唯一新增的文件就是本文件）。
 *   - 不调用内部函数伪造结果：所有判定只看 DOM / 事件路径的真实效果。
 *     唯一的「观测插桩」是包装 requestAnimationFrame / setTimeout /
 *     CanvasRenderingContext2D.drawImage / Web Audio 原型方法，用来**数数**，
 *     不改变任何行为。
 *   - 不把窗口显示出来。
 *
 * 判定原则：
 *   PASS = 真的观测到了；FAIL = 真的观测到不符合预期；
 *   SKIP = 前置条件不成立、当前代码还看不到这个行为（必须写明原因）。
 *   绝不放宽断言去凑 PASS。
 *
 * 【环境适配】（本机实测，2026-xx）
 *   - Chromium 沙箱在本机不可用：不带 --no-sandbox 时 electron 直接以退出码 3
 *     结束，连 JS 都不执行。所以运行命令带 --no-sandbox。
 *   - 本进程对 %TEMP% 的写入被拒绝（EPERM），Chromium 初始化会因此段错误
 *     （0xC0000005）。所以这里把 Chromium 的 temp / userData / cache / crashDumps
 *     全部改到工作区下的 .naiwa-smoke-tmp/（**项目目录之外**），
 *     并且用隔离的 userData，避免污染用户真实的便签 / 剪贴板数据。
 *     这两件事都必须在 require('./main.js') 之前做完。
 *   - 环境变量：SMOKE_TIMEOUT_MS（默认 420000）、SMOKE_RUN_CYCLES（默认 3）、
 *     SMOKE_DEBUG=1（打印每项检查的原始证据）。
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PROJECT = __dirname;
const WORKSPACE = path.dirname(PROJECT);          // 项目之外、但可写的目录
// 隔离的工作目录。默认在项目旁边，可以用 SMOKE_TMP_DIR 指到别处。
//
// 为什么需要这个开关：main.js 用 app.requestSingleInstanceLock()，而那个锁是按
// userData 路径算的 —— 也就是按这个目录算的。如果上一次跑挂了、进程还赖着不走，
// 新的一轮会直接走「已存在实例」分支退出，整张表全判 FAIL。
// 换一个目录就等于换一把锁，照样能跑。
const SMOKE_TMP = process.env.SMOKE_TMP_DIR
  ? path.resolve(process.env.SMOKE_TMP_DIR)
  : path.join(WORKSPACE, '.naiwa-smoke-tmp');
const CM = process.argv.slice(1);                  // 启动参数，写进报告备查

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 420000);
const RUN_CYCLES = Math.max(1, Number(process.env.SMOKE_RUN_CYCLES || 3));
const IDLE_WAIT_MS = Number(process.env.SMOKE_IDLE_WAIT_MS || 72000);   // 每轮等起跑的上限（规格是 60~65s 触发）
const DEBUG = process.env.SMOKE_DEBUG === '1';

// ───────────────────────── 0. 环境适配（必须在 require('./main.js') 之前） ─────

for (const sub of ['temp', 'userdata', 'cache', 'crash']) {
  try { fs.mkdirSync(path.join(SMOKE_TMP, sub), { recursive: true }); } catch (e) { /* 忽略 */ }
}
process.env.TEMP = path.join(SMOKE_TMP, 'temp');
process.env.TMP = process.env.TEMP;
process.env.TMPDIR = process.env.TEMP;

const { app, BrowserWindow } = require('electron');

try { app.setPath('temp', process.env.TEMP); } catch (e) { /* 忽略 */ }
try { app.setPath('userData', path.join(SMOKE_TMP, 'userdata')); } catch (e) { /* 忽略 */ }
try { app.setPath('crashDumps', path.join(SMOKE_TMP, 'crash')); } catch (e) { /* 忽略 */ }
try { app.setPath('sessionData', path.join(SMOKE_TMP, 'cache')); } catch (e) { /* 忽略 */ }
app.commandLine.appendSwitch('disk-cache-dir', path.join(SMOKE_TMP, 'cache'));
app.commandLine.appendSwitch('crash-dumps-dir', path.join(SMOKE_TMP, 'crash'));

// ───────────────────────── 1. 报告管道 ─────────────────────────

const LOG_LINES = [];
function emit(line) {
  LOG_LINES.push(line);
  try { process.stdout.write(line + '\n'); } catch (e) { /* stdout 可能不可用 */ }
}
function flushLog() {
  try { fs.writeFileSync(path.join(SMOKE_TMP, 'report.txt'), LOG_LINES.join('\n') + '\n', 'utf8'); } catch (e) { /* 忽略 */ }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

const CANON = [
  ['H0_renderer_boot', '渲染进程完成启动（window.Naiwa.Pet + #pet 就绪）', 'harness'],
  ['E1_mode_structure', '模式模块结构就位（Naiwa.Modes.relax / pet 新原语）', 'extra: docs/00 §5.3'],
  ['S1_static_idle_no_loop', '进入模式后静止，没有循环动画', 'docs/01 §8-1'],
  ['S2_click_once_laugh_then_idle', '点一下 → 大笑 → 笑完回静态', 'docs/01 §8-2'],
  ['S3_click_once_audio', '点一下有音效被触发', 'docs/01 §8-2'],
  ['S4_quad_click_two_clones', '2.6s 内点 4 下 → 恰好出现 2 个分身', 'docs/01 §8-3'],
  ['S5_clones_frame_synced', '主体 + 2 分身严格同帧大笑', 'docs/01 §8-3'],
  ['S6_clones_removed_after', '笑完分身从 DOM 消失', 'docs/01 §8-3'],
  ['S7_no_extra_clones_during_performance', '分身表演期间继续点击不会产生更多分身', 'docs/01 §8-4'],
  ['S8_no_retrigger_within_3s', '表演结束后 3s 内不会再次触发（含正对照）', 'docs/01 §8-5'],
  ['S9_idle_60s_starts_run', '闲置约 60s → 起跑循环 + 左右往返位移', 'docs/01 §8-6'],
  ['S10_run_click_returns_then_laughs', '跑步时点击 → 平滑归位 + 立即大笑', 'docs/01 §8-7'],
  ['S11_run_mouseover_stops', '跑步时鼠标移入奶蛙 → 平滑归位', 'docs/01 §8-8'],
  ['S12_pupils_follow_mouse', '鼠标在窗口内移动 → 瞳孔跟随', 'docs/01 §8-9'],
  ['S13_mode_switch_20x', '来回切模式 20 次：不报错、行为不叠加', 'docs/01 §8-健壮性'],
  ['S14_no_uncaught_renderer_errors', '全程没有未捕获异常 / unhandled rejection', 'harness'],
  ['S15_clone_cleanup_on_mode_switch', '分身表演到一半右键切模式 → 分身立刻消失', 'docs/01 §8-健壮性'],
  ['S16_run_cleanup_on_mode_switch', '跑步到一半切模式 → 位移归零', 'docs/01 §8-健壮性'],
  ['S17_menu_single_right_click', '右键单击弹出操作窗（含退出奶蛙），光标移开自动收起', '第五次会话'],
  ['S18_drag_keeps_static_image', '拖拽时保持当前静态图，不换成占位卡通蛙', '第五次会话'],
];
const CANON_IDS = CANON.map((c) => c[0]);

const checks = [];
let finished = false;
let win = null;
const consoleMsgs = [];       // 渲染进程 console（含 error/warning）
const pageErrors = [];        // 主进程侧捕获的渲染进程异常（preload / render-process-gone 等）
const notes = [];

function record(id, status, evidence, detail) {
  const meta = CANON.find((c) => c[0] === id) || [id, id, ''];
  const prev = checks.find((c) => c.id === id);
  const item = {
    id,
    title: meta[1],
    source: meta[2],
    status,
    evidence: String(evidence == null ? '' : evidence),
    detail: detail || null,
    ms: null,
    at: new Date().toISOString(),
  };
  if (prev) Object.assign(prev, item); else checks.push(item);
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  emit(`  [${mark}] ${id} — ${item.evidence}`);
  if (DEBUG && detail) emit('         detail: ' + JSON.stringify(detail).slice(0, 1200));
  return item;
}
function fillMissing(reason) {
  for (const id of CANON_IDS) if (!checks.find((c) => c.id === id)) record(id, 'SKIP', reason, null);
}
function fmtCounts() {
  const c = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const x of checks) c[x.status] = (c[x.status] || 0) + 1;
  c.TOTAL = checks.length;
  return c;
}

function hashSources() {
  const files = [
    'main.js', 'preload.js', '__verify.js', 'package.json',
    'renderer/index.html', 'renderer/app.js', 'renderer/pet.js', 'renderer/assets.js',
    'renderer/audio.js', 'renderer/panels.js', 'renderer/style.css',
    'assets/manifest.js', 'assets/manifest.relax.js', 'assets/manifest.work.js',
    'renderer/modes/relax.js', 'renderer/modes/work.js', 'renderer/core/pet.js',
  ];
  const out = {};
  for (const f of files) {
    try {
      out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(PROJECT, f))).digest('hex').slice(0, 12);
    } catch (e) { out[f] = null; }
  }
  return out;
}

// ───────────────────────── 2. 看门狗 / 收尾 ─────────────────────────

let currentStage = 'init';
const watchdog = setTimeout(() => {
  emit('');
  emit(`[FATAL] 看门狗超时（${TIMEOUT_MS}ms）——强制结束，避免挂死。当前阶段：${currentStage}`);
  finish(2, { watchdog: true, stage: currentStage });
}, TIMEOUT_MS);
if (watchdog.unref) watchdog.unref();
function stage(name) { currentStage = name; emit(`\n[smoke] ── ${name} ──`); }

function hideAll() {
  try { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.isVisible()) w.hide(); } catch (e) { /* 忽略 */ }
}

/**
 * 窗口策略。
 *   'hidden'  —— 窗口 hide()，桌面上绝对看不到（默认、最干净）。
 *   'stealth' —— setOpacity(0) + showInactive()：窗口对用户完全不可见（全透明、
 *                不抢焦点、skipTaskbar、点击穿透），但它对合成器是「可见」的。
 *
 * 为什么要留第二种：**隐藏窗口拿不到 BeginFrame，rAF 完全不跑**，
 * 那样所有跟动画/帧相关的验收项都观测不到（那是环境假象，不是产品问题）。
 * 所以先按需求 hide()，实测 rAF 是否还在跑；跑不动才退到全透明的隐身模式，
 * 并在报告里写清楚。
 */
let POLICY = 'hidden';
let PRIMING = false;
function ensureInvisible() {
  if (finished || !win || win.isDestroyed()) return;
  if (POLICY === 'hidden') { try { if (win.isVisible()) win.hide(); } catch (e) {} return; }
  try { if (win.getOpacity() !== 0) win.setOpacity(0); } catch (e) {}
  try { if (!win.isVisible()) win.showInactive(); } catch (e) {}
  // 全透明窗口也绝不能挡住桌面点击：渲染层会根据光标位置来回切穿透，这里持续压回穿透态
  try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (e) {}
}
function raceTimeout(p, ms, fallback) {
  return Promise.race([p.then((v) => v, (e) => ({ __err: String(e && e.message) })), sleep(ms).then(() => fallback)]);
}
/** 帧能不能跑起来：带超时，绝不让 rAF 卡住整个测试。 */
async function rafProbe(ms, timeoutMs) {
  return raceTimeout(js(`window.__SMOKE__.rafPerFrameRun(${ms}, function(){})`), timeoutMs, { stalled: true, frames: 0, perFrame: null, ms: ms });
}
/** 所有依赖 rAF 的页面调用都从这里走，保证不会挂死。 */
async function pageMetrics(ms) {
  return raceTimeout(PJ('metrics', ms), ms * 4 + 2000, {
    stalled: true, mode: null, activeAnim: null, m41: null, clones: null, laughing: null,
    pendingTimeouts: 0, pendingIntervals: 0, createdTimeouts: 0, createdIntervals: 0,
    clearedTimeouts: 0, clearedIntervals: 0, rafCallbacks: 0, rafCallbacksDelta: 0,
    frames: 0, rafPerFrame: null, anims: { supported: false, infinite: [], all: [] }, errors: 0, consoleErrors: 0, audio: 0,
  });
}
async function pageTrack(ms) {
  return raceTimeout(PJ('track', ms), ms * 5 + 3000, { stalled: true, ms: ms, n: 0, mFirst: null, mLast: null, mMin: null, mMax: null, leftMin: null, leftMax: null, distinct: 0, samplesTail: [] });
}

function pad(s, n) {
  // 中日韩字符按两列宽估算，纯为了让表格能看
  const w = (str) => Array.from(String(str)).reduce((a, ch) => a + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
  const str = String(s);
  const diff = n - w(str);
  return str + (diff > 0 ? ' '.repeat(diff) : '');
}

function finish(code, extra) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  fillMissing('未执行（前面的检查提前退出了）');

  // 源码在运行期间被改过？那这份基线就不能归因到某一个版本 —— 必须写出来。
  let hashesAtEnd = null, changedDuringRun = [];
  try {
    hashesAtEnd = hashSources();
    changedDuringRun = Object.keys(hashesAtEnd).filter((k) => hashesAtEnd[k] !== (HASHES || {})[k]);
    if (changedDuringRun.length) {
      notes.push('⚠ 运行期间下列文件被改动过：' + changedDuringRun.join('、') + ' —— 本次结果对应的是一个**变动中的工作树**，不能归因到单一版本。');
    }
  } catch (e) { /* 忽略 */ }

  const counts = fmtCounts();
  const order = new Map(CANON_IDS.map((id, i) => [id, i]));
  checks.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));

  emit('\n' + '='.repeat(96));
  emit(' 奶蛙桌宠 · 无头冒烟测试结果（baseline）');
  emit('='.repeat(96));
  emit(' ' + pad('#', 3) + pad('ID', 38) + pad('状态', 7) + pad('耗时', 8) + '证据摘要');
  emit(' ' + '-'.repeat(94));
  checks.forEach((c, i) => {
    emit(' ' + pad(i + 1, 3) + pad(c.id, 38) + pad(c.status, 7) + pad(c.ms == null ? '-' : c.ms + 'ms', 8) + String(c.evidence).slice(0, 200));
  });
  emit(' ' + '-'.repeat(94));
  emit(` 合计 PASS=${counts.PASS} FAIL=${counts.FAIL} SKIP=${counts.SKIP} TOTAL=${counts.TOTAL}`);

  const bad = checks.filter((c) => c.status === 'FAIL');
  if (bad.length) {
    emit('\n 未通过项的证据详情：');
    for (const c of bad) emit(`  · ${c.id}（${c.source}）\n      ${c.evidence}`);
  }
  const skipped = checks.filter((c) => c.status === 'SKIP');
  if (skipped.length) {
    emit('\n SKIP 及原因：');
    for (const c of skipped) emit(`  · ${c.id}：${c.evidence}`);
  }

  const appConsoleErrors = consoleMsgs.filter((m) => m.level === 'error');
  const loadErrors = appConsoleErrors.filter((m) => /Failed to load resource|ERR_FILE_NOT_FOUND|net::ERR/i.test(m.message || ''));
  const scriptErrors = appConsoleErrors.filter((m) => loadErrors.indexOf(m) < 0);
  const missingFiles = [...new Set(loadErrors.map((m) => (/(file:\/\/[^\s'"]+)/.exec(m.message || '') || [null, m.source])[1]).filter(Boolean).map((u) => String(u).replace(/^.*?naiwa-pet[\\/]/i, '').replace(/^file:\/\//, '')))];
  emit('\n 渲染进程 console 捕获：error=' + appConsoleErrors.length + `（脚本异常 ${scriptErrors.length} / 资源加载失败 ${loadErrors.length}）` + ' warning=' + consoleMsgs.filter((m) => m.level === 'warning').length + ' 总条数=' + consoleMsgs.length);
  if (missingFiles.length) emit('   ! 加载失败的文件：' + missingFiles.join('、'));
  if (scriptErrors.length) for (const m of scriptErrors.slice(0, 20)) emit(`   ! [${m.at}ms] ${m.source}:${m.line} ${String(m.message).slice(0, 400)}`);
  else if (loadErrors.length) for (const m of loadErrors.slice(0, 8)) emit(`   ! [${m.at}ms] ${m.source} ${String(m.message).slice(0, 240)}`);
  if (pageErrors.length) {
    emit(' 主进程侧捕获的渲染进程错误：');
    for (const e of pageErrors.slice(0, 10)) emit('   ! ' + JSON.stringify(e).slice(0, 400));
  }
  if (notes.length) { emit('\n 备注：'); for (const n of notes) emit('  · ' + n); }

  const payload = {
    harness: '__smoke.js',
    startedAt: STARTED_ISO,
    durationMs: Date.now() - START_MS,
    project: PROJECT,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    launchArgs: CM,
    runInSandbox: !CM.some((a) => /no-sandbox/.test(a)),
    windowPolicy: POLICY,
    counts,
    checks: checks.map((c) => ({ id: c.id, title: c.title, source: c.source, status: c.status, evidence: c.evidence, ms: c.ms, ...(c.detail ? { detail: c.detail } : {}) })),
    consoleErrors: appConsoleErrors.map((m) => ({ at: m.at, source: m.source, line: m.line, message: String(m.message).slice(0, 500) })),
    consoleLoadErrors: loadErrors.map((m) => ({ at: m.at, source: m.source, message: String(m.message).slice(0, 400) })),
    missingFiles,
    consoleWarnings: consoleMsgs.filter((m) => m.level === 'warning').map((m) => ({ at: m.at, source: m.source, message: String(m.message).slice(0, 300) })),
    pageErrors,
    sourceHashes: HASHES,
    sourceHashesAtEnd: hashesAtEnd,
    sourcesChangedDuringRun: changedDuringRun,
    notes,
    ...(extra || {}),
  };
  emit('\nSMOKE_RESULT ' + JSON.stringify(payload));
  flushLog();
  try { fs.writeFileSync(path.join(SMOKE_TMP, 'report.json'), JSON.stringify(payload, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
  try { if (win && !win.isDestroyed()) win.hide(); } catch (e) { /* 忽略 */ }
  hideAll();
  app.exit(code);
}

const START_MS = Date.now();
const STARTED_ISO = new Date().toISOString();
let HASHES = null;   // main() 开头填充

// ───────────────────────── 3. 页面侧观测库（注入到渲染进程主世界） ─────────────
/* 这个函数会被 toString() 后注入渲染进程，所以：
   - 不能引用外部变量（自成一体）
   - 只做观测，不改产品行为
   - 返回的都是可 JSON 序列化的数据 */

function PAGE_LIB() {
  if (window.__SMOKE__) return;
  var S = {};
  window.__SMOKE__ = S;
  S.t0 = Date.now();
  S.errors = [];            // 未捕获异常 / unhandledrejection
  S.consoleErrors = [];     // console.error 双保险

  // ── 错误捕获 ──
  window.addEventListener('error', function (ev) {
    S.errors.push({ kind: 'error', message: String(ev.message), source: String(ev.filename || ''), line: ev.lineno, stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 600) : null, at: Date.now() - S.t0 });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    S.errors.push({ kind: 'unhandledrejection', message: r && r.message ? String(r.message) : String(r), stack: r && r.stack ? String(r.stack).slice(0, 600) : null, at: Date.now() - S.t0 });
  });
  try {
    var _ce = console.error.bind(console);
    console.error = function () {
      try { S.consoleErrors.push({ text: Array.prototype.map.call(arguments, String).join(' ').slice(0, 500), at: Date.now() - S.t0 }); } catch (e) {}
      return _ce.apply(null, arguments);
    };
  } catch (e) {}

  // ── 定时器登记（只数数，不改行为） ──
  S.timers = { timeouts: {}, intervals: {}, createdTimeouts: 0, createdIntervals: 0, clearedTimeouts: 0, clearedIntervals: 0 };
  var _st = window.setTimeout, _si = window.setInterval, _ct = window.clearTimeout, _ci = window.clearInterval;
  window.setTimeout = function (fn, ms) {
    S.timers.createdTimeouts++;
    if (typeof fn !== 'function') { var id0 = _st.apply(window, arguments); S.timers.timeouts[String(id0)] = { ms: ms || 0, at: Date.now() - S.t0 }; return id0; }
    var extra = Array.prototype.slice.call(arguments, 2), id;
    id = _st(function () { delete S.timers.timeouts[String(id)]; return fn.apply(this, extra); }, ms);
    S.timers.timeouts[String(id)] = { ms: ms || 0, at: Date.now() - S.t0 };
    return id;
  };
  window.clearTimeout = function (id) { if (id != null && S.timers.timeouts[String(id)]) { delete S.timers.timeouts[String(id)]; S.timers.clearedTimeouts++; } return _ct.call(window, id); };
  window.setInterval = function () { S.timers.createdIntervals++; var id = _si.apply(window, arguments); S.timers.intervals[String(id)] = { ms: arguments[1] || 0, at: Date.now() - S.t0 }; return id; };
  window.clearInterval = function (id) { if (id != null && S.timers.intervals[String(id)]) { delete S.timers.intervals[String(id)]; S.timers.clearedIntervals++; } return _ci.call(window, id); };

  // ── rAF 计数 ──
  S.raf = { callbacks: 0, wrapped: 0 };
  var _raf = window.requestAnimationFrame, _caf = window.cancelAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    if (typeof cb !== 'function') return _raf.call(window, cb);
    S.raf.wrapped++;
    return _raf.call(window, function (ts) {
      S.raf.callbacks++;
      try { return cb(ts); } catch (e) { S.errors.push({ kind: 'raf-callback', message: String(e && e.message), stack: e && e.stack ? String(e.stack).slice(0, 500) : null, at: Date.now() - S.t0 }); throw e; }
    });
  };
  window.cancelAnimationFrame = function (id) { return _caf.call(window, id); };

  // ── 音频触发计数 ──
  S.audio = { oscillators: 0, bufferSources: 0, mediaPlay: 0, lastAt: null };
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC && AC.prototype) {
      var _co = AC.prototype.createOscillator, _cb = AC.prototype.createBufferSource;
      if (_co) AC.prototype.createOscillator = function () { S.audio.oscillators++; S.audio.lastAt = Date.now() - S.t0; return _co.apply(this, arguments); };
      if (_cb) AC.prototype.createBufferSource = function () { S.audio.bufferSources++; S.audio.lastAt = Date.now() - S.t0; return _cb.apply(this, arguments); };
    }
    if (window.HTMLMediaElement && HTMLMediaElement.prototype && HTMLMediaElement.prototype.play) {
      var _mp = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { S.audio.mediaPlay++; S.audio.lastAt = Date.now() - S.t0; return _mp.apply(this, arguments); };
    }
  } catch (e) { S.errors.push({ kind: 'audio-spy', message: String(e && e.message) }); }
  S.audioTotal = function () { return S.audio.oscillators + S.audio.bufferSources + S.audio.mediaPlay; };

  // ── drawImage 观测：用来验证「三个 canvas 同一帧画同一张图」 ──
  S.draw = { on: false, calls: [], truncated: 0, participants: [] };
  var cvId = 0, cvIds = new WeakMap(), srcId = 0, srcIds = new WeakMap();
  S.canvasId = function (el) { if (!el || typeof el !== 'object') return -1; if (!cvIds.has(el)) cvIds.set(el, ++cvId); return cvIds.get(el); };
  S.srcId = function (el) { if (!el || typeof el !== 'object') return -2; if (!srcIds.has(el)) srcIds.set(el, ++srcId); return srcIds.get(el); };
  try {
    var proto = CanvasRenderingContext2D.prototype, _di = proto.drawImage;
    proto.drawImage = function (src) {
      if (S.draw.on) {
        try {
          if (S.draw.calls.length < 30000) {
            var nums = [];
            for (var i = 1; i < arguments.length; i++) nums.push(typeof arguments[i] === 'number' ? Math.round(arguments[i]) : -1);
            // 「画的是哪一张」要用**内容**判断，不能用对象身份。
            // 每个分身各自 mount 一次序列帧，于是各自持有一份 Image 数组：
            // 同一帧在三个实例里是三个不同的对象，按对象 id 比永远是「不一致」。
            // 而 src 的 URL 直接编着帧号（laugh_0007.png），比对象身份更接近
            // 「同一帧」的本意，也更严格 —— 差一帧就会是不同的 URL。
            var u = '';
            try { u = (src && (src.currentSrc || src.src)) || ''; } catch (e) { u = ''; }
            if (!u) u = 'obj:' + S.srcId(src);
            S.draw.calls.push({ c: S.canvasId(this.canvas), s: S.srcId(src), u: u, a: nums, t: Math.round(performance.now() * 10) / 10 });
          } else S.draw.truncated++;
        } catch (e) {}
      }
      return _di.apply(this, arguments);
    };
  } catch (e) { S.errors.push({ kind: 'draw-spy', message: String(e && e.message) }); }

  // ── 分身探测（对新结构保持宽容：命名/容器两种写法都认；空容器不算分身） ──
  var CLONE_SEL = '[data-clone], .pet-clone, .clone, [class*="clone" i], [id*="clone" i]';
  var VISUAL = { CANVAS: 1, IMG: 1, VIDEO: 1, SVG: 1 };
  function visualRoots(e) {
    var out = [];
    if (VISUAL[e.tagName]) out.push(e);
    var kids = e.querySelectorAll ? e.querySelectorAll('canvas, img, video, svg, [data-anim]') : [];
    for (var i = 0; i < kids.length; i++) if (out.indexOf(kids[i]) < 0) out.push(kids[i]);
    return out;
  }
  S.probeClones = function () {
    var named = [];
    try { named = Array.prototype.slice.call(document.querySelectorAll(CLONE_SEL)); } catch (e) { named = []; }
    named = named.filter(function (e) { return e.id !== 'pet' && !(e.closest && e.closest('#panel')); });
    var top = named.filter(function (e) { return !named.some(function (o) { return o !== e && o.contains(e); }); });
    var list = [];
    top.forEach(function (e) {
      // 只看真正的可视实例；空的 #pet-clones 容器不算分身
      visualRoots(e).forEach(function (v) { if (list.indexOf(v) < 0) list.push(v); });
    });
    var pet = document.getElementById('pet');
    if (pet) {
      Array.prototype.slice.call(pet.children).forEach(function (c) {
        if (c.id === 'pet-base' || c.id === 'pet-fx' || c.id === 'pet-bubble' || c.id === 'pet-clones') return;
        if (top.indexOf(c) >= 0 || list.indexOf(c) >= 0) return;
        var vis = visualRoots(c);
        if (!vis.length && c.children.length === 0 && c.getBoundingClientRect().width > 2) vis = [c];
        vis.forEach(function (v) { if (list.indexOf(v) < 0) list.push(v); });
      });
    }
    return list;
  };
  S.describeClones = function () {
    return S.probeClones().map(function (c) {
      var r = c.getBoundingClientRect ? c.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      return { tag: c.tagName, id: c.id || null, cls: String(c.className || '').slice(0, 60), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), opacity: parseFloat(getComputedStyle(c).opacity) };
    });
  };
  S.cloneCanvases = function () {
    var out = [];
    S.probeClones().forEach(function (c) { var cv = c.tagName === 'CANVAS' ? c : c.querySelector('canvas'); if (cv) out.push(S.canvasId(cv)); });
    return out;
  };
  S.laughCanvases = function () {
    var out = [];
    try {
      Array.prototype.forEach.call(document.querySelectorAll('#pet [data-anim]'), function (h) {
        if (!/laugh/i.test(h.getAttribute('data-anim') || '')) return;
        var cv = h.tagName === 'CANVAS' ? h : h.querySelector('canvas');
        if (cv) out.push(S.canvasId(cv));
      });
    } catch (e) {}
    return out;
  };

  // ── 状态快照 ──
  S.m41 = function (el) {
    var node = el || document.getElementById('pet');
    if (!node) return 0;
    var tr = getComputedStyle(node).transform;
    if (!tr || tr === 'none') return 0;
    try { return Math.round(new DOMMatrixReadOnly(tr).m41 * 100) / 100; } catch (e) { return NaN; }
  };
  S.laughing = function () {
    // 「看起来在笑」= 当前**可见**的基础层在笑。隐藏层上残留的 is-laugh 类不算
    // （占位素材的 stop() 不会清 class，只看 class 会永远为真）。
    var a = S.activeLayer();
    if (!a || a.opacity < 0.5) return false;
    if (/laugh/i.test(a.anim || '')) return true;
    return !!(a.el.querySelector && a.el.querySelector('.ph-frog.is-laugh'));
  };
  /** 当前可见的基础层（opacity 最大的那个 [data-anim] 层） */
  S.activeLayer = function () {
    var base = document.getElementById('pet-base'), best = null, bestOp = -1;
    if (base) {
      Array.prototype.forEach.call(base.children, function (h) {
        var op = parseFloat(getComputedStyle(h).opacity) || 0;
        if (op > bestOp) { bestOp = op; best = h; }
      });
    }
    if (!best) return null;
    return { el: best, anim: best.getAttribute ? best.getAttribute('data-anim') : null, opacity: Math.round(bestOp * 100) / 100 };
  };
  /** 元素是否真的看得见（祖先链上没有 opacity:0 / display:none / 零尺寸） */
  S.isVisibleEl = function (el) {
    var pet = document.getElementById('pet');
    if (!el || !pet) return false;
    var n = el;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.02) return false;
      if (n === pet) break;
      n = n.parentNode;
    }
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return !!(r && r.width > 0.5 && r.height > 0.5);
  };
  S.state = function () {
    var pet = document.getElementById('pet'), base = document.getElementById('pet-base');
    var layers = [], active = null, best = -1;
    if (base) {
      Array.prototype.forEach.call(base.children, function (h) {
        var op = Math.round((parseFloat(getComputedStyle(h).opacity) || 0) * 100) / 100;
        var nm = h.getAttribute ? h.getAttribute('data-anim') : null;
        layers.push({ anim: nm, opacity: op });
        if (op > best) { best = op; active = nm; }
      });
    }
    var ph = pet ? pet.querySelector('.ph-frog') : null;
    var bubble = document.getElementById('pet-bubble');
    return {
      mode: (document.body && document.body.dataset ? document.body.dataset.mode : null) || null,
      activeAnim: active,
      activeOpacity: Math.round(best * 100) / 100,
      layers: layers,
      phClasses: ph ? Array.prototype.slice.call(ph.classList) : null,
      laughing: S.laughing(),
      isReacting: !!(window.Naiwa && window.Naiwa.Pet && window.Naiwa.Pet.isReacting),
      clones: S.probeClones().length,
      transform: pet ? getComputedStyle(pet).transform : null,
      m41: S.m41(pet),
      rectLeft: pet ? Math.round(pet.getBoundingClientRect().left * 10) / 10 : null,
      bubble: bubble && !bubble.hidden ? bubble.textContent : null,
      hidden: document.hidden,
      visibility: document.visibilityState
    };
  };

  // ── 动画清单（CSS + WAAPI）；区分「看得见」和「挂在隐藏层上」 ──
  S.runningAnims = function () {
    var pet = document.getElementById('pet');
    var res = { supported: typeof document.getAnimations === 'function', infinite: [], infiniteVisible: [], all: [], allVisible: [] };
    if (!res.supported || !pet) return res;
    var list = [];
    try { list = document.getAnimations(); } catch (e) { return res; }
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      try {
        var t = a.effect && a.effect.target;
        if (!t || !pet.contains(t)) continue;
        if (a.playState !== 'running') continue;
        var timing = a.effect.getTiming();
        var name = a.animationName || (a.constructor && a.constructor.name) || 'animation';
        var vis = S.isVisibleEl(t);
        var desc = {
          name: name,
          target: t.id ? '#' + t.id : (t.tagName || '?').toLowerCase() + (t.getAttribute && t.getAttribute('class') ? '.' + String(t.getAttribute('class')).trim().split(/\s+/).join('.') : ''),
          iterations: timing.iterations === Infinity ? 'Infinity' : timing.iterations,
          duration: timing.duration,
          visible: vis,
        };
        res.all.push(desc);
        if (vis) res.allVisible.push(desc);
        if (timing.iterations === Infinity) { res.infinite.push(desc); if (vis) res.infiniteVisible.push(desc); }
      } catch (e) {}
    }
    return res;
  };

  // ── 起跑证据（只认加在 #pet 本身上的位移，避免把占位素材的 CSS transform 误判成跑步） ──
  S.runEvidence = function () {
    var pet = document.getElementById('pet');
    var st = S.state();
    var onPet = [], translate = [];
    try {
      var list = document.getAnimations ? document.getAnimations() : [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i], t = a.effect && a.effect.target;
        if (!t || t !== pet) continue;                     // 文档要求：位移必须加在 #pet 元素本身
        var kfs = [];
        try { kfs = a.effect.getKeyframes().map(function (k) { return k.transform || ''; }); } catch (e) {}
        var kf = JSON.stringify(kfs).slice(0, 400);
        var amp = 0;
        kfs.forEach(function (s) { var m = /translate[XY]?\(\s*(-?[\d.]+)px/.exec(s || ''); if (m) amp = Math.max(amp, Math.abs(parseFloat(m[1]))); });
        var it = a.effect.getTiming().iterations;
        var d = { name: a.animationName || 'waapi', state: a.playState, iterations: it === Infinity ? 'Infinity' : it, keyframes: kf, amplitudePx: Math.round(amp * 10) / 10 };
        onPet.push(d);
        if (a.playState === 'running' && /translate/i.test(kf) && amp > 1) translate.push(d);
      }
    } catch (e) {}
    return {
      activeAnim: st.activeAnim, m41: st.m41, rectLeft: st.rectLeft, transform: st.transform,
      onPetAnims: onPet, runningTranslateAnims: translate, clones: st.clones, mode: st.mode,
      running: translate.length > 0 || Math.abs(st.m41) > 0.5 || /run/i.test(st.activeAnim || ''),
    };
  };

  // ── 采样：分身数量 / 大笑状态时间线 ──
  S.sampler = { on: false, series: [], maxClones: 0, firstTwoAt: null, laughTicks: 0, participants: [] };
  S.startSampler = function () {
    var s = S.sampler;
    s.on = true; s.series = []; s.maxClones = 0; s.firstTwoAt = null; s.laughTicks = 0; s.participants = [];
    S.draw.on = true; S.draw.calls = []; S.draw.truncated = 0;
    var t0 = performance.now();
    function tick() {
      if (!s.on) return;
      var t = Math.round(performance.now() - t0);
      var n = S.probeClones().length;
      if (n > s.maxClones) s.maxClones = n;
      if (n === 2 && s.firstTwoAt == null) s.firstTwoAt = t;
      if (n >= 2 && s.participants.length === 0) {
        var ids = S.cloneCanvases().concat(S.laughCanvases());
        if (ids.length >= 3) s.participants = ids;
      }
      var la = S.laughing() ? 1 : 0;
      if (la) s.laughTicks++;
      if (s.series.length < 8000) s.series.push([t, n, la]);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };
  S.samplerResult = function () {
    var s = S.sampler;
    var changes = [], last = null, zeroAfterTwo = null;
    s.series.forEach(function (r) {
      if (r[1] !== last) { changes.push({ t: r[0], clones: r[1], laughing: r[2] }); last = r[1]; }
      if (s.firstTwoAt != null && zeroAfterTwo == null && r[0] > s.firstTwoAt && r[1] === 0) zeroAfterTwo = r[0];
    });
    return {
      maxClones: s.maxClones,
      firstTwoAt: s.firstTwoAt,
      zeroAfterTwoAt: zeroAfterTwo,
      laughTicks: s.laughTicks,
      ticks: s.series.length,
      durationMs: s.series.length ? s.series[s.series.length - 1][0] : 0,
      changes: changes,
      participants: s.participants.slice(),
      drawCalls: S.draw.calls.length,
      drawTruncated: S.draw.truncated,
      lastClones: s.series.length ? s.series[s.series.length - 1][1] : null,
    };
  };
  S.stopSampler = function () { S.sampler.on = false; S.draw.on = false; return S.samplerResult(); };
  S.getDraws = function () {
    var parts = S.sampler.participants;
    var calls = S.draw.calls;
    if (parts && parts.length) calls = calls.filter(function (c) { return parts.indexOf(c.c) >= 0; });
    return { calls: calls, participants: parts || [] };
  };

  // ── 用户操作模拟（真实事件，不做任何内部调用） ──
  S.petPoint = function (frac) {
    var pet = document.getElementById('pet');
    if (!pet) return { ok: false, reason: 'no #pet' };
    var r = pet.getBoundingClientRect();
    var h = (window.NAIWA_MANIFEST && window.NAIWA_MANIFEST.hit) || { type: 'ellipse', x: 0.5, y: 0.57, rx: 0.42, ry: 0.38 };
    var cx, cy, x, y;
    if (h.type === 'rect') { cx = r.left + r.width * 0.5; cy = r.top + r.height * 0.5; x = cx; y = cy; }
    else {
      cx = r.left + r.width * h.x; cy = r.top + r.height * h.y;
      var f = frac == null ? 0.35 : frac;
      x = cx + r.width * h.rx * f; y = cy + r.height * h.ry * f;
    }
    var el = document.elementFromPoint(x, y);
    return {
      ok: true, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100,
      rect: { left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10, w: Math.round(r.width), h: Math.round(r.height) },
      hit: h,
      insideHit: !!(window.Naiwa && window.Naiwa.Pet && window.Naiwa.Pet.containsPoint(x, y)),
      elementAt: el ? (el.id ? '#' + el.id : (el.tagName + (el.className ? '.' + String(el.className).split(/\s+/)[0] : ''))) : null,
      insidePet: !!(el && el.closest && el.closest('#pet')),
    };
  };
  function mkEvt(Ctor, type, x, y, button, buttons) {
    try {
      return new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: button, buttons: buttons });
    } catch (e) {
      var e2 = document.createEvent('MouseEvents');
      e2.initMouseEvent(type, true, true, window, 0, x, y, x, y, false, false, false, false, button, null);
      return e2;
    }
  }
  S.dispatchAt = function (x, y, types, button, buttons, gapMs) {
    var target = document.elementFromPoint(x, y) || document.body || document.documentElement;
    var results = [];
    types.forEach(function (t) {
      var Ctor = (t.indexOf('pointer') === 0 && window.PointerEvent) ? window.PointerEvent : MouseEvent;
      try { target.dispatchEvent(mkEvt(Ctor, t, x, y, button, buttons)); results.push(t + ':ok'); }
      catch (e) { results.push(t + ':err(' + (e && e.message) + ')'); }
    });
    return { target: target.id ? '#' + target.id : target.tagName, results: results, gapMs: gapMs || 0 };
  };
  S.mouseMoveAt = function (x, y) {
    var pet = document.getElementById('pet');
    var before = null;
    var p = pet ? pet.querySelector('.ph-pupils') : null;
    if (p) { var tr = getComputedStyle(p).transform; before = tr === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(tr).m41 * 100) / 100; }
    var d = S.dispatchAt(x, y, ['pointermove', 'mousemove'], 0, 0, 0);
    var after = null;
    if (p) { var tr2 = getComputedStyle(p).transform; after = tr2 === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(tr2).m41 * 100) / 100; }
    return { dispatch: d, pupilBefore: before, pupilAfter: after, hasPupils: !!p, activeAnim: S.state().activeAnim };
  };
  S.clickAt = function (x, y, gapMs) {
    var gap = gapMs == null ? 35 : gapMs;
    var d = S.dispatchAt(x, y, ['pointerdown', 'mousedown'], 0, 1, 0);
    return new Promise(function (res) {
      setTimeout(function () {
        var up = S.dispatchAt(x, y, ['pointerup', 'mouseup'], 0, 0, 0);
        res({ down: d, up: up, gapMs: gap });
      }, gap);
    });
  };
  // 取点 + 立刻派发，**在同一次页面求值里完成**。
  //
  // 为什么不能用「主进程先 petPoint 再 clickAt」那两步：跑步时 #pet 每秒移动几十
  // 像素，两次 IPC 往返之间奶蛙已经跑开，mousedown 里的 containsPoint 判否，
  // 整个点击被丢掉（mouseup 因为 pressStart 是 null 直接 return）。
  // 结果就是「点了但什么都没发生」，看起来像功能坏了，其实是测量方式的问题。
  S.clickPetSelf = function (frac, gapMs) {
    var gap = gapMs == null ? 35 : gapMs;
    var p = S.petPoint(frac);
    if (!p.ok) return Promise.resolve({ point: p, down: null, up: null, gapMs: gap });
    var d = S.dispatchAt(p.x, p.y, ['pointerdown', 'mousedown'], 0, 1, 0);
    return new Promise(function (res) {
      setTimeout(function () {
        var up = S.dispatchAt(p.x, p.y, ['pointerup', 'mouseup'], 0, 0, 0);
        res({ point: p, down: d, up: up, gapMs: gap });
      }, gap);
    });
  };
  // 右键**单击** = 弹操作窗（S17 用）
  S.contextMenuOnceAt = function (x, y) {
    return S.dispatchAt(x, y, ['contextmenu'], 2, 2, 0);
  };
  /**
   * 右键**双击** = 切换模式（第五次会话改：单击右键让位给操作窗）。
   *
   * ⚠️ 两次之间必须小于 app.js 的 MENU_DBL_MS（400ms）。这里用 120ms，
   * 既在窗口内，又比人手快一点，避免轮询粒度把它拖过界。
   */
  S.contextMenuAt = function (x, y) {
    var first = S.contextMenuOnceAt(x, y);
    return new Promise(function (res) {
      setTimeout(function () {
        var second = S.contextMenuOnceAt(x, y);
        res({
          double: true,
          gapMs: 120,
          target: (first && first.target) || (second && second.target) || null,
          results: ((first && first.results) || []).concat((second && second.results) || []),
        });
      }, 120);
    });
  };
  /** 右键操作窗的状态（S17 用）。 */
  S.menuState = function () {
    var el = document.getElementById('pet-menu');
    if (!el) return { exists: false };
    var items = Array.prototype.map.call(el.querySelectorAll('.menu-item'), function (b) {
      return { act: b.getAttribute('data-act'), text: b.textContent, hidden: !!b.hidden };
    });
    var r = el.getBoundingClientRect();
    return {
      exists: true,
      hidden: !!el.hidden,
      open: !!(window.Naiwa && window.Naiwa.App && window.Naiwa.App.menuOpen),
      items: items,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      quitWired: typeof (window.naiwa && window.naiwa.quit) === 'function',
    };
  };
  S.metrics = function (fpsMs) {
    var c0 = S.raf.callbacks;
    return new Promise(function (res) {
      S.rafPerFrameRun(fpsMs || 600, function (r) {
        var st = S.state();
        res({
          mode: st.mode, activeAnim: st.activeAnim, m41: st.m41, clones: st.clones, laughing: st.laughing,
          pendingTimeouts: Object.keys(S.timers.timeouts).length,
          pendingIntervals: Object.keys(S.timers.intervals).length,
          createdTimeouts: S.timers.createdTimeouts, createdIntervals: S.timers.createdIntervals,
          clearedTimeouts: S.timers.clearedTimeouts, clearedIntervals: S.timers.clearedIntervals,
          rafCallbacks: S.raf.callbacks, rafCallbacksDelta: S.raf.callbacks - c0,
          frames: r.frames, rafPerFrame: r.perFrame,
          anims: S.runningAnims(),
          errors: S.errors.length, consoleErrors: S.consoleErrors.length, audio: S.audioTotal(),
          pendingTimeoutDetail: Object.keys(S.timers.timeouts).length <= 12 ? S.timers.timeouts : '(too many)',
        });
      });
    });
  };
  S.rafPerFrameRun = function (ms, cb) {
    return new Promise(function (res) {
      var c0 = S.raf.callbacks, n = 0, t0 = performance.now();
      function tick() {
        n++;
        var dt = performance.now() - t0;
        if (dt < ms) requestAnimationFrame(tick);
        else res({ frames: n, ms: Math.round(dt), perFrame: Math.round(((S.raf.callbacks - c0) / Math.max(1, n)) * 100) / 100 });
      }
      requestAnimationFrame(tick);
    }).then(function (r) { if (cb) cb(r); return r; });
  };
  S.track = function (ms, stepMs) {
    return new Promise(function (res) {
      var t0 = performance.now(), samples = [], closed = false;
      function push() { samples.push({ t: Math.round(performance.now() - t0), m: S.m41(), left: S.state().rectLeft, clones: S.probeClones().length }); }
      push();
      function done(stalled) {
        if (closed) return;
        closed = true;
        var ms2 = samples.map(function (s) { return s.m; }).filter(function (v) { return !isNaN(v); });
        var lefts = samples.map(function (s) { return s.left; });
        var base = lefts[0];
        var dleft = lefts.map(function (v) { return Math.round((v - base) * 10) / 10; });
        res({
          stalled: !!stalled,
          ms: Math.round(performance.now() - t0),
          n: samples.length,
          mFirst: ms2.length ? ms2[0] : null,
          mLast: ms2.length ? ms2[ms2.length - 1] : null,
          mMin: ms2.length ? Math.min.apply(null, ms2) : null,
          mMax: ms2.length ? Math.max.apply(null, ms2) : null,
          leftMin: dleft.length ? Math.min.apply(null, dleft) : null,
          leftMax: dleft.length ? Math.max.apply(null, dleft) : null,
          distinct: (function () { var s = {}; ms2.forEach(function (v) { s[Math.round(v)] = 1; }); return Object.keys(s).length; })(),
          // 整段窗口里的「中间态」样本数：严格落在首尾之间的那些。
          //
          // 为什么不能用 samplesTail 去数：那个只有最后 10 个样本，而一次 250ms 的
          // 归位动画在 2.5s 的窗口里早就结束了，尾部全是静止值 —— 拿它判「平滑」
          // 会把**任何**平滑归位都判成「直接跳回」。这里用全量 samples 数。
          mids: (function () {
            if (ms2.length < 3) return 0;
            var a = ms2[0], b = ms2[ms2.length - 1];
            var lo = Math.min(a, b), hi = Math.max(a, b);
            var span = hi - lo;
            if (span < 1) return 0;
            var n = 0;
            for (var i = 0; i < ms2.length; i++) {
              if (ms2[i] > lo + 0.1 * span && ms2[i] < hi - 0.1 * span) n++;
            }
            return n;
          })(),
          samplesTail: samples.slice(-10).map(function (s) { return [s.t, s.m, s.clones]; }),
        });
      }
      setTimeout(function () { done(true); }, ms * 4 + 500);   // rAF 不跑时兜底，绝不挂死
      function tick() { push(); if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done(false); }
      requestAnimationFrame(tick);
    });
  };
  S.taintProbe = function (relPath) {
    return new Promise(function (res) {
      try {
        var img = new Image();
        img.onload = function () {
          try {
            var c = document.createElement('canvas'); c.width = 8; c.height = 8;
            var cx = c.getContext('2d'); cx.drawImage(img, 0, 0, 8, 8);
            cx.getImageData(0, 0, 1, 1);
            res({ ok: true, note: 'file:// 图片不污染 canvas，像素级比对可用' });
          } catch (e) { res({ ok: false, note: 'canvas 被 file:// 图片污染（' + (e && e.name) + '），像素级比对不可用' }); }
        };
        img.onerror = function () { res({ ok: null, note: '探测图片加载失败' }); };
        img.src = relPath;
      } catch (e) { res({ ok: null, note: '探测异常 ' + (e && e.message) }); }
    });
  };
  S.reducedMotion = function () { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return null; } };
  S.hasApi = function () {
    var P = window.Naiwa && window.Naiwa.Pet;
    var M = window.Naiwa && window.Naiwa.Modes;
    return {
      naiwa: !!window.Naiwa,
      pet: !!P,
      modes: !!M,
      modeRelax: !!(M && M.relax),
      modeWork: !!(M && M.work),
      petApi: P ? ['setIdle', 'playOnce', 'playLoop', 'stopLoop', 'preload', 'performWithClones', 'containsPoint', 'lookAt', 'isReacting'].filter(function (k) { return typeof P[k] === 'function'; }) : [],
      petOldApi: P ? ['react', 'endReact', 'setOverlay', 'say'].filter(function (k) { return typeof P[k] === 'function'; }) : [],
      manifest: !!window.NAIWA_MANIFEST,
    };
  };
}

// ───────────────────────── 4. 主进程辅助 ─────────────────────────

const js = (code, userGesture) => {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('window gone'));
  return win.webContents.executeJavaScript(code, !!userGesture);
};
const PJ = (fn, ...args) => js('window.__SMOKE__.' + fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')', true);

async function pollJs(expr, timeoutMs, intervalMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await js('!!(' + expr + ')'); } catch (e) { last = false; }
    if (last) return { ok: true, at: Date.now() - t0 };
    await sleep(intervalMs || 150);
  }
  return { ok: false, at: Date.now() - t0, last };
}

async function injectLib() {
  try { await js('(' + PAGE_LIB.toString() + ')()'); return true; } catch (e) { return false; }
}

async function waitForWindow(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ws = BrowserWindow.getAllWindows();
    if (ws.length) return ws[0];
    await sleep(100);
  }
  return null;
}

/** 统一在 #pet 命中椭圆内取点，返回 (x,y)，点必须真的落在奶蛙身上。 */
async function petPoint(frac) {
  const p = await PJ('petPoint', frac == null ? 0.35 : frac);
  if (!p || !p.ok || !p.insideHit) throw new Error('无法在奶蛙命中区内取点: ' + JSON.stringify(p));
  return p;
}

async function clickPet(frac, gapMs) {
  // 取点和派发都在页面里一次做完：跑步中的 #pet 一直在动，
  // 分两次 IPC 的话点会落到已经跑开的奶蛙之外（见 clickPetSelf 的说明）。
  const r = await PJ('clickPetSelf', frac == null ? 0.35 : frac, gapMs == null ? 35 : gapMs);
  if (!r || !r.point || !r.point.ok) throw new Error('无法在奶蛙命中区内取点: ' + JSON.stringify(r));
  return { point: r.point, result: r };
}

/** 4 连点：2600ms 窗口内完成（间隔 320ms，> 240ms 冷却，不会被丢弃）。 */
async function quadClick(gapMs) {
  const gap = gapMs == null ? 320 : gapMs;
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push(await clickPet(0.35, 35));
    if (i < 3) await sleep(gap - 35);
  }
  return out;
}

// ───────────────────────── 5. 主流程 ─────────────────────────

async function main() {
  HASHES = hashSources();
  emit('[smoke] electron=' + process.versions.electron + ' chrome=' + process.versions.chrome + ' pid=' + process.pid);
  emit('[smoke] project=' + PROJECT);
  emit('[smoke] argv=' + JSON.stringify(CM));
  emit('[smoke] 隔离 userData=' + path.join(SMOKE_TMP, 'userdata') + '（不碰用户真实便签/剪贴板）');
  if (!CM.some((a) => /no-sandbox/.test(a))) notes.push('本次未带 --no-sandbox 启动；若本机 Chromium 沙箱不可用，Electron 会在初始化阶段直接退出（连 JS 都不执行）。');
  else notes.push('本次启动带了 --no-sandbox（本机 Chromium 沙箱不可用的环境适配；正常机器上 `npx electron __smoke.js` 即可）。');
  notes.push('Chromium 的 temp/userData/cache/crashDumps 被改到 ' + SMOKE_TMP + '（项目目录之外）：本进程写 %TEMP% 会被拒绝(EPERM)，不改路径 Electron 初始化会段错误。');
  notes.push('窗口全程 hide()（实测隐藏时 document.hidden 仍为 false、rAF 仍满速，所以页面可见性不会影响任何断言）。');

  // ── require 真实主进程 ──
  stage('require(./main.js) 启动真实主进程');
  app.on('browser-window-created', (_e, w) => {
    try {
      // 任何时刻被 show 出来都要马上藏回去；只有「隐身点亮」那一小段例外
      w.on('show', () => {
        try {
          if (PRIMING) return;
          if (POLICY === 'hidden') w.hide(); else w.setOpacity(0);
        } catch (e) { /* 忽略 */ }
      });
      w.hide();
    } catch (e) { /* 忽略 */ }
  });
  require('./main.js');
  hideAll();
  const hideGuard = setInterval(ensureInvisible, 100);
  if (hideGuard.unref) hideGuard.unref();

  win = await waitForWindow(20000);
  if (!win) {
    record('H0_renderer_boot', 'FAIL', '20s 内没有创建任何 BrowserWindow —— main.js 可能走了单实例锁退出分支（已有实例在跑？）', { args: CM });
    finish(3, { noWindow: true });
    return;
  }
  try { win.hide(); } catch (e) {}
  emit('[smoke] 窗口已隐藏：isVisible=' + win.isVisible());

  // ── 渲染进程诊断订阅 ──
  win.webContents.on('console-message', (...a) => {
    try {
      let level, message, line = 0, source = '';
      if (a.length >= 2 && typeof a[1] === 'object' && a[1] !== null) {
        const d = a[1]; level = d.level; message = d.message; line = d.lineNumber; source = d.sourceId;
      } else {
        const lv = a[1];
        level = typeof lv === 'number' ? (['verbose', 'info', 'warning', 'error'][lv] || String(lv)) : String(lv);
        message = a[2]; line = a[3]; source = a[4];
      }
      consoleMsgs.push({ at: Date.now() - START_MS, level: String(level), message: String(message), line, source: String(source || '') });
    } catch (e) { /* 忽略 */ }
  });
  win.webContents.on('preload-error', (_e, p, err) => pageErrors.push({ kind: 'preload-error', preload: p, message: err && err.message, stack: err && err.stack ? String(err.stack).slice(0, 600) : null, at: Date.now() - START_MS }));
  win.webContents.on('render-process-gone', (_e, d) => pageErrors.push({ kind: 'render-process-gone', detail: d, at: Date.now() - START_MS }));
  win.webContents.on('unresponsive', () => pageErrors.push({ kind: 'unresponsive', at: Date.now() - START_MS }));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => pageErrors.push({ kind: 'did-fail-load', code, desc, url, at: Date.now() - START_MS }));
  win.webContents.on('dom-ready', () => { injectLib().catch(() => {}); });
  win.webContents.on('did-finish-load', () => { injectLib().catch(() => {}); });
  await injectLib();

  // ── 等渲染进程启动完成 ──
  stage('等待渲染进程异步启动');
  const boot = await pollJs(
    'window.Naiwa && window.Naiwa.Pet && !!document.getElementById("pet") && !!document.getElementById("pet-base") && document.getElementById("pet-base").children.length > 0 && !!(document.body.dataset && document.body.dataset.mode)',
    25000, 200);
  await injectLib();
  const api = await PJ('hasApi');
  emit('[smoke] boot=' + JSON.stringify(boot) + ' api=' + JSON.stringify(api));

  // ── 大笑时长：从素材清单派生，**不要写死** ──
  //
  // 产品侧的时长不是常量：core/assets.js 用 `count / fps` 算序列帧时长，
  // core/pet.js 的分身表演总时长 = 140 + 大笑 + 160 也是从它派生的。
  // 这里写死过 6000 / 4500，素材从 26 帧（1.73s）换成整段 231 帧（15.4s）之后
  // 那些上限全部不够，S2/S6 会**假失败**、S8 还会把「此刻」当成表演结束时刻，
  // 于是拿上一场残留的分身去判冷却期 —— 归因完全是错的。
  // 所以这里读同一个真相来源。
  const LAUGH_MS = Number(process.env.SMOKE_LAUGH_MS || 0) || Number(await js(`(function(){
    var a = (window.NAIWA_MANIFEST && window.NAIWA_MANIFEST.animations
             && window.NAIWA_MANIFEST.animations.laugh) || null;
    return (a && a.kind === 'frames' && a.count && a.fps) ? Math.round(a.count / a.fps * 1000) : 0;
  })()`)) || 0;
  if (!LAUGH_MS) notes.push('⚠ 读不到 manifest 里 laugh 的时长（kind 不是 frames？），退回兜底上限');
  const LAUGH_WAIT_MS = Math.max(6000, LAUGH_MS + 2500);   // 起播延迟 + 交叉淡入 + 轮询粒度
  const PERF_MS = Math.max(4200, LAUGH_MS + 1000);         // 分身表演整场：140 出现 + 大笑 + 160 淡出
  emit(`[smoke] 大笑时长（读自 manifest）= ${LAUGH_MS}ms；等笑完上限 ${LAUGH_WAIT_MS}ms；表演采样窗 ${PERF_MS}ms`);
  if (!boot.ok) {
    record('H0_renderer_boot', 'FAIL', `25s 内渲染进程没起来（Naiwa.Pet / #pet / #pet-base 未就绪）`, { api });
  } else {
    record('H0_renderer_boot', 'PASS', `就绪耗时 ${boot.at}ms；Pet API=[${api.petApi.join(',')}] 旧 API=[${api.petOldApi.join(',')}]` + (api.modes ? ' Modes=' + JSON.stringify(Object.keys((await js('Object.keys(window.Naiwa.Modes||{})')) || [])) : ''), { api, boot });
  }

  // ── 结构检查（docs/00 §5.3，非 §8 但决定后面能不能过） ──
  const need = ['setIdle', 'playLoop', 'stopLoop', 'preload', 'performWithClones'];
  const missing = need.filter((k) => api.petApi.indexOf(k) < 0);
  if (api.modeRelax && missing.length === 0) {
    record('E1_mode_structure', 'PASS', `Naiwa.Modes.relax 存在；pet 新原语齐全（${need.join('/')}）`, { api });
  } else {
    record('E1_mode_structure', 'FAIL', `阶段 1 结构改造未完成：Naiwa.Modes.relax=${api.modeRelax}；pet 缺少 ${missing.join('/') || '（无）'}` + (api.petOldApi.length ? `；当前仍是旧接口 [${api.petOldApi.join(',')}]` : ''), { api });
  }

  // ── 诊断快照 / 窗口策略 ──
  stage('窗口策略 / 诊断快照');
  // 实测：**从没被 show 过的窗口几乎是停帧的（~2fps）**；只要 show 过一次，
// 之后即使 hide() 也保持满帧（probe: 242fps）。
// 所以先做一次「隐身点亮」：setFocusable(false) + setOpacity(0) + showInactive()
// ——对用户完全不可见、也不抢焦点、点击穿透——把帧时钟激活；随后尽量回到 hide()。
  const policyProbe = {};
  PRIMING = true;
  POLICY = 'stealth';
  try { win.setFocusable(false); } catch (e) { /* 忽略 */ }
  try { win.setOpacity(0); } catch (e) { notes.push('setOpacity(0) 失败：' + e.message); }
  try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { /* 忽略 */ }
  try { win.showInactive(); } catch (e) { /* 忽略 */ }
  await sleep(800);
  PRIMING = false;
  policyProbe.stealth = {
    fps: await rafProbe(600, 3000),
    page: await js('({hidden: document.hidden, vis: document.visibilityState})'),
    isVisible: win.isVisible(), opacity: (() => { try { return win.getOpacity(); } catch (e) { return null; } })(),
    focused: (() => { try { return win.isFocused(); } catch (e) { return null; } })(),
  };
  POLICY = 'hidden';                        // 试回隐藏态
  ensureInvisible();
  await sleep(600);
  policyProbe.hidden = {
    fps: await rafProbe(600, 3000),
    page: await js('({hidden: document.hidden, vis: document.visibilityState})'),
    isVisible: win.isVisible(), opacity: (() => { try { return win.getOpacity(); } catch (e) { return null; } })(),
    focused: (() => { try { return win.isFocused(); } catch (e) { return null; } })(),
  };
  const framesOk = (p) => p && p.fps && !p.fps.stalled && p.fps.frames >= 5;
  const pageVisible = (p) => p && p.page && p.page.hidden === false;
  if (framesOk(policyProbe.hidden) && pageVisible(policyProbe.hidden)) POLICY = 'hidden';
  else if (framesOk(policyProbe.stealth) && pageVisible(policyProbe.stealth)) POLICY = 'stealth';
  else POLICY = (policyProbe.hidden.fps.frames || 0) >= (policyProbe.stealth.fps.frames || 0) ? 'hidden' : 'stealth';
  ensureInvisible();
  await sleep(300);
  emit('[smoke] 窗口策略探测: ' + JSON.stringify(policyProbe) + ' → 采用 ' + POLICY);
  notes.push(`窗口策略=${POLICY}（先 opacity=0 + showInactive 点亮一次合成器帧时钟，再回到隐藏态）：` +
    `隐身态 rAF=${policyProbe.stealth.fps.frames}帧/${policyProbe.stealth.fps.ms}ms(document.hidden=${policyProbe.stealth.page.hidden})，` +
    `隐藏态 rAF=${policyProbe.hidden.fps.frames}帧/${policyProbe.hidden.fps.ms}ms(document.hidden=${policyProbe.hidden.page.hidden})；` +
    `窗口 isVisible=${win.isVisible()}，opacity=${policyProbe.hidden.opacity}`);
  if (POLICY === 'stealth') notes.push('⚠ 退回隐身模式（opacity=0 + 不抢焦点 + 点击穿透，桌面上不可见）：隐藏态拿不到满帧，会让动画类断言变成假阴性。');
  if (!framesOk(policyProbe[POLICY])) notes.push('⚠ 两种窗口状态下 rAF 都不满速，动画/时序类断言可能不可靠（报告里会标 stalled）。');

  const diag = await js(`(function(){
    var p = window.__SMOKE__.petPoint(0.35);
    var st = window.__SMOKE__.state();
    return { point: p, state: st, anims: window.__SMOKE__.runningAnims(), reducedMotion: window.__SMOKE__.reducedMotion(), hasPuppets: !!document.querySelector('#pet .ph-pupils') };
  })()`);
  const fpsInfo = await rafProbe(800, 4000);
  const metricsQuiet = await pageMetrics(600);
  let pngRel = null;
  try {
    const stack = [path.join(PROJECT, 'assets')];
    while (stack.length && !pngRel) {
      const dir = stack.pop();
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (/\.png$/i.test(name)) { pngRel = '../assets/' + path.relative(path.join(PROJECT, 'assets'), full).split(path.sep).join('/'); break; }
      }
    }
  } catch (e) { /* 忽略 */ }
  const taint = pngRel ? await PJ('taintProbe', pngRel) : { ok: null, note: 'assets/ 下没有 png，跳过污染探测' };
  const visCheck = await js('({hidden: document.hidden, visibility: document.visibilityState, isVisible: null})');
  const winHidden = win.isVisible() === false;
  const opacityNow = (() => { try { return win.getOpacity(); } catch (e) { return null; } })();
  emit('[smoke] 诊断: ' + JSON.stringify({ point: diag.point, activeAnim: diag.state.activeAnim, infiniteAnims: diag.anims.infinite, reducedMotion: diag.reducedMotion, fps: fpsInfo, rafPerFrameQuiet: metricsQuiet.rafPerFrame, policy: POLICY, winHidden: winHidden, opacity: opacityNow, pageHidden: visCheck.hidden, taint: taint }));
  notes.push(`窗口策略=${POLICY}；rAF≈${fpsInfo.frames} 帧/${fpsInfo.ms}ms；document.hidden=${visCheck.hidden}；win.isVisible=${!winHidden}；win.getOpacity=${opacityNow}`);
  notes.push('canvas 像素比对探测：' + taint.note + '（所以「严格同帧」用 drawImage 观测而不是像素哈希）');
  if (diag.reducedMotion) notes.push('⚠ 系统开启了「减少动态效果」(prefers-reduced-motion)：CSS 循环动画会被压掉，S1 的判定会偏乐观。');

  const staticIdle = async () => {
    const s = await js(`(function(){ var st = window.__SMOKE__.state(); return { st: st, an: window.__SMOKE__.runningAnims(), raf: 0 }; })()`);
    return s;
  };

  // ── S1 静态待机 ──
  stage('S1 静态待机是否有循环动画');
  await sleep(1500);   // 让启动期的 toast / 气泡 / 交叉淡入落定
  const s1 = await staticIdle();
  const s1m = await pageMetrics(700);
  const inf = s1.an.infiniteVisible || [];   // 只算「看得见」的循环动画
  const infHidden = (s1.an.infinite || []).length - inf.length;
  const rafLoop = s1m.rafPerFrame > 2.0;
  {
    const ev = `${inf.length} 个**可见**的无限循环动画在 #pet 内运行` + (inf.length ? `：${inf.slice(0, 4).map((a) => `${a.name}@${a.target}(${a.duration}ms×∞)`).join('、')}` : '') +
      (infHidden > 0 ? `；另有 ${infHidden} 个挂在 opacity:0 的隐藏层上（不影响观感，不计入判定）` : '') +
      `；当前可见基础层=${s1.st.activeAnim}；每帧 rAF 回调=${s1m.rafPerFrame}`;
    if (inf.length === 0 && !rafLoop) {
      record('S1_static_idle_no_loop', 'PASS', ev + '；静止 ✅', { anims: s1.an, state: s1.st, metrics: s1m });
    } else {
      record('S1_static_idle_no_loop', 'FAIL', ev + (rafLoop ? '；另有每帧 JS 循环在跑（疑似 canvas 待机动画）' : '') + ' —— 待机必须是静态图', { anims: s1.an, state: s1.st, metrics: s1m });
    }
  }

  // ── S12 瞳孔跟随 ──
  stage('S12 瞳孔跟随');
  {
    const near = await PJ('mouseMoveAt', 24, 30);
    const far = await PJ('mouseMoveAt', 436, 610);
    const near2 = await PJ('mouseMoveAt', 24, 30);
    const detail = { near, far, near2 };
    if (!near.hasPupils) {
      record('S12_pupils_follow_mouse', 'SKIP', '当前基础层不是内置占位奶蛙（没有 .ph-pupils），瞳孔跟随无从观测（真实素材的视线画在图里）', detail);
    } else if (near.pupilAfter == null || far.pupilAfter == null) {
      record('S12_pupils_follow_mouse', 'SKIP', '取不到 .ph-pupils 的 transform', detail);
    } else if (near2.pupilAfter < far.pupilAfter && near.pupilAfter !== far.pupilAfter) {
      record('S12_pupils_follow_mouse', 'PASS', `鼠标在左上 → 瞳孔 translateX=${near2.pupilAfter}px；移到右下 → ${far.pupilAfter}px（随鼠标方向变化）`, detail);
    } else {
      record('S12_pupils_follow_mouse', 'FAIL', `瞳孔没有随鼠标移动：左上=${near.pupilAfter}px 右下=${far.pupilAfter}px（期望 左上 < 右下）`, detail);
    }
  }

  // ── S2 / S3 单点大笑 ──
  stage('S2/S3 单点 → 大笑 → 回静态');
  await sleep(600);
  {
    const before = await PJ('state');
    const audioBefore = (await pageMetrics(300)).audio;
    const t0 = Date.now();
    const click = await clickPet(0.35, 35);
    let laughAt = null, laughState = null;
    while (Date.now() - t0 < 2000) {
      const st = await PJ('state');
      if (st.laughing) { laughAt = Date.now() - t0; laughState = st; break; }
      await sleep(40);
    }
    const audioAfter = (await pageMetrics(600)).audio;
    let idleAt = null;
    while (Date.now() - t0 < LAUGH_WAIT_MS) {
      const st = await PJ('state');
      if (!st.laughing && /idle|static/i.test(st.activeAnim || '')) { idleAt = Date.now() - t0; break; }
      await sleep(80);
    }
    const st2 = await PJ('state');
    const ev = `点击坐标 (${click.point.x},${click.point.y}) 落在命中椭圆内(elementAt=${click.point.elementAt})；` +
      (laughAt == null ? '点击后 2s 内没有观察到大笑状态' : `${laughAt}ms 进入大笑（基础层=${laughState.activeAnim} 占位类=[${(laughState.phClasses || []).join(' ')}]）`) +
      (idleAt == null ? `；${Math.round(LAUGH_WAIT_MS / 1000)}s 内没有回到静态待机` : `；${idleAt}ms 回到待机（${st2.activeAnim}）`);
    if (laughAt != null && idleAt != null) record('S2_click_once_laugh_then_idle', 'PASS', ev, { before, laughState, st2, click: click.point });
    else record('S2_click_once_laugh_then_idle', 'FAIL', ev, { before, laughState, st2, click: click.point });
    const dAudio = audioAfter - audioBefore;
    if (dAudio > 0) record('S3_click_once_audio', 'PASS', `点击后音频被触发：振荡器/音源调用 +${dAudio}（同类计数 ${audioBefore}→${audioAfter}）`);
    else record('S3_click_once_audio', 'FAIL', `点击后没有观测到任何音频触发（createOscillator/createBufferSource/HTMLMediaElement.play 计数没变：${audioBefore}→${audioAfter}）`, { audioBefore, audioAfter });
  }

  // ── 分身表演（第 1 场）：S4 / S7 / S5 / S6 ──
  stage('S4/S5/S6/S7 连点分身表演');
  await sleep(3400);   // 让上一次点击的连点窗口 / 冷却过期
  let perf1 = null;
  {
    await PJ('startSampler');
    const t0 = Date.now();
    await quadClick(320);
    let duringFired = 0, maxDuring = 0, clonesAppearedAt = null;
    while (Date.now() - t0 < PERF_MS) {
      const st = await PJ('state');
      if (st.clones >= 2 && clonesAppearedAt == null) clonesAppearedAt = Date.now() - t0;
      if (st.clones >= 2 && duringFired < 2 && Date.now() - t0 > (clonesAppearedAt || 0) + 120) {
        await clickPet(0.35, 30); duringFired++;   // 表演期间继续点击（S7）
      }
      if (st.clones > maxDuring) maxDuring = st.clones;
      await sleep(70);
    }
    const series = await PJ('stopSampler');
    const draws = await PJ('getDraws');
    let zeroAt = null;
    const tz = Date.now();
    while (Date.now() - tz < LAUGH_WAIT_MS) {
      const st = await PJ('state');
      if (st.clones === 0 && series.maxClones > 0) { zeroAt = Date.now() - tz; break; }
      if (st.clones === 0 && series.maxClones === 0) { zeroAt = 0; break; }
      await sleep(80);
    }
    perf1 = { series, draws, maxDuring, duringFired, clonesAppearedAt, zeroAt, quadAt: t0 };
    emit('[smoke] 第 1 场表演：maxClones=' + series.maxClones + ' firstTwoAt=' + series.firstTwoAt + ' laughTicks=' + series.laughTicks + ' drawCalls=' + series.drawCalls + ' changes=' + JSON.stringify(series.changes.slice(0, 12)));

    // S4
    const ev4 = `4 次点击在 2.6s 内完成（间隔 320ms，> 240ms 冷却）；采样 ${series.ticks} 帧/${series.durationMs}ms，` +
      `分身数量峰值=${series.maxClones}（期望恰好 2）` + (series.firstTwoAt != null ? `，首次出现 2 个分身于 ${series.firstTwoAt}ms` : '') +
      `；期间大笑帧=${series.laughTicks}`;
    record('S4_quad_click_two_clones', series.maxClones === 2 ? 'PASS' : 'FAIL', ev4, { changes: series.changes.slice(0, 20), describe: await PJ('describeClones') });

    // S7
    if (series.maxClones === 0) {
      record('S7_no_extra_clones_during_performance', 'SKIP', '没有出现过任何分身（S4 已 FAIL），「表演期间不产生更多分身」无从观测', { duringFired, maxDuring });
    } else if (maxDuring <= 2) {
      record('S7_no_extra_clones_during_performance', 'PASS', `表演期间又点了 ${duringFired} 次，分身数量峰值始终 ≤ 2（实测峰值 ${maxDuring}）`, { duringFired, maxDuring, changes: series.changes.slice(0, 20) });
    } else {
      record('S7_no_extra_clones_during_performance', 'FAIL', `表演期间点击后分身数量涨到 ${maxDuring}（> 2）`, { duringFired, maxDuring, changes: series.changes.slice(0, 20) });
    }

    // S5 严格同帧
    {
      const calls = draws.calls || [];
      const byCanvas = {};
      calls.forEach((c) => { byCanvas[c.c] = (byCanvas[c.c] || 0) + 1; });
      const canvases = Object.keys(byCanvas);
      if (series.maxClones < 2) {
        record('S5_clones_frame_synced', 'SKIP', '分身没出现，三个实例的同帧关系无从观测', { drawCalls: calls.length });
      } else if (canvases.length < 3) {
        record('S5_clones_frame_synced', 'SKIP', `分身出现了，但只观测到 ${canvases.length} 个 canvas 在 drawImage（严格同帧要求主体+2分身都是同一帧计数器驱动的序列帧/canvas 素材）`, { canvases, byCanvas });
      } else {
        // 按 8ms 时间窗分组 = 同一拍绘制
        // 分组口径：**同一拍的切分不能只看时间窗**。
        //
        // 原实现是「相邻两次绘制间隔 ≤ 8ms 就链式并进同一组」，每组取每个 canvas 的
        // **最后一次**绘制。素材从 26 帧变成 231 帧后，首轮解码会把同一拍内的三次绘制
        // 拉开到 ~8ms，链式合并于是**跨到了下一拍**，组里同时出现第 N 帧和第 N+1 帧
        // —— 报出来就是「不一致分组 1/228」，但三个播放器共用同一个 rAF 和同一套帧计算
        //（见 core/pet.js 的 performWithClones 说明），帧号不可能算岔，差的只是绘制落点。
        //
        // 正确的切分依据与负载无关：**同一拍里每个实例最多画一次，一旦某个 canvas
        // 又出现，就说明进入下一拍了。**
        const sorted = calls.slice().sort((a, b) => a.t - b.t);
        const groups = [];
        let cur = null;
        for (const c of sorted) {
          if (!cur || cur.seen[c.c]) {
            cur = { tStart: c.t, tEnd: c.t, calls: [], seen: {} };
            groups.push(cur);
          }
          cur.calls.push(c);
          cur.seen[c.c] = 1;
          cur.tEnd = c.t;
        }
        let mismatch = 0, fullSync = 0, orphan = 0, spreadMax = 0;
        const sigs = {};
        for (const g of groups) {
          const per = {};
          for (const c of g.calls) if (!per[c.c]) per[c.c] = c;
          const n = Object.keys(per).length;
          if (g.calls.length > 1) spreadMax = Math.max(spreadMax, Math.round((g.tEnd - g.tStart) * 10) / 10);
          if (n < 2) { orphan++; continue; }
          const s = {};
          for (const k in per) s[per[k].u + '|' + per[k].a.join(',')] = 1;
          const keys = Object.keys(s);
          if (keys.length === 1) { if (n >= 3) { fullSync++; sigs[keys[0]] = 1; } }
          else mismatch++;
        }
        const distinct = Object.keys(sigs).length;
        const ev5 = `同一拍（8ms 窗）内三个 canvas 画到同一张源图的分组=${fullSync}，不一致分组=${mismatch}，单实例孤立分组=${orphan}，` +
          `出现过的帧签名=${distinct}（>1 才说明动画在推进），组内最大时间散布=${spreadMax}ms`;
        if (mismatch === 0 && fullSync >= 5 && distinct >= 2) record('S5_clones_frame_synced', 'PASS', ev5, { canvases, byCanvas });
        else record('S5_clones_frame_synced', 'FAIL', ev5, { canvases, byCanvas, mismatch, fullSync, orphan, distinct });
      }
    }

    // S6 分身消失
    if (series.maxClones === 0) {
      record('S6_clones_removed_after', 'SKIP', '分身从未出现，无可消失', null);
    } else {
      const ok6 = series.zeroAfterTwoAt != null || zeroAt != null;
      record('S6_clones_removed_after', ok6 ? 'PASS' : 'FAIL',
        `分身峰值 ${series.maxClones}；` + (series.zeroAfterTwoAt != null ? `表演开始后 ${series.zeroAfterTwoAt}ms 采样到分身归零` : (zeroAt != null ? `轮询 ${zeroAt}ms 后归零` : '4.5s 内分身仍在 DOM 里')),
        { changes: series.changes.slice(0, 20), zeroAt });
    }
  }

  // ── S8 冷却 / S15 表演中切模式 ──
  stage('S8 表演后 3s 冷却 + S15 表演中切模式');
  if (!perf1 || perf1.series.maxClones !== 2) {
    record('S8_no_retrigger_within_3s', 'SKIP', 'S4 没观测到「2 个分身」的表演，冷却窗口无从测量', null);
    record('S15_clone_cleanup_on_mode_switch', 'SKIP', '分身表演没有成立，无法在表演中途切模式', null);
  } else {
    // 第 1 场表演的**结束时刻只能靠观测**，绝不能用「此刻」兜底。
    //
    // 上一版写的是 `Date.now() - (perf1.zeroAt != null ? perf1.zeroAt : 0)`：
    // zeroAt 测不到时它就把「现在」当成表演结束，于是冷却窗口整体前移，
    // (a) 的连点落在**上一场还在演**的时候 —— 残留分被采样器计入 cd.maxClones，
    // 判定就变成「冷却期又触发了分身」，**结论和归因都是错的**。
    // 素材从 1.73s 变成 15.4s 之后，zeroAt 一定会测不到，正好踩中这个兜底。
    const vanishAt = perf1.zeroAt != null
      ? Date.now() - perf1.zeroAt
      : (perf1.series.zeroAfterTwoAt != null ? perf1.quadAt + perf1.series.zeroAfterTwoAt : null);

    if (vanishAt == null) {
      record('S8_no_retrigger_within_3s', 'SKIP',
        `第 1 场表演的结束时刻没测到（分身归零没观测到，采样窗 ${PERF_MS}ms），冷却窗口无从对齐 —— 不用「此刻」当锚点`, null);
      record('S15_clone_cleanup_on_mode_switch', 'SKIP', '同上：表演结束时刻未测到，正对照不成立', null);
    } else {
    const perfEndAt = vanishAt;
    // (a) 冷却期内再连点：不应再触发
    await PJ('startSampler');
    await quadClick(320);
    await sleep(Math.max(0, perfEndAt + 3000 - Date.now()));
    const cd = await PJ('stopSampler');
    // (b) 正对照：冷却结束后再连点，应当能触发
    await sleep(Math.max(0, perfEndAt + 3400 - Date.now()));
    const beforeCtl = await PJ('state');
    await PJ('startSampler');
    await quadClick(320);
    let ctlMax = 0, ctlAppeared = null;
    const ctlBefore = beforeCtl.clones;      // 连点前已有的分身数（必须为 0，否则断的是上一场）
    const t1 = Date.now();
    let midSwitch = null;
    while (Date.now() - t1 < 4000) {
      const st = await PJ('state');
      if (st.clones > ctlMax) ctlMax = st.clones;
      if (ctlBefore === 0 && st.clones >= 2 && ctlAppeared == null) {
        ctlAppeared = Date.now() - t1;
        await sleep(150);
        const p = await petPoint(0.35);
        const sw = await js(`window.__SMOKE__.contextMenuAt(${p.x}, ${p.y})`, true);   // 表演中途右键切模式
        await sleep(250);
        const after = await PJ('state');
        await sleep(500);
        const after2 = await PJ('state');
        midSwitch = { dispatch: sw, after250: after.clones, after750: after2.clones, modeAfter: after2.mode };
        // 切回解压模式
        const p2 = await petPoint(0.35);
        await js(`window.__SMOKE__.contextMenuAt(${p2.x}, ${p2.y})`, true);
        await sleep(700);
        break;
      }
      await sleep(60);
    }
    await sleep(900);
    const ctl = await PJ('stopSampler');
    emit('[smoke] 冷却期 maxClones=' + cd.maxClones + '；正对照 maxClones=' + ctl.maxClones + '（peak ' + ctlMax + '）');

    if (ctl.maxClones === 0 && ctlMax === 0) {
      record('S8_no_retrigger_within_3s', 'SKIP', `冷却期内确实没再触发（0 个分身），但正对照（冷却结束后再连点）也没触发 —— 无法区分「冷却生效」和「触发本身不工作」`, { cooldown: cd, control: ctl });
    } else if (cd.maxClones > 0) {
      record('S8_no_retrigger_within_3s', 'FAIL', `表演结束后 3s 内的连点又触发了分身（冷却期峰值=${cd.maxClones}）`, { cooldown: cd, control: ctl });
    } else {
      record('S8_no_retrigger_within_3s', 'PASS', `冷却期内 4 连点 → 0 个分身；冷却结束后同样 4 连点 → ${ctl.maxClones} 个分身（正对照成立，说明抑制来自冷却）`, { cooldown: cd.changes, control: ctl.changes });
    }

    if (!midSwitch) {
      record('S15_clone_cleanup_on_mode_switch', 'SKIP', '正对照那场没有出现分身，没能在表演中途切模式', null);
    } else if (midSwitch.after250 === 0 && midSwitch.after750 === 0 && midSwitch.modeAfter === 'work') {
      record('S15_clone_cleanup_on_mode_switch', 'PASS', `分身出现后 150ms 右键切模式：250ms 后分身=${midSwitch.after250}，750ms 后=${midSwitch.after750}（当前模式=${midSwitch.modeAfter}）→ 立刻清场`, midSwitch);
    } else {
      record('S15_clone_cleanup_on_mode_switch', 'FAIL', `表演中途切模式后仍有残留：250ms=${midSwitch.after250}，750ms=${midSwitch.after750}，模式=${midSwitch.modeAfter}`, midSwitch);
    }
    await sleep(1200);
    }   // ← 结束 vanishAt != null 的分支
  }

  // ── S9 / S10 / S11 / S16 起跑阶段（每轮真等 ~60s 空闲） ──
  stage('S9 闲置 ~60s 起跑（真等，不伪造时间）');
  // ⚠️ 跑步功能现在由 modes/relax.js 的 `CONFIG.RUN_ENABLED = false` 停用
  //（docs/04 第 7 节：没有可用素材，代码与槽位保留、只用开关关掉）。
  //
  // 停用状态下「闲置 60s 会不会自己跑起来」这一项**不适用**：继续断言它「必须跑起来」
  // 等于把一个开关状态报成回归，而且这条会**永远是红的** —— 长期红着的测试等于没有测试，
  // 真出问题时没人会再看这张表。
  //
  // 所以按开关分流，而不是放宽断言：
  //   关着 → SKIP，并写明是哪个开关、在哪儿；
  //   打开 → 下面所有断言原样执行（谁把开关改回 true，这几项立刻恢复成真检查）。
  const runEnabled = await js('!!(window.Naiwa.Modes && window.Naiwa.Modes.relax' +
    ' && window.Naiwa.Modes.relax.config && window.Naiwa.Modes.relax.config.RUN_ENABLED)');
  emit('[smoke] 跑步功能开关 RUN_ENABLED=' + runEnabled);
  let runSeen = false;
  if (!runEnabled) {
    const whyRun = '跑步功能已按配置停用（modes/relax.js 的 CONFIG.RUN_ENABLED=false，见 docs/04 第 7 节），' +
      '起跑相关验收项不适用；把开关改回 true 后这几项会自动恢复为断言';
    record('S9_idle_60s_starts_run', 'SKIP', whyRun, null);
    record('S10_run_click_returns_then_laughs', 'SKIP', '跑步功能已按配置停用（RUN_ENABLED=false）', null);
    record('S11_run_mouseover_stops', 'SKIP', '跑步功能已按配置停用（RUN_ENABLED=false）', null);
    record('S16_run_cleanup_on_mode_switch', 'SKIP', '跑步功能已按配置停用（RUN_ENABLED=false）', null);
  } else {
  {
    const waited = await (async () => {
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < IDLE_WAIT_MS) {
        last = await PJ('runEvidence');
        if (last.running) return { ok: true, at: Date.now() - t0, ev: last };
        await sleep(400);
      }
      return { ok: false, at: Date.now() - t0, ev: last };
    })();
    runSeen = waited.ok;
    if (!waited.ok) {
      const rafStill = await pageMetrics(500);
      record('S9_idle_60s_starts_run', 'FAIL',
        `最后一次交互后等了 ${Math.round(waited.at / 1000)}s，没有观察到任何起跑迹象：基础层=${waited.ev && waited.ev.activeAnim}，#pet 位移 m41=${waited.ev && waited.ev.m41}，translate 动画=0；` +
        `期间页面 document.hidden=${(await PJ('state')).hidden}、每帧 rAF 回调=${rafStill.rafPerFrame}（说明不是页面被挂起，而是没有实现/没有触发）`,
        { waited: waited.ev, metrics: rafStill });
      record('S10_run_click_returns_then_laughs', 'SKIP', '起跑从未发生（S9 已 FAIL），「跑步时点击」无从观测', null);
      record('S11_run_mouseover_stops', 'SKIP', '起跑从未发生（S9 已 FAIL），「跑步时鼠标移入」无从观测', null);
      record('S16_run_cleanup_on_mode_switch', 'SKIP', '起跑从未发生（S9 已 FAIL），「跑步中切模式」无从观测', null);
    } else {
      const track = await pageTrack(7000);
      emit('[smoke] 起跑采样: ' + JSON.stringify(track));
      const moved = Math.abs(track.mMax - track.mMin) > 1 || (Math.abs(track.leftMax - track.leftMin) > 1);
      const bothWays = (track.mMax > 3 && track.mMin < -3) || (track.leftMax > 3 && track.leftMin < -3);
      const ev9 = `空闲 ${Math.round(waited.at / 1000)}s 后进入起跑：基础层=${waited.ev.activeAnim}；7s 采样 ${track.n} 帧：m41 ∈ [${track.mMin}, ${track.mMax}]，` +
        `相对命中框左边界位移 ∈ [${track.leftMin}, ${track.leftMax}]，translate 动画=${(waited.ev.runningTranslateAnims || []).length} 个` +
        `（${(waited.ev.runningTranslateAnims || []).map((a) => a.name + ':' + a.state + ' it=' + a.iterations).join('、')}）`;
      if (moved && bothWays) record('S9_idle_60s_starts_run', 'PASS', ev9 + ' → 左右往返 ✅', { waited: waited.ev, track });
      else if (moved) record('S9_idle_60s_starts_run', 'FAIL', ev9 + ' → 有位移但没看到左右两个方向（未观测到往返）', { waited: waited.ev, track });
      else record('S9_idle_60s_starts_run', 'FAIL', ev9 + ' → 位移幅度不足（<1px），没有真的跑起来', { waited: waited.ev, track });

      // S11 跑步中鼠标移入 → 平滑归位
      {
        const before = await PJ('runEvidence');
        const p = await petPoint(0.3);
        const hover = await PJ('mouseMoveAt', p.x, p.y);
        const back = await pageTrack(2500);
        const startOff = Math.max(Math.abs(back.mFirst), 0);
        const returned = Math.abs(back.mLast) <= 2 || (Math.abs(back.leftMax - back.leftMin) < 2);
        const intermediates = Number(back.mids) || 0;   // 全量样本统计，见页面里 track() 的 mids
        const smooth = startOff >= 8 ? intermediates >= 2 : null;
        const ev11 = `移入前 m41=${before.m41}（left=${before.rectLeft}）；鼠标移到 (${p.x},${p.y})（命中椭圆内=${p.insideHit}）；2.5s 后 m41=${back.mLast}，` +
          `归位过程采样 min/max=[${back.mMin},${back.mMax}]，中间态样本=${intermediates}` + (smooth === null ? '（起点位移太小，平滑性不可判定）' : '');
        if (returned && smooth !== false) record('S11_run_mouseover_stops', 'PASS', ev11 + ' → 停跑并归位 ✅', { before, hover, back });
        else record('S11_run_mouseover_stops', 'FAIL', ev11 + (returned ? ' → 归位不平滑（直接跳回）' : ' → 2.5s 内没有回到原位'), { before, hover, back });
      }

      // 再等一轮空闲 → S10 跑步中点击
      let cycle2 = null;
      if (RUN_CYCLES >= 2) {
        stage('S10 跑步中点击（第 2 轮空闲等待）');
        const t0 = Date.now();
        let ev = null;
        while (Date.now() - t0 < IDLE_WAIT_MS) {
          ev = await PJ('runEvidence');
          if (ev.running) break;
          await sleep(400);
        }
        cycle2 = { ev, waitedMs: Date.now() - t0 };
        const running = !!cycle2.ev.running;
        if (!running) {
          record('S10_run_click_returns_then_laughs', 'SKIP', `第 2 轮空闲 ${Math.round(cycle2.waitedMs / 1000)}s 内没有再次起跑，「跑步时点击」无从观测`, cycle2);
        } else {
          const trackBefore = await pageTrack(900);
          const startOff = trackBefore.mLast;
          const click = await clickPet(0.35, 35);
          // 大笑探测必须**和归位采样同时开始**。
          // 曾经是等 pageTrack(2600) 跑完才开始轮询「有没有笑」——那时大笑早演完了
          // （当时素材是 1.73 秒的乒乓版，2.6 秒采样结束时它已经结束），
          // 于是不管实现对不对都必然判「没有大笑」。
          let laughAt = null;
          const laughProbe = (async () => {
            const tl = Date.now();
            while (Date.now() - tl < 3200) {
              const st = await PJ('state');
              if (st.laughing) { laughAt = Date.now() - tl; return; }
              await sleep(50);
            }
          })();
          const back = await pageTrack(2600);
          await laughProbe;
          const returned = Math.abs(back.mLast) <= 2 || Math.abs(back.leftMax - back.leftMin) < 2;
          const intermediates = Number(back.mids) || 0;   // 全量样本统计，见页面里 track() 的 mids
          const smooth = Math.abs(startOff) >= 8 ? intermediates >= 2 : null;
          const ev10 = `点击时 m41=${startOff}（left=${trackBefore.samplesTail.slice(-1)[0][2]}）；点击坐标 (${click.point.x},${click.point.y}) 命中内=${click.point.insideHit}；` +
            `2.6s 后 m41=${back.mLast}，归位中间态样本=${intermediates}` + (smooth === null ? '（起点位移太小，平滑性不可判定）' : '') +
            `；点击后 ${laughAt == null ? '3s 内没有大笑' : laughAt + 'ms 进入大笑'}`;
          if (returned && laughAt != null && smooth !== false) record('S10_run_click_returns_then_laughs', 'PASS', ev10 + ' → 平滑归位 + 立即大笑 ✅', { trackBefore, click: click.point, back });
          else record('S10_run_click_returns_then_laughs', 'FAIL', ev10 + (returned ? '' : ' → 没有归位') + (laughAt == null ? ' → 没有大笑' : '') + (smooth === false ? ' → 归位不平滑' : ''), { trackBefore, click: click.point, back });
        }
      } else {
        record('S10_run_click_returns_then_laughs', 'SKIP', 'SMOKE_RUN_CYCLES<2，跳过了第二轮空闲等待（起跑要真等 60s）', null);
      }

      // S16 跑步中切模式（复用第 3 轮空闲）
      if (RUN_CYCLES >= 3) {
        stage('S16 跑步中切模式（第 3 轮空闲等待）');
        const t0 = Date.now();
        let ev = null;
        while (Date.now() - t0 < IDLE_WAIT_MS) {
          ev = await PJ('runEvidence');
          if (ev.running) break;
          await sleep(400);
        }
        const running = !!ev.running;
        if (!running) {
          record('S16_run_cleanup_on_mode_switch', 'SKIP', `第 3 轮空闲 ${Math.round((Date.now() - t0) / 1000)}s 内没有再次起跑`, ev);
        } else {
          const p = await petPoint(0.5);
          const before = await PJ('runEvidence');
          await js(`window.__SMOKE__.contextMenuAt(${p.x}, ${p.y})`, true);
          await sleep(900);
          const after = await PJ('state');
          const m = await js('window.naiwa.getMode()');
          await js(`window.__SMOKE__.contextMenuAt(${p.x}, ${p.y})`, true);
          await sleep(800);
          const ev16 = `切模式前 m41=${before.m41}（基础层=${before.activeAnim}）；右键双击切到 ${after.mode} 后 900ms：m41=${after.m41}，基础层=${after.activeAnim}，主进程 mode=${m}`;
          if (Math.abs(after.m41) <= 1 && after.mode === 'work') record('S16_run_cleanup_on_mode_switch', 'PASS', ev16 + ' → 位移归零 ✅', { before, after });
          else record('S16_run_cleanup_on_mode_switch', 'FAIL', ev16 + ' → 切模式后位移没有归零', { before, after });
        }
      } else {
        record('S16_run_cleanup_on_mode_switch', 'SKIP', 'SMOKE_RUN_CYCLES<3，跳过第三轮空闲等待', null);
      }
    }
  }
  }   // ← 结束 RUN_ENABLED=true 的分支

  // ── S17 右键操作窗 + S18 拖拽保持静态图（第五次会话新增的功能） ──
  stage('S17 右键操作窗 + S18 拖拽保持静态图');
  {
    // ── S17：右键单击 → 操作窗 ──
    const p = await petPoint(0.4);
    const before17 = await PJ('menuState');
    await js(`window.__SMOKE__.contextMenuOnceAt(${p.x}, ${p.y})`, true);
    await sleep(240);
    const opened = await PJ('menuState');

    // 菜单必须完整落在窗口里，否则用户点不到
    const inWindow = !!(opened.rect && opened.rect.x >= 0 && opened.rect.y >= 0
      && opened.rect.x + opened.rect.w <= 460 && opened.rect.y + opened.rect.h <= 640);
    const quitItem = (opened.items || []).filter((i) => i.act === 'quit')[0] || null;
    const modeItem = (opened.items || []).filter((i) => i.act === 'mode')[0] || null;

    // 光标移开 → 自动收起（走的是真实 mousemove 路径；穿透态下是主进程推送那条）
    await PJ('mouseMoveAt', 20, 20);
    await sleep(300);
    const closed = await PJ('menuState');

    const ok17 = before17.hidden === true && opened.exists && opened.open && !opened.hidden
      && !!quitItem && !quitItem.hidden && quitItem.text.indexOf('退出') >= 0
      && !!modeItem && opened.quitWired && inWindow
      && closed.hidden === true && closed.open === false;
    record('S17_menu_single_right_click', ok17 ? 'PASS' : 'FAIL',
      `右键单击前 hidden=${before17.hidden} → 之后 hidden=${opened.hidden}、App.menuOpen=${opened.open}；` +
      `项=[${(opened.items || []).map((i) => `${i.text}${i.hidden ? '(隐藏)' : ''}`).join(' / ')}]；` +
      `位置 ${opened.rect ? `${opened.rect.x},${opened.rect.y} ${opened.rect.w}x${opened.rect.h}` : '?'}（完整在窗口内=${inWindow}）；` +
      `退出项存在=${!!quitItem}、quit IPC 已暴露=${opened.quitWired}；光标移到 (20,20) 后 hidden=${closed.hidden}`,
      { before17, opened, closed, p });

    // ── S18：拖拽 → 保持当前静态图 ──
    // 真实链路：mousedown 落在奶蛙上 → mousemove 超过 6px → app.js 判定为拖拽。
    // 旧实现此时会把基础层换成一个**占位卡通蛙**（`.ph-frog.is-drag`，手脚乱晃），
    // 用户看到的就是「一拖变成一只小螃蟹」。现在要求全程不动。
    const dp = await petPoint(0.4);
    const before18 = await PJ('state');
    await js(`(function () {
      var x = ${dp.x}, y = ${dp.y};
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
      for (var i = 1; i <= 20; i++) {
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x + i * 3, clientY: y + i, button: 0, buttons: 1 }));
      }
      return true;
    })()`, true);
    await sleep(300);
    const during18 = await PJ('state');
    const phDrag = !!(during18.phClasses && during18.phClasses.indexOf('is-drag') >= 0);
    const dragLayer = (during18.layers || []).filter((l) => l.anim === 'drag' && l.opacity > 0.5);
    const stayedIdle = during18.activeAnim === 'idle_relax' && during18.activeOpacity > 0.9;

    // 收尾：松开鼠标（拖拽必须在 mouseup 结束，否则后面所有用例都带着拖拽状态）
    await js(`(function () {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ${dp.x} + 60, clientY: ${dp.y} + 20, button: 0, buttons: 0 }));
      return true;
    })()`, true);
    await sleep(300);
    const after18 = await PJ('state');

    const ok18 = stayedIdle && !phDrag && dragLayer.length === 0
      && after18.activeAnim === 'idle_relax' && !after18.isReacting;
    record('S18_drag_keeps_static_image', ok18 ? 'PASS' : 'FAIL',
      `拖拽前基础层=${before18.activeAnim}；拖动中基础层=${during18.activeAnim}（不透明度 ${during18.activeOpacity}）、` +
      `占位蛙 is-drag=${phDrag}、可见 drag 层=${dragLayer.length} 个；松开后基础层=${after18.activeAnim}、isReacting=${after18.isReacting}`,
      { before18: { active: before18.activeAnim, ph: before18.phClasses }, during18: { active: during18.activeAnim, layers: during18.layers, ph: during18.phClasses }, after18: { active: after18.activeAnim, isReacting: after18.isReacting }, dp });
  }

  // ── 确保回到解压模式 ──
  {
    const st = await PJ('state');
    if (st.mode !== 'relax') {
      const p = await petPoint(0.4);
      await js(`window.__SMOKE__.contextMenuAt(${p.x}, ${p.y})`, true);
      await sleep(900);
    }
  }

  // ── S13 来回切模式 20 次 ──
  stage('S13 来回切模式 20 次');
  {
    const pre = await pageMetrics(700);
    const errPre = (await js('window.__SMOKE__.errors.length')) + consoleMsgs.filter((m) => m.level === 'error').length;
    const stormStart = Date.now();
    let dispatchFails = 0;
    for (let i = 0; i < 20; i++) {
      const p = await petPoint(0.4);
      const r = await js(`window.__SMOKE__.contextMenuAt(${p.x}, ${p.y})`, true);
      if (!r || (r.results || []).some((s) => /err/.test(s))) dispatchFails++;
      await sleep(130);
    }
    await sleep(1500);
    const post = await pageMetrics(700);
    const errPost = (await js('window.__SMOKE__.errors.length')) + consoleMsgs.filter((m) => m.level === 'error').length;
    const stormErrors = consoleMsgs.filter((m) => m.level === 'error' && m.at >= stormStart - START_MS);
    const pageErrs = await js('window.__SMOKE__.errors.slice(0, 10)');
    const rendererMode = (await PJ('state')).mode;
    const mainMode = await js('window.naiwa.getMode()');
    const ev13 = `20 次右键**双击**切换（每次双击两击间隔 120ms，循环间隔 130ms）：` +
      `渲染进程错误 ${errPre}→${errPost}（其中切模式期间 console error=${stormErrors.length}，未捕获=${(pageErrs || []).length}）；` +
      `每帧 rAF 回调 ${pre.rafPerFrame}→${post.rafPerFrame}；#pet 内**可见**无限动画 ${pre.anims.infiniteVisible.length}→${post.anims.infiniteVisible.length}，可见动画总数 ${pre.anims.allVisible.length}→${post.anims.allVisible.length}；` +
      `残留分身 ${pre.clones}→${post.clones}；m41 ${pre.m41}→${post.m41}；挂起定时器 timeout ${pre.pendingTimeouts}→${post.pendingTimeouts} / interval ${pre.pendingIntervals}→${post.pendingIntervals}；` +
      `最终模式 渲染=${rendererMode} 主进程=${mainMode}（期望 relax）`;
    const bad13 =
      (pageErrs || []).length > 0 || stormErrors.length > 0 ||
      post.clones > 0 || Math.abs(post.m41) > 1 ||
      (post.rafPerFrame != null && pre.rafPerFrame != null && post.rafPerFrame > pre.rafPerFrame * 1.5 + 1) ||
      post.anims.allVisible.length > pre.anims.allVisible.length + 1 ||
      post.pendingIntervals > pre.pendingIntervals + 2 ||
      post.pendingTimeouts > pre.pendingTimeouts + 8 ||
      rendererMode !== 'relax' || mainMode !== 'relax' ||
      dispatchFails > 0;
    record('S13_mode_switch_20x', bad13 ? 'FAIL' : 'PASS', ev13 + (bad13 ? '' : ' → 无报错、无叠加、状态一致 ✅'),
      { pre, post, stormErrors, pageErrs, rendererMode, mainMode, dispatchFails });
  }

  // ── S14 全局错误 ──
  stage('S14 全局异常汇总');
  {
    const pageErrs = (await js('window.__SMOKE__.errors.slice(0, 20)')) || [];
    const inPageConsole = (await js('window.__SMOKE__.consoleErrors.slice(0, 20)')) || [];
    const appConsoleErrors = consoleMsgs.filter((m) => m.level === 'error' && /naiwa-pet/i.test(m.source));
    const otherConsoleErrors = consoleMsgs.filter((m) => m.level === 'error' && !/naiwa-pet/i.test(m.source));
    const loadErrs = appConsoleErrors.filter((m) => /Failed to load resource|ERR_FILE_NOT_FOUND|net::ERR/i.test(m.message || ''));
    const scriptErrs = appConsoleErrors.filter((m) => loadErrs.indexOf(m) < 0);
    const missing = [...new Set(loadErrs.map((m) => (/(file:\/\/[^\s'"]+)/.exec(m.message || '') || [null, null])[1]).filter(Boolean).map((u) => String(u).replace(/^file:\/\//, '')))];
    const detail = { pageErrs, inPageConsole, scriptErrs: scriptErrs.slice(0, 10), loadErrs: loadErrs.slice(0, 10), missing, otherConsoleErrors: otherConsoleErrors.slice(0, 10), pageErrors };
    const total = pageErrs.length + inPageConsole.length + scriptErrs.length + loadErrs.length + pageErrors.length;
    if (total === 0) {
      record('S14_no_uncaught_renderer_errors', 'PASS',
        `全程没有未捕获异常 / unhandled rejection / 应用自身 console.error / 资源加载失败（外部来源的 console error ${otherConsoleErrors.length} 条不计入）`, detail);
    } else {
      record('S14_no_uncaught_renderer_errors', 'FAIL',
        `未捕获异常=${pageErrs.length}，页内 console.error=${inPageConsole.length}，脚本 console error=${scriptErrs.length}，` +
        `资源加载失败=${loadErrs.length}${missing.length ? '（缺文件：' + missing.map((f) => f.replace(/^.*?naiwa-pet[\\/]/i, '')).join('、') + '）' : ''}，主进程侧=${pageErrors.length}；首条：` +
        JSON.stringify(pageErrs[0] || inPageConsole[0] || scriptErrs[0] || loadErrs[0] || pageErrors[0]).slice(0, 300), detail);
    }
    if (otherConsoleErrors.length) notes.push('外部/非应用来源的 console error ' + otherConsoleErrors.length + ' 条（未计入判定）：' + JSON.stringify(otherConsoleErrors.slice(0, 3)).slice(0, 300));
  }

  const counts = fmtCounts();
  finish(counts.FAIL > 0 ? 1 : 0, null);
}

// ───────────────────────── 6. 引导 ─────────────────────────

app.on('before-quit', (e) => {
  if (!finished) {
    emit('[FATAL] main.js 触发了退出（大概率是单实例锁没拿到：已经有另一个奶蛙实例在跑）。');
    finish(3, { quitUnexpectedly: true });
  }
});
process.on('uncaughtException', (e) => {
  emit('[FATAL] 主进程未捕获异常: ' + (e && e.stack ? e.stack : e));
  finish(4, { mainUncaught: String(e && e.message) });
});

app.whenReady().then(() => {
  main().catch((e) => {
    emit('[FATAL] 冒烟测试自身出错: ' + (e && e.stack ? e.stack : e));
    try { record('H0_renderer_boot', 'FAIL', '测试流程异常中断: ' + (e && e.message), { stack: String(e && e.stack).slice(0, 1500) }); } catch (e2) {}
    finish(4, { harnessError: String(e && e.message) });
  });
});