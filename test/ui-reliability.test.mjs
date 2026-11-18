// ui-reliability.test.mjs —— 四类"人会被卡住/被骗"的场景（2026-11-18 自检）
//
// 用户投诉过的四类：
//   ① UI 显示陈旧状态（节点卡住了还写"运行中"）
//   ② 错误信息没用（只说失败，不说原因）
//   ③ 提交之后没有反馈
//   ④ 中途停摆不进下一环节（没人发现）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SELFLOOP_STATE = mkdtempSync(join(tmpdir(), 'sl-rel-state-'))
const { routeHandlers, ROUTES } = await import('../lib/routes.js')
const runsRoot = mkdtempSync(join(tmpdir(), 'sl-rel-runs-'))

function makeRun(name, { stages = {}, active, requirement = '把雷暴技能的电弧做得像参考那样自然', budget = {} } = {}) {
  const dir = join(runsRoot, name)
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, userReview: false, resupply: false, ...budget }))
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n\n' + requirement + '\n')
  for (const [stage, rec] of Object.entries(stages)) {
    writeFileSync(join(dir, 'stages', stage + '.json'), JSON.stringify({ stage, ...rec }))
  }
  if (active) writeFileSync(join(dir, 'active.json'), JSON.stringify(active))
  return dir
}
async function boot(runDir) {
  const map = new Map(routeHandlers({ prefix: '/plugins/dsh-selfloop', runDir, runsRoot }).map((h) => [h.path, h.handler]))
  const server = createServer((req, res) => { const h = map.get((req.url || '').split('?')[0]); if (!h) { res.writeHead(404); res.end('{}'); return } h(req, res) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}
const stateOf = async (port) => (await fetch('http://127.0.0.1:' + port + ROUTES.state).then((r) => r.json()))

test('① 节点卡了两小时 → state 必须报 stuck（而不是只写"运行中"）', async () => {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const dir = makeRun('r-stall', {
    stages: {
      '1.1-preflight': { status: 'done' }, '1.2-translate1': { status: 'done' }, '1.3-research-env': { status: 'done' },
      '1.6-gate': { status: 'done' }, '1.7-absorb': { status: 'done' }, '1.8-translate2': { status: 'done' },
      '1.9-confirm': { status: 'done' }, '1.10-translate3': { status: 'done' }, '2.1-plan-r1': { status: 'done' },
    },
    active: { stage: '2.2-exec-r1', openedAt: old },
  })
  const s = await boot(dir)
  try {
    const st = await stateOf(s.port)
    assert.ok(st.status.stageStall, 'state.status.stageStall 必须存在')
    assert.equal(st.status.stageStall.stuck, true, '卡了两小时必须 stuck：' + JSON.stringify(st.status.stageStall))
    assert.ok(st.status.stageStall.idleMs > 60 * 60 * 1000, 'idleMs 应 > 1 小时，实测 ' + st.status.stageStall.idleMs)
    assert.equal(st.status.stageStall.limitMs, 20 * 60 * 1000, 'worker 的阈值应是 20 分钟')
  } finally { await s.close() }
})

test('①b 刚打开的节点 → 不算 stuck（别乱报）', async () => {
  const dir = makeRun('r-fresh', {
    stages: {
      '1.1-preflight': { status: 'done' }, '1.2-translate1': { status: 'done' }, '1.3-research-env': { status: 'done' },
      '1.6-gate': { status: 'done' }, '1.7-absorb': { status: 'done' }, '1.8-translate2': { status: 'done' },
      '1.9-confirm': { status: 'done' }, '1.10-translate3': { status: 'done' }, '2.1-plan-r1': { status: 'done' },
    },
    active: { stage: '2.2-exec-r1', openedAt: new Date().toISOString() },
  })
  const s = await boot(dir)
  try {
    const st = await stateOf(s.port)
    assert.equal(st.status.stageStall.stuck, false, '刚打开不该报 stuck')
  } finally { await s.close() }
})

test('② 阶段失败 → state 必须带真实原因（不是只有状态词）', async () => {
  const dir = makeRun('r-error', {
    stages: {
      '1.1-preflight': { status: 'done' },
      '2.3-verify-r1': { status: 'failed', error: '排列与参考不像：rowProfile 相关 0.540 < 下限 0.83' },
    },
  })
  const s = await boot(dir)
  try {
    const st = await stateOf(s.port)
    assert.ok(st.status.lastError, 'state.status.lastError 必须存在')
    assert.match(st.status.lastError.message, /rowProfile/, '必须带真实原因：' + JSON.stringify(st.status.lastError))
    assert.equal(st.status.lastError.stage, '2.3-verify-r1')
  } finally { await s.close() }
})

test('③ 下单成功 → 回执里必须带能立刻轮询的东西（runDir + 状态地址）', async () => {
  const s = await boot(join(runsRoot, 'r-empty-none'))
  try {
    const res = await fetch('http://127.0.0.1:' + s.port + ROUTES.start, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-selfloop': '1' },
      body: JSON.stringify({ requirement: '把雷暴电弧做得像参考那样自然，需要可复现', name: 'rel1', budget: { research: 'low' } }),
    })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.ok(body.runDir, '回执必须带 runDir（UI 立刻能切过去看）')
    assert.ok(body.stateUrl || body.run, '回执应带 stateUrl 或 run，便于马上轮询')
  } finally { await s.close() }
})

test('④ 需求太短 → 400 且说明是哪条（不能让用户猜）', async () => {
  const s = await boot(join(runsRoot, 'r-empty-none2'))
  try {
    const res = await fetch('http://127.0.0.1:' + s.port + ROUTES.start, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-selfloop': '1' },
      body: JSON.stringify({ requirement: '短', name: 'rel2', budget: {} }),
    })
    const body = await res.json()
    assert.equal(res.status, 400)
    assert.equal(body.error, 'requirement-too-short', '要给出具体原因码：' + JSON.stringify(body))
  } finally { await s.close() }
})
