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
      { round: 2, plan: { orders: [{ id: 'T3', task: '云改 ParticleSystem' }], executor: 'mimo-v2.6-pro' } },
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
