'use strict';
/**
 * 素材加载层
 *
 * 对外只暴露一件事：把「动画名」变成容器里一个能播的元素。
 * 上层（pet.js / app.js）完全不需要知道素材是 GIF、视频、序列帧还是雪碧图，
 * 也不需要在素材缺失时做特殊处理——这一层会自动退回内置占位奶蛙。
 *
 * 支持四种 kind：file / frames / sheet / none，写法见 assets/manifest*.js。
 */

window.Naiwa = window.Naiwa || {};

Naiwa.Assets = (function () {

  // ⚠️ 这个前缀是**相对 index.html**（也就是文档基地址）算的，不是相对本文件！
// 这里踩过一次坑：文件搬进 core/ 之后顺手把前缀改成 '../../assets/'，
// 结果 img.src 从 renderer/ 往上退两级，指到项目外面去了，全部素材静默 404，
// 于是所有动画都退回占位奶蛙——而画面看起来「还是有只奶蛙」，极难发现。
// renderer/index.html → '../assets/' 正好是项目根的 assets/。
  const BASE = '../assets/';
  const MANIFEST = window.NAIWA_MANIFEST || {};
  const ANIMS = MANIFEST.animations || {};
  const OVERLAYS = MANIFEST.overlays || {};
  const SOUNDS = MANIFEST.sounds || {};
  const CANVAS = MANIFEST.canvas || { width: 190, height: 190 };

  const url = (p) => BASE + String(p).replace(/^\/+/, '');
  const isVideoFile = (p) => /\.(webm|mp4|mov|m4v|ogv)$/i.test(String(p));

  /**
   * 「可能带动画」的图片格式。
   *
   * 只有这几种才需要「回到第 0 帧」那套重置 src 的手段。静态图（png / jpg / svg…）
   * 重置 src 是纯浪费：强制同步重排 + 重新解码，还闪一帧空白——而回待机、切模式
   * 都会走到播放路径，等于每次都在白白付这个代价。
   *
   * ⚠️ APNG 请用 `.apng` 扩展名。写成 `.png` 会被当成静态图，重播时不会回到第 0 帧。
   */
  const isAnimatedImage = (p) => /\.(gif|webp|apng)$/i.test(String(p));

  // ───────────────────────── 共享 rAF ─────────────────────────
  // 所有 canvas 动画共用一个 requestAnimationFrame，避免几十个动画各开一个循环。

  const tickers = new Set();
  let rafId = null;

  function tick(now) {
    for (const fn of tickers) {
      try { fn(now); } catch (e) { console.error('[奶蛙] 动画帧出错:', e); }
    }
    rafId = requestAnimationFrame(tick);
  }
  function addTicker(fn) {
    tickers.add(fn);
    if (rafId == null) rafId = requestAnimationFrame(tick);
  }
  function removeTicker(fn) {
    tickers.delete(fn);
    if (!tickers.size && rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ───────────────────────── 清单读取 ─────────────────────────

  function spec(name, layer) {
    const s = (layer === 'overlay' ? OVERLAYS : ANIMS)[name];
    return (s && s.kind && s.kind !== 'none') ? s : null;
  }

  function soundSrc(name) {
    const p = SOUNDS[name];
    return p ? url(p) : null;
  }

  /**
   * 命中区域。
   *
   * 传入当前基础动画名时，**优先用该槽位自己的 `hit` 覆盖**。
   * 因为不同姿势的轮廓宽度可以差很多（实测：idle_relax 152px / sweat 196px /
   * idle_work 262px，380 画布坐标），共用一组数值必然有一边「看得见点不到」。
   *
   * 槽位级覆盖的写法（写在你自己那份 manifest.<模式>.js 里，不用碰共享清单）：
   *
   *   sweat: {
   *     kind: 'file', src: 'work/sweat.png',
   *     hit: { type: 'ellipse', x: 0.50, y: 0.516, rx: 0.26, ry: 0.40 },
   *   }
   *
   * 数值怎么量：`ffmpeg -i 图.png -vf "alphaextract,bbox" -f null -`
   * 会打印非透明区域的包围盒，把 w/h 换算成相对显示区（190×190）的比例即可：
   *   rx = w / 380，ry = h / 380（素材是 380×380 时）
   *
   * ⚠️ 别把 rx/ry 调得比主体明显大——那会让窗口在看不见的地方拦住桌面点击。
   * 宁可小一点：点不中边缘只是手感差，挡住桌面是用户会直接卸载的问题。
   */
  function hitRegion(name) {
    if (name) {
      const s = ANIMS[name];
      if (s && s.hit) return s.hit;
    }
    return MANIFEST.hit || { type: 'ellipse', x: 0.5, y: 0.58, rx: 0.47, ry: 0.44 };
  }

  // ───────────────────────── 占位奶蛙 ─────────────────────────
  // 在真实素材到位之前顶上，保证程序始终可运行、可交互。

  const PLACEHOLDER_STATES = [
    'is-idle-relax', 'is-idle-work', 'is-laugh',
    'is-laugh-lv1', 'is-laugh-lv2', 'is-laugh-lv3', 'is-drag',
  ];

  const PLACEHOLDER_DURATION = {
    laugh: 1600,
    laugh_short: 1600,   // 工作模式勾选待办时的短笑（见 assets/manifest.relax.js）
    laugh_hard: 2200,
  };

  function elFromSVG(str) {
    const box = document.createElement('div');
    box.innerHTML = str.trim();
    return box.firstElementChild;
  }

  function frogSVG() {
    return elFromSVG(`
      <svg class="ph-frog" viewBox="0 0 190 190" xmlns="http://www.w3.org/2000/svg">
        <g class="ph-root">
          <!-- 脚 -->
          <ellipse cx="54" cy="166" rx="23" ry="12" fill="#F3DFC2" stroke="#4A3F35" stroke-width="3.5"/>
          <ellipse cx="136" cy="166" rx="23" ry="12" fill="#F3DFC2" stroke="#4A3F35" stroke-width="3.5"/>

          <!-- 手臂 -->
          <g class="ph-arm ph-arm-l">
            <ellipse cx="33" cy="128" rx="15" ry="11" fill="#FFF4E3" stroke="#4A3F35" stroke-width="3.5"/>
          </g>
          <g class="ph-arm ph-arm-r">
            <ellipse cx="157" cy="128" rx="15" ry="11" fill="#FFF4E3" stroke="#4A3F35" stroke-width="3.5"/>
          </g>

          <g class="ph-body">
            <!-- 身体 -->
            <ellipse cx="95" cy="122" rx="66" ry="54" fill="#FFF4E3" stroke="#4A3F35" stroke-width="4"/>

            <!-- 头顶眼睛凸起 -->
            <circle cx="62" cy="66" r="27" fill="#FFF4E3" stroke="#4A3F35" stroke-width="4"/>
            <circle cx="128" cy="66" r="27" fill="#FFF4E3" stroke="#4A3F35" stroke-width="4"/>

            <!-- 睁眼。瞳孔单独成组，方便做视线跟随 -->
            <g class="ph-eye-open">
              <circle cx="62" cy="68" r="19" fill="#ffffff"/>
              <circle cx="128" cy="68" r="19" fill="#ffffff"/>
              <g class="ph-pupils">
                <circle cx="66" cy="71" r="9"   fill="#3A3028"/>
                <circle cx="132" cy="71" r="9"  fill="#3A3028"/>
                <circle cx="61" cy="64" r="3.4" fill="#ffffff"/>
                <circle cx="127" cy="64" r="3.4" fill="#ffffff"/>
              </g>
            </g>

            <!-- 眯眼（大笑时用） -->
            <g class="ph-eye-happy" fill="none" stroke="#3A3028" stroke-width="5" stroke-linecap="round">
              <path d="M50 73 Q62 55 74 73"/>
              <path d="M116 73 Q128 55 140 73"/>
            </g>

            <!-- 眼皮（眨眼） -->
            <g class="ph-lid">
              <ellipse cx="62" cy="68" rx="19.5" ry="19.5" fill="#FFF4E3"/>
              <ellipse cx="128" cy="68" rx="19.5" ry="19.5" fill="#FFF4E3"/>
            </g>

            <!-- 腮红 -->
            <ellipse cx="45" cy="124" rx="15" ry="9" fill="#FFAD9E" opacity="0.7"/>
            <ellipse cx="145" cy="124" rx="15" ry="9" fill="#FFAD9E" opacity="0.7"/>

            <!-- 嘴：闭合 / 张开 -->
            <path class="ph-mouth-normal" d="M72 108 Q95 128 118 108"
                  fill="none" stroke="#4A3F35" stroke-width="4" stroke-linecap="round"/>
            <path class="ph-mouth-open" d="M72 106 Q95 146 118 106 Z"
                  fill="#C4626B" stroke="#4A3F35" stroke-width="4" stroke-linejoin="round"/>
          </g>
        </g>
      </svg>`);
  }

  function overlaySVG(name) {
    if (name === 'zzz') {
      return elFromSVG(`
        <svg class="ph-frog" viewBox="0 0 190 190" xmlns="http://www.w3.org/2000/svg">
          <g fill="#6FBFB4" font-family="sans-serif" font-weight="700" text-anchor="middle">
            <text class="ph-zzz" x="132" y="70" font-size="17">Z</text>
            <text class="ph-zzz" x="132" y="70" font-size="13">Z</text>
            <text class="ph-zzz" x="132" y="70" font-size="10">Z</text>
          </g>
        </svg>`);
    }
    // 默认当作汗滴
    return elFromSVG(`
      <svg class="ph-frog" viewBox="0 0 190 190" xmlns="http://www.w3.org/2000/svg">
        <g fill="#8FD3E8" stroke="#4A3F35" stroke-width="2">
          <path class="ph-sweat-drop" d="M140 52 q7 10 7 14 a7 7 0 0 1 -14 0 q0 -4 7 -14"/>
          <path class="ph-sweat-drop" d="M152 74 q5.5 8 5.5 11 a5.5 5.5 0 0 1 -11 0 q0 -3 5.5 -11"/>
          <path class="ph-sweat-drop" d="M128 66 q5 7 5 10 a5 5 0 0 1 -10 0 q0 -3 5 -10"/>
        </g>
      </svg>`);
  }

  function placeholderHandle(name, layer) {
    const el = layer === 'overlay' ? overlaySVG(name) : frogSVG();
    let endCb = null;
    let endTimer = null;
    let cur = null;

    function applyState(animName) {
      PLACEHOLDER_STATES.forEach((c) => el.classList.remove(c));
      cur = animName;
      if (animName === 'idle_relax') el.classList.add('is-idle-relax');
      else if (animName === 'idle_work') el.classList.add('is-idle-work');
      else if (animName === 'laugh') el.classList.add('is-laugh', 'is-laugh-lv1');
      else if (animName === 'laugh_short') el.classList.add('is-laugh', 'is-laugh-lv2');
      else if (animName === 'laugh_hard') el.classList.add('is-laugh', 'is-laugh-lv3');
      else if (animName === 'drag') el.classList.add('is-drag');
    }

    const duration = PLACEHOLDER_DURATION[name] || 0;

    return {
      element: el,
      duration,
      isPlaceholder: true,

      /** 供 pet.js 触发眨眼 */
      setBlink(on) { el.classList.toggle('is-blink', !!on); },

      play(animName) {
        clearTimeout(endTimer);
        applyState(animName || name);
        if (duration > 0 && endCb) endTimer = setTimeout(() => endCb(), duration);
      },

      stop() { clearTimeout(endTimer); },
      onEnd(cb) { endCb = cb; },
      destroy() { clearTimeout(endTimer); el.remove(); },
    };
  }

  // ───────────────────────── kind: file ─────────────────────────

  async function fileHandle(name, s) {
    const asVideo = isVideoFile(s.src);
    // 只有动图才需要「重置 src 重播」，见下面 play() 里的说明
    const mayAnimate = isAnimatedImage(s.src);
    const el = document.createElement(asVideo ? 'video' : 'img');

    if (asVideo) {
      el.src = url(s.src);
      el.muted = true;              // 必须有，否则自动播放会被拦
      el.playsInline = true;
      el.preload = 'auto';
      el.loop = !!s.loop;
      el.autoplay = false;

      await new Promise((resolve, reject) => {
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(new Error('视频加载失败: ' + s.src)); };
        const cleanup = () => {
          el.removeEventListener('loadeddata', ok);
          el.removeEventListener('error', bad);
        };
        el.addEventListener('loadeddata', ok, { once: true });
        el.addEventListener('error', bad, { once: true });
        setTimeout(bad, 8000);       // 兜底，避免一直挂着
      });
    } else {
      el.draggable = false;
      el.src = url(s.src);
      await new Promise((resolve, reject) => {
        if (el.complete && el.naturalWidth) return resolve();
        el.addEventListener('load', resolve, { once: true });
        el.addEventListener('error', () => reject(new Error('图片加载失败: ' + s.src)), { once: true });
        setTimeout(() => reject(new Error('图片加载超时: ' + s.src)), 8000);
      });
    }

    // 时长：视频读元数据，GIF/WebP 只能由清单手填
    let duration = Number(s.duration) || 0;
    if (!duration && asVideo && isFinite(el.duration)) duration = Math.round(el.duration * 1000);

    let endCb = null;
    let endTimer = null;

    if (asVideo) {
      el.addEventListener('ended', () => { if (endCb) endCb(); });
    }

    return {
      element: el,
      duration,
      isPlaceholder: false,
      setBlink() {},

      play() {
        clearTimeout(endTimer);
        if (asVideo) {
          try { el.currentTime = 0; } catch { /* 元数据未就绪，忽略 */ }
          const p = el.play();
          if (p && p.catch) p.catch((e) => console.warn('[奶蛙] 视频播放被拒:', e.message));
        } else if (!s.loop && mayAnimate) {
          // GIF / 动画 WebP 没有 API 能让它回到第 0 帧，
          // 只能重置 src 强制重新解码。这是浏览器层面的限制。
          //
          // ⚠️ 必须限定在动图上（见 isAnimatedImage）。静态图走这条路不但没用，
          // 还会强制一次同步布局 + 重新解码，并闪出一帧空白；而「笑完回待机」
          // 和「切模式」每次都会调到这里，白白付代价。
          const src = el.src;
          el.src = '';
          void el.offsetWidth;
          el.src = src;
        }
        if (!asVideo && duration > 0 && endCb) endTimer = setTimeout(() => endCb(), duration);
      },

      stop() {
        clearTimeout(endTimer);
        if (asVideo) { try { el.pause(); } catch { /* 忽略 */ } }
      },

      onEnd(cb) { endCb = cb; },
      destroy() { clearTimeout(endTimer); if (asVideo) { try { el.pause(); } catch {} } el.remove(); },
    };
  }

  // ───────────────────────── kind: frames / sheet ─────────────────────────
  // 两者都是「把一张图按帧画到 canvas 上」，只是取图位置不同，共用播放器。

  function makeFramePlayer(ctx, fps, count, loop, draw, onEndCb) {
    let frame = 0, acc = 0, last = 0, playing = false;

    function paint() { draw(frame); }

    const update = (now) => {
      if (!playing) return;
      if (!last) { last = now; return; }
      const dt = Math.min(now - last, 250);   // 挂起后回来不要一次性跳完
      last = now;
      acc += dt;

      const step = 1000 / Math.max(1, fps);
      let changed = false;
      while (acc >= step) {
        acc -= step;
        frame++;
        changed = true;
        if (frame >= count) {
          if (loop) { frame = 0; }
          else {
            frame = count - 1;
            playing = false;
            changed = true;
            removeTicker(update);
            if (onEndCb) onEndCb();
            break;
          }
        }
      }
      if (changed) paint();
    };

    return {
      play() { frame = 0; acc = 0; last = 0; playing = true; paint(); addTicker(update); },
      stop() { playing = false; removeTicker(update); },
      dispose() { playing = false; removeTicker(update); },
      get playing() { return playing; },
    };
  }

  async function canvasHandle(name, s, loadFrames) {
    const w = (s.size && s.size[0]) || CANVAS.width;
    const h = (s.size && s.size[1]) || CANVAS.height;

    // 按屏幕缩放比放大画布后端缓冲。Windows 笔记本普遍是 125%~150% 缩放，
    // 不做这一步，序列帧和雪碧图会明显发糊。
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingQuality = 'high';

    const { imgs, draw } = await loadFrames(ctx, w, h);

    let endCb = null;
    const player = makeFramePlayer(ctx, s.fps || 12, imgs, !!s.loop, draw, () => { if (endCb) endCb(); });

    const duration = s.loop ? 0 : Math.round((imgs / (s.fps || 12)) * 1000);

    return {
      element: canvas,
      duration,
      isPlaceholder: false,
      setBlink() {},
      play() { player.play(); },
      stop() { player.stop(); },
      onEnd(cb) { endCb = cb; },
      destroy() { player.dispose(); canvas.remove(); },
    };
  }

  /**
   * 序列帧的**图源缓存**。
   *
   * 同一个动画会被挂载多次：主体 1 次 + 连点时每个分身各 1 次
   * （core/pet.js 的 performWithClones 会对每个分身单独 mount）。
   * 没有缓存时 231 帧的大笑要解码 231×3 张，首次表演时每一帧都可能卡在解码上。
   * 实测后果很具体：冒烟测试 S5「三个实例严格同帧」从
   * `不一致分组 0 / 组内时间散布 0.1ms` 退化成 `1 / 8ms` ——
   * 绘制被解码阻塞挤进了相邻的测量窗口。
   *
   * 缓存之后三个实例画的是**同一批 Image 对象**：解码一次、三处复用，
   * 常驻内存也降到约 1/3。
   *
   * 键必须包含所有决定「取哪些文件」的字段：dir / pattern / start / pad / count。
   */
  const frameCache = new Map();

  function framesLoader(s) {
    return async (ctx, w, h) => {
      const pad = s.pad == null ? 4 : s.pad;
      const start = s.start == null ? 1 : s.start;
      const pattern = String(s.pattern || 'frame_{n}.png');
      const key = [s.dir, pattern, start, pad, s.count].join('|');

      let imgs = frameCache.get(key);
      if (!imgs) {
        imgs = [];
        for (let i = 0; i < s.count; i++) {
          const n = String(start + i).padStart(pad, '0');
          const img = new Image();
          img.src = url(s.dir.replace(/\/+$/, '') + '/' + pattern.replace('{n}', n));
          imgs.push(img);
        }
        frameCache.set(key, imgs);
      }

      const results = await Promise.all(imgs.map((img) => new Promise((resolve) => {
        if (img.complete && img.naturalWidth) return resolve(true);
        img.addEventListener('load', () => resolve(true), { once: true });
        img.addEventListener('error', () => resolve(false), { once: true });
        setTimeout(() => resolve(false), 8000);
      })));

      const okCount = results.filter(Boolean).length;
      if (!okCount) throw new Error('序列帧一张都没加载成功，检查 dir / pattern / 文件名编号');
      if (okCount < imgs.length) console.warn(`[奶蛙] 序列帧只加载到 ${okCount}/${imgs.length} 张`);

      const draw = (frame) => {
        ctx.clearRect(0, 0, w, h);
        const img = imgs[frame];
        if (img && img.naturalWidth) ctx.drawImage(img, 0, 0, w, h);
      };
      return { imgs: imgs.length, draw };
    };
  }

  function sheetLoader(s) {
    return async (ctx, w, h) => {
      const img = new Image();
      img.src = url(s.src);
      await new Promise((resolve, reject) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', () => reject(new Error('雪碧图加载失败: ' + s.src)), { once: true });
        setTimeout(() => reject(new Error('雪碧图加载超时: ' + s.src)), 8000);
      });

      const fw = s.frameW || w;
      const fh = s.frameH || h;
      const count = s.count || Math.max(1, Math.floor(img.naturalWidth / fw));

      const draw = (frame) => {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, frame * fw, 0, fw, fh, 0, 0, w, h);
      };
      return { imgs: count, draw };
    };
  }

  // ───────────────────────── 对外接口 ─────────────────────────

  /**
   * 把名为 name 的动画挂到 container 里，返回一个播放句柄。
   * 素材缺失或加载失败时自动退回占位奶蛙，不会抛错。
   */
  async function mount(container, name, layer) {
    const s = spec(name, layer);
    let handle = null;

    if (s) {
      try {
        if (s.kind === 'file')        handle = await fileHandle(name, s);
        else if (s.kind === 'frames') handle = await canvasHandle(name, s, framesLoader(s));
        else if (s.kind === 'sheet')  handle = await canvasHandle(name, s, sheetLoader(s));
        else console.warn(`[奶蛙] 未识别的 kind: ${s.kind}（动画 "${name}"）`);
      } catch (e) {
        // 这条一定要响：素材没加载成功时界面**仍然有一只奶蛙**（占位的），
        // 光看画面很难发现，所以要把「实际请求了哪个地址」打出来。
        // 路径写错 / core/assets.js 的 BASE 前缀不对，都会在这里现形。
        console.error(`[奶蛙] 素材 "${name}" 加载失败，已退回占位素材 —— ${e.message}`);
        try {
          console.error(`      实际请求：${new URL(url(s.src), location.href).href}`);
        } catch { /* location 拿不到就算了 */ }
        handle = null;
      }
    }

    if (!handle) handle = placeholderHandle(name, layer);

    handle.name = name;
    container.appendChild(handle.element);
    return handle;
  }

  return {
    mount,
    spec,
    soundSrc,
    hitRegion,
    canvasSize: CANVAS,
    /** 清单里是否声明了该动画的真实素材 */
    has(name, layer) { return !!spec(name, layer); },
    soundNames: Object.keys(SOUNDS),
  };
})();