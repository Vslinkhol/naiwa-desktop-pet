'use strict';
/**
 * 奶蛙素材清单 · 共享部分 + 合并器
 *
 * ═══════════════════════════════════════════════════════════════
 *  这个文件现在只放「两个模式共用」的声明，并且把另外两份合并起来
 * ═══════════════════════════════════════════════════════════════
 *
 *   assets/manifest.relax.js   ← 🅰 解压模式的声明
 *   assets/manifest.work.js    ← 🅱 工作模式的声明
 *   assets/manifest.js         ← 你正在看的这份：canvas / hit / 静态待机 + 合并
 *
 * **为什么要拆成三份？** 两个模式由不同的智能体开发。如果都往这一个文件里加
 * 声明，两边必然改同一个文件、产生冲突；拆开之后各改各的，互不影响。
 * 所以：**你自己模式的素材，声明请写进你自己那份 `manifest.<模式>.js`**，
 * 不要加到这里来。这份文件在结构改造完成后就冻结了。
 *
 * ⚠️ 加载顺序（见 renderer/index.html）：两份分清单必须在本文件**之前**加载，
 * 否则这里合并时读到的还是 undefined。
 *
 * 四种 kind 的写法、尺寸建议、ffmpeg 转换命令，见项目根目录 ASSETS.md。
 * 没有声明的槽位会自动退回内置占位奶蛙，所以素材可以一个一个慢慢替换，
 * 任何时候程序都是能跑的。
 */

window.NAIWA_MANIFEST = (function () {

  // ───────────────────────── 共享声明 ─────────────────────────

  const SHARED = {

    // 显示区尺寸，也是 canvas / 序列帧的画布尺寸。
    // ⚠️ 改这里的同时，renderer/core/style.css 里 .pet 的宽高要一起改（两处保持一致）。
    canvas: { width: 190, height: 190 },

    /**
     * 命中区域：鼠标落在哪儿才算「碰到奶蛙」。
     *
     * 这里千万不要用整个窗口矩形，否则窗口四角的透明区域也会挡住桌面点击，
     * 用户会觉得「这软件怎么点不到桌面图标」。
     *
     * 这组数值是**量出来的**，不是拍脑袋：真实素材统一在 380x380 画布上，
     * 奶蛙实体的包围盒是 x 114..265、y 44..348，换算成相对显示区的比例就是
     * 中心 (0.50, 0.516)、半径 (0.20, 0.40)，正好贴住身体轮廓。
     * `npm run check` 会算出覆盖率（这里约 25%）并给出判断。
     */
    hit: {
      type: 'ellipse',   // 'ellipse' | 'rect'
      x: 0.50,           // 中心点，0~1 相对显示区
      y: 0.516,
      rx: 0.20,          // 半径，相对显示区的宽 / 高
      ry: 0.40,
    },

    // ── 基础动画（同一时刻只显示一个，切换时交叉淡入） ──
    animations: {

      /**
       * 解压模式的静态待机图。
       *
       * **静止不动**是明确需求——不要做成循环动画，也不要加呼吸、摇摆。
       * 唯一保留的是视线跟随，那是交互反馈，不算「待机动作」。
       *
       * 素材来源：工作区提供的 `解压模式待机.jpg`（1920x1090，白底）。
       * 处理方式：白底 + 柔和投影一起抠掉 → 裁到奶蛙 → 统一到 380x380 画布，
       * 并和 `laugh` 序列帧对齐到同一个缩放和锚点（脚底 y=348、水平中心 x=190），
       * 这样点击前后奶蛙不会跳位置、也不会变大小。
       */
      idle_relax: { kind: 'file', src: 'shared/idle_relax.png' },

      /**
       * 被鼠标拎起来（可选）。
       * 没有素材时用内置占位奶蛙的手脚乱晃，够用，所以留空。
       */
      drag: { kind: 'none' },
    },

    overlays: {},
    sounds: {},
  };

  // ───────────────────────── 合并 ─────────────────────────

  const relax = window.NAIWA_MANIFEST_RELAX || {};
  const work  = window.NAIWA_MANIFEST_WORK || {};

  if (!window.NAIWA_MANIFEST_RELAX) {
    console.warn('[奶蛙] 没读到 assets/manifest.relax.js，检查 index.html 的加载顺序');
  }
  if (!window.NAIWA_MANIFEST_WORK) {
    console.warn('[奶蛙] 没读到 assets/manifest.work.js，检查 index.html 的加载顺序');
  }

  /** 后写的覆盖先写的：共享 → 解压 → 工作。 */
  const merge = (key) => Object.assign({}, SHARED[key], relax[key], work[key]);

  return {
    canvas: SHARED.canvas,
    hit: SHARED.hit,
    animations: merge('animations'),
    overlays: merge('overlays'),
    sounds: merge('sounds'),
  };
})();