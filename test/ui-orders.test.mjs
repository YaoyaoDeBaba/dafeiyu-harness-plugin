// ui-orders.test.mjs —— 订单列表与状态推导（2026-11-17）
//
// 用户定稿的三条规则：
//   ① 每个会话只有一个订单在跑（下拉里只有一单「进行中」）
//   ② 有单在跑时「+ 新订单」直接置灰（不是点了再检查）
//   ③ 多个历史订单可切换查看
// 状态：等需求 / 等回复 / 来吐槽 / 请验收 / 运行中 / 已结束
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SELFLOOP_STATE = mkdtempSync(join(tmpdir(), 'sl-orders-state-'))
const { routeHandlers, ROUTES } = await import('../lib/routes.js')

const runsRoot = mkdtempSync(join(tmpdir(), 'sl-orders-runs-'))

function makeRun(name, { stages = {}, requirement = '做一件事，需求写得足够长一些', budget = {}, activeStage } = {}) {
  const dir = join(runsRoot, name)
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'high', maxRounds: 1, useCritic: true, userReview: true, resupply: true, ...budget }))
  if (requirement) writeFileSync(join(dir, 'requirement.md'), '# 需求\n\n' + requirement + '\n')
  for (const [stage, status] of Object.entries(stages)) {
    writeFileSync(join(dir, 'stages', stage + '.json'), JSON.stringify({ stage, status }))
  }
  if (activeStage) writeFileSync(join(dir, 'active.json'), JSON.stringify({ stage: activeStage, openedAt: new Date().toISOString() }))
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

const stateOf = async (port, run) => (await fetch('http://127.0.0.1:' + port + ROUTES.state + (run ? '?run=' + encodeURIComponent(run) : ''))).json()

test('没写需求 → 等需求', async () => {
  makeRun('r-empty', { requirement: '' })
  const dir = join(runsRoot, 'r-empty')
  const s = await boot(dir)
  try {
    const body = await stateOf(s.port)
    assert.equal(body.orderState, 'wait-requirement')
  } finally { await s.close() }
})

test('当前站是 1.9 → 等回复', async () => {
  const done = {}
  for (const id of ['1.1-preflight', '1.2-translate1', '1.3-research-env', '1.4-research-doc', '1.5-research-ref', '1.6-gate', '1.7-absorb', '1.8-translate2']) done[id] = 'done'
  makeRun('r-reply', { stages: done })
  const s = await boot(join(runsRoot, 'r-reply'))
  try {
    const body = await stateOf(s.port)
    assert.equal(body.orderState, 'wait-reply')
  } finally { await s.close() }
})

test('主 Agent 正在做（有 active.json）→ 来吐槽；全部 done → 已结束', async () => {
  const done = { '1.1-preflight': 'done', '1.2-translate1': 'done', '1.3-research-env': 'done', '1.4-research-doc': 'done', '1.5-research-ref': 'done', '1.6-gate': 'done', '1.7-absorb': 'done', '1.8-translate2': 'done', '1.9-confirm': 'done', '1.10-translate3': 'done' }
  makeRun('r-vent', { stages: done, activeStage: '2.1-plan-r1' })
  const dir = join(runsRoot, 'r-vent')
  const s1 = await boot(dir)
  try {
    const body = await stateOf(s1.port)
    // 新契约（用户第 1 条）：没到「首轮交付 + 复盘站」不许弹吐槽，处理中就是 running
    assert.equal(body.orderState, 'running', '主 Agent 处理中（未交付）应算「运行中」')
  } finally { await s1.close() }

  // 没有 active.json 的 manager 站：窗口是关的，状态回落到 running（用户此刻无事可做）
  const noActive = join(runsRoot, 'r-vent')
  const { unlinkSync } = await import('node:fs')
  unlinkSync(join(noActive, 'active.json'))
  const s2 = await boot(noActive)
  try {
    const body = await stateOf(s2.port)
    assert.equal(body.orderState, 'running')
  } finally { await s2.close() }

  // 全部 done → 已结束
  const s3 = await boot(noActive)
  try {
    const probe = await stateOf(s3.port)
    for (const n of probe.nodes) writeFileSync(join(noActive, 'stages', n.id + '.json'), JSON.stringify({ stage: n.id, status: 'done' }))
    const body = await stateOf(s3.port)
    assert.equal(body.orderState, 'finished')
  } finally { await s3.close() }
})

test('orders 列表：当前单被标记，历史单可列出', async () => {
  makeRun('r-old', { stages: {} })
  utimesSync(join(runsRoot, 'r-old', 'budget.json'), new Date(Date.now() - 86400000), new Date(Date.now() - 86400000))
  const cur = join(runsRoot, 'r-vent')
  const s = await boot(cur)
  try {
    const body = await stateOf(s.port)
    const names = (body.orders || []).map((o) => o.name)
    assert.ok(names.includes('r-old'), '应列出历史订单')
    assert.ok(names.includes('r-vent'), '应列出当前订单')
    const current = body.orders.find((o) => o.current)
    assert.equal(current.name, 'r-vent')
    assert.equal(body.orders.filter((o) => o.current).length, 1, '只能有一单是当前')
  } finally { await s.close() }
})

test('查看历史订单：?run= 能读另一单', async () => {
  const s = await boot(join(runsRoot, 'r-vent'))
  try {
    const body = await stateOf(s.port, join(runsRoot, 'r-old'))
    assert.equal(body.run.name, 'r-old')
  } finally { await s.close() }
})