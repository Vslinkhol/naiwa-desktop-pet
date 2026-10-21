'use strict';
/**
 * 奶蛙表现层（共享层 · 冻结）
 *
 * 只管「奶蛙长什么样、在做什么动作」，不关心为什么——那是各模式模块的事。
 *
 * ═══════════════════════════════════════════════════════════════
 *  分层
 * ═══════════════════════════════════════════════════════════════
 *   基础层  idle_relax / idle_work / laugh / laugh_hard / drag
 *           同一时刻只显示一个，用透明度交叉淡入，避免硬切闪烁
 *   特效层  sweat / zzz
 *           独立叠加在基础层之上，可与任何基础动画同时存在
 *   分身层  连点时的 2 个分身，由 performWithClones 管理，平时是空的
 *
 * ═══════════════════════════════════════════════════════════════
 *  两种「正在表演」的状态
 * ═══════════════════════════════════════════════════════════════
 *   reacting    一次性反应（playOnce）进行中
 *   cloneState  分身表演（performWithClones）进行中
 *   isReacting() 是两者之一。模式层用它决定「现在要不要忽略点击」。
 *
 * 素材是懒加载的：先挂待机图保证启动快，其余在后台预热，
 * 这样第一次点击也不会因为加载而卡一下。
 */

window.Naiwa = window.Naiwa || {};

Naiwa.Pet = (function () {

  const IDLE = { relax: 'idle_relax', work: 'idle_work' };
  const OVERLAY_NAMES = ['sweat', 'zzz'];

  /** 素材没写 duration 时的兜底时长（毫秒） */
  const FALLBACK_DURATION = { laugh: 1500, laugh_hard: 2000 };

  /** 分身「从中心散开」的出现时长（毫秒），对应 01-解压模式.md 第 4.3 节的阶段 ① */
  const CLONE_APPEAR_MS = 140;

  let root = null, baseEl = null, fxEl = null, cloneEl = null, bubbleEl = null;

  const bases = {};      // name -> { holder, handle }
  const overlays = {};   // name -> { holder, handle }
  let cloneCache = { name: null, entries: [] };

  let mode = 'relax';
  let current = null;        // 当前基础动画名
  let reacting = false;      // 一次性反应中
  let reactTimer = null;
  let reactEndCb = null;
  let loopName = null;       // 正在循环的基础动画名
  let bubbleTimer = null;
  let blinkTimer = null;
  let cloneState = null;     // { timers: [], entries: [] }

  // ── 取消令牌（epoch） ──
  //
  // 异步流程在 await 期间可能被切模式、或被新的表演顶掉。而清理逻辑只认
  // 「表演建立之后」才存在的句柄（cloneState / loopName），挂载却发生在句柄
  // 建立**之前**——那段时间里清理是空操作，表演却会继续跑完。
  // 表现就是「已经切到工作模式了，奶蛙还在演解压模式的分身大笑」。
  //
  // 所以每个异步流程开头的记下当前世代，await 之后再比对一次；清理动作负责 bump。
  let cloneEpoch = 0;
  let loopEpoch = 0;

  // ───────────────────────── 初始化 ─────────────────────────

  function makeHolder(animName, parent) {
    const h = document.createElement('div');
    h.style.position = 'absolute';
    h.style.inset = '0';
    h.style.opacity = '0';
    h.style.transition = 'opacity 0.12s linear';
    h.dataset.anim = animName;
    parent.appendChild(h);
    return h;
  }

  function bindLook(handle) {
    // 只有内置占位奶蛙支持瞳孔跟随；真实素材的视线是画在素材里的
    if (handle.isPlaceholder) handle.pupils = handle.element.querySelector('.ph-pupils');
  }

  async function ensureBase(name) {
    if (bases[name]) return bases[name];
    const holder = makeHolder(name, baseEl);
    const handle = await Naiwa.Assets.mount(holder, name);
    bindLook(handle);
    bases[name] = { holder, handle };
    return bases[name];
  }

  async function ensureOverlay(name) {
    if (overlays[name]) return overlays[name];
    const holder = makeHolder(name, fxEl);
    const handle = await Naiwa.Assets.mount(holder, name, 'overlay');
    overlays[name] = { holder, handle };
    return overlays[name];
  }

  /**
   * 待机动画该用哪一张图。
   *
   * ASSETS.md 第 2.1 节承诺「`idle_work` 没提供时会复用 `idle_relax`」——
   * 这个回落必须在这里做。素材层只知道 `idle_work` 是 kind:'none'，
   * 它会退回占位奶蛙，而占位奶蛙和真实素材画风差得很远，
   * 切模式时突然换一只卡通蛙会很突兀。
   *
   * 顺序：本模式自己的待机图 → 共享待机图 → 占位奶蛙（它自己区分两种姿势）。
   */
  function idleName(m) {
    const want = IDLE[m] || IDLE.relax;
    if (Naiwa.Assets.has(want)) return want;
    if (want !== IDLE.relax && Naiwa.Assets.has(IDLE.relax)) return IDLE.relax;
    return want;
  }

  async function init() {
    root = document.getElementById('pet');
    baseEl = document.getElementById('pet-base');
    fxEl = document.getElementById('pet-fx');
    cloneEl = document.getElementById('pet-clones');
    bubbleEl = document.getElementById('pet-bubble');

    if (!root || !baseEl || !fxEl) throw new Error('index.html 缺少 #pet / #pet-base / #pet-fx');

    // 关键路径：待机图必须立刻可用
    await Promise.all([...new Set([idleName('relax'), idleName('work')])].map((n) => ensureBase(n)));
    await switchTo(idleName(mode), /* force */ true);
    scheduleBlink();

    // 其余素材后台预热，不阻塞启动
    setTimeout(() => {
      if (Naiwa.Assets.has('laugh')) ensureBase('laugh').catch(() => {});
      if (Naiwa.Assets.has('laugh_hard')) ensureBase('laugh_hard').catch(() => {});
      if (Naiwa.Assets.has('drag')) ensureBase('drag').catch(() => {});
      OVERLAY_NAMES.forEach((n) => {
        if (Naiwa.Assets.has(n, 'overlay')) ensureOverlay(n).catch(() => {});
      });
    }, 1200);
  }

  // ───────────────────────── 基础动画切换 ─────────────────────────

  /** 只负责「把某张基础素材显示出来」，不碰循环 / 反应状态。 */
  async function switchTo(name, force) {
    if (current === name && !force) {
      const e = bases[name];
      if (e) { e.holder.style.opacity = '1'; e.handle.play(name); }
      return;
    }

    const entry = await ensureBase(name);

    if (current && bases[current] && current !== name) {
      const old = bases[current];
      old.holder.style.opacity = '0';
      old.handle.stop();
    }

    entry.holder.style.opacity = '1';
    entry.handle.play(name);
    current = name;
  }

  /** 回到静态待机（只切基础层，不动别的状态）。 */
  function returnToIdle() {
    return switchTo(idleName(mode));
  }

  /**
   * 切回静态待机图。
   *
   * 这是「清理」语义：会停掉循环、取消分身表演、结束进行中的一次性反应。
   * 模式切换和 deactivate() 都靠它保证不留残影。
   */
  async function setIdle(newMode) {
    if (newMode) mode = newMode === 'work' ? 'work' : 'relax';
    cancelClones();
    clearTimeout(reactTimer);
    reactTimer = null;
    reactEndCb = null;
    reacting = false;
    loopName = null;
    return returnToIdle();
  }

  // ───────────────────────── 一次性反应 ─────────────────────────

  /**
   * 播放一次性反应，播完自动回静态待机。
   *
   * @param name  'laugh' | 'laugh_hard' | 'drag' …
   * @param opts  { duration, hold, sticky, onEnd }
   *              duration 覆盖素材自带时长
   *              hold     播完后再多停一会儿
   *              sticky   true 表示不自动结束，需手动 setIdle()（拖拽用）
   * @returns     预计总时长（毫秒）
   */
  async function playOnce(name, opts) {
    opts = opts || {};
    const entry = await ensureBase(name);

    clearTimeout(reactTimer);
    reacting = true;
    reactEndCb = opts.onEnd || null;
    loopName = null;

    if (current && bases[current] && current !== name) {
      const old = bases[current];
      old.holder.style.opacity = '0';
      old.handle.stop();
    }

    entry.holder.style.opacity = '1';
    entry.handle.onEnd(() => finishReact());
    entry.handle.play(name);
    current = name;

    if (opts.sticky) return 0;   // 由外部决定何时结束

    const own = entry.handle.duration || 0;
    const dur = own || opts.duration || FALLBACK_DURATION[name] || 1500;
    const total = dur + (opts.hold || 0);

    reactTimer = setTimeout(finishReact, total + 60);
    return total;
  }

  function finishReact() {
    if (!reacting) return undefined;
    reacting = false;
    clearTimeout(reactTimer);
    reactTimer = null;

    const cb = reactEndCb;
    reactEndCb = null;

    return returnToIdle().then(() => { if (cb) cb(); });
  }

  /** 旧接口，保留给外壳层（拖拽结束）用。 */
  function endReact() {
    if (reacting) finishReact();
  }

  // ───────────────────────── 循环状态 ─────────────────────────

  /**
   * 播放循环状态（跑步这类），一直播到自己调 stopLoop()。
   * 素材本身在清单里是 loop 的，这里只负责「显示哪一个」。
   */
  async function playLoop(name) {
    cancelClones();
    const myEpoch = ++loopEpoch;
    loopName = name;          // 先占位：这样 await 期间 stopLoop() 才拦得住
    const entry = await ensureBase(name);

    // 挂载期间被 stopLoop() 取消（切模式会走到那儿）→ 别再切过去，
    // 否则新模式里会永久挂着这个循环状态，直到下一次 setIdle。
    if (myEpoch !== loopEpoch) return entry;

    await switchTo(name);
    return entry;
  }

  /**
   * 停止循环状态，回静态待机。
   * 位移的归位由调用方负责——只有它知道位移加在了哪个元素上。
   */
  function stopLoop() {
    loopEpoch++;              // 让挂起中的 playLoop 失效
    if (!loopName) return undefined;
    const entry = bases[loopName];
    if (entry) entry.handle.stop();
    loopName = null;
    return returnToIdle();
  }

  // ───────────────────────── 分身同步表演 ⭐ ─────────────────────────

  /**
   * 准备（或复用）分身容器。每个分身是一块独立的 canvas，
   * 但**由同一个 rAF 循环和同一套帧计算驱动**——这是「严格同帧」的关键。
   */
  async function ensureClones(count, name) {
    if (!cloneEl) throw new Error('index.html 缺少 #pet-clones');

    if (cloneCache.name !== name) {
      destroyClones();
      cloneCache = { name, entries: [] };
    }

    while (cloneCache.entries.length < count) {
      const el = document.createElement('div');
      el.className = 'clone';
      cloneEl.appendChild(el);
      const handle = await Naiwa.Assets.mount(el, name);
      cloneCache.entries.push({ el, handle, anim: null, fadeAnim: null });
    }
    return cloneCache.entries.slice(0, count);
  }

  function destroyClones() {
    cloneCache.entries.forEach((e) => {
      try { e.handle.destroy(); } catch { /* 忽略 */ }
      e.el.remove();
    });
    cloneCache = { name: null, entries: [] };
  }

  /**
   * 撤掉一个分身上的两段动画。
   *
   * ⚠️ 这两段**必须分开存、一起撤**：
   * 「散开出现」那段带 `fill: 'forwards'`，它停在那儿才把分身固定在两侧。
   * 如果为了做淡出而先把出现动画 cancel 掉，分身会瞬间弹回中心（缩放的原始位置）
   * 才开始淡出——画面上就是消失前先往中间跳一下。淡出只动 opacity，
   * 和出现动画动的 transform 不是同一个属性，两者可以同时挂着互不干扰。
   */
  function stopCloneAnims(e) {
    [e.anim, e.fadeAnim].forEach((a) => {
      if (a) { try { a.cancel(); } catch { /* 已经结束了，忽略 */ } }
    });
    e.anim = null;
    e.fadeAnim = null;
  }

  /**
   * 立刻收场：清定时器、撤动画、把分身从 DOM 里摘掉。任何时刻调用都安全。
   *
   * 是「摘掉」而不是「销毁」：canvas 和帧数据留在 cloneCache 里，
   * 下次表演直接挂回去，省掉重新解码序列帧的几十毫秒——那段耗时正是
   * 「三个实例严格同帧」最怕的东西。
   */
  function cancelClones() {
    cloneEpoch++;   // 让挂起中的 performWithClones 在下一个 await 之后收手

    if (cloneState) {
      cloneState.timers.forEach(clearTimeout);
      cloneState.timers.length = 0;
      cloneState = null;
    }

    // ⚠️ DOM 清理**不能**挂在 cloneState 上。
    // ensureClones 会在 await 挂载期间就把 .clone 节点 appendChild 进去，
    // 那时 cloneState 还没建立；写成 `if (!cloneState) return` 会漏掉这些
    // 「半挂载」的节点，切模式后它们留在屏幕上把整场演完。
    // 节点缓存本身（canvas / 帧数据）不动，下次表演直接挂回去是瞬时的。
    cloneCache.entries.forEach((e) => {
      stopCloneAnims(e);
      e.handle.stop();
      e.el.style.opacity = '0';
      e.el.remove();
    });
  }

  /**
   * 分身同步表演 —— 解压模式连点专用。
   *
   * ═══════════════════════════════════════════════════════════════
   *  为什么三个实例能做到「严格同帧」
   * ═══════════════════════════════════════════════════════════════
   *  素材层把所有序列帧播放器挂在**同一个 requestAnimationFrame 循环**上
   *  （见 core/assets.js 的共享 ticker）：同一个 tick 里，每个播放器拿到的
   *  `now` 是同一个值。三个播放器都从 frame=0 / acc=0 出发，喂进同样的 `now`
   *  序列，算出来的帧号必然逐帧相同。
   *
   *  所以这里只要保证两件事：
   *    1. 三个素材**都已经加载完**（await 完再开演，播放时不能还有加载）
   *    2. 三个 play() 在**同一个同步块**里调用（中间不能有 await）
   *  做到这两点就是严格同帧，不存在几十毫秒的错位。
   */
  async function performWithClones(name, opts) {
    opts = opts || {};

    cancelClones();   // 不叠加：上一次还没收场就先收掉
    const myEpoch = cloneEpoch;   // 记下世代（cancelClones 刚 bump 过）

    const count   = opts.clones == null ? 2 : Math.max(0, opts.clones | 0);
    const spread  = opts.spread == null ? 0.85 : opts.spread;
    const scale   = opts.scale == null ? 0.82 : opts.scale;
    const opacity = opts.opacity == null ? 0.92 : opts.opacity;
    const fadeOut = opts.fadeOut == null ? 160 : opts.fadeOut;

    // ① 全部就绪后才开演。播放时再加载就会分出先后，同步立刻破功。
    const main = await ensureBase(name);
    const entries = await ensureClones(count, name);

    // ⚠️ 挂载期间可能被取消：用户切了模式，或者又触发了一次表演。
    // 首次表演要加载 52 张序列帧（冷盘可达数百毫秒），这里必须收手——
    // 否则整场表演会在**新模式里**从头演一遍。
    // 这是 cloneState 建立之前唯一的拦截点，光靠 cancelClones 清 DOM 不够。
    if (myEpoch !== cloneEpoch) {
      cancelClones();
      return 0;
    }

    // ② 顶掉可能正在进行的一次性大笑。
    //    不清的话，之前那次 playOnce 留下的「结束回调 + 兜底定时器」会在分身
    //    正笑到一半时触发，把主体拉回静态待机——画面上就是主体先停了，很突兀。
    clearTimeout(reactTimer);
    reactTimer = null;
    reactEndCb = null;
    reacting = false;
    if (typeof main.handle.onEnd === 'function') main.handle.onEnd(null);

    const boxW = root.offsetWidth || Naiwa.Assets.canvasSize.width;
    const offset = boxW * spread;

    // 主体先亮出来（但还没起播），让分身的出现有「主体站在原地」的参照
    if (current && bases[current] && current !== name) {
      const old = bases[current];
      old.holder.style.opacity = '0';
      old.handle.stop();
    }
    main.holder.style.opacity = '1';
    current = name;

    // ② 分身从中心散开 + 淡入
    entries.forEach((e, i) => {
      const dir = i % 2 === 0 ? -1 : 1;          // 左右各一
      const rank = Math.floor(i / 2) + 1;        // 超过两个时继续往外排
      const off = dir * offset * rank;

      // 从 cloneCache 里取出来的元素上一轮结束时已经摘掉了，这里挂回去。
      // 挂回去是瞬时的：canvas 和帧数据一直都在，不会重新解码。
      if (e.el.parentNode !== cloneEl) cloneEl.appendChild(e.el);
      stopCloneAnims(e);   // 上一轮的残留（正常路径已经在收场时撤过）

      e.home = `translate(-50%, -50%) translateX(${off}px) scale(${scale})`;
      e.el.style.opacity = '0';
      e.anim = e.el.animate(
        [
          { transform: 'translate(-50%, -50%) translateX(0px) scale(0.5)', opacity: 0 },
          { transform: e.home, opacity },
        ],
        { duration: CLONE_APPEAR_MS, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.25)', fill: 'forwards' }
      );
    });

    const laughMs = main.handle.duration || opts.duration || FALLBACK_DURATION[name] || 1500;
    const total = CLONE_APPEAR_MS + laughMs + fadeOut;

    cloneState = { timers: [], entries };
    const timers = cloneState.timers;

    // ③ 同步大笑：三个 play() 必须在同一个同步块里，中间不能有 await
    timers.push(setTimeout(() => {
      if (!cloneState) return;
      main.handle.play(name);
      entries.forEach((e) => e.handle.play(name));
    }, CLONE_APPEAR_MS));

    // ④ 分身淡出。只动 opacity，出现动画继续挂着把分身固定在两侧（见 stopCloneAnims 的说明）
    timers.push(setTimeout(() => {
      if (!cloneState) return;
      entries.forEach((e) => {
        e.fadeAnim = e.el.animate([{ opacity }, { opacity: 0 }],
          { duration: fadeOut, fill: 'forwards' });
      });
    }, CLONE_APPEAR_MS + laughMs));

    // ⑤ 收场：分身淡出并从 DOM 移除，主体回静态待机
    timers.push(setTimeout(() => {
      if (!cloneState) return;
      cloneState.entries.forEach((e) => {
        stopCloneAnims(e);
        e.handle.stop();
        e.el.style.opacity = '0';
        e.el.remove();
      });
      cloneState = null;
      returnToIdle().then(() => { if (opts.onEnd) opts.onEnd(); });
    }, total));

    return total;
  }

  // ───────────────────────── 特效叠加 ─────────────────────────

  async function setOverlay(name, on, opts) {
    if (OVERLAY_NAMES.indexOf(name) === -1) return;
    const entry = await ensureOverlay(name);
    entry.holder.style.opacity = on ? '1' : '0';
    if (on) entry.handle.play(name);
    else entry.handle.stop();
    if (on && opts && opts.once) {
      setTimeout(() => { entry.holder.style.opacity = '0'; entry.handle.stop(); }, opts.once);
    }
  }

  // ───────────────────────── 气泡台词 ─────────────────────────

  function say(text, ms) {
    if (!bubbleEl) return;
    clearTimeout(bubbleTimer);
    if (!text) { bubbleEl.hidden = true; return; }
    bubbleEl.textContent = text;
    bubbleEl.hidden = false;
    if (ms) bubbleTimer = setTimeout(() => { bubbleEl.hidden = true; }, ms);
  }

  // ───────────────────────── 眨眼 ─────────────────────────

  function scheduleBlink() {
    clearTimeout(blinkTimer);
    // 真人每分钟眨 15~20 次，这里再加一点随机，避免看起来像机器
    const wait = 1700 + Math.random() * 4300;
    blinkTimer = setTimeout(() => {
      doBlink();
      if (Math.random() < 0.22) setTimeout(doBlink, 190);   // 偶尔连眨两下
      scheduleBlink();
    }, wait);
  }

  function doBlink() {
    if (reacting || cloneState) return;      // 大笑时本来就眯着眼
    const entry = current && bases[current];
    if (!entry || !entry.handle.setBlink) return;
    entry.handle.setBlink(true);
    setTimeout(() => entry.handle.setBlink(false), 110);
  }

  // ───────────────────────── 视线跟随 ─────────────────────────

  /**
   * 视线跟随。传**客户端坐标**（和 mousemove 的 clientX/clientY 一致），
   * 内部按奶蛙自己的显示区归一化——这样奶蛙被跑步位移挪走后，
   * 视线仍然是相对它自己算的。
   */
  function lookAt(clientX, clientY) {
    const entry = current && bases[current];
    if (!entry || !entry.handle.pupils) return;
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height) return;

    const nx = (clientX - r.left) / r.width;
    const ny = (clientY - r.top) / r.height;
    const dx = Math.max(-1, Math.min(1, (nx - 0.5) * 2)) * 4.5;
    const dy = Math.max(-1, Math.min(1, (ny - 0.5) * 2)) * 3.2;
    entry.handle.pupils.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  }

  // ───────────────────────── 命中判定 ─────────────────────────

  /**
   * 判断屏幕坐标是否落在奶蛙身上。
   *
   * 默认是内切椭圆而不是矩形——用矩形的话，窗口四角的透明区域也会挡住
   * 桌面点击，用户会觉得「这软件怎么点不到桌面图标」。
   *
   * 命中形状优先取**当前基础动画槽位自己的 `hit`**，取不到才回落到共享清单里
   * 那一组。因为不同姿势的轮廓宽度能差很多（实测 idle_relax 152px / sweat 196px /
   * idle_work 262px），共用一组必然有一边「看得见点不到」。
   * 所以换基础图之后，命中区会在下一次求值时自动跟着切过去。
   *
   * 这里读的是 #pet 的 getBoundingClientRect()，而它**包含元素自身的 transform**，
   * 所以只要把跑步位移加在 #pet 上，命中区域就会跟着走。
   */
  function containsPoint(clientX, clientY) {
    if (!root) return false;
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height) return false;

    const h = Naiwa.Assets.hitRegion(current);

    if (h.type === 'rect') {
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    }

    const cx = r.left + r.width * h.x;
    const cy = r.top + r.height * h.y;
    const rx = r.width * h.rx;
    const ry = r.height * h.ry;
    const dx = (clientX - cx) / rx;
    const dy = (clientY - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }

  // ───────────────────────── 预热 ─────────────────────────

  /** 预加载动画。**同步播放前必须先调这个**，否则首次播放会有加载延迟导致不同步。 */
  async function preload(names) {
    const list = Array.isArray(names) ? names : [names];
    await Promise.all(list.map((n) => (
      OVERLAY_NAMES.indexOf(n) !== -1 ? ensureOverlay(n) : ensureBase(n)
    )));
  }

  return {
    init,
    setIdle,
    playOnce,
    playLoop,
    stopLoop,
    endReact,
    setOverlay,
    say,
    lookAt,
    containsPoint,
    preload,
    performWithClones,
    /** 某个槽位有没有真实素材（没有就是占位奶蛙）。 */
    /**
     * 某槽位有没有**真正可用**的素材（false = 会退回占位奶蛙）。
     *
     * ⚠️ **是异步的。** 只有尝试挂载之后才能知道结果：清单里声明了、但路径写错
     * 或文件损坏时，挂载会静默回落到占位奶蛙，这种情况必须返回 false。
     * 早期版本只看「清单里声明了没有」，于是路径写错时会把画风完全不同的
     * 占位卡通蛙当成真素材挂上去——正是最该避免的画风突变。
     *
     * 有副作用：会顺带完成挂载（等于预热），所以后面再 play 是瞬时的。
     */
    async has(name, layer) {
      if (!Naiwa.Assets.has(name, layer)) return false;
      try {
        const entry = layer === 'overlay' ? await ensureOverlay(name) : await ensureBase(name);
        return !entry.handle.isPlaceholder;
      } catch {
        return false;
      }
    },
    /**
     * 主体元素 #pet。
     *
     * 给模式层做「需要加在主体自己身上的位移」用的——跑步的左右移动必须加在
     * #pet 本身，不能加在内层容器上。因为命中判定读的是 #pet 的
     * getBoundingClientRect()，位移加在内层的话，奶蛙跑出去了、可点区域还留在
     * 原地，用户会发现点不到它。
     *
     * 这是相对 00-协作约定.md 第 4 节新增的一个能力，已写进交接文档。
     */
    root() { return root; },
    get isReacting() { return reacting || !!cloneState; },
    get isLooping() { return !!loopName; },
    get mode() { return mode; },
    get currentAnim() { return current; },
  };
})();