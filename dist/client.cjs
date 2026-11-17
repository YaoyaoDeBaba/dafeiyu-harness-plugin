window.__ModuleLoader__.load({
  id: "dsh-selfloop",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
// client.js —— selfloop 的浏览器半边（2026-11-17 重画：按轮分组 + 肥鱼接单）
//
// 结构照抄大肥鱼那颗 pill 的三条经验：
//   ① 组件只返回一个带稳定 ref 的空 span，真实 DOM 自己管（宿主重渲染不会拆掉）
//   ② react 只在运行期向 loader 要（静态 import 失败会整页 boot 失败）
//   ③ 任何一步抛错只留日志，绝不抛进 loader
//
// 挂两个槽位（都已在本代宿主内置插件里验证过存在）：
//   conversation.composer.dock          输入框底部那颗胶囊（肥鱼接单 · 状态）
//   conversation.session.header.actions 标题栏那颗「肥鱼接单」按钮
// 面板由插件自己 docked 到右侧渲染；视图与数据层分离。
// 契约见 docs/ui-contract-v2.md §6（以它为准）。
// 注意：本文件是**裸脚本**，由 tools/build-client.mjs 包进 __ModuleLoader__ 外壳，
// 所以不写 import/export，只用 exports.*（相对路径 import 在外壳里解析不到）。

// 路由必须写成**完整字面量**：与宿主侧 lib/routes.js 的 ROUTES 逐字一致，
// 有一条测试在比对这两边（拼字符串会让漂移检查失效）。
const STATE_ROUTE = '/plugins/dsh-selfloop/state'
const WINDOW_ROUTE = '/plugins/dsh-selfloop/window'
const INTERRUPT_ROUTE = '/plugins/dsh-selfloop/interrupt'
const ANSWERS_ROUTE = '/plugins/dsh-selfloop/intent-answers'
const SHOT_ROUTE = '/plugins/dsh-selfloop/shot'
const START_ROUTE = '/plugins/dsh-selfloop/start'

/** 会话键：一个 DSH 会话一个订单（用户规则）。探测顺序：全局钩子 → DOM 属性 → URL → global。 */
function sessionKey() {
  try {
    const g = typeof window !== 'undefined' ? window : undefined
    const boot = g && g.__DSH_BOOT__
    const guess = (boot && (boot.sessionId || (boot.session && boot.session.id))) ||
      (g && g.__DSH_SESSION__ && g.__DSH_SESSION__.id)
    if (guess) return String(guess)
    const el = document.querySelector('[data-session-id]')
    if (el) return String(el.getAttribute('data-session-id'))
    const m = String(location.pathname + location.hash).match(/session[\/=-]([0-9a-fA-F-]{8,})/)
    if (m) return m[1]
  } catch (e) { /* 探测失败就用 global */ }
  return ''
}

const PLUGIN_ID = 'dsh-selfloop'
const STYLE_ID = 'dsh-selfloop/ui.css'
const POLL_MS = 3000
const PANEL_WIDTH = 432
/** 吐槽输入框的静默窗：用户正在打字时这个窗口内不重绘（待办 16） */
const VENT_SILENCE_MS = 2000

// 视觉三档字号：标题 13px/600、正文 12.5px、元信息 11px #8a8f98（契约 §6 最后一条）。
// 分类色：蓝=流程信息 / 黄=要你吐槽 / 红=有风险或失败 / 绿=通过 / 灰=存档类。
const CSS = [
'.sl-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid #e3e3e8;background:#fbfbfc;font-size:11.5px;color:#3c4043;cursor:pointer;user-select:none}',
'.sl-chip:hover{background:#f1f3f4}',
'.sl-dot{width:7px;height:7px;border-radius:50%;background:#9aa0a6;flex:none}',
'.sl-dot.run{background:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,.15)}',
'.sl-dot.wait{background:#f2b544;box-shadow:0 0 0 3px rgba(242,181,68,.18)}',
'.sl-dot.done{background:#2e9e5b}',
'.sl-dot.red{background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.18)}',
'.sl-chip .sl-win{color:#8a8f98;font-variant-numeric:tabular-nums}',
'.sl-chip .sl-win.open{color:#1a73e8}',
'.sl-chip.on{background:#1a73e8;border-color:#1a73e8;color:#fff}',
'.sl-chip.on .sl-dot{background:#fff}',
'.sl-mode{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;width:min(960px,calc(100% - 40px));background:#fff;border:1px solid #cfe0fd;border-radius:16px;box-shadow:0 10px 34px rgba(26,115,232,.18);z-index:2147483000;display:none;flex-direction:column;font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328}',
'.sl-mode.on{display:flex}',
'.sl-mode .mhead{display:flex;align-items:center;gap:8px;padding:8px 14px;background:#f4f8ff;border-bottom:1px solid #e6effd;font-size:12px;color:#1a73e8;border-radius:16px 16px 0 0}',
'.sl-mode .mhead .tag{background:#1a73e8;color:#fff;border-radius:5px;padding:1px 6px;font-size:11px}',
'.sl-mode .mhead .x{margin-left:auto;cursor:pointer;color:#8a8f98}',
'.sl-refs{display:flex;gap:8px;padding:12px 14px 0;flex-wrap:wrap}',
'.sl-ref{width:62px;height:76px;border-radius:8px;background:linear-gradient(135deg,#dfe3e8,#cfd5dc);position:relative;overflow:hidden}',
'.sl-ref img{width:100%;height:100%;object-fit:cover;display:block}',
'.sl-ref .rm{position:absolute;top:2px;right:2px;width:15px;height:15px;border-radius:8px;background:rgba(0,0,0,.45);color:#fff;font-size:10px;line-height:15px;text-align:center;cursor:pointer}',
'.sl-addref{width:62px;height:76px;border:1px dashed #c9ced6;border-radius:8px;display:grid;place-items:center;color:#9aa0a6;font-size:20px;cursor:pointer}',
'.sl-mode .req{width:100%;border:0;outline:0;font:inherit;font-size:13.5px;resize:none;padding:10px 14px 4px;min-height:46px;box-sizing:border-box}',
'.sl-mode .ttl-in{display:block;width:calc(100% - 28px);margin:8px 14px 0;border:1px solid #e6effd;background:#fbfcff;border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;outline:0;box-sizing:border-box}',
'.sl-mode .mfoot{display:flex;align-items:center;gap:8px;padding:8px 12px 10px;font-size:12px;color:#5f6368;flex-wrap:wrap}',
'.sl-mode .mf-lb{font-size:11px;color:#8a8f98}',
'.sl-sel{border:1px solid #e3e3e8;border-radius:7px;padding:3px 8px;background:#fbfbfc;color:#3c4043;font-size:12px;max-width:190px}\n.sl-sel[disabled]{color:#9aa0a6;background:#f2f3f5;cursor:not-allowed}\n.sl-eff-hint{font-size:10.5px;color:#c0392b;max-width:150px;line-height:1.4}\n.sl-stale{color:#e5484d;font-weight:600}',
'.sl-send{margin-left:auto;background:#1a73e8;color:#fff;border:0;border-radius:8px;padding:6px 14px;font-size:12.5px;cursor:pointer}',
'.sl-send[disabled]{background:#dadce0;cursor:not-allowed}',
'.sl-order{display:flex;align-items:center;gap:6px;padding:2px 8px;border:1px solid #e3e3e8;border-radius:7px;background:#fbfbfc;font-size:12px;cursor:pointer;color:#3c4043;max-width:190px;overflow:hidden;white-space:nowrap}',
'.sl-menu{position:absolute;left:12px;right:12px;top:38px;background:#fff;border:1px solid #e3e3e8;border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,.14);display:none;z-index:6;overflow:hidden}',
'.sl-menu.on{display:block}',
'.sl-menu .it{padding:8px 10px;font-size:12.5px;border-bottom:1px solid #f4f4f6;display:flex;gap:8px;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
'.sl-menu .it:hover{background:#f7f9fc}',
'.sl-menu .it.cur{background:#f4f8ff;font-weight:600}',
'.sl-newbtn{width:100%;border:1px dashed #cfe0fd;background:#f4f8ff;color:#1a73e8;border-radius:9px;padding:8px;font-size:12.5px;cursor:pointer}',
'.sl-newbtn[disabled]{border-style:solid;border-color:#e8e8ec;background:#f7f7f8;color:#b0b4bb;cursor:not-allowed}',
'.sl-newhint{font-size:11px;color:#9aa0a6;margin-top:6px;text-align:center}',
'.sl-hact{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:7px;border:1px solid #e3e3e8;background:#fff;font-size:12px;color:#5f6368;cursor:pointer}',
'.sl-panel{position:fixed;top:40px;right:0;bottom:0;background:#fff;border-top-left-radius:10px;border-left:1px solid #e8e8ec;z-index:2147483000;display:none;flex-direction:column;box-shadow:-8px 0 24px rgba(0,0,0,.06);font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328}',
'.sl-panel.on{display:flex}',
'.sl-sh{display:flex;align-items:center;gap:6px;padding:9px 12px 0;border-bottom:1px solid #f0f0f2}',
'.sl-tab{padding:7px 12px;font-size:12.5px;color:#8a8f98;cursor:pointer;border-bottom:2px solid transparent}',
'.sl-tab.on{color:#1a73e8;font-weight:600;border-bottom-color:#1a73e8}',
'.sl-fold{cursor:pointer;color:#8a8f98;padding:0 6px 0 2px;font-size:15px;line-height:1}',
'.sl-fold:hover{color:#1a73e8}',
'.sl-title{font-size:12.5px;font-weight:600;color:#3c4043;margin-left:auto;padding-right:4px;position:relative}',
'.sl-body{flex:1;overflow:auto;padding:12px;min-width:0;overflow-wrap:anywhere}',
'.sl-sec{margin-bottom:14px}',
'.sl-h{font-size:11.5px;color:#8a8f98;font-weight:600;letter-spacing:.03em;margin-bottom:7px;display:flex;align-items:center;gap:6px}',
'.sl-h .ln{flex:1;height:1px;background:#f0f0f2}',
'.sl-card{border:1px solid #e8eaed;border-radius:11px;padding:9px 11px;margin-bottom:9px;background:#fff;min-width:0;overflow-wrap:anywhere}',
'.sl-card.blue{border-color:#cfe0fd;background:linear-gradient(180deg,#f5f9ff,#fff)}',
'.sl-card.amber{border-color:#f2dfb2;background:linear-gradient(180deg,#fffbf0,#fff)}',
'.sl-card.red{border-color:#f2c8c8;background:linear-gradient(180deg,#fff6f6,#fff)}',
'.sl-card.green{border-color:#c6e8d3;background:linear-gradient(180deg,#f5fdf8,#fff)}',
'.sl-card.gray{border-color:#e8eaed;background:#fbfbfc}',
'.sl-ttl{font-size:13px;font-weight:600;color:#1f2328;display:flex;align-items:center;gap:6px;min-width:0}',
'.sl-p{font-size:12.5px;line-height:1.6;color:#3c4043;margin-top:5px;min-width:0;overflow-wrap:anywhere}',
'.sl-meta{font-size:11px;color:#8a8f98;margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0;overflow-wrap:anywhere}',
'.sl-lamp{width:8px;height:8px;border-radius:50%;background:#9aa0a6;flex:none;display:inline-block}',
'.sl-lamp.run{background:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,.16)}',
'.sl-lamp.wait{background:#f2b544;box-shadow:0 0 0 3px rgba(242,181,68,.2)}',
'.sl-lamp.done{background:#2e9e5b}',
'.sl-lamp.red{background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.2)}',
'.sl-foldh{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;min-width:0}',
'.sl-foldh .cv{color:#8a8f98;font-size:11px;width:10px;flex:none}',
'.sl-foldb{padding-top:6px;min-width:0;overflow-wrap:anywhere}\n.sl-foldb.folded{max-height:0;overflow:hidden;height:0;padding-top:0}',
'.sl-agents{display:flex;flex-direction:column;gap:3px;margin-top:6px}',
'.sl-agent{display:flex;gap:6px;font-size:11.5px;color:#3c4043;align-items:baseline}',
'.sl-agent .nm{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#1a73e8;flex:none}',
'.sl-rnd{margin-bottom:10px;border:1px solid #eef0f3;border-radius:12px;padding:9px 10px;background:#fff}',
'.sl-rnd.cur{border-color:#cfe0fd;box-shadow:0 2px 10px rgba(26,115,232,.06)}',
'.sl-rnd .hd{display:flex;align-items:center;gap:6px;cursor:pointer;min-width:0}',
'.sl-rnd .bd{padding-top:2px;min-width:0;overflow-wrap:anywhere}',
'.sl-sub{margin-top:8px;margin-bottom:8px}',
'.sl-sub:last-child{margin-bottom:0}',
'.sl-opt{display:flex;gap:7px;align-items:flex-start;padding:4px 6px;border-radius:6px;cursor:pointer}',
'.sl-opt.on{background:#f4f8ff}',
'.sl-ta{width:100%;min-height:96px;border:1px solid #e3e3e8;border-radius:9px;padding:9px 11px;font:inherit;font-size:12.5px;line-height:1.6;resize:vertical;margin-top:8px;box-sizing:border-box}',
'.sl-foot{border-top:1px solid #f0f0f2;padding:9px 12px;background:#fcfcfd}',
'.sl-foot .row1{display:flex;align-items:center;gap:8px;font-size:11px;color:#8a8f98;margin-bottom:4px}',
'.sl-foot .st{font-weight:600}',
'.sl-foot .open{color:#1a73e8}.sl-foot .closed{color:#c0392b}',
'.sl-thumb{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:6px;background:#eef0f3;display:block}',
'.sl-btn{background:#1a73e8;color:#fff;border:0;border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer}',
'.sl-btn:disabled{background:#dadce0;color:#fff;cursor:not-allowed}',
'.sl-txt{font-size:12.5px;line-height:1.6;color:#3c4043}',
'.sl-row{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;margin-bottom:5px}',
'.sl-row .k{color:#8a8f98;min-width:52px;flex:none}',
'.sl-badge{font-size:10.5px;border-radius:5px;padding:0 5px;border:1px solid #e6e6ea;color:#5f6368;flex:none}',
'.sl-metro{position:relative;padding-left:24px}',
'.sl-metro .line{position:absolute;left:8px;top:6px;bottom:6px;width:2px;background:#e8e8ec}',
'.sl-node{position:relative;padding:0 0 13px}',
'.sl-node .n{position:absolute;left:-24px;top:5px;width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #c9ced6}',
'.sl-node.done .n{background:#2e9e5b;border-color:#2e9e5b}',
'.sl-node.next .n{background:#f2b544;border-color:#f2b544;box-shadow:0 0 0 3px rgba(242,181,68,.22)}',
'.sl-node.run .n{background:#1a73e8;border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,.2)}',
'.sl-node.red .n{background:#e5484d;border-color:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.2)}',
'.sl-node .tx{font-size:12.5px}',
'.sl-node .id{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8a8f98}',
'.sl-node.done .tx{color:#8a8f98}',
'.sl-node.red .tx{color:#c0392b;font-weight:600}',
'.sl-node.next .tx{color:#a36a00;font-weight:600}',
'.sl-node.run .tx{color:#1a73e8;font-weight:600}',
'.sl-trace{border:1px solid #eee;border-radius:10px;overflow:hidden}',
'.sl-tr{padding:8px 10px;border-bottom:1px solid #f4f4f6}',
'.sl-tr:last-child{border-bottom:0}',
'.sl-tr .q{font-size:12.5px;margin-bottom:2px;overflow-wrap:anywhere}',
'.sl-tr .m{font-size:11px;color:#9aa0a6}',
].join('\n')

function logWarn(message) {
  try { console.warn('[selfloop] ' + message) } catch (e) { /* 控制台不可用就算了 */ }
}

function isSlots(v) { return !!v && typeof v === 'object' && typeof v.inject === 'function' && typeof v.register === 'function' }
function pickSlots(source) {
  if (isSlots(source)) return source
  try {
    const got = source && typeof source.get === 'function' ? source.get('slots', true) : undefined
    if (isSlots(got)) return got
  } catch (e) { /* 没声明 inject 时读属性会抛 */ }
  return undefined
}

function injectStyle() {
  try {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.dataset.plugin = PLUGIN_ID
    style.textContent = CSS
    document.head.appendChild(style)
  } catch (e) { logWarn('样式注入失败：' + e.message) }
}

const store = { state: null, window: null, error: null, at: 0 }
const listeners = new Set()

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(url + ' → ' + res.status)
  return res.json()
}

let viewRun = ''
function runQuery() {
  const parts = []
  if (viewRun) parts.push('run=' + encodeURIComponent(viewRun))
  const sk = sessionKey()
  if (sk) parts.push('session=' + encodeURIComponent(sk))
  return parts.length ? '?' + parts.join('&') : ''
}

async function refresh() {
  try {
    const pair = await Promise.all([fetchJson(STATE_ROUTE + runQuery()), fetchJson(WINDOW_ROUTE + runQuery())])
    store.state = pair[0]
    store.window = pair[1]
    store.error = null
    store.at = Date.now()
    // 提交意向后的「已提交，等 Agent 继续」卡片：流程一动（节点变了）就收起来
    if (submitWait) {
      const node = (store.state && store.state.status && store.state.status.node) || ''
      const st = (store.state && store.state.orderState) || ''
      if (st === 'finished' || (node && node !== submitWait.node)) submitWait = null
    }
  } catch (e) { store.error = e.message }
  listeners.forEach(function (fn) { try { fn() } catch (e) { /* 单个订阅者失败不影响别人 */ } })
}

let pollTimer = null
function startPolling() {
  refresh()
  if (pollTimer) return
  pollTimer = setInterval(refresh, POLL_MS)
}

const STATE_LABEL = {
  'wait-requirement': '等需求',
  'wait-agent': '等接手',
  'wait-reply': '等回复',
  'vent': '来吐槽',
  'review': '请验收',
  'running': '运行中',
  'finished': '已结束',
}
const STATE_DOT = {
  'wait-requirement': 'wait',
  'wait-agent': 'wait',
  'wait-reply': 'wait',
  'vent': 'run',
  'review': 'run',
  'running': 'run',
  'finished': 'done',
}
/** 状态卡的指示灯：等你是黄、跑着是蓝、要你验收是红、完事是绿 */
const LAMP = {
  'wait-requirement': 'wait',
  'wait-agent': 'wait',
  'wait-reply': 'run',
  'vent': 'run',
  'review': 'red',
  'running': 'run',
  'finished': 'done',
}

/** 订单是不是还在跑（只有「没单 / 已结束」才允许进接单模式） */
function orderLive(stateOverride) {
  const s = stateOverride === undefined ? store.state : stateOverride
  const st = (s && s.orderState) || ''
  return !!st && st !== 'finished' && st !== 'wait-requirement'
}

/** 胶囊点击去向：跑单中 → 打开/聚焦右侧栏；无单/已结束 → 进接单模式（契约 §6） */
function chipClickAction(stateOverride) {
  return orderLive(stateOverride) ? 'panel' : 'composer'
}

/** 有待你确认的意向问题（中途追加的问题也算）→ 胶囊上打「等你确认」 */
function confirmPending(stateOverride) {
  const s = stateOverride === undefined ? store.state : stateOverride
  const c = s && s.confirm
  if (!c || !Array.isArray(c.questions) || !c.questions.length) return false
  return !(Array.isArray(c.answered) && c.answered.length)
}

function chipText(stateOverride) {
  const s = stateOverride === undefined ? store.state : stateOverride
  if (confirmPending(s)) return { text: '等你确认', dot: 'wait' }
  const st = (s && s.orderState) || ''
  return { text: STATE_LABEL[st] || '进行中', dot: STATE_DOT[st] || 'wait' }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  })
}

let composerMode = false
let lastChipEl = null

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', function () {
    if (composerMode && modeEl) alignModeToHost(lastChipEl)
  })
}

function renderChip(el) {
  const state = store.state
  const live = orderLive(state)
  el.className = 'sl-chip' + (composerMode ? ' on' : '')
  if (!live) {
    // 无订单 / 已结束：虚线胶囊就是下单入口
    el.style.borderStyle = 'dashed'
    el.innerHTML = '<span style="color:#1a73e8;font-weight:600">＋ 肥鱼接单</span>'
    el.title = '下单：说清目标 + 放参考，我按闭环流程跑'
    return
  }
  el.style.borderStyle = ''
  const info = chipText(state)
  el.innerHTML = '<span class="sl-dot ' + (composerMode ? 'done' : info.dot) + '"></span><span>肥鱼接单 · ' + esc(info.text) + '</span>'
  el.title = '点一下打开右侧栏看进度（不弹下单框）'
}

/* ------------------------------------------------------------------ *
 * 折叠状态：key → 展开与否；没记过的用调用点的默认值（当前轮展开 / 历史轮折叠）
 * ------------------------------------------------------------------ */
let panelFold = {}
function foldOpen(key, defaultOpen) {
  return panelFold[key] === undefined ? !!defaultOpen : !!panelFold[key]
}
function foldHeadHtml(key, open, titleHtml, extraHtml) {
  return '<div class="sl-foldh" data-fold="' + esc(key) + '" data-open="' + (open ? '1' : '0') + '">' +
    '<span class="cv">' + (open ? '▾' : '▸') + '</span>' + titleHtml + (extraHtml || '') + '</div>'
}
/**
 * 折叠体（㉛ 布局 bug）：展开时包住内容，折叠时**留一个 display:none + max-height:0 的空壳**。
 * 以前是「折叠就不渲染内容」，DOM 里根本没有节点 ⇒ 折叠态高度无从量、一旦哪天改成渲染就把
 * 卡片撑成一条缝。空壳同时把 min-width:0 / overflow-wrap:anywhere 钉在内容容器上，
 * 长 URL、长中文任务名不再把卡片顶出面板宽度。
 */
function foldBodyHtml(open, innerHtml) {
  if (!open) return '<div class="sl-foldb folded" data-folded="1" style="display:none;max-height:0;overflow:hidden"></div>'
  return '<div class="sl-foldb" style="min-width:0;overflow-wrap:anywhere">' + (innerHtml || '') + '</div>'
}

/* ------------------------------------------------------------------ *
 * 置顶「状态」卡：人话 + 指示灯 + 子代理名册（待办 12 / 契约 §6）
 * ------------------------------------------------------------------ */
function statusCardHtml(state) {
  if (!state) {
    return '<div class="sl-card red"><div class="sl-ttl">🔌 还没连上宿主路由</div>' +
      '<div class="sl-meta">' + esc(store.error || '等待第一次轮询…') + '</div></div>'
  }
  const st = state.status || {}
  const agents = Array.isArray(st.agents) ? st.agents : []
  // A2：子代理进度（已返回 2/3）+ 静默告警；静默超过阈值时灯直接转红
  const returned = Number(st.returned)
  const total = Number(st.total)
  const hasProgress = total > 0 && Number.isFinite(returned)
  const stale = !!st.stale
  const silentMin = Math.max(1, Math.round(Number(st.silentForMs || 0) / 60000))
  const lamp = stale ? 'red' : (LAMP[(state.orderState || '')] || 'wait')
  const text = st.text || (state.currentNode && state.currentNode.title) || '空闲'
  let html = '<div class="sl-card blue">' +
    '<div class="sl-ttl"><span class="sl-lamp ' + lamp + '"></span>🚦 ' + esc(text) + '</div>' +
    '<div class="sl-meta">' + (st.node ? '节点 ' + esc(st.node) : '没有当前节点') +
    (hasProgress ? ' · 已返回 ' + Math.max(0, returned) + '/' + total : '') +
    (st.windowOpen ? ' · 💬 吐槽窗口开放中' : '') + '</div>' +
    (stale ? '<div class="sl-meta"><span class="sl-stale">⚠ 已静默 ' + silentMin + ' 分钟</span></div>' : '')
  if (agents.length) {
    html += '<div class="sl-agents">' + agents.map(function (a) {
      return '<div class="sl-agent"><span class="nm">🤖 ' + esc(a.name) + '</span><span>' + esc(a.task || '在干活') + '</span></div>'
    }).join('') + '</div><div class="sl-meta">' + agents.length + ' 个子代理在跑</div>'
  } else {
    html += '<div class="sl-meta">暂无子代理在跑</div>'
  }
  return html + '</div>'
}

/* ------------------------------------------------------------------ *
 * 需求原文：常驻、默认折起、可展开（待办 5 / 8）
 * ------------------------------------------------------------------ */
function requirementCardHtml(state) {
  const text = String((state && state.requirement) || '').trim()
  if (!text) return ''
  const open = foldOpen('req', false)
  return '<div class="sl-card gray">' +
    foldHeadHtml('req', open, '<span class="sl-ttl">📋 需求原文</span>',
      '<span class="sl-meta" style="margin-left:auto">' + text.length + ' 字</span>') +
    foldBodyHtml(open, '<div class="sl-p" style="white-space:pre-wrap">' + esc(text) + '</div>') + '</div>'
}

/* ------------------------------------------------------------------ *
 * 模型下拉：数据来自 state.models（契约 §1 / §5）
 * ------------------------------------------------------------------ */
function modelValue(o) {
  if (!o) return ''
  return String(o.provider || '') + '|' + String(o.model || '')
}
function parseModel(v) {
  const s = String(v == null ? '' : v)
  if (!s) return null
  const i = s.indexOf('|')
  if (i <= 0) return null
  const provider = s.slice(0, i)
  const model = s.slice(i + 1)
  if (!provider || !model) return null
  return { provider: provider, model: model }
}
function modelLabel(o) {
  return String((o && (o.label || o.model)) || '')
}
/** attr 是 data-* 去掉 data- 的部分，例如 'research-model' → data-research-model */
function modelSelectHtml(attr, current, models) {
  const m = models || {}
  const def = m.default || '由主 Agent 分配'
  const list = Array.isArray(m.options) ? m.options : []
  let html = '<select class="sl-sel" data-' + attr + '><option value=""' + (current ? '' : ' selected') + '>' + esc(def) + '</option>'
  for (const o of list) {
    const v = modelValue(o)
    if (!v || v === '|') continue
    html += '<option value="' + esc(v) + '"' + (current === v ? ' selected' : '') + '>' + esc(modelLabel(o)) + '</option>'
  }
  return html + '</select>'
}

/* ------------------------------------------------------------------ *
 * 努力程度（⑱⑳）：值只认 state.models.options[].efforts；模型不宣告 = 不支持，下拉禁用
 * ------------------------------------------------------------------ */
const EFFORT_LEVELS = ['low', 'high', 'max']
const EFFORT_DEFAULT = 'max'
/** 某个模型值（provider|model）能选的努力档。没选模型 / 模型没写 efforts 字段 → 标准三档 */
function modelEfforts(models, pick) {
  const list = models && Array.isArray(models.options) ? models.options : []
  const value = String(pick == null ? '' : pick)
  const hit = value ? list.find(function (o) { return modelValue(o) === value }) : null
  if (!hit) return { levels: EFFORT_LEVELS.slice(), supported: true }
  if (!Array.isArray(hit.efforts)) return { levels: EFFORT_LEVELS.slice(), supported: true }
  const levels = hit.efforts.map(function (x) { return String(x) }).filter(function (x) { return !!x })
  // 宣告了 efforts 但是空的 ⇒ 这个模型不支持设定努力程度
  if (!levels.length) return { levels: EFFORT_LEVELS.slice(), supported: false }
  return { levels: levels, supported: true }
}
/** 当前值不在可选档里时：优先 max，其次最后一档（自定义档位只有 low/high 时不会选空） */
function pickEffort(levels, current) {
  const s = String(current == null ? '' : current)
  if (levels.indexOf(s) >= 0) return s
  if (levels.indexOf(EFFORT_DEFAULT) >= 0) return EFFORT_DEFAULT
  return levels[levels.length - 1] || EFFORT_DEFAULT
}
function effortHtml(attr, current, models, pick) {
  const info = modelEfforts(models, pick)
  const cur = pickEffort(info.levels, current)
  const opts = info.levels.map(function (l) {
    return '<option value="' + esc(l) + '"' + (l === cur ? ' selected' : '') + '>' + esc(l) + '</option>'
  }).join('')
  return '<select class="sl-sel" data-' + attr + (info.supported ? '' : ' disabled') + '>' + opts + '</select>' +
    (info.supported ? '' : '<span class="sl-eff-hint">该模型不支持设定努力程度</span>')
}
/** 请求体里的 effort：留空就按默认 max，不替用户瞎猜 */
function effortValue(v) {
  const s = String(v == null ? '' : v).trim()
  return s || EFFORT_DEFAULT
}

/* ------------------------------------------------------------------ *
 * 按轮分组（契约 §1 rounds / 待办 11）
 * ------------------------------------------------------------------ */
function currentRound(state) {
  const rs = state && Array.isArray(state.rounds) ? state.rounds : []
  const max = rs.reduce(function (m, r) { return Math.max(m, Number(r && r.round) || 0) }, 0)
  if (max) return max
  const p = state && state.plan && Number(state.plan.round)
  return p || 1
}

function normalizeRound(r) {
  const src = r || {}
  const c = src.confirm
  const questions = c && Array.isArray(c.questions) ? c.questions : []
  const o = {
    round: Number(src.round) || 0,
    confirm: questions.length ? { questions: questions, answers: Array.isArray(c.answers) ? c.answers : [] } : null,
    interrupts: Array.isArray(src.interrupts) ? src.interrupts : [],
    plan: null,
    verify: null,
    review: null,
    decide: null,
  }
  const p = src.plan
  if (p) o.plan = { orders: Array.isArray(p.orders) ? p.orders : [], executor: p.executor || '' }
  const v = src.verify
  if (v) o.verify = { pass: Array.isArray(v.pass) ? v.pass : [], fail: Array.isArray(v.fail) ? v.fail : [], measuredBy: v.measuredBy || '' }
  if (src.review && src.review.verdict) o.review = { verdict: src.review.verdict, failCount: src.review.failCount }
  if (src.decide) o.decide = { action: src.decide.action, gapsForNextRound: Array.isArray(src.decide.gapsForNextRound) ? src.decide.gapsForNextRound : [], nextRoundOrders: Array.isArray(src.decide.nextRoundOrders) ? src.decide.nextRoundOrders : [] }
  return o
}

/** 组装轮次：有 rounds 用它；老订单没有 rounds 目录时用顶层字段合成一轮；顶层 confirm 挂到当前轮上 */
function groupRounds(state) {
  const cur = currentRound(state)
  let groups = (state && Array.isArray(state.rounds) ? state.rounds : []).map(normalizeRound)
  if (!groups.length) {
    const legacy = normalizeRound({
      round: cur,
      confirm: state && state.confirm,
      interrupts: state && state.interrupts,
      plan: state && state.plan,
      verify: state && state.verify,
      review: state && state.review,
      decide: state && state.decide,
    })
    const any = legacy.confirm || legacy.interrupts.length || legacy.plan || legacy.verify || legacy.review || legacy.decide
    // 合成的老单一轮（整单没有 rounds）：允许借用顶层字段，但这一轮要在界面上标出来
    if (any) { legacy.synthetic = true; groups = [legacy] }
  }
  if (groups.length && !groups.some(function (g) { return g.round === cur })) groups.push(normalizeRound({ round: cur }))
  // ㉝ 数据归属：意向确认**只认** rounds/r<N>/intent.confirm.json 归档的那一份。
  // 以前这里会把顶层 confirm 挂到当前轮，后果是 r2 的卡片上顶着 r1 的问题、用户点了答案
  // 却写进了错误的轮次。顶层的 confirm 现在只服务于「整单没有 rounds」的老订单合成（上面那段）。
  groups.sort(function (a, b) { return a.round - b.round })
  return { groups: groups, current: cur }
}

/* ------------------------------------------------------------------ *
 * 一轮里的五块内容：意向确认 / 吐槽 / 调查与转译 / 验收 / 决定
 * ------------------------------------------------------------------ */
let submitWait = null

/** 老单标记：整单没有 rounds 时才可能出现，且只出现在合成出来的那一轮上 */
function legacyTagHtml(synthetic) {
  if (!synthetic) return ''
  return '<span class="sl-badge" style="color:#8a8f98;font-weight:400">（阶段 1 · 旧单，无归档）</span>'
}

function confirmSectionHtml(c, round, isCurrent, synthetic) {
  // ㉝：本轮没有归档的意向确认就明说「本轮无意向确认」，不许拿别的轮次顶替
  if (!c || !c.questions || !c.questions.length) {
    return '<div class="sl-card gray"><div class="sl-meta" style="margin-top:0">📭 本轮无意向确认' + legacyTagHtml(synthetic) + '</div></div>'
  }
  const answered = Array.isArray(c.answers) && c.answers.length > 0
  // 等待卡片只在当前轮出现（历史轮只是回看，不该冒充「刚提交」）
  if (submitWait && isCurrent) {
    const at = new Date(submitWait.at)
    const hh = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
    return '<div class="sl-card blue"><div class="sl-ttl">✅ 已提交，等 Agent 继续</div>' +
      '<div class="sl-p">' + submitWait.count + ' 条选择已经送到流程。我这边每 3 秒看一眼状态，不会替你自动点完成。</div>' +
      '<div class="sl-meta">提交于 ' + hh + ' · 轮询中</div></div>'
  }
  const key = 'c' + round
  const open = foldOpen(key, !answered)
  const html = '<div class="sl-card ' + (answered ? 'gray' : 'amber') + '">' +
    foldHeadHtml(key, open, '<span class="sl-ttl">❓ 意向确认' + (answered ? '（已填）' : '（待你选）') + legacyTagHtml(synthetic) + '</span>',
      '<span class="sl-badge" style="margin-left:auto">' + (answered ? '已提交' : '待确认') + '</span>')
  let inner = ''
  for (const q of c.questions) {
    const picked = (c.answers || []).find(function (a) { return a && a.id === q.id })
    const rec = typeof q.recommend === 'number' ? q.recommend : -1
    inner += '<div class="sl-sub" style="border:1px solid #f3e6c8;border-radius:9px;padding:8px 10px;background:#fff">' +
      '<div class="sl-p" style="margin-top:0">' + esc(q.question) + '</div>' +
      (q.options || []).map(function (opt, i) {
        const on = picked ? picked.chosen === opt : i === rec
        return '<label class="sl-opt' + (on ? ' on' : '') + '"><input type="radio" name="' + esc(q.id) + '" value="' + esc(opt) + '"' +
          (on ? ' checked' : '') + (answered ? ' disabled' : '') + '>' +
          '<span class="sl-p" style="margin-top:0">' + esc(opt) +
          (i === rec ? '<span class="sl-badge" style="color:#1a73e8;border-color:#cfe0fd;margin-left:5px">推荐</span>' : '') +
          '</span></label>'
      }).join('') +
      (q.why ? '<div class="sl-meta">理由：' + esc(q.why) + '</div>' : '') + '</div>'
  }
  if (!answered) inner += '<button class="sl-btn" data-act="submit-intent">提交给流程</button>'
  return html + foldBodyHtml(open, inner) + '</div>'
}

function interruptsSectionHtml(list, round) {
  const items = Array.isArray(list) ? list : []
  if (!items.length) return ''
  const key = 't' + round
  const open = foldOpen(key, false)
  const body = items.slice(-8).map(function (it) {
    const state = it.expired ? '已过期 · 顺延下一轮' : '进下一轮工单'
    return '<div class="sl-tr"><div class="q">「' + esc(it.text) + '」</div><div class="m">' +
      esc(it.stage || '') + ' · ' + esc(String(it.at || '').slice(11, 16)) +
      ' · <span style="color:' + (it.expired ? '#c0392b' : '#2e9e5b') + '">' + esc(state) + '</span></div></div>'
  }).join('')
  return '<div class="sl-card amber">' +
    foldHeadHtml(key, open, '<span class="sl-ttl">💬 吐槽</span>',
      '<span class="sl-badge" style="margin-left:auto">' + items.length + ' 条</span>') +
    foldBodyHtml(open, '<div class="sl-trace">' + body + '</div>') + '</div>'
}

function planSectionHtml(g, isCurrent, state) {
  const plan = g.plan
  const intent = isCurrent && state ? state.intent : null
  const research = isCurrent && state ? state.research : null
  if (!plan && !intent && !research) return ''
  const key = 'p' + g.round
  const open = foldOpen(key, true)
  const html = '<div class="sl-card blue">' +
    foldHeadHtml(key, open, '<span class="sl-ttl">🔍 调查与转译</span>',
      (plan && plan.executor ? '<span class="sl-meta" style="margin-left:auto">执行 ' + esc(plan.executor) + '</span>' : ''))
  let inner = ''
  if (intent) {
    inner += '<div class="sl-p"><b>转译</b> · ' + esc(intent.restate) + '</div>' +
      '<div class="sl-meta">判据 ' + intent.criteria + ' 条（数值 ' + intent.numeric + ' / 人判 ' + intent.human + '）</div>'
  }
  if (research) {
    inner += '<div class="sl-meta">调查 ' + research.total + ' 条 · 带 URL ' + research.withUrl + ' · 用于决策 ' + research.used +
      (research.top && research.top[0] ? ' · 关键：' + esc(String(research.top[0]).slice(0, 60)) : '') + '</div>'
  }
  if (plan && plan.orders.length) {
    inner += '<div style="margin-top:6px">' + plan.orders.map(function (o) {
      return '<div class="sl-row"><span class="k">🗂 ' + esc(o.id) + '</span><span>' + esc(o.task) + '</span></div>'
    }).join('') + '</div>'
  }
  return html + foldBodyHtml(open, inner) + '</div>'
}

function verifySectionHtml(g) {
  const v = g.verify
  const rv = g.review
  if (!v && !rv) return ''
  const key = 'v' + g.round
  const open = foldOpen(key, true)
  const failed = !!(v && v.fail.length) || !!(rv && /不合格|不过|fail/i.test(String(rv.verdict || '')))
  const ttl = failed ? '⚠️ 验收 · 有不过的' : '✅ 验收'
  const html = '<div class="sl-card ' + (failed ? 'red' : 'green') + '">' +
    foldHeadHtml(key, open, '<span class="sl-ttl">' + ttl + '</span>',
      rv && rv.verdict ? '<span class="sl-badge" style="margin-left:auto">评审 ' + esc(rv.verdict) + '</span>' : '')
  let inner = ''
  if (v) {
    inner += '<div class="sl-p"><span style="color:#2e9e5b">过 ' + v.pass.length + '</span> · <span style="color:#c0392b">不过 ' + v.fail.length + '</span></div>'
    if (v.fail.length) inner += '<div class="sl-meta">' + v.fail.slice(0, 4).map(function (x) { return '❌ ' + esc(x) }).join(' · ') + '</div>'
    if (v.measuredBy) inner += '<div class="sl-meta">量法：' + esc(v.measuredBy) + '</div>'
  }
  return html + foldBodyHtml(open, inner) + '</div>'
}

function decideSectionHtml(d) {
  if (!d) return ''
  const gaps = d.gapsForNextRound || []
  const next = d.nextRoundOrders || []
  const key = 'd' + (next.length + '-' + (d.action || ''))
  const open = foldOpen(key, false)
  const html = '<div class="sl-card gray">' +
    foldHeadHtml(key, open, '<span class="sl-ttl">🔁 决定' + (d.action ? ' · ' + esc(d.action) : '') + '</span>',
      '<span class="sl-badge" style="margin-left:auto">' + (next.length ? '下一轮 ' + next.length + ' 张工单' : '无下一轮工单') + '</span>')
  let inner = ''
  if (gaps.length) inner += '<div class="sl-meta">要补的：' + gaps.slice(0, 6).map(function (x) { return '· ' + esc(String(x).slice(0, 60)) }).join(' ') + '</div>'
  if (next.length) inner += next.map(function (o) {
    return '<div class="sl-row"><span class="k">🗂 ' + esc(o.id || '') + '</span><span>' + esc(o.task || '') + '</span></div>'
  }).join('')
  return html + foldBodyHtml(open, inner) + '</div>'
}

function roundGroupHtml(g, isCurrent, state) {
  const key = 'r' + g.round
  const open = foldOpen(key, isCurrent)
  let badge = ''
  if (g.verify) badge = g.verify.fail.length ? '⚠️ 有不过' : '✅ 过了'
  else if (g.review && g.review.verdict) badge = esc(g.review.verdict)
  else if (g.plan) badge = '执行中'
  let html = '<div class="sl-rnd' + (isCurrent ? ' cur' : '') + '">' +
    '<div class="hd" data-fold="' + esc(key) + '" data-open="' + (open ? '1' : '0') + '">' +
    '<span class="cv" style="color:#8a8f98;font-size:11px;width:10px">' + (open ? '▾' : '▸') + '</span>' +
    '<span class="sl-ttl">🔄 第 ' + esc(g.round) + ' 轮' + (isCurrent ? ' · 当前' : '') + '</span>' +
    (badge ? '<span class="sl-badge" style="margin-left:auto">' + badge + '</span>' : '') + '</div>'
  const inner = confirmSectionHtml(g.confirm, g.round, isCurrent, !!g.synthetic) +
    interruptsSectionHtml(g.interrupts, g.round) +
    planSectionHtml(g, isCurrent, state) +
    verifySectionHtml(g) +
    decideSectionHtml(g.decide)
  // ㉛：轮次内容容器同样 min-width:0，长任务名不会把卡片顶出面板
  return html + foldBodyHtml(open, '<div class="bd" style="min-width:0;overflow-wrap:anywhere">' + inner + '</div>') + '</div>'
}

/** 面板主视图：状态卡 → 需求原文 → 参考与产物 → 按轮分组 */
function roundPanelHtml(state, win) {
  if (!state) return statusCardHtml(state)
  let html = statusCardHtml(state)
  html += requirementCardHtml(state)
  html += thumbsHtml(state)
  const grouped = groupRounds(state)
  if (!grouped.groups.length) {
    html += '<div class="sl-card gray"><div class="sl-ttl">🗂 还没有轮次数据</div>' +
      '<div class="sl-p">下单后这里按轮显示：意向确认 / 吐槽 / 调查与转译 / 验收。</div></div>'
  }
  for (const g of grouped.groups) html += roundGroupHtml(g, g.round === grouped.current, state)
  return html
}

/* ------------------------------------------------------------------ *
 * 流转状态（原样保留）与参考/产物缩略图
 * ------------------------------------------------------------------ */
function metroHtml(state) {
  if (!state) return '<div class="sl-txt">还没有数据</div>'
  let html = '<div class="sl-metro"><div class="line"></div>'
  const cur = state.currentNode && state.currentNode.id
  for (const n of state.nodes || []) {
    const isCur = n.id === cur
    const status = n.status === 'done' ? 'done' : isCur ? (n.kind === 'human' ? 'red' : 'run') : 'todo'
    html += '<div class="sl-node ' + status + '"><div class="n"></div><div class="tx"><span class="id">' + esc(n.id) + '</span> · ' + esc(n.title) + '</div></div>'
  }
  return html + '</div>'
}

function thumbsHtml(state) {
  const refs = (state.refs || []).slice(0, 8)
  const shots = (state.shots || []).slice(0, 4)
  if (!refs.length && !shots.length) return ''
  const cell = function (name, tag) {
    return '<div><img class="sl-thumb" loading="lazy" src="' + SHOT_ROUTE + '?name=' + encodeURIComponent(name) + '" alt="">' +
      '<div class="sl-meta" style="display:block;margin-top:2px">' + esc(tag) + '</div></div>'
  }
  let html = '<div class="sl-card gray"><div class="sl-ttl">🖼 参考与产物</div><div class="sl-meta">' + (refs.length + shots.length) + ' 张</div>' +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px">'
  for (const s of shots) html += cell(s, String(s).split('/').pop().replace('.png', ''))
  for (const r of refs) html += cell(r, String(r).split('/').pop().replace('.png', ''))
  return html + '</div></div>'
}

/* ------------------------------------------------------------------ *
 * 面板骨架：标题栏 / 订单下拉（只显示标题）/ 吐槽框 / 新订单
 * ------------------------------------------------------------------ */
function orderBarHtml(state) {
  const orders = (state && state.orders) || []
  if (!orders.length) return ''
  const cur = orders.find(function (o) { return o.current }) || orders[0]
  // 待办 4：下拉只显示任务标题（状态在胶囊上已经有了），收窄到面板宽度内
  const labelOf = function (o) { return String((o && (o.title || o.name)) || '').slice(0, 16) }
  const items = orders.map(function (o) {
    return '<div class="it' + (o.current ? ' cur' : '') + '" data-order="' + esc(o.dir) + '">' + esc(labelOf(o)) + '</div>'
  }).join('')
  return '<button class="sl-order" data-act="order-menu" title="切换查看历史订单">' + esc(labelOf(cur)) + ' ⌄</button>' +
    '<div class="sl-menu" data-order-menu>' + items + '</div>'
}

function ventFooterHtml(state, win) {
  const open = !!(win && win.open)
  const stage = (win && win.stage) || (state && state.currentNode && state.currentNode.id) || ''
  return '<div class="sl-foot">' +
    '<div class="row1"><span class="st ' + (open ? 'open' : 'closed') + '">' + (open ? '● 吐槽窗口开放中' : '● 窗口已关闭') + '</span>' +
    '<span>' + (open ? '现在说进下一轮工单' : '仍可写，会标 expired 顺延下一轮') + '</span></div>' +
    '<textarea class="sl-ta" data-vent placeholder="想到什么说什么——哪里看着不对、哪里太生硬，说具体点就行"></textarea>' +
    '<div class="row1" style="margin-top:6px"><span>Ctrl+Enter 发送</span><span style="margin-left:auto"><span data-count>0</span> / 500</span></div>' +
    '<button class="sl-btn" data-act="send-vent">发送到 selfloop' + (stage ? '（' + esc(stage) + '）' : '') + '</button>' +
    '</div>'
}

function newOrderFooterHtml(state) {
  const live = orderLive(state)
  return '<div style="border-top:1px solid #f0f0f2;padding:10px 12px;background:#fcfcfd">' +
    '<button class="sl-newbtn" data-act="new-order"' + (live ? ' disabled' : '') + '>' + (live ? '＋ 新订单（当前单进行中）' : '＋ 新订单') + '</button>' +
    (live ? '<div class="sl-newhint">当前订单未结束，结束或交付后才能开新单</div>' : '') +
    '</div>'
}

function panelHtml(tab, stateOverride, winOverride) {
  const state = stateOverride === undefined ? store.state : stateOverride
  const win = winOverride === undefined ? store.window : winOverride
  const body = tab === 'flow' ? metroHtml(state) : roundPanelHtml(state, win)
  return '<div class="sl-sh"><span class="sl-fold" data-act="close" title="收起右侧栏">«</span>' +
    '<div class="sl-tab ' + (tab !== 'flow' ? 'on' : '') + '" data-tab="auto">肥鱼接单</div>' +
    '<div class="sl-tab ' + (tab === 'flow' ? 'on' : '') + '" data-tab="flow">流转状态</div>' +
    '<span class="sl-title">' + orderBarHtml(state) + '</span></div>' +
    '<div class="sl-body" style="min-width:0;overflow-wrap:anywhere">' + body + '</div>' + ventFooterHtml(state, win) + newOrderFooterHtml(state)
}

/* ------------------------------------------------------------------ *
 * 吐槽输入框：重绘前存 value + 选区，重绘后回填；输入中 2s 内不重绘（待办 16）
 * ------------------------------------------------------------------ */
let ventTypingUntil = 0
let ventFlushTimer = null

function captureVent(root) {
  try {
    const ta = root && root.querySelector ? root.querySelector('[data-vent]') : null
    if (!ta) return null
    const active = !!(typeof document !== 'undefined' && document.activeElement === ta)
    return {
      value: String(ta.value || ''),
      start: Number(ta.selectionStart || 0),
      end: Number(ta.selectionEnd || 0),
      active: active,
    }
  } catch (e) { return null }
}

function restoreVent(root, snap) {
  if (!snap || !root || !root.querySelector) return
  try {
    const ta = root.querySelector('[data-vent]')
    if (!ta) return
    if (String(ta.value || '') !== snap.value) ta.value = snap.value
    // 选区无条件回填（重绘不该让光标跳回开头）；只有本来聚焦过才抢焦点，免得从别处偷焦点
    if (typeof ta.setSelectionRange === 'function') {
      try { ta.setSelectionRange(snap.start, snap.end) } catch (e) { /* number/email 这类 input 不支持 */ }
    }
    if (snap.active && typeof ta.focus === 'function') ta.focus()
    const cnt = root.querySelector('[data-count]')
    if (cnt) cnt.textContent = String(snap.value.length)
  } catch (e) { /* 回填失败就不回填，别炸 */ }
}

function ventQuiet(now) {
  return (now === undefined ? Date.now() : now) < ventTypingUntil
}

/* ------------------------------------------------------------------ *
 * 面板 DOM
 * ------------------------------------------------------------------ */
let panelEl = null
let panelTab = 'auto'

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-selfloop': '1' },
    body: JSON.stringify(body || {}),
  })
  let data
  try { data = await res.json() } catch (e) { data = { ok: false, error: 'bad-json' } }
  return { status: res.status, data }
}

function flash(message) {
  if (!panelEl) return
  const bar = document.createElement('div')
  bar.textContent = message
  bar.style.cssText = 'position:absolute;left:12px;right:12px;bottom:12px;background:#1a73e8;color:#fff;border-radius:8px;padding:8px 12px;font-size:12.5px;box-shadow:0 6px 18px rgba(0,0,0,.18);z-index:5'
  panelEl.appendChild(bar)
  setTimeout(function () { try { bar.remove() } catch (e) { /* 已经没了 */ } }, 2600)
}

async function sendVent() {
  const ta = panelEl && panelEl.querySelector('[data-vent]')
  if (!ta) return
  const text = String(ta.value || '').trim()
  if (!text) { flash('先写点什么'); return }
  const stage = (store.window && store.window.stage) || (store.state && store.state.currentNode && store.state.currentNode.id) || ''
  const r = await postJson(INTERRUPT_ROUTE, { text: text, stage: stage })
  if (r.status === 200 || r.status === 409) {
    ta.value = ''
    ventTypingUntil = 0
    const cnt = panelEl.querySelector('[data-count]')
    if (cnt) cnt.textContent = '0'
    await refresh()
    drawPanel()
    flash(r.status === 409 ? '窗口已关：这条标 expired，顺延下一轮' : '已收到，会进下一轮工单')
  } else {
    flash('没发出去：' + ((r.data && r.data.error) || r.status))
  }
}

async function submitIntent() {
  if (!panelEl) return
  const qs = (store.state && store.state.confirm && store.state.confirm.questions) || []
  const answers = []
  for (const q of qs) {
    const el = panelEl.querySelector('input[name="' + q.id + '"]:checked')
    if (el) answers.push({ id: q.id, chosen: el.value })
  }
  if (!answers.length) { flash('还没选'); return }
  const before = (store.state && store.state.status && store.state.status.node) || ''
  const r = await postJson(ANSWERS_ROUTE, { answers: answers })
  if (r.status === 200) {
    // 待办 7：提交后不停住——卡片立刻切成「已提交，等 Agent 继续」，继续 3s 轮询（不自动 done）
    submitWait = { count: answers.length, at: Date.now(), node: before }
    lastHtml = ''
    await refresh()
    drawPanel()
    startPolling()
    flash('已提交 ' + answers.length + ' 条选择，等 Agent 继续')
  } else flash('提交失败：' + ((r.data && r.data.error) || r.status))
}

function ensurePanel() {
  if (panelEl && panelEl.isConnected) return panelEl
  panelEl = document.createElement('div')
  panelEl.className = 'sl-panel'
  panelEl.style.width = PANEL_WIDTH + 'px'
  document.body.appendChild(panelEl)
  // 用 pointerdown 而不是 click：轮询每 3s 重绘一次 innerHTML，
  // 元素在 mousedown 与 mouseup 之间被换掉时 click 永远不触发（2026-11-17 实测：分栏点不动）。
  panelEl.addEventListener('pointerdown', function (ev) {
    const tab = ev.target.closest('[data-tab]')
    if (tab) { panelTab = tab.getAttribute('data-tab'); drawPanel(); return }
    if (ev.target.closest('[data-act="close"]')) { panelEl.classList.remove('on'); return }
    if (ev.target.closest('[data-act="send-vent"]')) { sendVent(); return }
    if (ev.target.closest('[data-act="submit-intent"]')) { submitIntent(); return }
    if (ev.target.closest('[data-act="order-menu"]')) {
      const menu = panelEl.querySelector('[data-order-menu]')
      if (menu) menu.classList.toggle('on')
      return
    }
    const orderItem = ev.target.closest('[data-order]')
    if (orderItem) {
      viewRun = orderItem.getAttribute('data-order') || ''
      panelFold = {}
      const menu = panelEl.querySelector('[data-order-menu]')
      if (menu) menu.classList.remove('on')
      refresh()
      return
    }
    if (ev.target.closest('[data-act="new-order"]')) { toggleComposerMode(true); return }
    const foldEl = ev.target.closest('[data-fold]')
    if (foldEl) {
      const key = foldEl.getAttribute('data-fold')
      panelFold[key] = foldEl.getAttribute('data-open') !== '1'
      drawPanel()
      return
    }
  })
  listeners.add(function () { if (panelEl.classList.contains('on')) drawPanel() })
  panelEl.addEventListener('input', function (ev) {
    const ta = ev.target && ev.target.closest ? ev.target.closest('[data-vent]') : null
    if (!ta) return
    const counter = panelEl.querySelector('[data-count]')
    if (counter) counter.textContent = String(String(ta.value || '').length)
    ventTypingUntil = Date.now() + VENT_SILENCE_MS
    if (ventFlushTimer) clearTimeout(ventFlushTimer)
    ventFlushTimer = setTimeout(function () { drawPanel() }, VENT_SILENCE_MS + 80)
  })
  panelEl.addEventListener('keydown', function (ev) {
    const ta = ev.target && ev.target.closest ? ev.target.closest('[data-vent]') : null
    if (ta && ev.key === 'Enter' && ev.ctrlKey) { ev.preventDefault(); sendVent() }
  })
  return panelEl
}

let lastHtml = ''
function drawPanel() {
  if (!panelEl) return
  if (ventQuiet()) return
  const snap = captureVent(panelEl)
  const bodyBefore = panelEl.querySelector ? panelEl.querySelector('.sl-body') : null
  const scrollTop = bodyBefore ? bodyBefore.scrollTop || 0 : 0
  const html = panelHtml(panelTab)
  // 内容没变就别重建 DOM：重建会打断点击，也会让滚动位置跳回顶部
  if (html !== lastHtml || !panelEl.classList.contains('on')) {
    lastHtml = html
    panelEl.innerHTML = html
  }
  restoreVent(panelEl, snap)
  const bodyAfter = panelEl.querySelector ? panelEl.querySelector('.sl-body') : null
  if (bodyAfter && scrollTop) bodyAfter.scrollTop = scrollTop
}

function openPanel() {
  try {
    ensurePanel()
    panelEl.classList.add('on')
    startPolling()
    drawPanel()
  } catch (e) { logWarn('右侧栏打开失败：' + e.message) }
}

function togglePanel() {
  try {
    ensurePanel()
    panelEl.classList.toggle('on')
    if (panelEl.classList.contains('on')) { startPolling(); drawPanel() }
  } catch (e) { logWarn('面板打开失败：' + e.message) }
}

/* ------------------------------------------------------------------ *
 * 接单模式（下单框）：标题 + 需求 + 参考 + 调查/执行模型 + 预算
 * ------------------------------------------------------------------ */
let modeEl = null
let modeRefs = []
let modeHost = null
let modeHostPrev = ''
const modeForm = { req: '', title: '', research: 'high', rounds: 3, researchModel: '', execModel: '', researchEffort: EFFORT_DEFAULT, execEffort: EFFORT_DEFAULT }

/**
 * 从胶囊往上找「真实输入框容器」：最近一个包含 textarea / contenteditable 的祖先。
 * 为什么从胶囊找而不是 document.querySelector：胶囊本身就在 composer.dock 里，
 * 沿祖先链找最稳，不依赖宿主的类名（那玩意会变）。
 */
function findComposerHost(fromEl) {
  let node = fromEl
  let best = null
  for (let i = 0; i < 8 && node; i += 1) {
    const hasInput = node.querySelector && node.querySelector('textarea,[contenteditable="true"]')
    if (hasInput && node.getBoundingClientRect) {
      const r = node.getBoundingClientRect()
      // 只认「像输入框那条」的容器：太高就把整页都藏了（2026-11-17 差点踩）
      if (r.height > 40 && r.height <= 340 && r.width > 240) best = node
    }
    node = node.parentElement
  }
  return best
}

/** 把我们这块按真实输入框的矩形摆好（宽/底部对齐），并把握不住的宿主藏起来。 */
function alignModeToHost(chipEl) {
  if (!modeEl) return
  const host = findComposerHost(chipEl) || findComposerHost(modeEl)
  if (!host) return
  const rect = host.getBoundingClientRect()
  modeEl.style.left = rect.left + 'px'
  modeEl.style.width = rect.width + 'px'
  modeEl.style.bottom = Math.max(8, window.innerHeight - rect.bottom) + 'px'
  modeEl.style.transform = 'none'
  if (modeHost !== host) {
    if (modeHost && modeHostPrev !== undefined) modeHost.style.visibility = modeHostPrev
    modeHost = host
    modeHostPrev = host.style.visibility || ''
  }
  host.style.visibility = 'hidden'
}

function releaseModeHost() {
  if (modeHost) {
    modeHost.style.visibility = modeHostPrev || ''
    modeHost = null
  }
}

function ensureMode() {
  if (modeEl && modeEl.isConnected) return modeEl
  modeEl = document.createElement('div')
  modeEl.className = 'sl-mode'
  document.body.appendChild(modeEl)
  modeEl.addEventListener('click', function (ev) {
    if (ev.target.closest('[data-act="mode-close"]')) { toggleComposerMode(false); return }
    if (ev.target.closest('[data-act="mode-addref"]')) {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = 'image/*,video/*,.txt,.md,.json,.cs,.js,.ts,.py,.ps1'
      input.addEventListener('change', function () {
        for (const f of Array.from(input.files || [])) modeRefs.push(f)
        drawMode()
      })
      input.click()
      return
    }
    const rm = ev.target.closest('[data-rm]')
    if (rm) { modeRefs.splice(Number(rm.getAttribute('data-rm')), 1); drawMode(); return }
    if (ev.target.closest('[data-act="mode-submit"]')) { submitMode(); return }
  })
  const matches = function (el, sel) {
    return !!(el && typeof el.matches === 'function' && el.matches(sel))
  }
  modeEl.addEventListener('input', function (ev) {
    const t = ev.target
    if (matches(t, '[data-req]')) modeForm.req = t.value
    else if (matches(t, '[data-title]')) modeForm.title = t.value
  })
  modeEl.addEventListener('change', function (ev) {
    const t = ev.target
    // 换模型要重画：可选的努力档、禁用态、提示都跟着模型走
    if (matches(t, '[data-research-model]')) { modeForm.researchModel = t.value; drawMode(); return }
    if (matches(t, '[data-exec-model]')) { modeForm.execModel = t.value; drawMode(); return }
    if (matches(t, '[data-research-effort]')) modeForm.researchEffort = t.value
    else if (matches(t, '[data-exec-effort]')) modeForm.execEffort = t.value
    else if (matches(t, '[data-research]')) modeForm.research = t.value
    else if (matches(t, '[data-rounds]')) modeForm.rounds = t.value
  })
  return modeEl
}

/** 下单框 html（纯函数，测试直接拿它断言模型下拉存在） */
function modeHtml(state) {
  const models = (state && state.models) || {}
  const refs = modeRefs.map(function (f, i) {
    return '<div class="sl-ref"><span style="position:absolute;left:3px;bottom:2px;font-size:9px;color:#fff">' + esc(f.name) + '</span>' +
      '<div class="rm" data-rm="' + i + '">×</div></div>'
  }).join('')
  const rounds = [1, 2, 3, 4, 5].map(function (n) {
    const on = String(modeForm.rounds) === String(n) || (modeForm.rounds === undefined && n === 3)
    return '<option value="' + n + '"' + (on ? ' selected' : '') + '>' + n + '</option>'
  }).join('')
  const research = ['high', 'max', 'mid', 'low'].map(function (lvl) {
    return '<option value="' + lvl + '"' + (modeForm.research === lvl ? ' selected' : '') + '>调研 ' + lvl + '</option>'
  }).join('')
  return '<div class="mhead"><span class="tag">肥鱼接单</span><span>说清目标 + 放参考，下单后我按闭环流程跑</span><span class="x" data-act="mode-close">退出</span></div>' +
    '<div class="sl-refs">' + refs + '<div class="sl-addref" data-act="mode-addref">+</div></div>' +
    '<input class="ttl-in" data-title placeholder="标题（可不填，留空自动截取需求首句）" value="' + esc(modeForm.title) + '">' +
    '<textarea class="req" data-req rows="1" placeholder="要做什么？一句话描述目标，例如：把这个特效调成参考片的样子">' + esc(modeForm.req) + '</textarea>' +
    '<div class="mfoot">' +
      '<span class="mf-lb">调查模型</span>' + modelSelectHtml('research-model', modeForm.researchModel, models) +
      '<span class="mf-lb">努力程度 · 调查</span>' + effortHtml('research-effort', modeForm.researchEffort, models, modeForm.researchModel) +
      '<span class="mf-lb">执行模型</span>' + modelSelectHtml('exec-model', modeForm.execModel, models) +
      '<span class="mf-lb">努力程度 · 执行</span>' + effortHtml('exec-effort', modeForm.execEffort, models, modeForm.execModel) +
      '<span class="sl-meta" title="live=从宿主 llm 服务实时拉取；fallback=插件内置清单，可能少了你新装的模型">' + (models.source === 'live' ? '🟢 实时' : '🟡 兜底') + '</span>' +
      '<span class="mf-lb">调研</span><select class="sl-sel" data-research>' + research + '</select>' +
      '<span class="mf-lb">轮数</span><select class="sl-sel" data-rounds>' + rounds + '</select>' +
      '<button class="sl-send" data-act="mode-submit">下单</button>' +
    '</div>'
}

function drawMode() {
  if (!modeEl) return
  modeEl.innerHTML = modeHtml(store.state)
}

/** /start 请求体（纯函数）：模型没选就是 null = 由主 Agent 分配；title 留空就交给后端截断 */
function buildStartBody(req, refs, form) {
  const f = form || {}
  const body = {
    requirement: String(req == null ? '' : req),
    refs: Array.isArray(refs) ? refs : [],
    budget: { research: f.research || 'high', maxRounds: Number(f.rounds || 3) },
    researchModel: parseModel(f.researchModel),
    execModel: parseModel(f.execModel),
    // ⑱⑳：努力程度跟着两个模型各走一份（后端落进 order.json）
    researchEffort: effortValue(f.researchEffort),
    execEffort: effortValue(f.execEffort),
    session: sessionKey() || null,
  }
  const title = String(f.title || '').trim()
  if (title) body.title = title
  return body
}

/**
 * 展开 GIF：用浏览器自带的 ImageDecoder 逐帧解，再画到 canvas 导出 PNG。
 * 为什么在客户端做：参考片常是 GIF（雷暴那次就是），而 preflight 只量 PNG。
 * 拿不到 ImageDecoder 时不阻塞下单，原样传上去并在界面上提示「这一单的 GIF 可能量不了」。
 */
async function explodeGif(file, cap) {
  const limit = cap || 60
  if (typeof ImageDecoder === 'undefined') return { frames: [], skipped: true }
  try {
    const buf = await file.arrayBuffer()
    const decoder = new ImageDecoder({ data: buf, type: file.type || 'image/gif' })
    await decoder.tracks.ready
    const track = decoder.tracks.selectedTrack
    const total = Math.min(track ? track.frameCount : 1, limit)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const out = []
    const base = String(file.name || 'ref').replace(/\.[^.]+$/, '')
    for (let i = 0; i < total; i += 1) {
      const { image } = await decoder.decode({ frameIndex: i })
      canvas.width = image.displayWidth || image.codedWidth
      canvas.height = image.displayHeight || image.codedHeight
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0)
      if (image.close) image.close()
      const blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png') })
      if (!blob) continue
      out.push(new File([blob], base + '-g' + String(i + 1).padStart(3, '0') + '.png', { type: 'image/png' }))
    }
    try { decoder.close() } catch (e) { /* 已关闭 */ }
    return { frames: out, skipped: false }
  } catch (e) {
    logWarn('GIF 拆帧失败：' + e.message)
    return { frames: [], skipped: true }
  }
}

async function submitMode() {
  const ta = modeEl && modeEl.querySelector('[data-req]')
  if (ta && typeof ta.value === 'string') modeForm.req = ta.value
  const req = String(modeForm.req || '').trim()
  if (req.length < 8) { flash('需求太短了，至少 8 个字'); return }
  if (orderLive(store.state)) { flash('当前订单还没结束，不能在同一个会话里开新单'); return }
  const btn = modeEl.querySelector('[data-act="mode-submit"]')
  if (btn) { btn.disabled = true; btn.textContent = '下单中…' }
  const refs = []
  let gifSkipped = false
  try {
    const expanded = []
    for (const f of modeRefs) {
      const isGif = /\.gif$/i.test(f.name || '') || f.type === 'image/gif'
      if (isGif) {
        const got = await explodeGif(f)
        if (got.skipped || !got.frames.length) { gifSkipped = true; expanded.push(f) }
        else got.frames.forEach(function (x) { expanded.push(x) })
      } else expanded.push(f)
    }
    modeRefs = expanded
    for (const f of modeRefs) {
      if (f.size > 8 * 1024 * 1024) { flash(f.name + ' 超过 8MB'); return }
      const buf = await f.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
      refs.push({ name: f.name, data: btoa(bin) })
    }
  } catch (e) {
    flash('读文件失败：' + e.message)
    return
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '下单' }
  }
  const body = buildStartBody(req, refs, modeForm)
  const r = await postJson(START_ROUTE, body)
  if (r.status === 200) {
    modeRefs = []
    modeForm.req = ''
    modeForm.title = ''
    modeForm.researchModel = ''
    modeForm.execModel = ''
    modeForm.researchEffort = EFFORT_DEFAULT
    modeForm.execEffort = EFFORT_DEFAULT
    toggleComposerMode(false)
    await refresh()
    flash('已下单：' + (r.data.run || '') + (refs.length ? '（' + refs.length + ' 个参考）' : '') + (gifSkipped ? ' · GIF 未能拆帧，可能量不了' : ''))
  } else {
    flash('下单失败：' + ((r.data && r.data.error) || r.status))
  }
}

function toggleComposerMode(next, chipEl) {
  try {
    ensureMode()
    composerMode = typeof next === 'boolean' ? next : !composerMode
    modeEl.classList.toggle('on', composerMode)
    if (composerMode) {
      alignModeToHost(chipEl || lastChipEl)
      drawMode()
    } else {
      releaseModeHost()
    }
    listeners.forEach(function (fn) { try { fn() } catch (e) { /* 单个订阅者失败不影响别人 */ } })
  } catch (e) {
    logWarn('接单模式切换失败：' + e.message)
  }
}

/* ------------------------------------------------------------------ *
 * 槽位挂载
 * ------------------------------------------------------------------ */
function mountChip(slots, createElement) {
  function Chip() {
    const onRef = function (el) {
      if (!el || el.dataset.slReady) return
      el.dataset.slReady = '1'
      el.className = 'sl-chip'
      lastChipEl = el
      el.addEventListener('click', function () {
        // 契约 §6：跑单中点胶囊＝打开/聚焦右侧栏（不弹下单框）；只有无单或已结束才进接单模式
        if (chipClickAction(store.state) === 'panel') { openPanel(); return }
        toggleComposerMode(undefined, el)
      })
      listeners.add(function () { renderChip(el) })
      startPolling()
      renderChip(el)
    }
    return createElement('span', { ref: onRef })
  }
  slots.inject('conversation.composer.dock', function () {
    return slots.register({ name: 'conversation.composer.dock', id: PLUGIN_ID + '-chip', order: 20 }, Chip)
  })
}

function mountHeaderAction(slots, createElement) {
  function Btn() {
    const onRef = function (el) {
      if (!el || el.dataset.slReady) return
      el.dataset.slReady = '1'
      el.className = 'sl-hact'
      el.textContent = '肥鱼接单'
      el.addEventListener('click', togglePanel)
    }
    return createElement('span', { ref: onRef })
  }
  slots.inject('conversation.session.header.actions', function () {
    return slots.register({ name: 'conversation.session.header.actions', id: PLUGIN_ID + '-header', order: 30 }, Btn)
  })
}

function apply(ctx) {
  try {
    injectStyle()
    // 与大肥鱼同款取值顺序：先按属性（声明过 inject 才可读），再 ctx.get，最后才是上下文本身
    const slots = pickSlots(ctx && ctx.slots) || pickSlots(ctx && ctx.get ? ctx.get('slots', true) : undefined) || pickSlots(ctx)
    if (!slots) { logWarn('没拿到 slots 服务，UI 不挂载（插件其余部分照常）'); return }
    let createElement
    try {
      const react = require('react')
      createElement = react && react.createElement
    } catch (e) { logWarn('拿不到 react.createElement：' + e.message); return }
    if (typeof createElement !== 'function') { logWarn('react.createElement 不是函数，UI 不挂载'); return }
    try { mountChip(slots, createElement) } catch (e) { logWarn('胶囊挂载失败：' + e.message) }
    try { mountHeaderAction(slots, createElement) } catch (e) { logWarn('标题栏按钮挂载失败：' + e.message) }
    // 下单入口已并入胶囊（无订单时胶囊就是「＋ 肥鱼接单」），不再单挂一颗按钮
  } catch (e) { logWarn('apply 失败：' + e.message) }
}

exports.name = PLUGIN_ID
exports.inject = ['slots']
exports.apply = apply
exports.__routes = { STATE_ROUTE: STATE_ROUTE, WINDOW_ROUTE: WINDOW_ROUTE, INTERRUPT_ROUTE: INTERRUPT_ROUTE, ANSWERS_ROUTE: ANSWERS_ROUTE }
// 测试面：纯函数留口子给 test/client-render.test.mjs 直接断言（浏览器里没有任何调用方）
exports.__ui = {
  chipClickAction: chipClickAction,
  orderLive: orderLive,
  confirmPending: confirmPending,
  chipText: chipText,
  panelHtml: panelHtml,
  roundPanelHtml: roundPanelHtml,
  modeHtml: modeHtml,
  modelSelectHtml: modelSelectHtml,
  buildStartBody: buildStartBody,
  parseModel: parseModel,
  modelEfforts: modelEfforts,
  setModeForm: function (patch) { Object.assign(modeForm, patch || {}) },
  modeForm: function () { return Object.assign({}, modeForm) },
  groupRounds: groupRounds,
  currentRound: currentRound,
  foldOpen: foldOpen,
  setFold: function (key, open) { panelFold[key] = open },
  resetFold: function () { panelFold = {} },
  captureVent: captureVent,
  restoreVent: restoreVent,
  ventQuiet: ventQuiet,
  noteTyping: function (ms) { ventTypingUntil = Date.now() + (ms === undefined ? VENT_SILENCE_MS : ms) },
  clearTyping: function () { ventTypingUntil = 0 },
  marksSubmitted: function (has) { submitWait = has ? { count: 2, at: Date.now(), node: '' } : null },
  VENT_SILENCE_MS: VENT_SILENCE_MS,
}

    return module.exports;
  },
});
