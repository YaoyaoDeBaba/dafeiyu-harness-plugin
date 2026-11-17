// ui-state-v2.test.mjs —— /state 的契约 v2 三块新增（2026-11-17）
//
// 覆盖 docs/ui-contract-v2.md §1 的三块：
//   title（订单标题：order.json > 需求首句截 12 字 > 目录名）
//   status（text / node / agents（读 active-agents.json）/ windowOpen）
//   rounds[]（按轮分组：confirm / interrupts / plan / verify / review / decide）
// 模型清单在 ui-models.test.mjs 里单独判（它牵扯宿主 llm 服务）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SELFLOOP_STATE = mkdtempSync(join(tmpdir(), 'sl-state-v2-'))
const { routeHandlers, ROUTES, titleFromRequirement } = await import('../lib/routes.js')

const runsRoot = mkdtempSync(join(tmpdir(), 'sl-state-v2-runs-'))

function makeRun(name, { requirement = '把雷云的电弧做得像参考片那样自然', order, budget, stages = {} } = {}) {
  const dir = join(runsRoot, name)
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'high', maxRounds: 2, useCritic: true, userReview: true, resupply: true, ...(budget || {}) }))
  if (requirement) writeFileSync(join(dir, 'requirement.md'), '# 需求（用户原话）\n\n' + requirement + '\n', 'utf8')
  if (order) writeFileSync(join(dir, 'order.json'), JSON.stringify(order, null, 2), 'utf8')
  for (const [stage, status] of Object.entries(stages)) {
    writeFileSync(join(dir, 'stages', stage + '.json'), JSON.stringify({ stage, status }))
  }
  return dir
}

async function boot(runDir) {
  const map = new Map(routeHandlers({ prefix: '/plugins/dsh-selfloop', runDir, runsRoot }).map((h) => [h.path, h.handler]))
  const server = createServer((req, res) => {
    const h = map.get((req.url || '').split('?')[0])
    if (!h) { res.writeHead(404); res.end('{}'); return }
    h(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

const getState = async (port, run) =>
  (await fetch('http://127.0.0.1:' + port + ROUTES.state + (run ? '?run=' + encodeURIComponent(run) : ''))).json()

test('title：order.json 优先', async () => {
  const dir = makeRun('t-order', { order: { title: '雷云优化', researchModel: null, execModel: null, session: null, at: '2026-11-17T00:00:00Z' } })
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.equal(body.title, '雷云优化')
    const cur = body.orders.find((o) => o.current)
    assert.equal(cur.title, '雷云优化', 'orders[].title 与 state.title 同源')
  } finally { await s.close() }
})

test('title：没有 order.json 时用需求首句截 12 字；orders 缺省用目录名', async () => {
  const dir = makeRun('t-derive', { requirement: '把雷云的电弧做得像参考片那样自然。另外颜色要暖一点' })
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.equal(body.title, titleFromRequirement('把雷云的电弧做得像参考片那样自然。另外颜色要暖一点'))
    assert.equal(body.title, '把雷云的电弧做得像参考片', '首句（切到句号）前 12 字')
    assert.equal(body.title.length, 12)
    const cur = body.orders.find((o) => o.current)
    assert.equal(cur.title, 't-derive', '没有 order.json 的历史订单只能显示目录名')
  } finally { await s.close() }
})

test('status：人话文案 + 子代理名册（读 active-agents.json）', async () => {
  const dir = makeRun('t-status', {
    stages: { '1.1-preflight': 'done', '1.2-translate1': 'done', '1.3-research-env': 'done', '1.4-research-doc': 'done', '1.5-research-ref': 'done', '1.6-gate': 'done', '1.7-absorb': 'done', '1.8-translate2': 'done', '1.9-confirm': 'done', '1.10-translate3': 'done', '2.1-plan-r1': 'done', '2.2-exec-r1': 'done', '2.3-verify-r1': 'done', '2.4-critique-r1': 'done', '2.4b-userreview-r1': 'done' },
  })
  writeFileSync(join(dir, 'active-agents.json'), JSON.stringify({
    at: '2026-11-17T00:00:00Z',
    agents: [{ name: 'exec-cloud4', task: '云改 ParticleSystem' }, { name: 'exec-arc3', task: '电弧段数' }, { task: '没有名字，应被丢掉' }],
  }), 'utf8')
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.equal(typeof body.status.text, 'string')
    assert.equal(body.status.text, '决定要不要下一轮')
    assert.equal(body.status.node, '2.5-decide-r1')
    assert.equal(body.status.windowOpen, false)
    assert.deepEqual(body.status.agents, [
      { name: 'exec-cloud4', task: '云改 ParticleSystem' },
      { name: 'exec-arc3', task: '电弧段数' },
    ], '名册逐条照抄，没名字的丢掉')
  } finally { await s.close() }
})

test('status：没有 active-agents.json / 文件坏了 → agents 是空数组，不抛错', async () => {
  const dir = makeRun('t-status-bad')
  writeFileSync(join(dir, 'active-agents.json'), '{ 这不是 json', 'utf8')
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.deepEqual(body.status.agents, [])
    assert.equal(body.ok, true)
  } finally { await s.close() }
})

test('rounds[]：按轮分组，形状符合契约 §1', async () => {
  const dir = makeRun('t-rounds')
  const r1 = join(dir, 'rounds', 'r1')
  const r2 = join(dir, 'rounds', 'r2')
  mkdirSync(r1, { recursive: true })
  mkdirSync(r2, { recursive: true })
  writeFileSync(join(r1, 'intent.confirm.json'), JSON.stringify({
    questions: [{ id: 'Q1', question: '云底色偏冷还是偏暖？', options: ['冷', '暖'], recommend: '暖', why: '参考片偏暖' }],
  }))
  writeFileSync(join(r1, 'intent.confirm.answers.json'), JSON.stringify({ answers: [{ id: 'Q1', chosen: '暖' }], whoDecided: 'user' }))
  writeFileSync(join(r1, 'user-interrupt.jsonl'), JSON.stringify({ at: '2026-11-17T01:00:00Z', stage: '2.4-critique-r1', text: '电弧像纸带', expired: false }) + '\n')
  writeFileSync(join(r1, 'plan.json'), JSON.stringify({ round: 1, orders: [{ id: 'A', task: '改云生成' }], executor: { model: 'deepseek-v4-pro' } }))
  writeFileSync(join(r1, 'verify.json'), JSON.stringify({ pass: ['能跑'], fail: ['能看'] }))
  writeFileSync(join(r1, 'review.json'), JSON.stringify({ verdict: '不合格' }))
  writeFileSync(join(r1, 'decide.json'), JSON.stringify({ action: 'next', gapsForNextRound: ['电弧太亮'], nextRoundOrders: [{ id: 'B', task: '压电弧亮度' }] }))
  writeFileSync(join(r2, 'decide.json'), JSON.stringify({ action: 'stop' }))
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.equal(body.rounds.length, 2)
    const [one, two] = body.rounds
    assert.equal(one.round, 1)
    assert.equal(one.confirm.questions[0].recommend, '暖')
    assert.deepEqual(one.confirm.answers, [{ id: 'Q1', chosen: '暖' }])
    assert.equal(one.interrupts.length, 1)
    assert.equal(one.interrupts[0].text, '电弧像纸带')
    assert.deepEqual(one.plan.orders, [{ id: 'A', task: '改云生成' }])
    assert.equal(one.plan.executor, 'deepseek-v4-pro')
    assert.deepEqual(one.verify, { pass: ['能跑'], fail: ['能看'] })
    assert.equal(one.review.verdict, '不合格')
    assert.equal(one.decide.action, 'next')
    assert.deepEqual(one.decide.gapsForNextRound, ['电弧太亮'])
    assert.deepEqual(one.decide.nextRoundOrders, [{ id: 'B', task: '压电弧亮度' }])
    // 只有 decide 的轮次：其余块为 null（客户端据此折叠）
    assert.equal(two.round, 2)
    assert.equal(two.plan, null)
    assert.equal(two.confirm, null)
    assert.deepEqual(two.interrupts, [])
    assert.equal(two.decide.action, 'stop')
  } finally { await s.close() }
})

test('rounds[]：没有 rounds/ 目录 → 空数组（老订单不炸）', async () => {
  const dir = makeRun('t-rounds-empty')
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.deepEqual(body.rounds, [])
  } finally { await s.close() }
})

test('titleFromRequirement：去标题行、切首句、截 12 字、空需求给空串', () => {
  assert.equal(titleFromRequirement('# 需求\n\n把雷云做得更紫。电弧要粗一点'), '把雷云做得更紫'.slice(0, 12))
  assert.equal(titleFromRequirement('把雷云做得更紫。电弧要粗一点'), '把雷云做得更紫')
  assert.equal(titleFromRequirement('   '), '')
  assert.equal(titleFromRequirement('一二三四五六七八九十，十一十二'), '一二三四五六七八九十，十', '只截 12 个字')
})
