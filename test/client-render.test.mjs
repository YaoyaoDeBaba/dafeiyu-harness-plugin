// client-render.test.mjs —— 浏览器半边的渲染判据（2026-11-17 重画）
//
// 为什么单开一个文件：test/plugin.test.mjs 有 1300 行，读它会被截断、改它风险高。
// 这里只干一件事：把 dist/client.cjs 装进假宿主，直接调 exports.__ui 里的纯函数断言，
// 覆盖契约 §6 的五条硬要求（改名 / 胶囊去向 / 模型下拉 / 按轮分组 / 吐槽框不丢字）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/* ---------------- 假宿主：把 web 那套全局铺好，再 require 一遍 bundle ---------------- */
function loadClient() {
  globalThis.window = globalThis
  const el = () => ({
    dataset: {}, style: {}, className: '', innerHTML: '', value: '',
    appendChild() {}, addEventListener() {}, setAttribute() {}, remove() {},
    querySelector: () => null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  })
  globalThis.document = {
    getElementById: () => null,
    createElement: el,
    querySelector: () => null,
    activeElement: null,
    head: { appendChild() {} },
    body: { appendChild() {} },
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}
  const reactStub = { createElement: (type, props) => ({ type, props }) }
  let exported = null
  globalThis.__ModuleLoader__ = {
    load({ id, factory }) {
      assert.equal(id, 'dsh-selfloop', '外壳 id 不对')
      exported = factory((name) => (name === 'react' ? reactStub : {}))
    },
  }
  const require = createRequire(import.meta.url)
  require(join(ROOT, 'dist', 'client.cjs'))
  assert.ok(exported && exported.__ui, 'bundle 没导出 __ui 测试面')
  return exported
}

execFileSync(process.execPath, [join(ROOT, 'tools', 'build-client.mjs')], { stdio: 'pipe' })
const bundle = readFileSync(join(ROOT, 'dist', 'client.cjs'), 'utf8')
const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
const client = loadClient()
const ui = client.__ui

/* ---------------- 固定夹具 ---------------- */
const MODELS = {
  default: '由主 Agent 分配',
  options: [
    { provider: 'haituo', model: 'mimo-v2.6-pro', label: 'mimo-v2.6-pro（读图强）' },
    { provider: 'haituo', model: 'kimi-k3.1-pro', label: 'kimi-k3.1-pro（禁用读图）' },
  ],
}
function fixture(over) {
  return Object.assign({
    ok: true,
    run: { dir: 'D:/x/sl-雷云', name: 'sl-雷云' },
    title: '雷云优化',
    requirement: '对 MonSlayer 现有雷云技能优化，云要更厚、电弧更碎',
    status: { text: '等待子代理执行', node: '2.2-exec-r2', agents: [{ name: 'exec-cloud4', task: '云改 ParticleSystem' }], windowOpen: true },
    orderState: 'running',
    orders: [{ name: 'sl-雷云', dir: 'D:/x/sl-雷云', title: '雷云优化', state: 'running', current: true }],
    rounds: [
      { round: 1, confirm: { questions: [{ id: 'q0', question: '第一轮色温？', options: ['冷', '暖'], recommend: 0 }], answers: [{ id: 'q0', chosen: '冷' }] },
        interrupts: [{ at: '2026-11-17T10:00:00', stage: '2.4-critique-r1', text: '云底太亮', expired: false }],
        plan: { orders: [{ id: 'T1', task: '改云生成' }], executor: 'mimo-v2.6-pro' },
        verify: { pass: ['厚度'], fail: ['边缘过硬'] },
        review: { verdict: '不合格' },
        decide: { action: 'next', gapsForNextRound: ['边缘软化'], nextRoundOrders: [{ id: 'T2', task: '软化边缘' }] } },
      { round: 2,
        // 第二轮**自己的**意向确认（㉝ 之后只认 rounds[].confirm，顶层 confirm 不再顶替当前轮）
        confirm: { questions: [{ id: 'q2', question: '第二轮云底色？', options: ['冷灰', '暖'], recommend: 0 }], answers: [] },
        plan: { orders: [{ id: 'T3', task: '云改 ParticleSystem' }], executor: 'mimo-v2.6-pro' } },
    ],
    models: MODELS,
    confirm: { questions: [{ id: 'q1', question: '这一轮云底色选哪个？', options: ['冷灰', '折中', '暖'], recommend: 2, why: '参考片偏冷' }], answered: [] },
    intent: { restate: '把雷云做成参考片那种厚云', criteria: 6, numeric: 4, human: 2 },
    research: { total: 12, byKind: { web: 12 }, withUrl: 9, used: 5, top: ['ParticleSystem 的 Shape 参数'] },
    plan: { round: 2, orders: [{ id: 'T3', task: '云改 ParticleSystem' }], executor: 'mimo-v2.6-pro' },
    verify: null, review: null, decide: null,
    interrupts: [], shots: [], refs: [],
    currentNode: { id: '2.2-exec-r2', kind: 'auto', title: '等待子代理执行' },
    nodes: [{ id: '2.2-exec-r2', kind: 'auto', title: '等待子代理执行', status: 'run' }],
  }, over || {})
}

/* ---------------- 1. 改名：不许再有「肥鱼自治」 ---------------- */
test('全部文案「肥鱼自治」→「肥鱼接单」', () => {
  assert.ok(!source.includes('肥鱼自治'), 'lib/client.js 里还有「肥鱼自治」')
  assert.ok(!bundle.includes('肥鱼自治'), 'dist/client.cjs 里还有「肥鱼自治」')
  assert.ok(bundle.includes("el.textContent = '肥鱼接单'"), '标题栏按钮文案没改')
  assert.ok(bundle.includes('data-tab="auto">肥鱼接单<'), '面板 tab 名没改')
  assert.ok(bundle.includes('＋ 肥鱼接单'), '无单胶囊文案没改')
  assert.ok(bundle.includes('肥鱼接单 · '), '有单胶囊文案没改')
})

/* ---------------- 2. 胶囊行为：跑单中点它＝开右侧栏 ---------------- */
test('胶囊点击去向：跑单中打开右侧栏，无单/已结束才进接单模式', () => {
  assert.equal(ui.chipClickAction(fixture()), 'panel', '跑单中应打开右侧栏')
  assert.equal(ui.chipClickAction(fixture({ orderState: 'wait-reply' })), 'panel')
  assert.equal(ui.chipClickAction(fixture({ orderState: 'finished' })), 'composer', '已结束应进接单模式')
  assert.equal(ui.chipClickAction(null), 'composer', '无订单应进接单模式')
  assert.equal(ui.orderLive(fixture()), true)
  assert.equal(ui.orderLive(fixture({ orderState: 'finished' })), false)
})

test('有待确认的意向问题时胶囊打「等你确认」', () => {
  assert.equal(ui.confirmPending(fixture()), true)
  assert.equal(ui.confirmPending(fixture({ confirm: { questions: [{ id: 'q1', question: 'x', options: ['a'] }], answered: [{ id: 'q1', chosen: 'a' }] } })), false)
  assert.equal(ui.chipText(fixture()).text, '等你确认')
  assert.equal(ui.chipText(fixture({ confirm: null })).text, '运行中')
})

/* ---------------- 3. 接单模式：标题 + 调查/执行模型两个下拉 ---------------- */
test('接单模式有调查模型 / 执行模型两个下拉，默认项来自 state.models.default', () => {
  const html = ui.modeHtml(fixture())
  assert.ok(html.includes('data-research-model'), '缺调查模型下拉')
  assert.ok(html.includes('data-exec-model'), '缺执行模型下拉')
  assert.ok(html.includes('data-title'), '缺标题输入框')
  assert.ok(html.includes('由主 Agent 分配'), '默认项不是 state.models.default')
  assert.ok(html.includes('haituo|mimo-v2.6-pro'), '模型选项值没带 provider|model')
  assert.ok(html.includes('mimo-v2.6-pro（读图强）'), '模型选项没显示 label')
  // 没有 models 也不许崩，仍要有默认项
  const bare = ui.modeHtml(fixture({ models: undefined }))
  assert.ok(bare.includes('data-research-model') && bare.includes('data-exec-model'))
  assert.ok(bare.includes('由主 Agent 分配'))
})

test('/start 请求体带 researchModel / execModel，title 留空就不发', () => {
  const body = ui.buildStartBody('把雷云调厚一点，边缘要碎', [], {
    research: 'high', rounds: 3, researchModel: 'haituo|kimi-k3.1-pro', execModel: 'haituo|mimo-v2.6-pro', title: '',
  })
  assert.deepEqual(body.researchModel, { provider: 'haituo', model: 'kimi-k3.1-pro' })
  assert.deepEqual(body.execModel, { provider: 'haituo', model: 'mimo-v2.6-pro' })
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'title'), false, 'title 留空不该出现在请求体里')
  assert.deepEqual(body.budget, { research: 'high', maxRounds: 3 })
  const withTitle = ui.buildStartBody('把雷云调厚一点，边缘要碎', [], { research: 'mid', rounds: 2, title: ' 雷云优化 ', researchModel: '', execModel: '' })
  assert.equal(withTitle.title, '雷云优化')
  assert.equal(withTitle.researchModel, null, '没选模型应为 null（由主 Agent 分配）')
  assert.equal(withTitle.execModel, null)
  assert.equal(ui.parseModel(''), null)
  assert.equal(ui.parseModel('haituo|'), null)
})

/* ---------------- 4. 按轮分组：当前轮展开、历史轮折叠 ---------------- */
test('面板按 rounds 分组：当前轮展开、历史轮折叠', () => {
  ui.resetFold()
  const html = ui.panelHtml('auto', fixture(), { open: true, stage: '2.2-exec-r2' })
  assert.ok(html.includes('第 1 轮'), '缺第 1 轮分组')
  assert.ok(html.includes('第 2 轮 · 当前'), '缺当前轮标记')
  const r1 = html.match(/data-fold="r1" data-open="(\d)"/)
  const r2 = html.match(/data-fold="r2" data-open="(\d)"/)
  assert.ok(r1 && r2, '两组折叠头都要有 data-fold/data-open')
  assert.equal(r1[1], '0', '历史轮应默认折叠')
  assert.equal(r2[1], '1', '当前轮应默认展开')
  // 当前轮展开后能看到这一轮的模块
  assert.ok(html.includes('意向确认'), '缺意向确认区')
  assert.ok(html.includes('调查与转译'), '缺调查与转译区')
  assert.ok(html.includes('❓'), '意向确认缺 emoji 前缀')
  assert.ok(html.includes('🔍'), '调查与转译缺 emoji 前缀')
  // 折起来以后，组内内容不渲染
  ui.setFold('r2', false)
  const folded = ui.panelHtml('auto', fixture(), { open: true })
  assert.equal(folded.match(/data-fold="r2" data-open="(\d)"/)[1], '0')
  assert.ok(!folded.includes('调查与转译'), '折叠后不该渲染组内内容')
})

test('历史轮里验收过/不过、吐槽、决定都能回看', () => {
  ui.resetFold()
  ui.setFold('r1', true)
  const html = ui.panelHtml('auto', fixture(), { open: false })
  assert.ok(html.includes('✅ 验收') || html.includes('⚠️ 验收'), '缺验收区')
  assert.ok(html.includes('不 过') || html.includes('不过 1') || html.includes('不过 1'), '缺不过计数')
  assert.ok(html.includes('💬 吐槽'), '缺吐槽区')
  assert.ok(html.includes('🔁 决定'), '缺决定区')
})

test('老订单没有 rounds 时，用顶层字段合成一轮', () => {
  ui.resetFold()
  const legacy = fixture({ rounds: [], confirm: { questions: [{ id: 'q1', question: '选色', options: ['冷', '暖'], recommend: 0 }], answered: [] } })
  const html = ui.panelHtml('auto', legacy, { open: false })
  assert.ok(html.includes('第 2 轮 · 当前'), '应把 plan.round 当成当前轮')
  assert.ok(html.includes('意向确认'), '顶层 confirm 要挂到当前轮上')
  assert.ok(html.includes('提交给流程'), '没答完时要能提交')
  // 合成的老单必须自报家门，别让人以为是归档里的意向确认
  assert.ok(html.includes('阶段 1 · 旧单，无归档'), '老单合成的轮没标「（阶段 1 · 旧单，无归档）」')
})

/* ---------------- 5. 吐槽框：重绘不丢字 + 输入中 2s 不重绘 ---------------- */
test('吐槽框重绘前存 value + 选区，重绘后回填', () => {
  const ta = { value: '云底还是太亮，希望再暗一点', selectionStart: 4, selectionEnd: 9, focused: false,
    focus() { this.focused = true }, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b } }
  const cnt = { textContent: '' }
  const root = { querySelector: (sel) => (sel === '[data-vent]' ? ta : sel === '[data-count]' ? cnt : null) }
  const snap = ui.captureVent(root)
  assert.equal(snap.value, '云底还是太亮，希望再暗一点')
  assert.equal(snap.start, 4)
  // 模拟轮询把 innerHTML 重建：换了个空 textarea
  const fresh = { value: '', selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b } }
  const root2 = { querySelector: (sel) => (sel === '[data-vent]' ? fresh : sel === '[data-count]' ? cnt : null) }
  ui.restoreVent(root2, snap)
  assert.equal(fresh.value, '云底还是太亮，希望再暗一点', '重绘后没回填')
  assert.equal(fresh.selectionStart, 4, '没回填选区')
  assert.equal(cnt.textContent, String(snap.value.length), '字数没跟着回填')
  assert.equal(cnt.textContent, '13')
})

test('输入中 2s 内不重绘，静默之后才允许', () => {
  ui.clearTyping()
  assert.equal(ui.ventQuiet(), false, '没在输入时不该拦重绘')
  ui.noteTyping()
  assert.equal(ui.ventQuiet(), true, '刚打完字应拦住重绘')
  assert.equal(ui.ventQuiet(Date.now() + ui.VENT_SILENCE_MS + 50), false, '静默窗过了应放行')
  assert.equal(ui.VENT_SILENCE_MS, 2000)
  assert.ok(bundle.includes('VENT_SILENCE_MS')) 
  ui.clearTyping()
})

/* ---------------- 6. 提交后不停住 ---------------- */
test('提交后卡片切成「已提交，等 Agent 继续」', () => {
  ui.resetFold()
  const html = ui.panelHtml('auto', fixture(), { open: true })
  assert.ok(html.includes('提交给流程'), '没提交时应有提交按钮')
  ui.marksSubmitted(true)
  const after = ui.panelHtml('auto', fixture(), { open: true })
  assert.ok(after.includes('已提交，等 Agent 继续'), '提交后没有等待卡片')
  assert.ok(after.includes('每 3 秒'), '没说明会轮询')
  assert.ok(!after.includes('提交给流程'), '提交后不该还留着提交按钮')
  assert.ok(bundle.includes('setInterval(refresh, POLL_MS)'), '轮询不是 3s')
  assert.ok(bundle.includes('POLL_MS = 3000'))
  ui.marksSubmitted(false)
})

test('「已提交」等待卡片只出现在当前轮，不冒充历史轮', () => {
  ui.resetFold()
  ui.setFold('r1', true)
  ui.marksSubmitted(true)
  const html = ui.panelHtml('auto', fixture(), { open: true })
  assert.equal((html.match(/已提交，等 Agent 继续/g) || []).length, 1, '历史轮不该也显示等待卡片')
  ui.marksSubmitted(false)
})

/* ---------------- 7. 视觉：状态卡 + 子代理名册 + 分类色 + 三档字号 ---------------- */
test('置顶状态卡有指示灯和子代理名册', () => {
  ui.resetFold()
  const html = ui.panelHtml('auto', fixture(), { open: true })
  assert.ok(html.includes('🚦'), '状态卡缺 emoji')
  assert.ok(html.includes('等待子代理执行'), '状态没用人话')
  assert.ok(html.includes('exec-cloud4'), '子代理名册缺名字')
  assert.ok(html.includes('云改 ParticleSystem'), '子代理名册缺在干什么')
  assert.ok(/sl-lamp (run|wait|red|done)/.test(html), '缺指示灯')
  // 需求原文默认折起
  assert.ok(html.includes('📋 需求原文'), '缺需求原文区')
  assert.ok(!html.includes('云要更厚'), '需求原文默认应该折起')
  ui.setFold('req', true)
  assert.ok(ui.panelHtml('auto', fixture(), { open: true }).includes('云要更厚'), '展开后要能看到需求原文')
})

test('分类色卡片 + 三档字号写进 CSS', () => {
  for (const cls of ['blue', 'amber', 'red', 'green', 'gray']) {
    assert.ok(bundle.includes('.sl-card.' + cls + '{'), '缺分类色卡片 .sl-card.' + cls)
  }
  assert.ok(bundle.includes('.sl-ttl{font-size:13px;font-weight:600'), '标题档应为 13px/600')
  assert.ok(bundle.includes('.sl-p{font-size:12.5px'), '正文档应为 12.5px')
  assert.ok(bundle.includes('.sl-meta{font-size:11px;color:#8a8f98'), '元信息档应为 11px #8a8f98')
  const html = ui.panelHtml('auto', fixture(), { open: true })
  assert.ok(html.includes('sl-card'), '面板里没用分类色卡片')
})

test('订单下拉只显示任务标题（不显示状态）', () => {
  const html = ui.panelHtml('auto', fixture(), { open: false })
  const menu = html.slice(html.indexOf('data-order-menu'))
  assert.ok(menu.includes('雷云优化'), '下拉里没有标题')
  assert.ok(!menu.includes('sl-menu .it') && !/class="it[^"]*"[^>]*>[\s\S]{0,40}<span class="st">/.test(html), '下拉别再渲染状态')
  assert.ok(!html.includes('/>sl-雷云<' + 'span'), '下拉不该用目录名当标签')
})

/* ---------------- 8. ㉛ 布局：内容容器 min-width:0 + 折叠态不占高 ---------------- */
test('㉛ 内容容器带 min-width:0，长串不把卡片顶破', () => {
  ui.resetFold()
  const html = ui.panelHtml('auto', fixture(), { open: true })
  assert.ok(/class="sl-body" style="[^"]*min-width:0/.test(html), '面板内容容器（sl-body）缺 min-width:0')
  assert.ok(/class="bd" style="[^"]*min-width:0/.test(html), '轮次内容容器（bd）缺 min-width:0')
  assert.ok(/style="min-width:0;overflow-wrap:anywhere"/.test(html), '内容容器没有同时带上 overflow-wrap:anywhere')
  // CSS 侧也要兜住：卡片 / 正文 / 折叠体三处都不能被长串撑开
  assert.match(bundle, /\.sl-body\{[^}]*min-width:0/, '.sl-body 的 CSS 缺 min-width:0')
  assert.match(bundle, /\.sl-card\{[^}]*min-width:0[^}]*overflow-wrap:anywhere/, '.sl-card 的 CSS 缺 min-width:0 + overflow-wrap')
  assert.match(bundle, /\.sl-p\{[^}]*min-width:0/, '.sl-p 的 CSS 缺 min-width:0')
})

test('㉛ 折叠态是 display:none / max-height:0 的空壳，不占高度', () => {
  ui.resetFold()
  const html = ui.panelHtml('auto', fixture(), { open: true })
  const shells = html.match(/<div class="sl-foldb folded"[^>]*><\/div>/g) || []
  // 需求原文 + 第 1 轮（历史轮）默认折叠
  assert.ok(shells.length >= 2, '折叠态没输出空壳节点（实际 ' + shells.length + ' 个）')
  for (const s of shells) {
    const style = (s.match(/style="([^"]*)"/) || [])[1] || ''
    assert.ok(/display:none|max-height:0/.test(style), '折叠态节点的 style 既没 display:none 也没 max-height:0：' + s)
  }
  // 折叠头后面紧跟的就是这块空壳（不是「内容照渲染只是看不见」）
  assert.ok(/data-fold="r1" data-open="0"[\s\S]{0,240}?<div class="sl-foldb folded"/.test(html), '第 1 轮折叠后没有紧跟折叠空壳')
  // 展开态必须有内容容器
  assert.ok(/<div class="sl-foldb" style="min-width:0/.test(html), '展开态缺内容容器')
  assert.match(bundle, /\.sl-foldb\.folded\{[^}]*max-height:0/, 'CSS 里折叠体缺 max-height:0')
})

/* ---------------- 9. ㉝ 意向确认归属：顶层 confirm 不再挂当前轮 ---------------- */
test('㉝ 无归档的轮显示「本轮无意向确认」，顶层 confirm 不许顶替', () => {
  ui.resetFold()
  const state = fixture()
  // r1 有归档的 confirm；r2 故意没有；顶层还留着一条（老数据）——它不许出现在任何一轮里
  state.rounds = [state.rounds[0], { round: 2, plan: state.rounds[1].plan }]
  assert.ok(state.confirm && state.confirm.questions.length, '夹具应保留顶层 confirm 才能验证不串轮')
  const html = ui.panelHtml('auto', state, { open: true })
  const at = html.indexOf('data-fold="r2"')
  assert.ok(at > 0, '没渲染出第 2 轮')
  const r2 = html.slice(at)
  assert.ok(!r2.includes('❓ 意向确认'), 'r2 组里冒出了别的轮次的意向确认标题')
  assert.ok(!r2.includes('这一轮云底色选哪个'), 'r2 组里出现了顶层 confirm 的问题（被挂到当前轮了）')
  assert.ok(r2.includes('本轮无意向确认'), '空轮没说明「本轮无意向确认」')
  // 有 rounds（哪怕是 r2）就严格按归档：不许再出现老单标记
  assert.ok(!html.includes('阶段 1 · 旧单，无归档'), '有 rounds 时不许出现老单标记')
  // r1 自己归档的那份还在（已答过的确认默认折起，这里手动展开看内容）
  ui.setFold('r1', true)
  ui.setFold('c1', true)
  const opened = ui.panelHtml('auto', state, { open: true })
  assert.ok(opened.includes('第一轮色温？'), 'r1 自己的意向确认丢了')
  assert.ok(!opened.includes('这一轮云底色选哪个'), '顶层 confirm 不该被渲染进任何一轮')
  ui.resetFold()
})

/* ---------------- 10. A2 状态卡：子代理进度 + 静默告警 ---------------- */
test('A2 状态卡显示「已返回 2/3」，stale 时红字报「已静默 X 分钟」', () => {
  ui.resetFold()
  const html = ui.panelHtml('auto', fixture({
    status: { text: '等待子代理执行', node: '2.2-exec-r2', agents: [], returned: 2, total: 3, stale: true, silentForMs: 660000 },
  }), { open: true })
  assert.ok(html.includes('2/3'), '缺「已返回 2/3」')
  assert.ok(html.includes('已返回'), '缺「已返回」字样')
  assert.ok(html.includes('已静默'), '缺静默告警')
  assert.ok(html.includes('11 分钟'), '静默时长不对（660000ms 应为 11 分钟）')
  assert.ok(/class="sl-stale"/.test(html), '静默告警没有红色样式')
  assert.ok(/sl-lamp red/.test(html), '静默时指示灯没转红')
  const calm = ui.panelHtml('auto', fixture({
    status: { text: '等待子代理执行', node: '2.2-exec-r2', agents: [], returned: 2, total: 3, stale: false, silentForMs: 0 },
  }), { open: true })
  assert.ok(calm.includes('2/3'), '正常态也要显示进度')
  assert.ok(!calm.includes('已静默'), '没 stale 不该报静默')
})

/* ---------------- 11. ⑱⑳ 努力程度下拉 ---------------- */
const MODELS_EFFORT = {
  default: '由主 Agent 分配',
  options: [
    { provider: 'haituo', model: 'mimo-v2.6-pro', label: 'mimo-v2.6-pro', efforts: ['low', 'high', 'max'] },
    { provider: 'haituo', model: 'kimi-k3.1-pro', label: 'kimi-k3.1-pro', efforts: [] },
    { provider: 'haituo', model: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
  ],
}

test('⑱ 下单表单有努力程度下拉，默认 max，档位来自 models.options[].efforts', () => {
  ui.setModeForm({ researchModel: '', execModel: '', researchEffort: 'max', execEffort: 'max' })
  const html = ui.modeHtml(fixture({ models: MODELS_EFFORT }))
  assert.ok(html.includes('data-research-effort'), '缺调查努力程度下拉')
  assert.ok(html.includes('data-exec-effort'), '缺执行努力程度下拉')
  assert.ok(html.includes('努力程度'), '下拉没有「努力程度」标签')
  // 没选模型（由主 Agent 分配）→ 不禁用，用标准三档
  assert.ok(/<select class="sl-sel" data-research-effort>/.test(html), '没选模型时不该禁用')
  assert.ok(/<option value="max" selected>/.test(html), '默认不是 max')
  assert.ok(html.includes('value="low"') && html.includes('value="high"'), '缺 low/high 档')
  // 选中宣告了 efforts 的模型 → 用它给的档位；没宣告 efforts 字段 → 回落标准三档且不禁用
  ui.setModeForm({ researchModel: 'haituo|mimo-v2.6-pro', execModel: 'haituo|deepseek-v4-pro' })
  const picked = ui.modeHtml(fixture({ models: MODELS_EFFORT }))
  assert.ok(/<select class="sl-sel" data-research-effort><option value="low">/.test(picked), '调查努力没按 models.options[].efforts 出档')
  assert.ok(/<select class="sl-sel" data-exec-effort>/.test(picked), '没宣告 efforts 的模型不该禁用')
  assert.ok(!picked.includes('该模型不支持设定努力程度'), '支持却报了不支持')
})

test('⑳ 选中不宣告 effort 的模型 → 该下拉禁用并提示', () => {
  ui.setModeForm({ researchModel: 'haituo|mimo-v2.6-pro', execModel: 'haituo|kimi-k3.1-pro' })
  const html = ui.modeHtml(fixture({ models: MODELS_EFFORT }))
  assert.ok(/<select class="sl-sel" data-exec-effort disabled>/.test(html), '执行努力程度没禁用')
  assert.ok(html.includes('该模型不支持设定努力程度'), '缺禁用理由')
  assert.ok(/<select class="sl-sel" data-research-effort>/.test(html), '别的模型被连坐禁用了')
  // 模型自己也不宣告努力程度
  assert.equal(ui.modelEfforts(MODELS_EFFORT, 'haituo|kimi-k3.1-pro').supported, false)
  assert.equal(ui.modelEfforts(MODELS_EFFORT, 'haituo|deepseek-v4-pro').supported, true)
  assert.deepEqual(ui.modelEfforts(MODELS_EFFORT, 'haituo|mimo-v2.6-pro').levels, ['low', 'high', 'max'])
  ui.setModeForm({ researchModel: '', execModel: '', researchEffort: 'max', execEffort: 'max' })
})

test('⑱ /start 请求体带 researchEffort / execEffort，缺省 max', () => {
  const body = ui.buildStartBody('把雷云调厚一点，边缘要碎', [], { research: 'high', rounds: 3, researchEffort: 'low', execEffort: 'high' })
  assert.equal(body.researchEffort, 'low')
  assert.equal(body.execEffort, 'high')
  const def = ui.buildStartBody('把雷云调厚一点，边缘要碎', [], {})
  assert.equal(def.researchEffort, 'max', '调查努力程度默认应为 max')
  assert.equal(def.execEffort, 'max', '执行努力程度默认应为 max')
})

// ── 可靠性自检（2026-11-18）：停摆 / 最近错误必须写进状态卡 ──
test('㊱ 节点卡住 → 状态卡写「卡在 <节点> N 分钟（阈值 M 分钟）」', () => {
  const state = fixture({
    status: Object.assign({}, fixture().status, {
      stageStall: { stage: '2.2-exec-r1', kind: 'worker', idleMs: 47 * 60 * 1000, limitMs: 20 * 60 * 1000, stuck: true },
    }),
  })
  const html = ui.statusCardHtml(state)
  assert.match(html, /卡在/)
  assert.match(html, /2\.2-exec-r1/)
  assert.match(html, /47 分钟/)
  assert.match(html, /阈值 20 分钟/)
})

test('㊲ 最近一次失败 → 状态卡带真实原因（不是只写"失败"）', () => {
  const state = fixture({
    status: Object.assign({}, fixture().status, {
      stageStall: { stage: '2.3-verify-r1', kind: 'manager', idleMs: 1000, limitMs: 1200000, stuck: false },
      lastError: { stage: '2.3-verify-r1', at: new Date().toISOString(), status: 'failed', message: '排列与参考不像：rowProfile 相关 0.540 < 下限 0.83' },
    }),
  })
  const html = ui.statusCardHtml(state)
  assert.match(html, /2\.3-verify-r1/)
  assert.match(html, /rowProfile/)
})
