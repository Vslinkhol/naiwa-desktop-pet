'use strict';
/**
 * preload —— 主进程与渲染进程之间唯一的通道。
 *
 * 渲染进程跑的是网页，不能直接碰 Node。这里用 contextBridge 只暴露一组
 * 明确的能力，既保证安全，也让「哪些操作需要原生支持」一目了然。
 *
 * 迁移到 Tauri 时，只需把 window.naiwa 换成 Tauri 的 invoke 实现，
 * 上层业务代码完全不用动。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 订阅主进程推送，返回取消订阅函数。 */
function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  // ── 窗口 ──
  /** 切换点击穿透。true = 鼠标事件穿过窗口落到桌面。 */
  setClickThrough: (ignore) => ipcRenderer.send('click-through:set', !!ignore),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  /**
   * 退出奶蛙（右键操作窗里的那一项）。
   * 走的是和托盘「退出奶蛙」完全相同的主进程路径：
   * 托盘常驻程序**关窗口不等于退出**，必须由主进程 app.quit()。
   */
  quit: () => ipcRenderer.send('app:quit'),

  // ── 模式 ──
  getMode: () => ipcRenderer.invoke('mode:get'),
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),
  onModeChanged: (cb) => subscribe('mode:changed', cb),

  // ── 便签 / 待办 ──
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    add: (text) => ipcRenderer.invoke('notes:add', text),
    toggle: (id) => ipcRenderer.invoke('notes:toggle', id),
    update: (id, text) => ipcRenderer.invoke('notes:update', id, text),
    remove: (id) => ipcRenderer.invoke('notes:remove', id),
  },

  // ── 剪贴板历史 ──
  clips: {
    list: () => ipcRenderer.invoke('clips:list'),
    copy: (id) => ipcRenderer.invoke('clips:copy', id),
    pin: (id) => ipcRenderer.invoke('clips:pin', id),
    remove: (id) => ipcRenderer.invoke('clips:remove', id),
    clear: () => ipcRenderer.invoke('clips:clear'),
  },
  onClipsUpdated: (cb) => subscribe('clips:updated', cb),

  // ── 系统 ──
  /** CPU 占用率推送，约每 2 秒一次。0~100。 */
  onCpu: (cb) => subscribe('sys:cpu', cb),
  /**
   * 全局光标位置推送（窗口内坐标），约 25fps。
   * 点击穿透状态下前端收不到 mousemove，命中判定必须依赖这个。
   */
  onCursor: (cb) => subscribe('sys:cursor', cb),

  /** 读设置 → Promise<{clipboardWatch, cpuWatch, clipLimit}>。返回的是副本。 */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  /** 写设置（部分补丁），返回合并后的完整设置。 */
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  /**
   * 数据加载状态 → Promise<{ok, reason, at, message?}>
   * reason: null 正常 / 'missing' 首次运行 / 'corrupt' JSON 损坏 / 'io' 读不出来
   *
   * 用来解释「便签和剪贴板为什么突然全空」——那种情况必须给用户一个说法，
   * 而不是让面板自己用 localStorage 猜。
   */
  getDataStatus: () => ipcRenderer.invoke('data:status'),
};

contextBridge.exposeInMainWorld('naiwa', api);