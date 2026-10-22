'use strict';
/**
 * 奶蛙桌宠 · Electron 主进程
 *
 * 对应分层架构第 1 层「外壳窗口层」，负责：
 *   - 透明 / 无边框 / 置顶 / 跳过任务栏的窗口
 *   - 点击穿透的动态切换（默认整窗穿透，鼠标压到奶蛙身上才恢复可点）
 *   - 全局拖拽（按屏幕坐标移动窗口，规避穿透态的坐标问题）
 *   - 剪贴板历史轮询
 *   - CPU 占用采样
 *   - 托盘菜单 + 数据持久化
 *
 * 这一层与「奶蛙长什么样」完全解耦：换成别的美术资源、甚至换成 3D，
 * 本文件一行都不用改。
 */

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, dialog, clipboard, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { frogIconPNG } = require('./lib/png');

/**
 * ★ 必须在任何 Electron 窗口/Chromium 初始化之前，确保 userData 目录存在**且可写**。
 *
 * 为什么要显式建：在本机（Windows + Electron 33.4.11）实测，当
 * `%APPDATA%\naiwa-pet` **不存在**时，Chromium 初始化 userData 会以
 * **访问违例**（0xC0000005，进程退出码 -1073741819）直接崩溃 ——
 * 表现是「双击/命令行启动后什么都没出现，也没有任何报错」，
 * 连 `uncaughtException` 都捕不到，因为那是原生层崩溃。
 *
 * 复现：删掉 `%APPDATA%\naiwa-pet` 再启动，必崩。
 *
 * 这个调用必须放在文件靠前的位置：实测崩溃发生在 main.js **求值完成之后**，
 * 所以在这里把目录建好，Chromium 就能正常走下去。
 * 目录已存在时 mkdirSync 是空操作，没有副作用。
 *
 * ⚠️ 第六次会话补充：**「建得出来」不等于「写得进去」**。
 * 遇到过目录存在、ACL 正常、但进程写不进去的机器，症状同样是
 * 「双击后什么都没出现」。所以这里不只建目录，还**真的写一个探针文件**；
 * 写不进去就换备用目录，而不是等 Chromium 崩掉。
 */
const DEFAULT_USER_DATA = path.join(app.getPath('appData'), app.getName());
/** 默认目录写不进时的备用位置（同一个用户下另一个足够普通的目录）。 */
const FALLBACK_USER_DATA = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'naiwa-pet-data');

/**
 * 目录能不能真的写进去？返回 `{ ok, error }`。
 *
 * ⚠️ 两条教训（第六次会话踩出来的）：
 *  1. **必须把真实错误带出去**。原来只说「没有写入权限」，看不到 errno 和路径，
 *     排查时白绕一大圈 —— 实测用户机器上目录其实可写，是探测本身误报。
 *  2. **不要用「写完再删掉」判定**。杀软扫描刚写入的文件时删除会短暂失败（EPERM），
 *     那是假阴性；只要**写入成功**就算可写（探针文件留着无所谓）。
 */
function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.write-probe'), 'ok');
    return { ok: true, error: null, dir };
  } catch (e) {
    return { ok: false, error: (e && (e.code ? e.code + ': ' + e.message : e.message)) || String(e), dir };
  }
}

/** 探测结果：单实例锁失败时要用它区分「已在运行」和「目录写不进」 */
let USER_DATA_PROBE = probeWritable(DEFAULT_USER_DATA);
if (!USER_DATA_PROBE.ok) {
  console.error('[奶蛙] 默认数据目录写不进去：' + USER_DATA_PROBE.error + ' （' + DEFAULT_USER_DATA + '）');
  const alt = probeWritable(FALLBACK_USER_DATA);
  if (alt.ok) {
    app.setPath('userData', FALLBACK_USER_DATA);
    USER_DATA_PROBE = { ok: true, error: null, dir: FALLBACK_USER_DATA, fellBackFrom: DEFAULT_USER_DATA };
    console.warn('[奶蛙] 已改用备用数据目录：' + FALLBACK_USER_DATA);
  } else {
    console.error('[奶蛙] 备用数据目录也写不进去：' + alt.error + ' （' + FALLBACK_USER_DATA + '）');
    USER_DATA_PROBE = { ok: false, error: USER_DATA_PROBE.error + '；备用目录同样失败：' + alt.error, dir: DEFAULT_USER_DATA };
  }
}

const WIN_W = 460;
const WIN_H = 640;

// 桌宠会在「没有用户交互」的时刻发声（比如 CPU 飙高时的流汗提示音），
// 关掉 Chromium 的自动播放限制，否则这类音效会被静默拦掉。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let tray = null;
let dragOffset = null;
let lastClipText = '';
let lastCpuSample = null;
let saveTimer = null;

// ───────────────────────────── 数据层 ─────────────────────────────

let data = {
  mode: 'relax',   // 'relax' 解压模式 | 'work' 工作模式
  notes: [],       // { id, text, done, at }
  clips: [],       // { id, text, at, pinned }
  settings: {
    clipboardWatch: true,
    cpuWatch: true,
    clipLimit: 200,
  },
};

const dataFile = () => path.join(app.getPath('userData'), 'naiwa-data.json');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/**
 * 数据加载状态。渲染进程要靠它解释「便签/剪贴板为什么突然全空」。
 *
 * 早期这里的 catch 是**空的**，损坏时静默回退默认值——面板那边拿不到任何信号，
 * 只能靠 localStorage 猜「上次有多少条」。而「数据没了却不告诉用户为什么」
 * 是最糟糕的失败模式。所以把真实原因记下来，通过 IPC 暴露出去。
 */
let dataStatus = { ok: true, reason: null, at: Date.now() };

function loadData() {
  const file = dataFile();

  // 文件不存在 = 首次运行，不是错误
  if (!fs.existsSync(file)) {
    dataStatus = { ok: true, reason: 'missing', at: Date.now() };
    return;
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // 读不出来：权限、被别的进程占着、磁盘问题…
    dataStatus = { ok: false, reason: 'io', at: Date.now(), message: e.message };
    console.error('[奶蛙] 数据文件读取失败，已回退到空数据:', e.message, '\n     文件:', file);
    return;
  }

  try {
    const raw = JSON.parse(text);
    data = {
      ...data,
      ...raw,
      settings: { ...data.settings, ...(raw.settings || {}) },
      notes: Array.isArray(raw.notes) ? raw.notes : [],
      clips: Array.isArray(raw.clips) ? raw.clips : [],
    };
    dataStatus = { ok: true, reason: null, at: Date.now() };
  } catch (e) {
    // 解析失败：多半是写一半断电。**必须响**，否则用户只会看到便签全没了。
    dataStatus = { ok: false, reason: 'corrupt', at: Date.now(), message: e.message };
    console.error('[奶蛙] 数据文件损坏，已回退到空数据:', e.message, '\n     文件:', file);
  }
}

// 防抖保存：剪贴板轮询会频繁触发，不防抖会疯狂写盘
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
      fs.writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('[奶蛙] 数据保存失败:', e.message);
    }
  }, 400);
}

// ───────────────────────────── 窗口 ─────────────────────────────

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    // 默认贴在主屏右下角
    x: workArea.x + workArea.width - WIN_W - 30,
    y: workArea.y + workArea.height - WIN_H - 6,
    transparent: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,        // 透明窗口 + 阴影 = 黑边，必须关
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 失焦时不降频，否则奶蛙动画会卡
    },
  });

  // 'screen-saver' 层级能浮在绝大多数窗口之上
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 默认整窗穿透。forward:true 是关键——穿透状态下渲染进程仍能收到 mousemove，
  // 这样前端才判断得出「鼠标有没有压到奶蛙身上」。
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

/** 切换点击穿透。前端只在状态真正变化时调用，避免每帧一次 IPC。 */
ipcMain.on('click-through:set', (_e, ignore) => {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

/**
 * 退出奶蛙（右键操作窗里的那一项）。
 *
 * ⚠️ 必须和托盘那一项走**同一条路**：`app.isQuitting = true` + `app.quit()`。
 * 少了前面那个标志，`window-all-closed` 会把关闭拦下来（托盘常驻程序的设计），
 * 表现就是「点了退出，窗口没了，进程还在、托盘图标还在」。
 */
ipcMain.on('app:quit', () => {
  app.isQuitting = true;
  app.quit();
});

// ───────────────────────────── 拖拽 ─────────────────────────────
// 拖动期间由主进程按屏幕坐标移动窗口。比在前端累加 mousemove 可靠，
// 因为穿透开启时前端拿不到连续的事件流。

ipcMain.on('drag:start', () => {
  if (!win || win.isDestroyed()) return;
  const pt = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOffset = { x: pt.x - wx, y: pt.y - wy };
});

ipcMain.on('drag:end', () => { dragOffset = null; });

setInterval(() => {
  if (!dragOffset || !win || win.isDestroyed()) return;
  const pt = screen.getCursorScreenPoint();
  win.setPosition(pt.x - dragOffset.x, pt.y - dragOffset.y);
}, 16);

// ───────────────────────── 全局光标位置 ─────────────────────────
// 窗口处于点击穿透状态时，渲染进程收不到 mousemove（forward 只保证一部分场景）。
// 所以由主进程按 25fps 把光标换算成「窗口内坐标」喂给前端，
// 前端据此判断鼠标有没有压在奶蛙身上，进而决定要不要把窗口切回可点击。

let lastCursor = { x: -9999, y: -9999 };
let cursorTick = 0;

setInterval(() => {
  if (!win || win.isDestroyed() || !win.isVisible()) return;

  const pt = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const x = pt.x - b.x;
  const y = pt.y - b.y;

  cursorTick++;
  const moved = (x !== lastCursor.x || y !== lastCursor.y);

  // 位置没变就默认不发，省掉绝大部分 IPC。
  //
  // ⚠️ 但必须保留一个心跳（每 5 拍 ≈ 200ms）。原因是**奶蛙自己会移动**
  // （闲置久了会左右跑）：「窗口不动 + 光标不动 + 奶蛙跑过来」这个组合里，
  // 位置完全没变，可命中判定必须重算，否则
  //   · 感知不到「鼠标移入奶蛙」→ 不会归位；
  //   · 穿透状态和奶蛙实际位置脱节 → 点不到它，或者它跑开后窗口还挡着桌面。
  // 渲染进程的命中判定读的是当前 DOM 位置，所以重发同一个坐标是有意义的。
  if (!moved && cursorTick % 5 !== 0) return;

  lastCursor = { x, y };
  win.webContents.send('sys:cursor', lastCursor);
}, 40);

// ───────────────────────────── 模式切换 ─────────────────────────────

function setMode(mode) {
  data.mode = mode === 'work' ? 'work' : 'relax';
  saveData();
  if (win && !win.isDestroyed()) win.webContents.send('mode:changed', data.mode);
  refreshTray();
  return data.mode;
}

ipcMain.handle('mode:get', () => data.mode);
ipcMain.handle('mode:set', (_e, mode) => setMode(mode));

// ───────────────────────────── 便签 / 待办 ─────────────────────────────

ipcMain.handle('notes:list', () => data.notes);

ipcMain.handle('notes:add', (_e, text) => {
  const t = String(text == null ? '' : text).trim();
  if (!t) return data.notes;
  data.notes.unshift({ id: uid(), text: t, done: false, at: Date.now() });
  saveData();
  return data.notes;
});

ipcMain.handle('notes:toggle', (_e, id) => {
  const n = data.notes.find((x) => x.id === id);
  if (n) { n.done = !n.done; saveData(); }
  return data.notes;
});

ipcMain.handle('notes:update', (_e, id, text) => {
  const n = data.notes.find((x) => x.id === id);
  const t = String(text == null ? '' : text).trim();
  if (n && t) { n.text = t; saveData(); }
  return data.notes;
});

ipcMain.handle('notes:remove', (_e, id) => {
  data.notes = data.notes.filter((x) => x.id !== id);
  saveData();
  return data.notes;
});

// ───────────────────────────── 剪贴板历史 ─────────────────────────────

ipcMain.handle('clips:list', () => data.clips);

ipcMain.handle('clips:copy', (_e, id) => {
  const c = data.clips.find((x) => x.id === id);
  if (!c) return { ok: false, clips: data.clips };
  clipboard.writeText(c.text);
  // 自己写回剪贴板同样会改变内容，先记下来免得又被当成新记录
  lastClipText = c.text;
  // 刚复制过的移到最前
  data.clips = [c, ...data.clips.filter((x) => x.id !== id)];
  saveData();
  return { ok: true, clips: data.clips };
});

ipcMain.handle('clips:pin', (_e, id) => {
  const c = data.clips.find((x) => x.id === id);
  if (c) {
    c.pinned = !c.pinned;
    data.clips.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    saveData();
  }
  return data.clips;
});

ipcMain.handle('clips:remove', (_e, id) => {
  data.clips = data.clips.filter((x) => x.id !== id);
  saveData();
  return data.clips;
});

/** 清空未置顶的记录。手动置顶的保留，避免误删重要内容。 */
ipcMain.handle('clips:clear', () => {
  data.clips = data.clips.filter((x) => x.pinned);
  saveData();
  return data.clips;
});

ipcMain.handle('settings:set', (_e, patch) => {
  data.settings = { ...data.settings, ...(patch || {}) };
  saveData();
  refreshTray();
  return data.settings;
});

/**
 * 读设置。
 *
 * 设置存在主进程，渲染进程原本只能写（`settings:set`），没有合法的读法——
 * 面板只好用 `setSettings({})` 空补丁去把它「骗」回来。那是用写操作读状态，
 * 语义脏，而且每次都会触发一次保存 + 重建托盘菜单。
 *
 * ⚠️ 一律返回**副本**：直接给引用的话，渲染进程改一下对象就会绕过 saveData 污染主进程状态。
 */
ipcMain.handle('settings:get', () => ({ ...data.settings }));

/**
 * 数据加载状态。见上面 `dataStatus` 的说明。
 * reason: null（正常）/ 'missing'（首次运行）/ 'corrupt'（JSON 坏了）/ 'io'（读不出来）
 */
ipcMain.handle('data:status', () => ({ ...dataStatus }));

/**
 * 剪贴板轮询。
 *
 * Electron 没有剪贴板变化事件，只能轮询。这里每 700ms 读一次文本并与上次比较，
 * readText() 是原生调用，开销很低。
 *
 * 以后若迁到 Tauri/Rust，用 Win32 的 GetClipboardSequenceNumber() 更优雅：
 * 它返回一个每次剪贴板变化就自增的整数，轮询这个整数几乎零成本，
 * 只有发现变了才真的去读内容。
 *
 * 隐私：内容仅存本地 JSON，不上传。托盘菜单可随时关闭记录。
 */
function startClipboardWatch() {
  try { lastClipText = clipboard.readText() || ''; } catch { lastClipText = ''; }

  setInterval(() => {
    if (!data.settings.clipboardWatch || !win || win.isDestroyed()) return;

    let text = '';
    try { text = clipboard.readText() || ''; } catch { return; }
    if (!text || text === lastClipText) return;
    lastClipText = text;

    // 去重：复制同样的内容只把它移到最前，而不是新增一条
    data.clips = data.clips.filter((c) => c.text !== text);
    data.clips.unshift({ id: uid(), text, at: Date.now(), pinned: false });

    // 超上限时优先丢弃未置顶的旧记录
    if (data.clips.length > data.settings.clipLimit) {
      const pinned = data.clips.filter((c) => c.pinned);
      const rest = data.clips.filter((c) => !c.pinned);
      data.clips = [...pinned, ...rest.slice(0, Math.max(0, data.settings.clipLimit - pinned.length))];
    }

    saveData();
    win.webContents.send('clips:updated', data.clips);
  }, 700);
}

// ───────────────────────────── CPU 采样 ─────────────────────────────

/** 用 os.cpus() 的累计时间差算 CPU 占用率，Node 自带，零依赖。 */
function sampleCpu() {
  const now = os.cpus();
  if (!lastCpuSample) { lastCpuSample = now; return 0; }

  let idle = 0, total = 0;
  for (let i = 0; i < now.length && i < lastCpuSample.length; i++) {
    const a = lastCpuSample[i].times;
    const b = now[i].times;
    const dIdle = b.idle - a.idle;
    const dTotal = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + dIdle;
    idle += dIdle;
    total += dTotal;
  }
  lastCpuSample = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

function startCpuWatch() {
  sampleCpu(); // 丢弃第一次采样（没有基准）
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const cpu = data.settings.cpuWatch ? sampleCpu() : 0;
    win.webContents.send('sys:cpu', cpu);
  }, 2000);
}

// ───────────────────────────── 托盘 ─────────────────────────────

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: data.mode === 'work' ? '当前：工作模式' : '当前：解压模式', enabled: false },
    { type: 'separator' },
    { label: '解压模式', type: 'radio', checked: data.mode === 'relax', click: () => setMode('relax') },
    { label: '工作模式', type: 'radio', checked: data.mode === 'work', click: () => setMode('work') },
    { type: 'separator' },
    {
      label: '显示奶蛙',
      type: 'checkbox',
      checked: !!(win && !win.isDestroyed() && win.isVisible()),
      click: () => { if (!win) return; win.isVisible() ? win.hide() : win.show(); refreshTray(); },
    },
    {
      label: '记录剪贴板历史',
      type: 'checkbox',
      checked: data.settings.clipboardWatch,
      click: (i) => { data.settings.clipboardWatch = i.checked; saveData(); refreshTray(); },
    },
    {
      label: 'CPU 高时流汗',
      type: 'checkbox',
      checked: data.settings.cpuWatch,
      click: (i) => { data.settings.cpuWatch = i.checked; saveData(); refreshTray(); },
    },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.showItemInFolder(dataFile()) },
    { label: '退出奶蛙', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  try {
    // 托盘图标由 lib/png.js 现场生成，不依赖任何图片素材
    const icon = nativeImage.createFromBuffer(frogIconPNG(32));
    tray = new Tray(icon);
    tray.setToolTip('奶蛙桌宠');
    tray.on('click', () => {
      if (!win) return;
      win.isVisible() ? win.hide() : win.show();
      refreshTray();
    });
    refreshTray();
  } catch (e) {
    console.error('[奶蛙] 托盘创建失败:', e.message);
  }
}

// ───────────────────────────── 生命周期 ─────────────────────────────

// 单实例：重复启动时唤起已有窗口，而不是再养一只奶蛙
//
// ⚠️ 这里**绝对不能静默退出**。
//
// 实测踩过的坑：如果上一次运行留下了卡死的 electron 进程，单实例锁会被它永久占住，
// 而那种进程连 `taskkill /F` 都杀不掉（报「拒绝访问」—— 它跑在受保护的安全上下文里，
// 普通令牌没有终止权）。于是每次启动都是「双击后什么都没出现、也没有任何报错」，
// 用户完全无从下手。所以：
//   1. 失败时必须把原因打到 stderr（末尾有说明）；
//   2. 留一个逃生开关 NAIWA_ALLOW_MULTI=1，允许在锁被占死的情况下强行启动。
const ALLOW_MULTI = process.env.NAIWA_ALLOW_MULTI === '1';

/**
 * 真正把奶蛙养起来（单实例检查通过、或用户选择「仍然启动一只」之后调用）。
 *
 * 抽成函数是因为它现在有两条入口：正常通过 + 锁失败后用户坚持启动。
 */
function startApp() {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    loadData();
    createWindow();
    createTray();
    startClipboardWatch();
    startCpuWatch();
  });
}

/**
 * 数据目录到底能不能写？
 *
 * 单实例锁失败时**必须区分两种原因**，否则会给出误导性的提示：
 *   · 真的有一只奶蛙在跑      → 「已经在运行」是对的
 *   · 数据目录写不进去        → Chromium 建不出锁文件，报的也是「已经在运行」
 *
 * 第六次会话实测抓到过第二种（打包版在受限环境里启动）：
 *   `Lock file can not be created! Error code: 5`（拒绝访问）
 * 然后弹出「奶蛙已经在运行，或者上一次的进程卡住了」——
 * 用户照着提示去任务管理器找残留进程，永远找不到，因为根本没有。
 *
 * ⚠️ 而且**判断依据要可靠**：原来这里现写现删探针文件，删除被拦（杀软扫新文件）
 * 就被判成「目录不可写」，实测误报过一次（用户机器上目录明明可写，ACL 也正常，
 * 结果弹了错误的框）。现在直接用启动最前面那次探测的结果 —— 它只要求写入成功，
 * 而且把真实 errno 一起带出来。
 */
if (!ALLOW_MULTI && !app.requestSingleInstanceLock()) {
  const writable = USER_DATA_PROBE.ok;
  const ud = USER_DATA_PROBE.dir || app.getPath('userData');
  const msg = writable
    ? '奶蛙已经在运行，或者上一次的进程卡住了。\n\n' +
      '· 在托盘图标上右键 →「退出奶蛙」，或到任务管理器里结束残留的进程。\n' +
      '· 如果提示「拒绝访问」杀不掉，重启系统即可清除。\n' +
      '· 命令行用户也可以设 NAIWA_ALLOW_MULTI=1（或 npm run start:force）强行启动。'
    : '奶蛙的数据目录写不进去，启动被挡住了。\n\n' +
      '数据目录：' + ud + '\n' +
      '失败原因：' + USER_DATA_PROBE.error + '\n\n' +
      '· 这**不是**「已经在运行」——是权限或安全软件的问题。\n' +
      '· 可以试试：检查上面这个目录的权限；关掉/放行拦截它的安全软件。\n' +
      '· 想先跑起来：设环境变量 NAIWA_ALLOW_MULTI=1 再启动（会跳过单实例检查）。';
  console.error('[奶蛙] 启动中止（数据目录可写=' + writable + '，原因=' + USER_DATA_PROBE.error + '）：' + msg.replace(/\n+/g, ' '));
  // 必须弹框：桌宠是双击启动的，没有控制台可看。
  // 只打 stderr 的话，用户看到的就是「双击后什么都没发生」——最糟的失败模式。
  //
  // ⚠️ 但**不能只给「确定」**：单实例锁失败的原因常常是上一次的残留状态
  //（被强杀的进程、上一次崩在启动中的实例），过一会儿就自己好了。
  // 只让用户「确定 → 退出」，他就被永久挡在门外，连试都试不了。
  // 所以给两个选择：仍然启动一只 / 退出。默认选「退出」，不鼓励真的养两只。
  let choice = 1;
  try {
    choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: '奶蛙启动中止',
      message: writable ? '奶蛙已经在运行，或者上一次的进程卡住了。' : '奶蛙的数据目录写不进去。',
      detail: msg,
      buttons: ['仍然启动一只', '退出'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
  } catch { choice = 1; /* 弹不出来就当作退出 */ }
  if (choice !== 0) { app.quit(); }
  else {
    console.warn('[奶蛙] 用户选择「仍然启动一只」：跳过单实例检查。');
    startApp();
  }
} else {
  if (ALLOW_MULTI) {
    console.warn('[奶蛙] NAIWA_ALLOW_MULTI=1：跳过单实例检查，本次可能同时有两只奶蛙。');
  }
  startApp();
}

// 托盘常驻程序：关掉窗口不等于退出，只在托盘「退出」时才真正结束
app.on('window-all-closed', (e) => {
  if (!app.isQuitting) e.preventDefault();
});