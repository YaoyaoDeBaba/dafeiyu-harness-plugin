// client.js —— selfloop 的浏览器半边（2026-11-17）
//
// 结构照抄大肥鱼那颗 pill 的三条经验：
//   ① 组件只返回一个带稳定 ref 的空 span，真实 DOM 自己管（宿主重渲染不会拆掉）
//   ② react 只在运行期向 loader 要（静态 import 失败会整页 boot 失败）
//   ③ 任何一步抛错只留日志，绝不抛进 loader
//
// 挂两个槽位（都已在本代宿主内置插件里验证过存在）：
//   conversation.composer.dock          输入框底部那颗胶囊（状态 + 窗口倒计时）
//   conversation.session.header.actions 标题栏那颗「肥鱼自治」按钮
// 面板由插件自己 docked 到右侧渲染；视图与数据层分离，日后可整体换挂到原生右侧栏 tab。
// 注意：本文件是**裸脚本**，由 tools/build-client.mjs 包进 __ModuleLoader__ 外壳，
// 所以不写 import/export，只用 exports.*（相对路径 import 在外壳里解析不到）。

// 路由必须写成**完整字面量**：与宿主侧 lib/routes.js 的 ROUTES 逐字一致，
// 有一条测试在比对这两边（拼字符串会让漂移检查失效）。
const STATE_ROUTE = '/plugins/dsh-selfloop/state'
const WINDOW_ROUTE = '/plugins/dsh-selfloop/window'
const INTERRUPT_ROUTE = '/plugins/dsh-selfloop/interrupt'
const ANSWERS_ROUTE = '/plugins/dsh-selfloop/intent-answers'

const PLUGIN_ID = 'dsh-selfloop'
const STYLE_ID = 'dsh-selfloop/ui.css'
const POLL_MS = 3000
const PANEL_WIDTH = 432

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
'.sl-hact{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:7px;border:1px solid #e3e3e8;background:#fff;font-size:12px;color:#5f6368;cursor:pointer}',
'.sl-panel{position:fixed;top:40px;right:0;bottom:0;background:#fff;border-top-left-radius:10px;border-left:1px solid #e8e8ec;z-index:2147483000;display:none;flex-direction:column;box-shadow:-8px 0 24px rgba(0,0,0,.06);font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328}',
'.sl-panel.on{display:flex}',
'.sl-sh{display:flex;align-items:center;gap:6px;padding:9px 12px 0;border-bottom:1px solid #f0f0f2}',
'.sl-tab{padding:7px 12px;font-size:12.5px;color:#8a8f98;cursor:pointer;border-bottom:2px solid transparent}',
'.sl-tab.on{color:#1a73e8;font-weight:600;border-bottom-color:#1a73e8}',
'.sl-fold{cursor:pointer;color:#8a8f98;padding:0 6px 0 2px;font-size:15px;line-height:1}',
'.sl-fold:hover{color:#1a73e8}',
'.sl-title{font-size:12.5px;font-weight:600;color:#3c4043;margin-left:auto;padding-right:4px}',
'.sl-body{flex:1;overflow:auto;padding:14px}',
'.sl-sec{margin-bottom:16px}',
'.sl-h{font-size:11.5px;color:#8a8f98;font-weight:600;letter-spacing:.03em;margin-bottom:7px;display:flex;align-items:center;gap:6px}',
'.sl-h .ln{flex:1;height:1px;background:#f0f0f2}',
'.sl-cta{border:1px solid #cfe0fd;background:linear-gradient(180deg,#f4f8ff,#fff);border-radius:12px;padding:12px}',
'.sl-cta.warn{border-color:#f5d9a8;background:linear-gradient(180deg,#fffaf0,#fff)}',
'.sl-cta .t{font-size:13px;font-weight:600;color:#1a73e8;margin-bottom:5px}',
'.sl-cta.warn .t{color:#a36a00}',
'.sl-cta .d{font-size:12.5px;color:#3c4043;margin-bottom:9px}',
'.sl-btn{background:#1a73e8;color:#fff;border:0;border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer}',
'.sl-txt{font-size:12.5px;line-height:1.6;color:#3c4043}',
'.sl-row{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;margin-bottom:6px}',
'.sl-row .k{color:#8a8f98;min-width:52px;flex:none}',
'.sl-badge{font-size:10.5px;border-radius:5px;padding:0 5px;border:1px solid #e6e6ea;color:#5f6368}',
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
'.sl-ta{width:100%;min-height:132px;border:1px solid #e3e3e8;border-radius:9px;padding:10px 12px;font:inherit;font-size:13px;line-height:1.6;resize:vertical;margin-top:10px;box-sizing:border-box}',
'.sl-meta{display:flex;gap:8px;align-items:center;margin-top:6px;font-size:11px;color:#9aa0a6}',
'.sl-trace{border:1px solid #eee;border-radius:10px;overflow:hidden}',
'.sl-tr{padding:8px 10px;border-bottom:1px solid #f4f4f6}',
'.sl-tr:last-child{border-bottom:0}',
'.sl-tr .q{font-size:12.5px;margin-bottom:2px}',
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

async function refresh() {
  try {
    const pair = await Promise.all([fetchJson(STATE_ROUTE), fetchJson(WINDOW_ROUTE)])
    store.state = pair[0]
    store.window = pair[1]
    store.error = null
    store.at = Date.now()
  } catch (e) { store.error = e.message }
  listeners.forEach(function (fn) { try { fn() } catch (e) { /* 单个订阅者失败不影响别人 */ } })
}

let pollTimer = null
function startPolling() {
  refresh()
  if (pollTimer) return
  pollTimer = setInterval(refresh, POLL_MS)
}

function statusOf() {
  const cur = store.state && store.state.currentNode
  const w = store.window || {}
  if (!cur) return { kind: 'done', label: '全部完成', win: '' }
  if (w.open && w.reason === 'human') return { kind: 'red', label: '等你处理 · ' + (cur.title || cur.id), win: '' }
  if (w.open) return { kind: 'run', label: cur.title || cur.id, win: '窗口开放中' }
  return { kind: 'wait', label: cur.title || cur.id, win: '' }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>\"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c]
  })
}

function renderChip(el) {
  const s = statusOf()
  el.innerHTML = '<span class=\"sl-dot ' + s.kind + '\"></span><span>selfloop · ' + esc(s.label) + '</span>' +
    (s.win ? '<span class=\"sl-win open\">' + esc(s.win) + '</span>' : '')
}

function metroHtml(state) {
  if (!state) return '<div class=\"sl-txt\">还没有数据</div>'
  let html = '<div class=\"sl-metro\"><div class=\"line\"></div>'
  const cur = state.currentNode && state.currentNode.id
  for (const n of state.nodes || []) {
    const isCur = n.id === cur
    const status = n.status === 'done' ? 'done' : isCur ? (n.kind === 'human' ? 'red' : 'run') : 'todo'
    html += '<div class=\"sl-node ' + status + '\"><div class=\"n\"></div><div class=\"tx\"><span class=\"id\">' + esc(n.id) + '</span> · ' + esc(n.title) + '</div></div>'
  }
  return html + '</div>'
}

function autonomyHtml(state, win) {
  if (!state) {
    return '<div class=\"sl-sec\"><div class=\"sl-cta\"><div class=\"t\">还没连上宿主路由</div><div class=\"d\">' + esc(store.error || '等待第一次轮询…') + '</div></div></div>'
  }
  const cur = state.currentNode
  let cta
  if (!cur) cta = '<div class=\"sl-cta\"><div class=\"t\">本轮已全部完成</div><div class=\"d\">下一轮开始后这里会显示当前站的建议。</div></div>'
  else if (win && win.open && win.reason === 'human') cta = '<div class=\"sl-cta\"><div class=\"t\">这一步需要你</div><div class=\"d\">' + esc(cur.title) + ' 在等你，填完流程自动往下走。</div></div>'
  else if (win && win.open) cta = '<div class=\"sl-cta warn\"><div class=\"t\">吐槽窗口开放中</div><div class=\"d\">现在说会进下一轮工单；本环节一交付就关，过期只顺延不打断。</div></div>'
  else cta = '<div class=\"sl-cta\"><div class=\"t\">' + esc(cur.title) + ' 正在跑</div><div class=\"d\">不需要你动手，出结果我会在这里更新。</div></div>'
  let html = '<div class=\"sl-sec\">' + cta + '</div>'
  const intent = state.intent
  if (intent) html += '<div class=\"sl-sec\"><div class=\"sl-h\">意图分析<div class=\"ln\"></div></div><div class=\"sl-txt\">' + esc(intent.restate) + '</div><div class=\"sl-meta\">判据 ' + intent.criteria + ' 条（数值 ' + intent.numeric + ' / 人判 ' + intent.human + '）</div></div>'
  if (state.plan) html += '<div class=\"sl-sec\"><div class=\"sl-h\">任务规划<div class=\"ln\"></div><span class=\"sl-badge\">第 ' + esc(state.plan.round || 1) + ' 轮</span></div><div class=\"sl-txt\">' + (state.plan.orders || []).map(function (o) { return esc(o.id) + ' ' + esc(o.task) }).join('<br>') + '</div></div>'
  const research = state.research
  if (research) html += '<div class=\"sl-sec\"><div class=\"sl-h\">调查摘要<div class=\"ln\"></div><span class=\"sl-badge\">' + research.total + ' 条</span></div>' +
    '<div class=\"sl-row\"><span class=\"k\">分类</span><span>' + Object.keys(research.byKind || {}).map(function (k) { return esc(k) + ' ' + research.byKind[k] }).join(' · ') + '</span></div>' +
    '<div class=\"sl-row\"><span class=\"k\">可信度</span><span>带 URL ' + research.withUrl + ' 条 · 用于决策 ' + research.used + ' 条</span></div>' +
    ((research.top || []).length ? '<div class=\"sl-row\"><span class=\"k\">关键</span><span>' + esc(research.top[0]) + '</span></div>' : '') + '</div>'
  if (state.verify) html += '<div class=\"sl-sec\"><div class=\"sl-h\">本轮验收<div class=\"ln\"></div></div><div class=\"sl-txt\"><span style=\"color:#2e9e5b\">过 ' + state.verify.pass.length + '</span> · <span style=\"color:#c0392b\">不过 ' + state.verify.fail.length + '</span>' + (state.verify.measuredBy ? '<br><span style=\"color:#8a8f98\">量法：' + esc(state.verify.measuredBy) + '</span>' : '') + '</div></div>'
  const interrupts = state.interrupts || []
  if (interrupts.length) html += '<div class=\"sl-sec\"><div class=\"sl-h\">闭环：吐槽去了哪<div class=\"ln\"></div><span class=\"sl-badge\">' + interrupts.length + ' 条</span></div><div class=\"sl-trace\">' + interrupts.slice(-5).map(function (it) {
    return '<div class=\"sl-tr\"><div class=\"q\">「' + esc(it.text) + '」</div><div class=\"m\">' + esc(it.stage || '') + ' · ' + esc(String(it.at || '').slice(11, 16)) + (it.expired ? ' · <span style=\"color:#c0392b\">expired</span>' : '') + '</div></div>'
  }).join('') + '</div></div>'
  return html
}

function panelRoundLabel() {
  const plan = store.state && store.state.plan
  const round = plan && plan.round ? plan.round : 1
  return '第 ' + round + ' 轮'
}

function panelHtml(tab) {
  const body = tab === 'flow' ? metroHtml(store.state) : autonomyHtml(store.state, store.window)
  return '<div class=\"sl-sh\"><span class=\"sl-fold\" data-act=\"close\" title=\"收起右侧栏\">«</span>' +
    '<div class=\"sl-tab ' + (tab === 'auto' ? 'on' : '') + '\" data-tab=\"auto\">肥鱼自治</div>' +
    '<div class=\"sl-tab ' + (tab === 'flow' ? 'on' : '') + '\" data-tab=\"flow\">流转状态</div>' +
    '<span class=\"sl-title\">' + (panelRoundLabel()) + '</span></div>' +
    '<div class=\"sl-body\">' + body + '</div>'
}

let panelEl = null
let panelTab = 'auto'

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
    if (ev.target.closest('[data-act=\"close\"]')) { panelEl.classList.remove('on'); return }
  })
  listeners.add(function () { if (panelEl.classList.contains('on')) drawPanel() })
  return panelEl
}

let lastHtml = ''
function drawPanel() {
  if (!panelEl) return
  const html = panelHtml(panelTab)
  // 内容没变就别重建 DOM：重建会打断点击，也会让滚动位置跳回顶部
  if (html === lastHtml && panelEl.classList.contains('on')) return
  lastHtml = html
  panelEl.innerHTML = html
}

function togglePanel() {
  try {
    ensurePanel()
    panelEl.classList.toggle('on')
    if (panelEl.classList.contains('on')) { startPolling(); drawPanel() }
  } catch (e) { logWarn('面板打开失败：' + e.message) }
}

function mountChip(slots, createElement) {
  function Chip() {
    const onRef = function (el) {
      if (!el || el.dataset.slReady) return
      el.dataset.slReady = '1'
      el.className = 'sl-chip'
      el.addEventListener('click', togglePanel)
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
      el.textContent = '肥鱼自治'
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
  } catch (e) { logWarn('apply 失败：' + e.message) }
}

exports.name = PLUGIN_ID
exports.inject = ['slots']
exports.apply = apply
exports.__routes = { STATE_ROUTE: STATE_ROUTE, WINDOW_ROUTE: WINDOW_ROUTE, INTERRUPT_ROUTE: INTERRUPT_ROUTE, ANSWERS_ROUTE: ANSWERS_ROUTE }