'use strict';
/**
 * 音效层
 *
 * 两条路径：
 *   1. 你在 assets/manifest.js 的 sounds 里声明了音频文件 → 直接播你的文件
 *   2. 没声明 → 用 Web Audio 现场合成
 *
 * 之所以内置合成音效，是为了让项目在「一个素材都没有」的状态下也能完整运行，
 * 你可以先听效果、调手感，之后再换成正式音效。
 *
 * 注意：这里刻意没有用 fetch + decodeAudioData 去读本地音频文件——
 * Electron 的 file:// 页面不允许 fetch 本地文件。用 <audio> 元素加载媒体
 * 不受这个限制，所以走元素池方案。
 */

window.Naiwa = window.Naiwa || {};

Naiwa.Audio = (function () {

  let AC = null;
  let master = null;
  let enabled = true;

  /** AudioContext 必须在用户交互后才能创建/恢复，这里做懒初始化。 */
  function ctx() {
    if (!AC) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      AC = new Ctor();
      master = AC.createGain();
      master.gain.value = 0.55;
      master.connect(AC.destination);
    }
    if (AC.state === 'suspended') AC.resume().catch(() => {});
    return AC;
  }

  // ───────────────────── 合成音效基元 ─────────────────────

  /** 一声「哈」：锯齿波 + 共振低通扫频 + 快速包络，听感接近元音 /a/。 */
  function ha(c, dest, t0, f0, dur, vol) {
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0 * 1.12, t0);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.82, t0 + dur);

    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2000, t0);
    lp.frequency.exponentialRampToValueAtTime(640, t0 + dur);
    lp.Q.value = 7;

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.014);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(lp); lp.connect(g); g.connect(dest);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function beep(c, dest, t0, f0, f1, dur, vol, type) {
    const osc = c.createOscillator();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g); g.connect(dest);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // ───────────────────── 合成音效 ─────────────────────

  /**
   * 大笑动画的时长（毫秒）。
   *
   * ⚠️ **从素材清单读，不要写死。** 大笑是序列帧，时长 = count / fps；
   * 写死过一次（对着当时的 26 帧 / 1733ms 调的），结果换素材后
   * 动画还在笑、声音已经先没了 13 秒 —— 静音尬笑，很出戏。
   * 现在唯一的真相来源是 assets/manifest.relax.js 里的 laugh 声明；
   * 读不到（清单没加载 / 不是序列帧）才退回兜底值。
   */
  function laughMs() {
    try {
      const a = Naiwa.Assets && Naiwa.Assets.spec && Naiwa.Assets.spec('laugh');
      if (a && a.kind === 'frames' && a.count && a.fps) {
        return Math.round((a.count / a.fps) * 1000);
      }
    } catch { /* 拿不到就用兜底 */ }
    return 15400;
  }

  /**
   * 大笑。intensity 0~1 控制声数与力度；targetMs 是要填满的总时长，返回实际时长。
   *
   * **按「一段一段」组织**，不是一口气连到底：一段几声「哈」，段间留一口气的停顿，
   * 声数与音量随段序缓慢起伏。整片大笑有 15 秒，如果均匀地一路「哈哈哈哈」，
   * 听起来像机关枪；分段之后才像人在笑（笑一阵、喘一口、再笑）。
   *
   * 放进真实音效（manifest 的 sounds.laugh）后本函数就用不到了。
   */
  function synthLaugh(intensity, targetMs) {
    const c = ctx();
    if (!c) return 0;

    const t0 = c.currentTime + 0.03;
    const target = targetMs > 0 ? targetMs : 0;
    const base = 330 + Math.random() * 40;            // 奶蛙音色偏尖

    let t = t0;
    let i = 0, guard = 0;

    while (guard++ < 400) {
      const elapsed = (t - t0) * 1000;
      if (target && elapsed >= target) break;
      if (!target && i >= 8) break;                   // 没给时长：维持老的「短笑」行为

      // 一段：3~7 声（intensity 越高越密），音量带一点随机起伏
      const phrase = 3 + Math.floor(Math.random() * 4) + Math.round(intensity * 2);
      const vol = (0.26 + intensity * 0.14) * (0.85 + Math.random() * 0.3);

      for (let k = 0; k < phrase; k++) {
        const f0 = base * (1 - (i % 12) * 0.02) * (0.97 + Math.random() * 0.06);   // 逐声走低
        const dur = Math.max(0.07, 0.125 - (i % 12) * 0.004) * (1 + intensity * 0.15);
        ha(c, master, t, f0, dur, vol);
        t += dur + Math.max(0.035, 0.07 - (i % 12) * 0.003) + Math.random() * 0.03;
        i++;
        if (target && (t - t0) * 1000 >= target) break;
      }

      // 段间喘一口气（intensity 高时停顿短一些）
      t += 0.16 + Math.random() * 0.22 + intensity * 0.05;
    }
    return Math.round((t - t0) * 1000);
  }

  const SYNTH = {
    /** 解压模式被点一下：填满整个大笑动画 */
    laugh: (o) => synthLaugh(0.45, (o && o.ms) || laughMs()),

    /** 连点之后更夸张的狂笑：同样填满整场（分身表演用的是同一个素材） */
    laugh_hard: (o) => synthLaugh(1.0, (o && o.ms) || laughMs()),

    /** 面板弹出：气泡上浮 */
    bubble() {
      const c = ctx(); if (!c) return 0;
      const t0 = c.currentTime + 0.01;
      beep(c, master, t0, 420, 980, 0.17, 0.20, 'sine');
      beep(c, master, t0 + 0.05, 700, 1500, 0.12, 0.10, 'sine');
      return 190;
    },

    /** 面板收起 / 普通点击 */
    pop() {
      const c = ctx(); if (!c) return 0;
      const t0 = c.currentTime + 0.01;
      beep(c, master, t0, 880, 420, 0.11, 0.18, 'sine');
      return 120;
    },

    /** 模式切换：上行两音 */
    chime() {
      const c = ctx(); if (!c) return 0;
      const t0 = c.currentTime + 0.01;
      beep(c, master, t0, 660, 660, 0.14, 0.16, 'triangle');
      beep(c, master, t0 + 0.11, 990, 990, 0.22, 0.14, 'triangle');
      return 330;
    },

    /** 流汗：短促水滴 */
    drip() {
      const c = ctx(); if (!c) return 0;
      const t0 = c.currentTime + 0.01;
      beep(c, master, t0, 1500, 600, 0.09, 0.10, 'sine');
      return 100;
    },

    /** 待办完成：轻松的上行三音 */
    done() {
      const c = ctx(); if (!c) return 0;
      const t0 = c.currentTime + 0.01;
      [523.25, 659.25, 783.99].forEach((f, i) => {
        beep(c, master, t0 + i * 0.075, f, f, 0.20, 0.14, 'triangle');
      });
      return 400;
    },
  };

  // ───────────────────── 音频文件播放 ─────────────────────
  // 用元素池，因为 createMediaElementSource 一个元素只能调用一次，
  // 且需要支持「连点时多个笑声重叠」。

  const pools = {};
  const POOL_MAX = 4;

  function playFile(src, opts) {
    if (!pools[src]) pools[src] = [];
    const pool = pools[src];

    // 找一个空闲的；都在响就复用最早的
    let el = pool.find((a) => a.paused || a.ended);
    if (!el) {
      if (pool.length < POOL_MAX) {
        el = new Audio();
        el.src = src;
        el.preload = 'auto';
        pool.push(el);
      } else {
        el = pool[0];
      }
    }

    try { el.currentTime = 0; } catch { /* 还没加载完，忽略 */ }

    // 轻微音高随机（0.94~1.06）只对**几十毫秒的提示音**有意义 —— 避免每次一模一样。
    // 对整段原生录音（这里的大笑是 15.4 秒）它会变成明显的变调，听起来像快进/慢放，
    // 所以整段素材的调用方显式传 { jitter: false }（见 modes/relax.js）。
    const jitter = !opts || opts.jitter !== false;
    el.playbackRate = jitter ? 0.94 + Math.random() * 0.12 : 1;

    el.play().catch(() => { /* 自动播放被拦，静默忽略 */ });

    return isFinite(el.duration) ? Math.round(el.duration * 1000) : 0;
  }

  // ───────────────────── 对外接口 ─────────────────────

  /**
   * 播放音效，返回预估时长（毫秒；0 表示未知）。
   * 调用方可以用这个时长来对齐动画。
   */
  function play(name, opts) {
    if (!enabled) return 0;
    opts = opts || {};

    // 优先用清单里声明的真实音频
    const file = Naiwa.Assets && Naiwa.Assets.soundSrc(name);
    if (file) {
      const d = playFile(file, opts);
      if (d) return d;
      // 时长未知（还没加载完）时，给一个合理的估计值让动画能接上
    }

    const fn = SYNTH[name];
    if (!fn) return 0;

    try {
      const d = fn(opts);
      return d || 0;
    } catch (e) {
      console.warn('[奶蛙] 音效合成失败:', e.message);
      return 0;
    }
  }

  /** 在启动时调一次，把 AudioContext 建起来（部分环境需要提前预热）。 */
  function warmup() {
    const c = ctx();
    if (c && master) master.gain.value = 0.55;
  }

  function setEnabled(on) {
    enabled = !!on;
    if (master) master.gain.value = enabled ? 0.55 : 0;
  }

  function setVolume(v) {
    if (master) master.gain.value = Math.max(0, Math.min(1, v)) * 0.55;
  }

  return { play, warmup, setEnabled, setVolume, ctx };
})();