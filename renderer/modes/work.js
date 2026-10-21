'use strict';
/**
 * 工作模式  ← 🅱 的文件
 *
 * ═══════════════════════════════════════════════════════════════
 *  一句话目标
 * ═══════════════════════════════════════════════════════════════
 *  一只安静的桌面助手：点它弹出一个面板，里面能记便签待办、能翻剪贴板历史；
 *  电脑忙起来它会整只换成一张「累瘫」的图。
 *
 *  **待机状态不做任何动作**——就是一张静态图，不开循环动画、不做呼吸摇摆。
 *
 * ═══════════════════════════════════════════════════════════════
 *  状态机（只有一个状态是可变的：流汗）
 * ═══════════════════════════════════════════════════════════════
 *
 *        ┌───────────────────────────────┐
 *        │  静态待机 idle_work（一张图）   │
 *        └───┬───────────────────────┬───┘
 *            │ 点击                   │ CPU ≥ 75
 *            ▼                       ▼
 *      ┌──────────┐           ┌──────────────┐
 *      │ 面板开合  │           │  sweat 状态图 │
 *      │（独立）   │           │ （换基础图）  │
 *      └──────────┘           └──────┬───────┘
 *                                    │ CPU ≤ 62
 *                                    ▼（换回待机）
 *
 *  面板与状态图**互相独立**：面板开着的时候 CPU 飙高，照样换图。
 *  没有打盹状态——原方案的 `zzz` 已取消，`onIdleTick` 故意留空。
 *
 * ═══════════════════════════════════════════════════════════════
 *  三个容易踩的坑（都已在实现里处理）
 * ═══════════════════════════════════════════════════════════════
 *  1. **`ctx.pet.has()` 是异步的**，而且它会「真的去挂载」来确认素材可用。
 *     不 await 直接判真假的话，`Promise` 恒为真 → 素材没就位时会把画风差很远的
 *     占位卡通蛙挂上去。这里的做法：`await has('sweat')` 为假就**只播音效 + 冒台词**，
 *     完全不碰基础图。
 *  2. **`playLoop` 的语义是「进入一个持续状态」**，循环动画和静态姿势都用它，
 *     都由 `stopLoop()` 结束。流汗用的就是后者（整只换成另一张静态图）。
 *  3. **CPU 阈值必须留滞回区间**（≥75 开 / ≤62 关）。单阈值会让奶蛙在阈值附近
 *     疯狂来回切图，看起来像 bug。
 *
 * 接口规格见 docs/00-协作约定.md 第 3、4 节，行为规格见 docs/02-工作模式.md。
 *
 * 文件边界（见 00-协作约定.md 第 2 节）：
 *   ✅ 你拥有  renderer/modes/work.js · work.css · panels.js
 *              assets/manifest.work.js · assets/work/**
 *   ❌ 别碰    renderer/core/** · app.js · modes/relax.* · renderer/index.html
 *              assets/manifest.js · manifest.relax.js · assets/relax/**
 *              main.js · preload.js
 */

window.Naiwa = window.Naiwa || {};
window.Naiwa.Modes = window.Naiwa.Modes || {};

(function () {
  'use strict';

  /**
   * 可调参数。这些值是拍脑袋定的起点，不是真理，实际看效果再调。
   */
  const CONFIG = {
    // CPU 流汗（滞回阈值，必须留滞后区间，否则奶蛙会在阈值附近疯狂来回切图）
    CPU_ON: 75,               // ≥ 这个值换成流汗状态图
    CPU_OFF: 62,              // ≤ 这个值换回来（必须低于 CPU_ON）

    // 面板
    CLIP_PREVIEW_LINES: 3,    // 剪贴板条目最多显示几行
    NOTES_VIRTUALIZE_AT: 200, // 便签超过多少条时提示归档 + 分片渲染

    // 台词
    HEAT_LINE: '电脑好烫…',
    HEAT_LINE_MS: 2200,
    FIRST_OPEN_LINE: '记点什么吧～',
    FIRST_OPEN_LINE_MS: 1600,

    // 勾选待办后的正反馈：复用解压模式的大笑素材（零额外素材成本）
    //
    // ⚠️ 用 **laugh_short** 而不是 laugh。laugh 现在是源片**整段 15.4 秒**，
    // 而本模式在 `ctx.pet.isReacting()` 为真时会忽略点击（见下面的 onClick 守卫），
    // 用整段的话勾一个待办会让奶蛙**十几秒点不开面板**。
    // laugh_short 是同一批 PNG 的第 27~53 帧（1.8 秒），正好是「笑一下」。
    // 声明见 assets/manifest.relax.js。
    //
    // 注：NOTE_DONE_MS 对序列帧**无效**——frames 的时长由 count/fps 决定
    // （core/pet.js 里素材自带时长优先于 opts.duration），这里留着只作为
    // 素材缺失、退回占位奶蛙时的兜底。
    NOTE_DONE_ANIM: 'laugh_short',
    NOTE_DONE_MS: 1200,
  };

  /** 核心层注入的服务句柄。见 docs/00-协作约定.md 第 4 节。 */
  let ctx = null;

  // ───────────────────────── 状态 ─────────────────────────

  /** 逻辑上「电脑在忙」。**它是滞回状态机的当前态，不等于「画面上挂着 sweat」**。 */
  let hot = false;

  /**
   * sweat 素材是否真的可用。三态：
   *   null = 还没查过（第一次 CPU 飙高或 activate 时查）
   *   true / false = 查过的结果（`has()` 会顺带完成挂载，等于预热）
   */
  let sweatUsable = null;

  /**
   * 取消令牌（单调递增）。
   *
   * `has()` 和 `playLoop()` 都是异步的，await 期间可能：CPU 又降下来了、用户切模式了。
   * 每次「进出热态」「切模式」都 bump 一次，异步流程回来时比对，不一致就收手——
   * 否则会出现「已经切到解压模式了，这边还把 sweat 挂上去」。
   */
  let heatSeq = 0;

  let panelOpen = false;
  let greeted = false;              // 本次进入工作模式后是否已经给过引导
  let suppressCloseSound = false;   // 切模式收面板时不要「啵」一声
  let offNoteDone = null;           // 面板事件退订函数

  // ───────────────────────── 小工具 ─────────────────────────

  /** 吃掉一个 Promise 的 rejection：表现层理论上不 reject，但绝不能让它变成未捕获异常。 */
  function swallow(p) {
    if (p && typeof p.catch === 'function') {
      p.catch((e) => console.error('[work] 异步调用失败：', e));
    }
  }

  /**
   * 查 sweat 素材是否真的可用（结果缓存）。
   *
   * ⚠️ **必须 await。** `ctx.pet.has()` 是异步的：它要确认素材真的挂载成功，
   * 而不是只看清单里声明了没有——路径写错时只看声明会把画风完全不同的
   * 占位卡通蛙当真素材挂上去，正是最该避免的事。
   * 副作用是顺带完成挂载（等于预热），所以后面 playLoop 是瞬时的。
   */
  async function hasSweat() {
    if (sweatUsable !== null) return sweatUsable;
    try {
      sweatUsable = await ctx.pet.has('sweat');
    } catch (e) {
      console.error('[work] 检查 sweat 素材时出错，按「没有素材」处理：', e);
      sweatUsable = false;
    }
    return sweatUsable;
  }

  // ───────────────────────── CPU → 流汗状态图 ─────────────────────────

  /**
   * 进入「忙」状态：换图 + 滴一声 + 冒一句台词。
   *
   * 素材没就位时的降级：`has('sweat')` 为假就**不要**调 playLoop——那会挂上
   * 画风差很远的占位卡通蛙。退化成「只播音效 + 冒台词」即可。
   */
  async function enterHot() {
    const seq = ++heatSeq;
    try {
      ctx.audio.play('drip');
      ctx.pet.say(CONFIG.HEAT_LINE, CONFIG.HEAT_LINE_MS);

      if (!(await hasSweat())) {
        ctx.log('CPU 高，但没有 sweat 素材 —— 只播提示音和台词，不挂占位奶蛙');
        return;
      }
      // await 期间可能已经降温、或者切了模式，两种都得收手
      if (seq !== heatSeq || !hot || !ctx) return;

      // 正在做一次性反应（拖拽 / 勾选待办时的大笑）时不要抢基础图；
      // 反正下一拍（≤2 秒）的自愈会把它挂上去，不会一直漏着。
      if (ctx.pet.isReacting()) return;

      await ctx.pet.playLoop('sweat');   // 「进入持续状态」：整只换成流汗状态图
      ctx.log('CPU 高 → 换成流汗状态图');
    } catch (e) {
      console.error('[work] 进入流汗状态失败：', e);
    }
  }

  /**
   * 退出「忙」状态：换回静态待机。
   *
   * ⚠️ `deactivate()` 里也必须调一次（见那边的说明），否则切到解压模式后
   * 还挂着这张流汗图。
   */
  function exitHot() {
    heatSeq++;   // 让挂起中的 enterHot 在 await 之后收手
    if (!ctx) return;
    // 正在做一次性反应（拖拽 / 勾选待办时的大笑）时不要抢基础图：
    // 那会把动画切掉；反应结束时表现层自己会回待机。
    if (ctx.pet.isReacting()) return;
    ctx.pet.stopLoop();                    // 换回本模式的静态待机
    ctx.log('CPU 降下来 → 回到静态待机');
  }

  /**
   * 自愈：确认热态仍然画在屏幕上。
   *
   * 有几个会把基础图顶掉的路径（拖拽的 drag 姿势、勾选待办时的大笑），
   * 它们结束后表现层回的是**静态待机**而不是 sweat。如果这时 CPU 仍然高，
   * 每隔 2 秒的那一拍就把 sweat 重新挂回去——playLoop 是幂等的，
   * 已经挂着 sweat 时等于空操作。
   */
  function reassertHot() {
    if (!ctx || sweatUsable !== true) return;
    if (ctx.pet.isReacting()) return;      // 反应进行中不抢
    swallow(ctx.pet.playLoop('sweat'));
  }

  // ───────────────────────── 模式模块 ─────────────────────────

  window.Naiwa.Modes.work = {
    id: 'work',
    label: '工作模式',

    // ──────── 生命周期 ────────

    /**
     * 切换到本模式时调用。核心层会 await 这个函数，所以里面可以放心做素材加载。
     */
    async activate(c) {
      ctx = c;
      hot = false;                 // 每次进来都从静态待机开始，热态由 onCpu 重新判
      sweatUsable = null;
      greeted = false;
      panelOpen = c.panel.isOpen();
      suppressCloseSound = false;
      const seq = ++heatSeq;       // 作废上一个模式留下的挂起流程

      // 面板 → 模式的通知。勾选完成时让奶蛙笑一下：
      // 这是让「待办」这件事和「桌宠」产生联系的关键，没有它就是个普通记事本。
      // （音效由核心层的 onNoteDone 钩子播，这里只负责动作。）
      if (offNoteDone) { offNoteDone(); offNoteDone = null; }
      if (window.Naiwa.Panels && typeof window.Naiwa.Panels.on === 'function') {
        offNoteDone = window.Naiwa.Panels.on('noteDone', () => {
          if (!ctx || ctx.pet.isReacting()) return;
          swallow(ctx.pet.playOnce(CONFIG.NOTE_DONE_ANIM, {
            duration: CONFIG.NOTE_DONE_MS,
            onEnd: () => { if (hot) reassertHot(); },   // 笑完如果还热着，把流汗图挂回去
          }));
        });
      }

      // 面板的分片渲染阈值 / 预览行数由这里下发，保证 CONFIG 是唯一的事实来源
      if (window.Naiwa.Panels && typeof window.Naiwa.Panels.configure === 'function') {
        window.Naiwa.Panels.configure({
          virtualizeAt: CONFIG.NOTES_VIRTUALIZE_AT,
          previewLines: CONFIG.CLIP_PREVIEW_LINES,
          cpuOn: CONFIG.CPU_ON,        // 面板底部那个徽标变色的阈值也跟着这份 CONFIG
        });
      }

      await c.pet.setIdle();       // 静态待机图（idle_work；没素材时回落到 idle_relax）

      // 预热：勾选待办要用的**短版**大笑 + 确认 sweat 素材
      await c.pet.preload([CONFIG.NOTE_DONE_ANIM]);
      const ok = await c.pet.has('sweat');
      if (seq !== heatSeq) return; // 挂载期间被切走了
      sweatUsable = ok;
      c.log(ok ? `素材就绪：idle_work / sweat / ${CONFIG.NOTE_DONE_ANIM}`
               : `没有可用的 sweat 素材：CPU 高时只播提示音 + 台词（不会挂占位奶蛙）`);
    },

    /**
     * 离开本模式时调用。
     *
     * ⚠️ **必须是同步的，而且必须清理干净**（疯狂右键来回切模式下，任何残留都会
     * 让两个模式的行为叠在一起）：
     *   · 作废挂起中的异步流程（热态切换、素材检查）
     *   · `ctx.pet.stopLoop()` —— CPU 高位时切走，流汗状态图必须复位
     *   · 面板如果开着，显式收起（不依赖核心层的兜底），并且不要发出声音
     */
    deactivate() {
      heatSeq++;                   // 让挂起中的 enterHot / has() 在 await 后收手
      hot = false;
      greeted = false;
      if (offNoteDone) { offNoteDone(); offNoteDone = null; }

      if (!ctx) return;

      // 勾选待办的大笑播到一半也要收掉（setIdle 本身就会取消一次性反应）
      if (ctx.pet.isReacting()) swallow(ctx.pet.setIdle());
      ctx.pet.stopLoop();                            // 流汗状态图复位（幂等）
      ctx.log('离开工作模式：状态图复位、面板收起');

      // 核心层切到解压模式时也会关面板，但别依赖别人的兜底。
      // 这里关面板不播「啵」——切模式本来就有 chime + toast，再叠一声很吵。
      suppressCloseSound = true;
      try {
        ctx.panel.close();
      } finally {
        suppressCloseSound = false;
      }
      panelOpen = false;
    },

    // ──────── 事件（全部可选，不实现就不分发） ────────

    /**
     * 左键点击奶蛙。拖拽已在核心层过滤掉，这里收到的都是纯点击。
     *
     * 开合面板的音效分工：
     *   · 展开 → 核心层的 onOpen 钩子已经播了 bubble，这里不重复播
     *   · 收起 → 由 onPanelToggled(false) 统一播 pop（点奶蛙、面板上的 ✕ 都走那条路）
     */
    onClick() {
      if (!ctx) return;
      try {
        if (ctx.panel.isOpen()) ctx.panel.close();
        else swallow(ctx.panel.open());
      } catch (e) {
        console.error('[work] 开合面板失败：', e);
      }
    },

    /**
     * 鼠标在窗口内移动。
     *
     * ⚠️ 这个事件会被派发两次（真实 mousemove + 主进程的光标推送），任何实现
     * 都必须幂等。工作模式不需要对鼠标做任何事——待机就该安静，所以是空实现。
     */
    onPointerMove() { /* 工作模式不跟随鼠标做任何动作 */ },

    /**
     * CPU 占用变化，约每 2 秒一次。0~100。
     *
     * 滞回：`hot` 只在自己那一侧翻转，中间那 13 个点里维持原状态。
     * 这样负载在 75 附近抖动时奶蛙不会疯狂来回切图。
     */
    onCpu(c, percent) {
      if (!ctx) return;
      const p = Number(percent);
      if (!isFinite(p)) return;

      const was = hot;
      hot = was ? p > CONFIG.CPU_OFF : p >= CONFIG.CPU_ON;

      if (hot !== was) {
        if (hot) swallow(enterHot());
        else exitHot();
        return;
      }
      if (hot) reassertHot();      // 自愈，见函数说明
    },

    /**
     * 空闲心跳，每 5 秒一次。idleMs = 距上次交互的毫秒数。
     *
     * 本模式**不需要实现**——打盹功能已取消（见 docs/02-工作模式.md 第 4.6 节）。
     * 留着空壳只是保持签名齐全，将来想加回来随时能加。
     */
    onIdleTick(c, idleMs) { /* 打盹已取消 */ },

    /**
     * 面板开合变化。
     *
     * 核心层在面板真正开合时各派发一次（`element.hidden` 变化的那一次）。
     * 这里用它做两件事：首次展开给个引导、收起时播 pop 音效。
     */
    onPanelToggled(c, isOpen) {
      const next = !!isOpen;
      if (next === panelOpen) return;    // 幂等：重复通知不重复响
      panelOpen = next;

      if (panelOpen) {
        if (!greeted) {
          greeted = true;
          c.pet.say(CONFIG.FIRST_OPEN_LINE, CONFIG.FIRST_OPEN_LINE_MS);
        }
      } else if (!suppressCloseSound) {
        c.audio.play('pop');
      }
    },

    // ──────── 元信息 ────────

    /**
     * 本模式用到的素材槽位名，供自检工具核对。
     *
     * `laugh_short`（短版大笑）是解压模式声明的素材，这里**有意复用**：
     * 勾选待办时让奶蛙笑一下，零额外素材成本，也是让「待办」和「桌宠」
     * 产生联系的关键正反馈。它没就位时只会退化成占位奶蛙的大笑，不影响面板功能。
     *
     * ⚠️ 特意**不用** `laugh`（整段 15.4 秒）——本模式在反应进行中会忽略点击，
     * 用整段会让奶蛙十几秒点不开面板。详见 CONFIG.NOTE_DONE_ANIM 那段注释。
     */
    assetSlots: ['idle_work', 'sweat', 'laugh_short'],

    /** 只读调试信息（冒烟测试 / 排查用，不参与业务）。 */
    get config() { return CONFIG; },
    get state() {
      return { hot, sweatUsable, panelOpen, greeted };
    },
  };
})();