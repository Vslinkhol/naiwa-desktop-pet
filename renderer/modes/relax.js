'use strict';
/**
 * 解压模式  ← 🅰 的文件
 *
 * ═══════════════════════════════════════════════════════════════
 *  一句话目标
 * ═══════════════════════════════════════════════════════════════
 *  一只会陪你玩的小奶蛙：点它会捧腹大笑，狂点会分裂出两个分身一起笑，
 *  长时间不理它，它会自己跑起来。
 *
 *  **待机状态不做任何动作**——就是一张静态图，安静地待着。
 *
 * ═══════════════════════════════════════════════════════════════
 *  状态机（优先级：cloning > running > laughing > static）
 * ═══════════════════════════════════════════════════════════════
 *
 *      ┌──────────────────────────────────────────┐
 *      │                                          │
 *      ▼                                          │
 *  ┌─────────┐   点击（冷却 240ms 后）   ┌──────────┴───┐
 *  │ static  │ ───────────────────────→ │  laughing    │
 *  │ 静态待机 │                          │  一次性大笑   │
 *  └────┬────┘ ←─────────────────────── └──────────────┘
 *       │              播完自动回                     ▲
 *       │                                           │ 连点 ≥4
 *       │  连点 ≥4                                  │
 *       ├──────────────────→ ┌───────────┐ ─────────┘
 *       │                    │  cloning  │
 *       │                    │ 分身同步笑 │
 *       │                    └─────┬─────┘
 *       │                    播完 + 3s 冷却
 *       │                          │
 *       │                          ▼
 *       │                     （回 static）
 *       │
 *       │  空闲 ≥60s
 *       ▼
 *  ┌──────────┐   点击 / 鼠标移入 / 切模式
 *  │ running  │ ─────────────────────────────→ 平滑归位 → static
 *  │  跑步循环 │                                （点击的话归位后立即大笑）
 *  └──────────┘
 *
 * ═══════════════════════════════════════════════════════════════
 *  两个关键实现点
 * ═══════════════════════════════════════════════════════════════
 *  1. 分身的「严格同帧」在 core/pet.js 的 performWithClones 里保证：
 *     三个实例共用一个 rAF 和同一套帧计算，且三个 play() 在同一个同步块里调用。
 *     本文件只负责把素材预热好，别在播放路径上做异步的事。
 *
 *  2. 跑步位移用 Web Animations API 而不是 CSS animation，
 *     因为需要能「暂停并读出当前位移」才能平滑归位（见 stopRun）。
 *     而且位移必须加在 #pet **本身**：命中判定读的是它的
 *     getBoundingClientRect()，那个 API 会算上元素自身的 transform。
 */

window.Naiwa = window.Naiwa || {};
window.Naiwa.Modes = window.Naiwa.Modes || {};

(function () {
  'use strict';

  /**
   * 可调参数，集中管理。
   *
   * **这些值都是拍脑袋定的起点，不是真理。** 做成真实素材后要实际看效果调整——
   * 尤其 CLONE_THRESHOLD（点几下才出分身）和 RUN_IDLE_MS（多久才跑起来），
   * 这两个直接决定手感。
   */
  const CONFIG = {
    // 点击大笑
    CLICK_COOLDOWN: 240,        // ms，两次触发的最小间隔
    LAUGH_FALLBACK_MS: 1500,    // 素材没写时长时的兜底

    // 连点分身
    CLONE_WINDOW: 2600,         // ms，连点统计窗口
    CLONE_THRESHOLD: 4,         // 触发分身的点击数
    CLONE_COOLDOWN: 3000,       // ms，表演后的冷却
    CLONE_COUNT: 2,
    CLONE_SPREAD: 0.85,         // 相对主体宽度的横向展开
    CLONE_SCALE: 0.82,
    CLONE_OPACITY: 0.92,
    CLONE_FADE_OUT: 160,        // ms

    // ─────────────────────────────────────────────────────────
    // 跑步 —— ⏸ **已暂时取消**（见 docs/01-解压模式.md 第 3.3 节）
    //
    // 为什么取消：手上没有可用的跑步素材。那个 `解压模式久不操作.gif` 在**构图**上
    // 是「跑远」而不是「原地跑」——实测奶蛙占画面比例从 7.6% 崩到 0.5%（约 15 倍），
    // 中间还跑出画幅一次；背景又是实拍公路，没有纯色可抠。可循环的精灵硬性要求
    // 主体原地、等大，这条素材做不到。
    //
    // ⚠️ 代码**故意保留**（项目没有版本控制，删了就找不回来了）。
    //    恢复只需两步，不用改代码：
    //      ① 把下面的 RUN_ENABLED 改成 true
    //      ② 在 assets/manifest.relax.js 里声明 run 槽位
    // ─────────────────────────────────────────────────────────
    RUN_ENABLED: false,         // ← 唯一的开关

    RUN_IDLE_MS: 60000,         // 空闲多久触发
    RUN_RANGE: 80,              // px，往返幅度
    RUN_CYCLE: 3200,            // ms，单程时长
    RUN_RETURN: 250,            // ms，归位过渡

    // 没有 run 素材时的替代表现（见下方 startRun 的说明）
    HOP_HEIGHT: 9,              // px，起伏幅度
    HOP_PER_TRIP: 4,            // 单程里起伏几次

    // ─────────────────────────────────────────────────────────
    // 台词
    //
    // 闲置自动自言自语 —— ⏸ **已取消**（用户要求，2026-10）
    //
    // 原设计：闲置满 IDLE_LINE_MIN_MS 之后，每次空闲心跳有 IDLE_LINE_CHANCE
    // 的概率自己冒一句 MOOD_LINES，用来制造「它还活着」的感觉。
    // 取消理由（用户原话）：桌面常驻的东西**自己出声**很打扰，
    // 而且它跟当前在做什么完全无关 —— 主动点它时的反馈台词保留。
    //
    // ⚠️ 代码**故意保留**（项目没有版本控制，删了就找不回来了），
    //    只由下面这个开关关掉。恢复只需把 false 改成 true。
    // ─────────────────────────────────────────────────────────
    IDLE_TALK_ENABLED: false,   // ← 唯一的开关
    IDLE_LINE_CHANCE: 0.06,     // 每次空闲心跳冒台词的概率
    IDLE_LINE_MIN_MS: 45000,    // 至少闲置这么久才开始自言自语
    MOOD_LINES: ['在忙什么呀？', '陪我玩会儿嘛', '咕噜咕噜…', '今天也要加油哦'],
    LAUGH_LINES: ['哈哈哈哈！', '好痒好痒～', '再来再来！', '嘻嘻嘻嘻'],
  };

  /** 核心层注入的服务句柄，见 docs/00-协作约定.md 第 4 节。 */
  let ctx = null;

  // ───────────────────────── 状态 ─────────────────────────

  let state = 'static';          // static | laughing | cloning | running
  let lastClickAt = 0;
  let clickTimes = [];           // 连点统计窗口内的点击时间戳
  let cloneCooldownUntil = 0;    // 分身表演结束后的冷却截止时间

  let runAnim = null;            // 往返位移（或起伏 + 位移的合成动画）
  let returnAnim = null;         // 平滑归位动画

  // ───────────────────────── 小工具 ─────────────────────────

  const petEl = () => (ctx && ctx.pet.root ? ctx.pet.root() : null);

  /**
   * 单调时钟。
   *
   * ⚠️ **不要用 Date.now()。** 冷却和连点计数判的都是「经过了多少毫秒」，
   * 而系统时间被 NTP 回拨时 `now < cloneCooldownUntil` 会长时间恒真——
   * 表现是奶蛙点不动，且没有任何线索指向时钟，极难排查。
   * performance.now() 单调递增，天然免疫。
   */
  const now = () => performance.now();

  /** 记一次点击并返回 CLONE_WINDOW 内的点击数。 */
  function countRecentClicks(now) {
    clickTimes.push(now);
    while (clickTimes.length && now - clickTimes[0] > CONFIG.CLONE_WINDOW) clickTimes.shift();
    return clickTimes.length;
  }

  function pick(arr) {
    return arr[(Math.random() * arr.length) | 0];
  }

  /** 安全地取消一个 Web Animation。 */
  function cancelAnim(anim) {
    if (!anim) return null;
    try { anim.cancel(); } catch { /* 已经结束了，忽略 */ }
    return null;
  }

  /** 读出元素当前实际的 translateX（像素）。必须在 cancel 之前读。 */
  function currentTranslateX(el) {
    try {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return isFinite(m.m41) ? m.m41 : 0;
    } catch {
      return 0;
    }
  }

  // ───────────────────────── 点击 → 大笑 ─────────────────────────

  function doLaugh(n) {
    state = 'laughing';

    // 笑声用的是**源视频的原生音轨**（assets/sfx/laugh.mp3，15.38 秒，
// 见 manifest.relax.js 的 sounds 一段），和动画是同一段素材，不用对表。
    // 音效返回时长，仍然作为动画时长的兜底（playOnce 内部排序：素材自带时长 > 这里传的）。
    //
    // `jitter: false` 是给**整段录音**用的：core/audio.js 对几十毫秒的提示音会做
    // ±6% 的音高随机（避免每次一模一样），套到 15 秒的笑声上就是明显的变调、像快进。
    const ms = ctx.audio.play('laugh', { jitter: false });
    ctx.pet.playOnce('laugh', {
      duration: ms || CONFIG.LAUGH_FALLBACK_MS,
      onEnd: () => { if (state === 'laughing') state = 'static'; },
    });

    // 台词别每次都冒，会烦：连点到第 3、7、11… 次时随机来一句
    if (n >= 3 && (n - 3) % 4 === 0) ctx.pet.say(pick(CONFIG.LAUGH_LINES), 1300);
  }

  // ───────────────────────── 连点 → 分身同步大笑 ⭐ ─────────────────────────

  async function doCloneShow() {
    state = 'cloning';
    clickTimes = [];             // 清空计数，否则表演一结束就又够 4 次了

    // 音效只播一次。三个实例同时出声会糊成一团，听起来像噪音而不是大笑。
    // 用的还是同一段原生笑声（manifest 里 laugh_hard 也指向 sfx/laugh.mp3），
    // 同样关掉音高随机。
    ctx.audio.play('laugh_hard', { jitter: false });

    let total = 0;
    try {
      total = await ctx.pet.performWithClones('laugh', {
        clones: CONFIG.CLONE_COUNT,
        spread: CONFIG.CLONE_SPREAD,
        scale: CONFIG.CLONE_SCALE,
        opacity: CONFIG.CLONE_OPACITY,
        fadeOut: CONFIG.CLONE_FADE_OUT,
        onEnd: () => {
          // 表演结束后加冷却，否则残留的点击记录会立刻再次触发
          cloneCooldownUntil = now() + CONFIG.CLONE_COOLDOWN;
          if (state === 'cloning') state = 'static';
        },
      });
    } catch (e) {
      // 表现层理论上不会 reject，但这里必须兜底：state 一旦卡在 'cloning'，
      // onClick 会永久提前 return —— 奶蛙点不动、没有任何提示，
      // 得切一次模式才恢复。宁可多写一个 catch。
      console.error('[relax] 分身表演失败：', e);
      if (state === 'cloning') state = 'static';
      ctx.pet.setIdle();
      return;
    }

    // 返回 0 = 表演在「素材挂载」阶段就被取消了（切了模式，或被新的表演顶掉）。
    // 那条路径走不到 onEnd，状态得自己收回来。
    if (!total && state === 'cloning') state = 'static';
  }

  // ───────────────────────── 久不操作 → 跑步 ─────────────────────────

  /**
   * 起跑。
   *
   * ⚠️ 关于「没有 run 素材」这件事：
   * 工作区提供的 `解压模式久不操作.gif` 是**实拍背景**，没有任何纯色可抠，
   * 而且奶蛙在画面里越跑越远、还跑出画幅，做不成可循环的透明精灵；
   * `解压模式单点大笑.mp4` 里则**根本没有跑步动作**（实测脚不离地、双腿从不分开）。
   *
   * 所以没有 run 素材时**不退化成内置占位奶蛙**——那只卡通蛙和真实素材画风差
   * 太远，闲置 60 秒后突然换一只蛙，看起来像 bug。改成保留静态待机图，
   * 由代码给一个轻微的上下起伏，配合左右往返位移，读起来仍然是「自己在动」。
   * 一旦 assets/manifest.relax.js 里配上了真正的 run 素材，这里会自动走上面那条路。
   */
  async function startRun() {
    if (state !== 'static') return;
    state = 'running';

    const el = petEl();
    if (!el) { state = 'static'; return; }

    el.classList.add('is-running');     // 样式在 modes/relax.css

    // ⚠️ has() 是**异步**的：它要确认素材真的挂载成功，而不是只看清单里声明了没有。
    // 只看声明的话，路径写错时会把画风完全不同的占位卡通蛙挂上来——正是要避免的事。
    const hasRun = await ctx.pet.has('run');
    if (hasRun) await ctx.pet.playLoop('run');
    if (state !== 'running') return;    // await 期间被切模式了

    const R = CONFIG.RUN_RANGE;

    // 关键帧：左右往返 ±R，单程 RUN_CYCLE。
    // 没有 run 素材时叠一个上下起伏，让「在原地滑」读起来像「在动」。
    // 注意 X 和 Y 必须写在**同一个动画**里：同一个元素上两个都动 transform 的
    // 动画会在层叠里互相覆盖，后加的那个直接盖掉前一个。
    const keyframes = [];
    if (hasRun) {
      keyframes.push({ transform: `translateX(${-R}px)` });
      keyframes.push({ transform: `translateX(${R}px)` });
    } else {
      const n = CONFIG.HOP_PER_TRIP * 2;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = -R + 2 * R * t;
        const y = (i % 2) ? -CONFIG.HOP_HEIGHT : 0;
        keyframes.push({ transform: `translateX(${x.toFixed(1)}px) translateY(${y}px)` });
      }
    }

    runAnim = el.animate(keyframes, {
      duration: CONFIG.RUN_CYCLE,
      direction: 'alternate',
      iterations: Infinity,
      easing: 'ease-in-out',
    });

    ctx.log(hasRun ? '闲置太久，跑起来了' : '闲置太久，自己动起来了（没有 run 素材，用起伏替代）');
  }

  /**
   * 停下跑步并**平滑归位**。
   *
   * 直接停掉移动动画，奶蛙会瞬间跳回中心，看起来像闪了一下。
   * 正确做法：先把当前位移读出来，再从这个位移补一段过渡回 0。
   */
  function stopRun(opts) {
    opts = opts || {};
    if (state !== 'running') return;

    const el = petEl();
    state = 'static';

    if (el) {
      const cur = currentTranslateX(el);   // 必须在 cancel 之前读
      runAnim = cancelAnim(runAnim);

      el.style.transform = `translateX(${cur}px)`;
      const back = el.animate(
        [{ transform: `translateX(${cur}px)` }, { transform: 'translateX(0px)' }],
        { duration: CONFIG.RUN_RETURN, easing: 'ease-out', fill: 'forwards' }
      );
      returnAnim = back;

      back.finished.then(() => {
        if (returnAnim !== back) return;   // 已经被替换或取消了
        returnAnim = null;
        el.style.transform = '';
        el.classList.remove('is-running');
        if (opts.thenLaugh) doLaugh(1);
      }).catch(() => { /* 被 cancel，正常路径 */ });
    }

    ctx.pet.stopLoop();
  }

  /** 立刻归零，不播放过渡。deactivate() 用这个——那时奶蛙马上就不归本模式管了。 */
  function abortRun() {
    const el = petEl();
    runAnim = cancelAnim(runAnim);
    returnAnim = cancelAnim(returnAnim);
    if (el) {
      el.style.transform = '';
      el.classList.remove('is-running');
    }
    if (state === 'running') {
      state = 'static';
      if (ctx) ctx.pet.stopLoop();
    }
  }

  // ───────────────────────── 模式模块 ─────────────────────────

  window.Naiwa.Modes.relax = {
    id: 'relax',
    label: '解压模式',

    // ──────── 生命周期 ────────

    async activate(c) {
      ctx = c;
      state = 'static';
      clickTimes = [];
      lastClickAt = 0;
      cloneCooldownUntil = 0;

      // 预热：先把大笑素材读进内存。播放路径上不能再有加载，
      // 否则三个实例会先后起播，「分身同步」当场破功。
      const warm = ['laugh'];
      // ⚠️ has() 是**异步**的，必须 await。
      // 漏掉的话 Promise 恒为真 → 永远给 run（kind:'none'）挂上一个透明度 0 的
      // 占位卡通蛙到基础层里：#pet 常年多一个无用节点，而且冒烟测试的 S12
      //（瞳孔跟随）会先找到那个占位蛙的 .ph-pupils，于是从 SKIP 误判成 FAIL。
      if (await ctx.pet.has('run')) warm.push('run');
      await ctx.pet.preload(warm);

      await ctx.pet.setIdle();
    },

    /**
     * 离开本模式。**同步、且必须清干净。**
     * 用户可能疯狂右键来回切模式：分身表演到一半、大笑播到一半、跑步跑到一半
     * 都可能被切走，这里必须把定时器、动画、位移、DOM 全部收干净。
     */
    deactivate() {
      abortRun();                 // 位移归零 + 停循环
      cloneCooldownUntil = 0;
      clickTimes = [];
      lastClickAt = 0;
      state = 'static';

      // setOverlay / 分身 / 进行中的一次性反应都由表现层统一收场
      if (ctx) ctx.pet.setIdle();
    },

    // ──────── 事件 ────────

    /** 左键点击奶蛙。拖拽已在核心层过滤掉，这里收到的都是纯点击。 */
    onClick() {
      const t = now();

      // 表演进行中：忽略点击，不要让它叠成 5 个、7 个分身
      if (state === 'cloning') return;
      // 防连点冷却：低于这个间隔的点击直接丢弃，否则声音会叠成一片噪音
      if (t - lastClickAt < CONFIG.CLICK_COOLDOWN) return;
      lastClickAt = t;

      // 跑步中点它：先平滑归位，归位后立刻走一次大笑
      if (state === 'running') {
        stopRun({ thenLaugh: true });
        return;
      }

      const n = countRecentClicks(t);

      // ⚠️ 分身冷却**只拦分身**，不能拦单次大笑。
      // 如果写成「冷却期内直接 return」，表演结束后 3 秒里点奶蛙会完全没反应
      // （没动画、没音效），用户会以为程序卡死了。
      const cloneReady = t >= cloneCooldownUntil;
      if (n >= CONFIG.CLONE_THRESHOLD && cloneReady) doCloneShow();
      else doLaugh(n);
    },

    /**
     * 鼠标在窗口内移动。
     *
     * ⚠️ 这个事件会被派发两次：一次来自真实的 mousemove，一次来自主进程的
     * 光标推送（穿透状态下前端收不到 mousemove，只能靠推送）。所以这里的
     * 处理**必须幂等**。
     */
    onPointerMove(c, x, y) {
      if (state !== 'running') return;
      if (!c.pet.containsPoint(x, y)) return;   // 已经考虑跑步位移，跑到哪判到哪
      stopRun();
    },

    /** 解压模式不看 CPU。工作模式才流汗。 */
    onCpu() { /* 本模式不需要 */ },

    /** 空闲心跳，每 5 秒一次。 */
    onIdleTick(c, idleMs) {
      if (state !== 'static') return;

      // 闲置自言自语 —— ⏸ **已取消**，见 CONFIG.IDLE_TALK_ENABLED 上面那段注释。
      // 注意这里只是**停用**：主动点它时的 LAUGH_LINES、切模式时的问候都不受影响。
      if (CONFIG.IDLE_TALK_ENABLED
          && idleMs > CONFIG.IDLE_LINE_MIN_MS
          && Math.random() < CONFIG.IDLE_LINE_CHANCE) {
        c.pet.say(pick(CONFIG.MOOD_LINES), 2200);
        // ⚠️ 这里**不能 return**：冒完台词还要继续往下判起跑。
        // 早期写成 return，导致命中台词的那一拍会跳过起跑检查，
        // 起跑最久被推迟 5 秒（连续命中最久更久）。
      }

      // ⏸ 跑步已暂时取消：RUN_ENABLED 为 false 时这一整条路径不会触发。
      // 恢复方法见 CONFIG 顶部那段注释。上面的台词逻辑不受影响。
      if (CONFIG.RUN_ENABLED && idleMs >= CONFIG.RUN_IDLE_MS) startRun();
    },

    /** 面板只属于工作模式。 */
    onPanelToggled() { /* 本模式不需要 */ },

    // ──────── 元信息 ────────

    /** 本模式用到的素材槽位名，供自检工具核对。 */
    assetSlots: ['idle_relax', 'laugh', 'run'],

    /** 只读调试信息（冒烟测试 / 排查用，不参与业务）。 */
    get state() { return state; },
    get config() { return CONFIG; },
  };
})();