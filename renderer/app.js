'use strict';
/**
 * 核心层 · 模式路由与事件分发（共享层 · 冻结）
 *
 * ═══════════════════════════════════════════════════════════════
 *  这个文件现在只做四件事，不再内联任何模式逻辑
 * ═══════════════════════════════════════════════════════════════
 *   1. 按当前模式查表，把事件分发给 Naiwa.Modes.<id>
 *   2. 组装并注入 ctx（模式层唯一能碰共享能力的入口）
 *   3. 管模式生命周期：切走时调 deactivate()，切来时 await activate(ctx)
 *   4. 调度与模式无关的窗口行为：点击穿透、拖拽、空闲心跳、CPU 转发
 *
 * 「解压模式点一下会笑」这类规则**不在这里**，在 renderer/modes/relax.js；
 * 工作模式的在 renderer/modes/work.js。改手感请去改那两个文件。
 *
 * ═══════════════════════════════════════════════════════════════
 *  关于点击穿透（整个项目最关键的一环）
 * ═══════════════════════════════════════════════════════════════
 *  窗口是个矩形，但奶蛙不是。如果整窗都接收鼠标事件，用户就点不到桌面上
 *  被窗口覆盖的图标——这是桌宠最容易翻车的地方。
 *
 *  做法：主进程以 25fps 推送全局光标位置（穿透状态下前端收不到 mousemove），
 *  前端据此判断光标是否落在「奶蛙身体」或「展开的面板」上，只在命中时才把
 *  窗口切回可点击。
 *
 *  注意命中形状用椭圆而不是矩形，见 core/pet.js 的 containsPoint()。
 */

window.Naiwa = window.Naiwa || {};

(function () {

  // ───────────────────────── 状态 ─────────────────────────

  let curMode = 'relax';
  let curMod = null;             // 当前模式模块对象
  let clickThrough = null;       // null = 尚未同步过，首次一定同步
  let cpuValue = 0;
  let pressStart = null;
  let pressMoved = false;
  let dragging = false;
  let lastActivityAt = Date.now();
  let idleTimer = null;
  let toastTimer = null;
  let modeChain = Promise.resolve();   // 串行化模式切换，疯狂右键也不会交叉执行

  const $ = (id) => document.getElementById(id);

  // ───────────────────────── 提示气泡 ─────────────────────────

  function toast(text, ms) {
    const el = $('toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = text;
    el.hidden = false;
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 1600);
  }

  // ───────────────────────── ctx ─────────────────────────

  /**
   * 模式层的服务句柄。**这是模式模块唯一能碰共享能力的入口**——
   * 不要绕过它直接操作 DOM 或 window.naiwa，否则共享层一改就全线崩。
   *
   * 接口规格见 docs/00-协作约定.md 第 4 节。这里刻意做成一层薄门面，而不是
   * 直接把 Naiwa.Pet 递出去：门面能保证签名稳定，也方便做参数适配
   * （比如 isReacting 在 pet.js 里是 getter，约定文档里写的是方法）。
   */
  const petApi = {
    /** 切回本模式的静态待机图。不传模式就表示「当前模式」。 */
    setIdle: (m) => Naiwa.Pet.setIdle(m || curMode),

    /** 播一次性反应，返回预计总时长（ms）。opts: { duration, hold, onEnd } */
    playOnce: (name, opts) => Naiwa.Pet.playOnce(name, opts),

    /** 播循环状态，需要自己调 stopLoop() 结束。 */
    playLoop: (name) => Naiwa.Pet.playLoop(name),

    /** 停止循环状态，回静态待机。 */
    stopLoop: () => Naiwa.Pet.stopLoop(),

    /** 是否正在做一次性反应或分身表演。 */
    isReacting: () => Naiwa.Pet.isReacting,

    /** 某槽位有没有真实素材（没有就是占位奶蛙）。 */
    has: (name, layer) => Naiwa.Pet.has(name, layer),

    /**
     * 主体元素 #pet。
     * 跑步位移必须加在它身上（不是内层容器），命中判定才会跟着走。
     */
    root: () => Naiwa.Pet.root(),

    /** 叠加特效开关（流汗、打盹这类）。 */
    setOverlay: (name, on, opts) => Naiwa.Pet.setOverlay(name, on, opts),

    /** 台词气泡。 */
    say: (text, ms) => Naiwa.Pet.say(text, ms),

    /** 判断窗口内坐标是否落在奶蛙身上（椭圆判定，已考虑跑步位移）。 */
    containsPoint: (x, y) => Naiwa.Pet.containsPoint(x, y),

    /** 视线跟随。传客户端坐标，内部会归一化。 */
    lookAt: (x, y) => Naiwa.Pet.lookAt(x, y),

    /** 预加载动画。同步播放前必须先调这个。 */
    preload: (names) => Naiwa.Pet.preload(names),

    /** 分身同步表演 —— 解压模式连点专用。 */
    performWithClones: (name, opts) => Naiwa.Pet.performWithClones(name, opts),
  };

  const panelApi = {
    open: (tab) => Naiwa.Panels.open(tab),
    close: () => Naiwa.Panels.close(),
    toggle: (tab) => Naiwa.Panels.toggle(tab),
    isOpen: () => Naiwa.Panels.isOpen(),
    refresh: () => Naiwa.Panels.refresh(),
  };

  const ctx = {
    pet: petApi,
    audio: { play: (name, opts) => Naiwa.Audio.play(name, opts) },
    panel: panelApi,
    toast,
    log: (msg) => console.log(`[${curMode}] ${msg}`),
    get mode() { return curMode; },
  };

  // ───────────────────────── 事件分发 ─────────────────────────

  /** 按名字把事件派发给当前模式。模式没实现该方法就静默跳过。 */
  function dispatch(name, ...args) {
    const fn = curMod && curMod[name];
    if (typeof fn !== 'function') return;
    try {
      fn.call(curMod, ctx, ...args);
    } catch (e) {
      // 模式回调抛错不能打断核心层这一轮的其他处理
      console.error(`[奶蛙] 模式 ${curMode} 的 ${name}() 抛错:`, e);
    }
  }

  // ───────────────────────── 模式切换 ─────────────────────────

  async function doApplyMode(mode, opts) {
    opts = opts || {};
    const next = mode === 'work' ? 'work' : 'relax';
    const nextMod = (Naiwa.Modes && Naiwa.Modes[next]) || null;

    // 1. 先让旧模式清场。deactivate 必须是同步的，且必须清干净——
    //    否则残留的定时器会让两个模式的行为叠在一起。
    if (curMod && curMod !== nextMod && typeof curMod.deactivate === 'function') {
      try {
        curMod.deactivate();
      } catch (e) {
        console.error(`[奶蛙] 模式 ${curMode} 的 deactivate() 抛错:`, e);
      }
    }

    curMode = next;
    curMod = nextMod;
    document.body.dataset.mode = curMode;

    // 2. 核心层兜底清场：无论模式自己清没清干净，表现层都回到静态待机
    Naiwa.Pet.setIdle(curMode);
    Naiwa.Pet.say('');
    closeMenu();          // 操作窗里也有「切换模式」，切完必须收起来

    // 面板只属于工作模式，切到解压模式时收起来，免得留下残留状态
    if (curMode === 'relax' && Naiwa.Panels.isOpen()) Naiwa.Panels.close();

    // 3. 新模式进场
    if (curMod && typeof curMod.activate === 'function') {
      try {
        await curMod.activate(ctx);
      } catch (e) {
        console.error(`[奶蛙] 模式 ${curMode} 的 activate() 抛错:`, e);
      }
    }

    if (!curMod) console.warn(`[奶蛙] 没有找到模式模块 Naiwa.Modes.${curMode}，界面会没有反应`);

    if (opts.announce !== false) {
      Naiwa.Audio.play('chime');
      toast(curMode === 'work' ? '工作模式' : '解压模式');
      Naiwa.Pet.say(curMode === 'work' ? '开始干活吧' : '来玩呀～', 1400);
    }

    if (!opts.silent) window.naiwa.setMode(curMode);
  }

  /** 切模式。用 Promise 链串起来，疯狂右键也不会两个模式交叉激活。 */
  function applyMode(mode, opts) {
    modeChain = modeChain
      .then(() => doApplyMode(mode, opts))
      .catch((e) => console.error('[奶蛙] 模式切换失败:', e));
    return modeChain;
  }

  function switchMode() {
    return applyMode(curMode === 'relax' ? 'work' : 'relax');
  }

  // ───────────────────────── 点击穿透调度 ─────────────────────────

  /** 判断某个窗口内坐标是否「压在了能点的东西上」。 */
  function isInteractiveAt(x, y) {
    // 面板和右键操作窗用 elementFromPoint 精确判断，圆角、内部元素都天然处理好了
    const el = document.elementFromPoint(x, y);
    if (el && el.closest && (el.closest('#panel') || el.closest('#pet-menu'))) return true;

    // 奶蛙用椭圆判定，避免窗口四角的透明区域挡住桌面点击
    return Naiwa.Pet.containsPoint(x, y);
  }

  /**
   * 操作窗打开时，光标只要离开「奶蛙 + 操作窗」就把它收起
   * （和常见软件的右键菜单一致）。
   *
   * ⚠️ 两个来源都要接：真实 mousemove（非穿透态）和主进程的光标推送
   *（穿透态）。和模式层的 onPointerMove 一样，这里必须**幂等**。
   */
  function closeMenuIfPointerAway(x, y) {
    if (menuOpen && !isInteractiveAt(x, y)) closeMenu();
  }

  function updateClickThrough(x, y) {
    const shouldPass = !isInteractiveAt(x, y);
    if (shouldPass === clickThrough) return;      // 只在真正变化时发 IPC
    clickThrough = shouldPass;
    window.naiwa.setClickThrough(shouldPass);
  }

  // ───────────────────────── 拖拽 ─────────────────────────
  // 拖动期间由主进程按屏幕坐标移动窗口，前端只负责起止和表现。

  /**
   * 拖拽时要不要换成「被拎起来」的动作素材。
   *
   * ⏸ **默认关掉**（用户要求）。原因：`assets/manifest.js` 里 `drag` 是
   * `kind:'none'`（没有真实拖拽素材），于是表现层会退回**内置占位卡通蛙**——
   * 那只蛙和真实素材画风差得很远，而且 CSS 里给它写了「手脚乱晃」的动画，
   * 用户看到的就是「一拖就变成一只小螃蟹」。
   *
   * 现在的做法是**全程保持当前静态图不变**，反馈只靠光标形状
   *（`.pet` 的 grab / grabbing）。以后拿到真实拖拽素材：
   *   ① 在 `assets/manifest.js` 里把 `drag` 声明成真素材；
   *   ② 把这里改成 true。代码路径原样保留着。
   */
  const DRAG_ANIM = false;

  function startDrag() {
    if (dragging) return;
    dragging = true;
    window.naiwa.dragStart();
    if (DRAG_ANIM) Naiwa.Pet.playOnce('drag', { sticky: true });
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    window.naiwa.dragEnd();
    if (DRAG_ANIM) Naiwa.Pet.endReact();
  }

  // ───────────────────────── 右键操作窗 ─────────────────────────
  //
  // 语义（第五次会话改，用户要求）：
  //   · 右键**单击** → 弹出操作窗（里面有「退出奶蛙」）
  //   · 右键**双击** → 切换模式（以前是单击切模式，现在让位给操作窗）
  //
  // 为什么不做「延迟 400ms 等第二击」：那会让每次右键菜单都慢半拍，
  // 而右键菜单的手感就靠「立刻出现」。所以是**先立刻弹出**；
  // 若在双击窗口内又来一次右键，就把菜单收起并切模式。
  // 双击切模式本来就是有意的二次动作，菜单闪一下反而像反馈。
  const MENU_DBL_MS = 400;      // 右键双击的判定间隔，和系统双击间隔同量级
  let menuOpen = false;
  let lastContextAt = 0;

  const menuEl = () => $('pet-menu');

  /**
   * 弹出操作窗。
   *
   * 位置固定在**奶蛙正上方居中**，而不是贴着光标：奶蛙就待在窗口最底部，
   * 贴光标会盖住它自己的头，还容易被窗口下边缘切掉。夹在窗口内是硬要求
   * （窗口只有 460×640，菜单跑出去就点不到了）。
   */
  function openMenu() {
    const el = menuEl();
    const pet = $('pet');
    if (!el || !pet) return;

    // 按模式决定哪些项有意义：面板只属于工作模式
    const panelItem = el.querySelector('[data-act="panel"]');
    if (panelItem) {
      panelItem.hidden = curMode !== 'work';
      panelItem.textContent = Naiwa.Panels.isOpen() ? '收起面板' : '打开面板';
    }

    el.hidden = false;           // 先显示，才能量到真实尺寸
    const r = pet.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const cx = r.left + r.width / 2;
    const x = Math.min(Math.max(6, cx - w / 2), window.innerWidth - w - 6);
    const y = Math.min(Math.max(6, r.top - h - 8), window.innerHeight - h - 6);
    el.style.left = (x - r.left) + 'px';
    el.style.top = (y - r.top) + 'px';
    menuOpen = true;
  }

  function closeMenu() {
    const el = menuEl();
    if (!el || !menuOpen) return;
    el.hidden = true;
    menuOpen = false;
  }

  /** 退出奶蛙。走主进程的正规退出路径（和托盘那一项同一条）。 */
  function quitApp() {
    try {
      window.naiwa.quit();
    } catch (e) {
      console.error('[奶蛙] 退出失败:', e);
    }
  }

  function bindMenu() {
    const el = menuEl();
    if (!el) return;

    el.addEventListener('click', (e) => {
      const item = e.target.closest && e.target.closest('.menu-item');
      if (!item || item.hidden) return;
      const act = item.dataset.act;
      closeMenu();
      if (act === 'mode') switchMode();
      else if (act === 'panel') { Naiwa.Panels.isOpen() ? Naiwa.Panels.close() : Naiwa.Panels.open(); }
      else if (act === 'quit') quitApp();
    });

    // 菜单里的右键不再参与「弹菜单 / 切模式」
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  }

  // ───────────────────────── 鼠标事件 ─────────────────────────

  function markActivity() {
    lastActivityAt = Date.now();
  }

  /**
   * 鼠标停在奶蛙身上也算「在跟它互动」，要重置空闲计时。
   *
   * 不这么做会有一个很显眼的抖动：闲置满 60 秒奶蛙跑起来 → 光标压在它身上
   * 把跑步打断 → 空闲计时早就超额了，5 秒后又被同一个悬停触发，
   * 于是跑一下停一下地抽。
   */
  function markIfHoveringPet(x, y) {
    if (Naiwa.Pet.containsPoint(x, y)) markActivity();
  }

  function bindMouse() {
    document.addEventListener('mousedown', (e) => {
      markActivity();
      if (e.button !== 0) return;
      if (!Naiwa.Pet.containsPoint(e.clientX, e.clientY)) return;
      pressStart = { x: e.clientX, y: e.clientY };
      pressMoved = false;
    });

    document.addEventListener('mousemove', (e) => {
      // 视线跟随：让奶蛙看着鼠标
      Naiwa.Pet.lookAt(e.clientX, e.clientY);
      markIfHoveringPet(e.clientX, e.clientY);
      closeMenuIfPointerAway(e.clientX, e.clientY);
      dispatch('onPointerMove', e.clientX, e.clientY);

      if (!pressStart) return;
      const dx = e.clientX - pressStart.x;
      const dy = e.clientY - pressStart.y;
      if (!pressMoved && Math.hypot(dx, dy) > 6) {
        pressMoved = true;
        startDrag();
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (!pressStart) return;
      const wasDrag = pressMoved;
      pressStart = null;
      pressMoved = false;

      if (wasDrag) { endDrag(); return; }
      if (e.button !== 0) return;

      // 拖拽已在上面过滤掉，这里收到的都是纯点击
      markActivity();
      dispatch('onClick');
    });

    // 右键：**单击 = 操作窗，双击 = 切模式**（第五次会话改，见上面「右键操作窗」）。
    // 必须拦掉默认菜单，否则会弹出 Chromium 的系统菜单。
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      markActivity();
      if (e.target.closest && (e.target.closest('#panel') || e.target.closest('#pet-menu'))) return;  // 面板 / 菜单内右键不参与

      const t = Date.now();
      if (t - lastContextAt <= MENU_DBL_MS) {
        lastContextAt = 0;
        closeMenu();               // 收起刚弹出来的那一下
        switchMode();              // 双击 = 切模式
        return;
      }
      lastContextAt = t;
      openMenu();
    });

    // Esc 收起操作窗（右键菜单的通用习惯）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    // 兜底：鼠标离开窗口就恢复穿透，避免残留成「整窗可点」
    document.addEventListener('mouseleave', () => {
      if (clickThrough !== true) {
        clickThrough = true;
        window.naiwa.setClickThrough(true);
      }
      endDrag();
      closeMenu();          // 光标离开窗口 = 离开菜单，收起
      pressStart = null;
      pressMoved = false;
    });
  }

  // ───────────────────────── 空闲心跳 ─────────────────────────

  function startIdleWatch() {
    clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (document.hidden) return;
      dispatch('onIdleTick', Date.now() - lastActivityAt);
    }, 5000);
  }

  // ───────────────────────── 启动 ─────────────────────────

  async function boot() {
    // 1. 面板先就绪（它要在 Pet 之前就绪，完成回调里会用到音效钩子）
    await Naiwa.Panels.init({
      onOpen: () => { Naiwa.Audio.play('bubble'); dispatch('onPanelToggled', true); },
      onClose: () => { dispatch('onPanelToggled', false); },
      onCopied: () => { Naiwa.Audio.play('pop'); toast('已复制'); },
      onNoteAdded: () => { Naiwa.Audio.play('pop'); },
      onNoteDone: () => { Naiwa.Audio.play('done'); },
      onToast: (t) => toast(t),
    });

    // 2. 奶蛙本体
    await Naiwa.Pet.init();

    // 3. 读回上次的模式
    let saved = 'relax';
    try {
      saved = (await window.naiwa.getMode()) || 'relax';
    } catch { /* 主进程还没就绪，用默认值 */ }
    await applyMode(saved, { announce: false });

    // 4. 事件
    bindMouse();
    bindMenu();
    startIdleWatch();

    // 5. 主进程推送
    window.naiwa.onCursor(({ x, y }) => {
      if (dragging) return;                 // 拖拽期间不做命中切换
      updateClickThrough(x, y);
      closeMenuIfPointerAway(x, y);
      Naiwa.Pet.lookAt(x, y);
      markIfHoveringPet(x, y);
      // 穿透状态下前端收不到 mousemove，光标推送是模式层感知「鼠标移过来」的
      // 唯一来源。真实的 mousemove 也会派发同一个事件，
      // 所以模式层的 onPointerMove 必须写成幂等的。
      dispatch('onPointerMove', x, y);
    });

    window.naiwa.onCpu((v) => {
      cpuValue = v;
      Naiwa.Panels.setCpu(v);               // 面板底部的实时徽标
      dispatch('onCpu', v);
    });

    window.naiwa.onModeChanged((m) => {
      // 托盘菜单切模式时同步界面，不要再回写一遍，否则会和主进程来回打架
      if (m !== curMode) applyMode(m, { announce: false, silent: true });
    });

    // 6. 首次同步穿透状态。默认整窗穿透，等光标位置进来再修正。
    window.naiwa.setClickThrough(true);
    clickThrough = true;

    // 7. 预热音频（部分环境需要一次用户交互才能出声）
    document.addEventListener('pointerdown', function once() {
      Naiwa.Audio.warmup();
      document.removeEventListener('pointerdown', once);
    }, { once: true });

    toast('右键菜单 · 双击右键切模式', 2600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 暴露一点点能力给面板 / 冒烟测试 / 调试用
  Naiwa.App = {
    toast,
    applyMode,
    switchMode,
    ctx,
    openMenu,
    closeMenu,
    get menuOpen() { return menuOpen; },
    get mode() { return curMode; },
    get cpu() { return cpuValue; },
    get currentModeId() { return curMod && curMod.id; },
  };
})();