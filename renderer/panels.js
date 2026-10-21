'use strict';
/**
 * 工作模式面板：便签 / 待办 + 剪贴板历史  ← 🅱 的文件
 *
 * ═══════════════════════════════════════════════════════════════
 *  安全提醒（改这个文件之前先读这三条）
 * ═══════════════════════════════════════════════════════════════
 *  1. **所有用户内容一律用 `textContent` 写入，绝不用 `innerHTML`。**
 *     剪贴板里可能夹带 `<script>alert(1)</script>` 这类内容，用 innerHTML
 *     就等于自己开了一个 XSS 口子。本文件里除了读 `value` / `checked`，
 *     没有任何一处拼 HTML 字符串。
 *  2. **不联网。** 剪贴板是隐私数据（密码、身份证号、私聊内容），全流程本地。
 *  3. **不把剪贴板内容写进日志。** 出错只打错误对象，不打内容。
 *
 * ═══════════════════════════════════════════════════════════════
 *  它负责什么
 * ═══════════════════════════════════════════════════════════════
 *  · 便签：新增 / 勾选 / 删除 / **双击编辑** / 排序（未完成在前、组内新的在前）
 *  · 剪贴板：点击复制 / 置顶 / 删除 / 清空（带二次确认）/ 搜索 / 元信息
 *  · 隐私：面板内可**直接关掉剪贴板记录** + 说明「仅存本机、明文、不上传」
 *  · 健壮：单条数据损坏只跳过那一条；IPC 失败降级；长列表分片渲染
 *
 *  数据本身由 `main.js` 管（读写 `%APPDATA%\naiwa-pet\naiwa-data.json`，400ms 防抖），
 *  这里只通过 `window.naiwa` 调用，不自己碰文件。
 *
 * ── 和模式层的接口 ──
 *  `Naiwa.Panels.on(event, cb)` 返回退订函数，事件：
 *    'noteDone' 待办被勾选为已完成（模式层用它让奶蛙笑一下）
 *    'noteAdded' / 'copied' / 'cleared'  其余用户动作
 *  `Naiwa.Panels.configure({...})` 由工作模式下发 CONFIG（分片阈值 / 预览行数 / CPU 阈值），
 *  保证「可调参数」只有 `modes/work.js` 顶上那一份。
 */

window.Naiwa = window.Naiwa || {};

Naiwa.Panels = (function () {

  // ───────────────────────── 常量 ─────────────────────────

  /** 分片渲染的步长：一次最多渲染这么多条，滚到底部再续一屏。 */
  const PAGE = 60;
  /** 单条剪贴板预览最多渲染多少字符（完整内容仍会原样复制，只是不进 DOM）。 */
  const PREVIEW_MAX = 4000;
  /** 「清空」的二次确认有效期。 */
  const CLEAR_CONFIRM_MS = 5000;
  /** 「上一次有多少条记录」的标记。用来发现数据文件损坏导致的整体丢失。 */
  const LS_KEY = 'naiwa.panel.counts';

  let panelEl = null;
  let notes = [];
  let clips = [];
  let activeTab = 'notes';
  let searchQuery = '';
  let hooks = {};
  let cfg = { virtualizeAt: 200, previewLines: 3, cpuOn: 75 };

  /** 分片渲染：当前愿意渲染多少条（只增不减，避免滚动位置反复跳）。 */
  let noteShown = PAGE;
  let clipShown = PAGE;

  /** 归一化时被跳过的损坏条数（UI 上要如实告诉用户，不能静默丢）。 */
  let skippedNotes = 0;
  let skippedClips = 0;

  let clearPending = false;
  let clearTimer = null;
  let editingId = null;
  let lastHot = false;
  let listeners = Object.create(null);

  /**
   * 运行时补齐的 DOM 元素（`renderer/index.html` 是冻结文件，新增元素在这里建）。
   * 见 `buildExtraDom()`。
   */
  const els = Object.create(null);

  const $ = (id) => document.getElementById(id);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // ───────────────────────── 事件总线（面板 → 模式层） ─────────────────────────

  function on(name, cb) {
    if (typeof cb !== 'function') return () => {};
    (listeners[name] || (listeners[name] = [])).push(cb);
    return () => {
      listeners[name] = (listeners[name] || []).filter((f) => f !== cb);
    };
  }

  function emit(name, payload) {
    (listeners[name] || []).forEach((cb) => {
      // 监听器抛错不能打断面板自己的流程
      try { cb(payload); } catch (e) { console.error(`[panel] ${name} 监听器抛错：`, e); }
    });
  }

  // ───────────────────────── 工具 ─────────────────────────

  let ipcFailures = 0;

  /**
   * 调用主进程，失败就降级。
   *
   * IPC 有可能失败（主进程忙、窗口正在销毁），任何一个 await 抛出都会变成
   * 未捕获的 rejection——面板会卡在半截、控制台一片红。所有 IPC 都从这里过。
   */
  async function call(fn, fallback) {
    try {
      const v = await fn();
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      console.error('[panel] 与主进程通信失败，已降级：', e && e.message ? e.message : e);
      ipcFailures++;
      return fallback;
    }
  }

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;   // ← 一律 textContent
    return el;
  }

  function relTime(ts) {
    const d = Date.now() - ts;
    if (d < 0) return '刚刚';
    if (d < 60_000) return '刚刚';
    if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前';
    if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前';
    return Math.floor(d / 86_400_000) + ' 天前';
  }

  function byteLen(s) {
    try { return new Blob([s]).size; } catch { return s.length; }
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** 只给 DOM 看的预览：超长内容截断，完整内容点一下照样原样复制。 */
  function preview(text) {
    return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + ' …' : text;
  }

  function toast(text) {
    if (typeof hooks.onToast === 'function') hooks.onToast(text);
  }

  // ───────────────────────── 数据归一化 ─────────────────────────
  // 数据文件可能被手工改坏、写一半断电、版本升级缺字段。
  // 这里的原则：**跳过错的那一条，而不是让整个列表崩掉**，同时把跳过条数报给用户。

  function normNotes(list) {
    const items = [];
    let bad = 0;
    if (!Array.isArray(list)) return { items, bad };
    for (const n of list) {
      if (!n || typeof n !== 'object') { bad++; continue; }
      const id = n.id == null ? '' : String(n.id);
      const text = typeof n.text === 'string' ? n.text : '';
      if (!id || !text.trim()) { bad++; continue; }
      items.push({ id, text, done: !!n.done, at: Number(n.at) || 0 });
    }
    return { items, bad };
  }

  function normClips(list) {
    const items = [];
    let bad = 0;
    if (!Array.isArray(list)) return { items, bad };
    for (const c of list) {
      if (!c || typeof c !== 'object') { bad++; continue; }
      const id = c.id == null ? '' : String(c.id);
      const text = typeof c.text === 'string' ? c.text : '';
      if (!id || !text) { bad++; continue; }
      items.push({ id, text, at: Number(c.at) || 0, pinned: !!c.pinned });
    }
    return { items, bad };
  }

  /** 未完成在前，已完成沉底；同组内按创建时间**倒序**。 */
  function sortedNotes() {
    return notes.slice().sort((a, b) => (a.done === b.done ? b.at - a.at : (a.done ? 1 : -1)));
  }

  /** 置顶在前，其余按时间倒序（`main.js` 也排过，这里再排一次保证稳定）。 */
  function sortedClips() {
    return clips.slice().sort((a, b) => (a.pinned === b.pinned ? b.at - a.at : (a.pinned ? -1 : 1)));
  }

  function searchedClips() {
    const q = searchQuery.trim().toLowerCase();
    const all = sortedClips();
    if (!q) return all;
    return all.filter((c) => {
      if (c._lc === undefined) c._lc = c.text.toLowerCase();   // 大文本只转一次
      return c._lc.includes(q);
    });
  }

  // ───────────────────────── 便签渲染 ─────────────────────────

  function noteRow(n) {
    const li = make('li', 'note-item' + (n.done ? ' is-done' : ''));
    li.dataset.id = n.id;

    const cb = make('input');
    cb.type = 'checkbox';
    cb.checked = n.done;
    cb.dataset.act = 'toggle';
    cb.title = n.done ? '标记为未完成' : '标记为完成';

    const span = make('span', 'text', n.text);   // ← 必须是 textContent
    span.title = '双击编辑';

    const del = make('button', 'row-del', '✕');
    del.title = '删除';
    del.dataset.act = 'remove';

    li.append(cb, span, del);
    return li;
  }

  function renderNotes() {
    const list = $('note-list');
    if (!list) return;
    const items = sortedNotes();
    const shown = Math.min(items.length, Math.max(PAGE, noteShown));
    noteShown = shown;

    const top = list.scrollTop;          // 重绘不该把滚动位置弹回顶部
    list.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < shown; i++) frag.appendChild(noteRow(items[i]));
    list.appendChild(frag);
    list.scrollTop = top;

    const empty = $('note-empty');
    if (empty) {
      empty.hidden = items.length > 0;
      empty.textContent = skippedNotes
        ? `没有可显示的便签（有 ${skippedNotes} 条数据缺字段，已跳过）。`
        : '还没有便签。写一条试试？（Ctrl + Enter 保存）';
    }
    updateFoot('notes', items, shown);
  }

  /** 滚到底部时续一屏，而不是一次把几千条塞进 DOM。 */
  function appendNotesTail() {
    const list = $('note-list');
    if (!list) return;
    const items = sortedNotes();
    const from = list.childElementCount;
    const to = Math.min(items.length, from + PAGE);
    if (to <= from) return;
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.appendChild(noteRow(items[i]));
    list.appendChild(frag);
    // 排序后 i 与 items 一一对应，from 就是下一条的下标
    noteShown = to;
    updateFoot('notes', items, to);
  }

  // ───────────────────────── 剪贴板渲染 ─────────────────────────

  function clipRow(c) {
    const li = make('li', 'clip-item' + (c.pinned ? ' is-pinned' : ''));
    li.dataset.id = c.id;
    li.title = '点击复制';

    const text = make('div', 'text', preview(c.text));   // ← 必须是 textContent

    const meta = make('div', 'meta');
    meta.append(
      make('span', null, c.at ? relTime(c.at) : '时间未知'),
      make('span', null, fmtSize(byteLen(c.text))),
      ...(c.pinned ? [make('span', 'pin-tag', '已置顶')] : [])
    );

    const actions = make('div', 'clip-actions');

    const pin = make('button', 'mini-btn', c.pinned ? '★' : '☆');
    pin.title = c.pinned ? '取消置顶' : '置顶（清空时保留）';
    pin.dataset.act = 'pin';

    const del = make('button', 'mini-btn', '✕');
    del.title = '删除这一条';
    del.dataset.act = 'remove';

    actions.append(pin, del);
    li.append(actions, text, meta);
    return li;
  }

  function renderClips() {
    const list = $('clip-list');
    if (!list) return;
    const items = searchedClips();
    const shown = Math.min(items.length, Math.max(PAGE, clipShown));
    clipShown = shown;

    const top = list.scrollTop;
    list.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < shown; i++) frag.appendChild(clipRow(items[i]));
    list.appendChild(frag);
    list.scrollTop = top;

    const empty = $('clip-empty');
    if (empty) {
      empty.hidden = items.length > 0;
      const q = searchQuery.trim();
      empty.textContent = q
        ? `没有匹配「${q}」的记录。`
        : (skippedClips
          ? `没有可显示的记录（有 ${skippedClips} 条数据缺字段，已跳过）。`
          : '复制点什么，这里就会记下来（只记文本，仅存本机）。');
    }
    updateFoot('clips', items, shown);
  }

  function appendClipsTail() {
    const list = $('clip-list');
    if (!list) return;
    const items = searchedClips();
    const from = list.childElementCount;
    const to = Math.min(items.length, from + PAGE);
    if (to <= from) return;
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.appendChild(clipRow(items[i]));
    list.appendChild(frag);
    clipShown = to;
    updateFoot('clips', items, to);
  }

  // ───────────────────────── 底部提示 ─────────────────────────

  function updateFoot(which, items, shown) {
    const el = which === 'notes' ? $('note-foot') : $('clip-foot');
    if (!el) return;
    const parts = [];
    const total = which === 'notes' ? notes.length : clips.length;

    if (items.length > shown) parts.push(`已显示 ${shown} / ${items.length} 条，继续往下滚加载更多`);
    else if (which === 'clips' && searchQuery.trim()) parts.push(`匹配 ${items.length} 条（共 ${total} 条）`);
    else if (total > 0) parts.push(`共 ${total} 条`);

    if (which === 'notes' && total > cfg.virtualizeAt) {
      parts.push(`超过 ${cfg.virtualizeAt} 条了，建议把已完成的归档`);
    }
    if (which === 'clips' && clips.some((c) => c.pinned)) parts.push('★ 置顶项在「清空」时会保留');

    el.textContent = parts.join(' · ');
    el.hidden = parts.length === 0;
  }

  // ───────────────────────── 损坏 / 丢失提示 ─────────────────────────

  function readMarker() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;   // 存储不可用时这个能力降级，不影响任何功能
    }
  }

  function persistCounts() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        notes: notes.length, clips: clips.length, at: Date.now(),
      }));
    } catch { /* 存储不可用就算了 */ }
  }

  /**
   * 数据整体丢失的检测。
   *
   * `main.js` 在 JSON 解析失败时会**静默**回退到空数组（那是对的，不能因为
   * 数据坏了就起不来），但用户会看到便签和剪贴板全空，却没有任何解释——
   * 那才是最糟的体验。这里用上一次记录的条数做对照：
   * 「上次还有记录，这次读到的是空的」= 数据很可能丢了，明确告诉用户。
   *
   * 只在**整体变空**时提示，且用户自己删空会同步更新标记，所以不会误报。
   */
  function checkDataLoss(marker) {
    if (!marker) return;
    const lostNotes = marker.notes > 0 && notes.length === 0;
    const lostClips = marker.clips > 0 && clips.length === 0;
    if (!lostNotes && !lostClips) return;
    showLostBanner([
      lostNotes ? `${marker.notes} 条便签` : '',
      lostClips ? `${marker.clips} 条剪贴板记录` : '',
    ].filter(Boolean).join(' 和 '));
  }

  function showLostBanner(what) {
    if (!els.warn) return;
    els.warn.hidden = false;
    els.warnText.textContent =
      `读取本地数据时发现异常：上次还有 ${what}，这次读到的却是空的。` +
      '数据文件可能已损坏（naiwa-data.json），那部分内容可能已经丢失。新记的内容不受影响。';
    emit('dataWarn', { what });
  }

  /** 有损坏条目时也要如实说一句，不能让用户以为「我明明记过」。 */
  function updateDataWarn() {
    if (!els.warn || !els.warnText) return;
    if (!els.warn.hidden) return;      // 已经有提示在显示（数据整体丢失更重要），不覆盖
    const bad = skippedNotes + skippedClips;
    if (!bad) return;
    els.warn.hidden = false;
    els.warnText.textContent =
      `有 ${bad} 条记录缺字段（可能是数据文件被改坏或写入中断），已跳过不显示；` +
      '其余记录不受影响。';
  }

  function hideWarn() {
    if (els.warn) els.warn.hidden = true;
  }

  // ───────────────────────── 便签：新增 / 编辑 ─────────────────────────

  function applyNotes(list) {
    const r = normNotes(list);
    notes = r.items;
    skippedNotes = r.bad;
  }

  function applyClips(list) {
    const r = normClips(list);
    clips = r.items;
    skippedClips = r.bad;
  }

  async function addNote() {
    const ta = $('note-text');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) return;
    const list = await call(() => window.naiwa.notes.add(text), null);
    if (!list) { toast('保存失败，请稍后再试'); return; }
    applyNotes(list);
    ta.value = '';
    noteShown = PAGE;
    renderNotes();
    persistCounts();
    emit('noteAdded', { text });
    if (typeof hooks.onNoteAdded === 'function') hooks.onNoteAdded();
  }

  /**
   * 双击进入编辑态。
   *
   * 用一个 textarea 顶掉那一行的文字，Enter 保存、Esc 取消、失焦保存。
   * 一次只允许编辑一条（`editingId`），否则重绘时会有两个编辑器互相顶掉。
   */
  function beginEdit(li, note) {
    if (editingId) return;
    const textEl = li.querySelector('.text');
    if (!textEl) return;

    editingId = note.id;
    li.classList.add('is-editing');

    const ta = make('textarea', 'note-edit');
    ta.value = note.text;                      // ← value 赋值，不解析 HTML
    ta.rows = clamp(Math.ceil(note.text.length / 30), 2, 6);
    ta.title = 'Enter 保存，Esc 取消';
    textEl.replaceWith(ta);
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* 忽略 */ }

    let finished = false;
    async function finish(save) {
      if (finished) return;
      finished = true;
      editingId = null;
      const next = ta.value.trim();
      if (save && next && next !== note.text) {
        const list = await call(() => window.naiwa.notes.update(note.id, next), null);
        if (list) {
          applyNotes(list);
          persistCounts();
          toast('已修改');
        } else {
          toast('修改失败，内容保持原样');
        }
      }
      renderNotes();
    }

    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();     // 别让按键冒到面板 / 核心层去
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    });
    ta.addEventListener('blur', () => { finish(true); });
    // 编辑框内的点击 / 双击不要再触发行上的其它行为
    ta.addEventListener('mousedown', (e) => e.stopPropagation());
    ta.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  // ───────────────────────── 剪贴板：清空（二次确认） ─────────────────────────

  function resetClearConfirm() {
    clearPending = false;
    clearTimeout(clearTimer);
    clearTimer = null;
    const btn = $('clip-clear');
    if (btn) {
      btn.textContent = '清空';
      btn.title = '清空未置顶的记录（会先让你确认一次）';
      btn.classList.remove('is-confirming');
    }
  }

  async function onClearClick() {
    const btn = $('clip-clear');
    if (!clearPending) {
      clearPending = true;
      if (btn) {
        btn.textContent = '确认清空？';
        btn.title = '清空后不可恢复；★ 置顶的记录会保留';
        btn.classList.add('is-confirming');
      }
      toast('再点一次确认清空（不可恢复，置顶项保留）');
      clearTimer = setTimeout(resetClearConfirm, CLEAR_CONFIRM_MS);
      return;
    }
    resetClearConfirm();
    const list = await call(() => window.naiwa.clips.clear(), null);
    if (!list) { toast('清空失败，请稍后再试'); return; }
    applyClips(list);
    clipShown = PAGE;
    renderClips();
    persistCounts();
    emit('cleared', {});
    toast(`已清空未置顶的记录（不可恢复），保留置顶 ${clips.filter((c) => c.pinned).length} 条`);
  }

  // ───────────────────────── 隐私开关 ─────────────────────────

  /**
   * 面板里的「记录剪贴板历史」开关。
   *
   * ⚠️ 这里用 `setSettings({})` 读当前设置：`preload.js` 只暴露了 `setSettings(patch)`，
   * 没有 getSettings，而传空 patch 时主进程会把合并后的设置原样返回，且不改任何值。
   * 这是**绕开冻结层的一个变通**，已经写进 docs/02-工作模式.md 第 10 节（申请 getSettings）。
   * 读不到时就退回「默认开」，并在 UI 上说明以托盘菜单为准，不假装知道。
   */
  async function buildPrivacyRow() {
    const row = make('div', 'clip-privacy');

    const label = make('label', 'privacy-switch');
    const cb = make('input');
    cb.type = 'checkbox';
    cb.id = 'clip-watch';
    cb.checked = true;
    label.append(cb, make('span', null, '记录剪贴板历史'));
    label.title = '关掉之后不再记录新复制的文本（已经记下的仍在本地）';

    const note = make('span', 'privacy-note', '只读文本 · 仅存本机 · 明文 JSON · 不联网');

    row.append(label, note);

    const s = await call(() => window.naiwa.setSettings({}), null);
    if (s && typeof s.clipboardWatch === 'boolean') {
      cb.checked = s.clipboardWatch;
    } else {
      note.textContent = '只读文本 · 仅存本机 · 开关状态读取失败，以托盘菜单为准';
    }

    cb.addEventListener('change', async () => {
      const want = cb.checked;
      const res = await call(() => window.naiwa.setSettings({ clipboardWatch: want }), null);
      if (!res) {
        cb.checked = !want;      // 没成功就别骗用户
        toast('设置失败，请用托盘菜单里的开关');
        return;
      }
      toast(want ? '已开启剪贴板记录' : '已关闭剪贴板记录（已记下的仍在本地）');
      emit('privacyChanged', { clipboardWatch: want });
    });

    return row;
  }

  // ───────────────────────── 动态补齐 DOM ─────────────────────────
  // `renderer/index.html` 是冻结文件，所以新增的元素在这里建、插进面板内部。
  // 全部落在 #panel 边界之内——超出面板的部分不参与命中判定，用户点不到。

  function buildExtraDom() {
    // ① 数据异常横幅（面板顶部，跨整宽）
    const warn = make('div', 'data-warn');
    warn.hidden = true;
    const warnText = make('span', 'data-warn-text', '');
    const warnClose = make('button', 'icon-btn data-warn-close', '✕');
    warnClose.title = '知道了';
    warnClose.addEventListener('click', () => { warn.hidden = true; });
    warn.append(warnText, warnClose);
    const head = panelEl.querySelector('.panel-head');
    if (head && head.nextSibling) panelEl.insertBefore(warn, head.nextSibling);
    else panelEl.appendChild(warn);
    els.warn = warn;
    els.warnText = warnText;

    // ② 便签页脚注
    const notePane = panelEl.querySelector('[data-pane="notes"]');
    if (notePane) {
      const foot = make('p', 'list-foot');
      foot.id = 'note-foot';
      foot.hidden = true;
      notePane.appendChild(foot);
    }

    // ③ 剪贴板：隐私行（在工具栏下面）+ 页脚注
    const clipPane = panelEl.querySelector('[data-pane="clips"]');
    if (clipPane) {
      const toolbar = clipPane.querySelector('.clip-toolbar');
      buildPrivacyRow().then((row) => {
        if (toolbar && toolbar.nextSibling) clipPane.insertBefore(row, toolbar.nextSibling);
        else clipPane.insertBefore(row, clipPane.firstChild);
      }).catch((e) => console.error('[panel] 隐私开关创建失败：', e));

      const foot = make('p', 'list-foot');
      foot.id = 'clip-foot';
      foot.hidden = true;
      clipPane.appendChild(foot);
    }
  }

  // ───────────────────────── 交互 ─────────────────────────

  /**
   * 切页。
   *
   * `opts.keepWarn`：程序化切页（初始化、`open(tab)`）时不要把数据异常横幅收起来——
   * 那个横幅是**启动时**就要让用户看到的，如果初始化最后那一下顺手把它隐藏了，
   * 数据丢了的用户就永远看不到提示。只有用户自己点标签页时才算「看过了」。
   */
  function switchTab(tab, opts) {
    activeTab = tab === 'clips' ? 'clips' : 'notes';
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.tab === activeTab);
    });
    document.querySelectorAll('.pane').forEach((p) => {
      p.hidden = p.dataset.pane !== activeTab;
    });
    resetClearConfirm();       // 离开这一页就别留着一个「确认清空？」按钮
    if (!opts || !opts.keepWarn) hideWarn();

    // ⚠️ 必须在这一页重绘一次。剪贴板的实时刷新是**只在停在剪贴板页时**才做的
    // （见 onClipsUpdated），所以从便签页切回来的那一刻，列表可能还是旧的。
    // 不重绘的话，用户切过去会看到一份过期的历史，甚至以为记录丢了。
    if (activeTab === 'clips') renderClips();
    else renderNotes();
  }

  function bindEvents() {
    // ── 标签页 ──
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    const closeBtn = $('panel-close');
    if (closeBtn) closeBtn.addEventListener('click', () => close());

    // ── 便签：新增 ──
    const addBtn = $('note-add');
    if (addBtn) addBtn.addEventListener('click', () => { addNote(); });

    const noteText = $('note-text');
    if (noteText) {
      noteText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          addNote();
        }
      });
    }

    // ── 便签：事件委托（整块监听，避免为每一行单独绑定） ──
    const noteList = $('note-list');
    if (noteList) {
      noteList.addEventListener('click', async (e) => {
        if (editingId) return;                       // 编辑态里不要误勾 / 误删
        const li = e.target.closest && e.target.closest('.note-item');
        if (!li) return;
        const act = e.target.dataset ? e.target.dataset.act : null;
        const id = li.dataset.id;

        if (act === 'toggle') {
          const list = await call(() => window.naiwa.notes.toggle(id), null);
          if (!list) { toast('操作失败，请稍后再试'); return; }
          applyNotes(list);
          renderNotes();
          persistCounts();
          // 勾成「已完成」时给个正反馈——面板这边只发事件，
          // 奶蛙笑一下和 done 音效分别由模式层 / 核心层负责
          const item = notes.find((x) => x.id === id);
          if (item && item.done) {
            emit('noteDone', { id });
            if (typeof hooks.onNoteDone === 'function') hooks.onNoteDone();
          }
        } else if (act === 'remove') {
          const list = await call(() => window.naiwa.notes.remove(id), null);
          if (!list) { toast('删除失败，请稍后再试'); return; }
          applyNotes(list);
          renderNotes();
          persistCounts();
        }
      });

      // 双击文字 → 编辑
      noteList.addEventListener('dblclick', (e) => {
        const li = e.target.closest && e.target.closest('.note-item');
        if (!li) return;
        if (!(e.target.closest && e.target.closest('.text'))) return;
        const n = notes.find((x) => x.id === li.dataset.id);
        if (n) beginEdit(li, n);
      });

      // 滚到底部续一屏（长列表不全量渲染）
      noteList.addEventListener('scroll', () => {
        if (noteList.scrollTop + noteList.clientHeight >= noteList.scrollHeight - 40) appendNotesTail();
      });
    }

    // ── 剪贴板 ──
    const search = $('clip-search');
    if (search) {
      search.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        clipShown = PAGE;
        renderClips();
      });
    }

    const clearBtn = $('clip-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => { onClearClick(); });

    const clipList = $('clip-list');
    if (clipList) {
      clipList.addEventListener('click', async (e) => {
        const li = e.target.closest && e.target.closest('.clip-item');
        if (!li) return;
        const act = e.target.dataset ? e.target.dataset.act : null;
        const id = li.dataset.id;

        if (act === 'pin') {
          const list = await call(() => window.naiwa.clips.pin(id), null);
          if (!list) { toast('操作失败，请稍后再试'); return; }
          applyClips(list);
          renderClips();
          persistCounts();
          return;
        }
        if (act === 'remove') {
          const list = await call(() => window.naiwa.clips.remove(id), null);
          if (!list) { toast('删除失败，请稍后再试'); return; }
          applyClips(list);
          renderClips();
          persistCounts();
          return;
        }

        // 点条目本身 = 复制回剪贴板
        const res = await call(() => window.naiwa.clips.copy(id), null);
        if (res && res.ok) {
          applyClips(res.clips);
          renderClips();
          persistCounts();
          emit('copied', { id });
          if (typeof hooks.onCopied === 'function') hooks.onCopied();   // 核心层播 pop + 冒「已复制」
        } else {
          toast('复制失败，请稍后再试');
        }
      });

      clipList.addEventListener('scroll', () => {
        if (clipList.scrollTop + clipList.clientHeight >= clipList.scrollHeight - 40) appendClipsTail();
      });
    }
  }

  // ───────────────────────── 开合 ─────────────────────────

  async function open(tab) {
    if (!panelEl) return;
    if (tab) switchTab(tab, { keepWarn: true });
    if (panelEl.hidden) {
      panelEl.hidden = false;
      emit('opened', {});
      if (typeof hooks.onOpen === 'function') hooks.onOpen();   // 核心层：bubble 音效 + 通知模式层
    }
    // 每次打开都刷新，保证看到的是最新数据
    await refresh();
    if (activeTab === 'notes') {
      setTimeout(() => {
        const t = $('note-text');
        if (t && panelEl && !panelEl.hidden) t.focus();
      }, 60);
    }
  }

  function close() {
    if (!panelEl || panelEl.hidden) return;
    panelEl.hidden = true;
    resetClearConfirm();
    if (typeof hooks.onClose === 'function') hooks.onClose();    // 核心层：通知模式层（播 pop）
    emit('closed', {});
  }

  function toggle(tab) {
    if (!panelEl || panelEl.hidden) return open(tab);
    close();
  }

  function isOpen() { return !!panelEl && !panelEl.hidden; }

  async function refresh() {
    const [n, c] = await Promise.all([
      call(() => window.naiwa.notes.list(), []),
      call(() => window.naiwa.clips.list(), []),
    ]);
    applyNotes(n);
    applyClips(c);
    renderNotes();
    renderClips();
    updateDataWarn();
    persistCounts();
  }

  // ───────────────────────── CPU 徽标 ─────────────────────────

  /**
   * 面板底部那个 CPU 徽标由核心层 `app.js` 调进来（拆分前就是这条调用链，保留）。
   * 工作模式自己的流汗逻辑在 `modes/work.js`，和这里无关。
   */
  function setCpu(v) {
    const el = $('cpu-badge');
    if (!el) return;
    const n = Number(v);
    el.textContent = 'CPU ' + (isFinite(n) ? n : '—') + '%';
    const hot = isFinite(n) && n >= cfg.cpuOn;
    if (hot !== lastHot) {
      el.classList.toggle('is-hot', hot);
      lastHot = hot;
    }
  }

  // ───────────────────────── 初始化 ─────────────────────────

  async function init(h) {
    hooks = h || {};
    try {
      panelEl = $('panel');
      if (!panelEl) {
        console.error('[panel] index.html 里没有 #panel，面板不可用');
        return;
      }

      // 先读「上一次有多少条」，再拉数据，最后回写——顺序不能反，
      // 否则读到的标记已经被这一轮覆盖，永远发现不了数据整体丢失。
      const marker = readMarker();

      bindEvents();
      buildExtraDom();

      // 应用设置里的可调参数（模式层可能还没下发，先用默认值）
      applyCfg();

      // 剪贴板有新记录时实时刷新：**只在面板开着且停在剪贴板页时**才重绘，省开销
      if (typeof window.naiwa.onClipsUpdated === 'function') {
        window.naiwa.onClipsUpdated((list) => {
          applyClips(list);
          if (isOpen() && activeTab === 'clips') {
            renderClips();
            persistCounts();
          }
        });
      }

      await refresh();
      // 先把初始页摆好（它会收起横幅），**再**判数据是不是丢了——
      // 顺序反了的话，刚显示出来的提示会被同一次初始化顺手隐藏掉。
      switchTab('notes', { keepWarn: true });
      checkDataLoss(marker);
      persistCounts();
    } catch (e) {
      // 初始化失败不能把整个应用拖死：面板不可用，但奶蛙和模式切换要照常
      console.error('[panel] 初始化失败：', e);
    }
  }

  function applyCfg() {
    if (!panelEl) return;
    panelEl.style.setProperty('--clip-lines', String(cfg.previewLines));
    panelEl.style.setProperty('--page-size', String(PAGE));
  }

  /** 由模式层下发 CONFIG（见文件头说明），保证参数只有一份。 */
  function configure(patch) {
    if (!patch || typeof patch !== 'object') return;
    if (Number.isFinite(patch.virtualizeAt)) cfg.virtualizeAt = patch.virtualizeAt;
    if (Number.isFinite(patch.previewLines)) cfg.previewLines = clamp(patch.previewLines, 1, 10);
    if (Number.isFinite(patch.cpuOn)) cfg.cpuOn = patch.cpuOn;
    applyCfg();
    renderNotes();
    renderClips();
  }

  return {
    init,
    open,
    close,
    toggle,
    isOpen,
    refresh,
    setCpu,
    configure,
    on,
    get activeTab() { return activeTab; },
    /** 只读调试信息（冒烟测试 / 排查用）。 */
    get debug() {
      return {
        notes: notes.length, clips: clips.length, shownNotes: noteShown, shownClips: clipShown,
        skippedNotes, skippedClips, ipcFailures, clearPending, editingId,
      };
    },
  };
})();