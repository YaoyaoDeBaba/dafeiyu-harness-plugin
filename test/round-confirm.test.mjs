// 意向确认的归属（P2·㉝）：只认 rounds/r<N>/intent.confirm.json，绝不把老确认挂到当前轮。
//
// 事故形状：r1 归档过的确认单，在 r2 的卡片上又出现一遍 —— 用户以为自己刚回答过，其实那是上一轮的。
// 判据：只归档到 r1 → rounds[1].confirm 有值、rounds[2].confirm 为 null；顶层 confirm 保留但标 legacy。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.DSH_SELFLOOP_STATE = mkdtempSync(join(tmpdir(), 'sl-confirm-state-'))
const { routeHandlers, ROUTES } = await import('../lib/routes.js')

const runsRoot = mkdtempSync(join(tmpdir(), 'sl-confirm-runs-'))

function makeRun(name) {
  const dir = join(runsRoot, name)
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 2, useCritic: false, userReview: false, resupply: true }))
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n把雷云做得像参考片\n')
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
const getState = async (port) => (await fetch('http://127.0.0.1:' + port + ROUTES.state)).json()

const Q1 = { id: 'Q1', question: '云底色偏冷还是偏暖？', options: ['冷', '暖'], recommend: '暖', why: '参考片偏暖' }

test('① 只归档到 r1 → rounds[1].confirm 有值、rounds[2].confirm 为 null', async () => {
  const dir = makeRun('c-two-rounds')
  // 顶层那份（老客户端读的）还在，但 R2 **不该**继承它
  writeFileSync(join(dir, 'intent.confirm.json'), JSON.stringify({ questions: [Q1] }))
  const r1 = join(dir, 'rounds', 'r1')
  const r2 = join(dir, 'rounds', 'r2')
  mkdirSync(r1, { recursive: true })
  mkdirSync(r2, { recursive: true })
  writeFileSync(join(r1, 'intent.confirm.json'), JSON.stringify({ questions: [Q1] }))
  writeFileSync(join(r1, 'intent.confirm.answers.json'), JSON.stringify({ answers: [{ id: 'Q1', chosen: '暖' }], whoDecided: 'user' }))
  writeFileSync(join(r2, 'decide.json'), JSON.stringify({ action: 'stop' }))

  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    const [one, two] = body.rounds
    assert.equal(one.round, 1)
    assert.ok(one.confirm, 'r1 归档过，必须有值')
    assert.equal(one.confirm.questions[0].id, 'Q1')
    assert.deepEqual(one.confirm.answers, [{ id: 'Q1', chosen: '暖' }])
    assert.equal(two.round, 2)
    assert.equal(two.confirm, null, 'r2 没归档 → 必须是 null（不许回落到 r1 或顶层）')
  } finally { await s.close() }
})

test('② 顶层 confirm 保留，但必须显式标 legacy:true（客户端据此不再当"本轮"）', async () => {
  const dir = makeRun('c-legacy')
  writeFileSync(join(dir, 'intent.confirm.json'), JSON.stringify({ questions: [Q1] }))
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.ok(body.confirm, '老客户端还要能读到')
    assert.equal(body.confirm.legacy, true, '顶层 confirm 必须标 legacy')
    assert.equal(body.confirm.questions.length, 1)
    assert.deepEqual(body.rounds, [], '没有 rounds/ 时不凭空造轮次')
  } finally { await s.close() }
})

test('③ 顶层有、轮次里没有 → 任何一轮都不许拿到它（确认归属只认归档）', async () => {
  const dir = makeRun('c-top-only')
  writeFileSync(join(dir, 'intent.confirm.json'), JSON.stringify({ questions: [Q1] }))
  mkdirSync(join(dir, 'rounds', 'r2'), { recursive: true })
  writeFileSync(join(dir, 'rounds', 'r2', 'plan.json'), JSON.stringify({ round: 2, orders: [{ id: 'B', task: '压亮度' }], executor: { model: 'x' } }))
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.equal(body.rounds.length, 1)
    assert.equal(body.rounds[0].round, 2, '只有 r2 目录')
    assert.equal(body.rounds[0].confirm, null, 'r2 没有归档 → null')
    // 别的块照常（确认归属错了不该连累 plan）
    assert.deepEqual(body.rounds[0].plan.orders, [{ id: 'B', task: '压亮度' }])
  } finally { await s.close() }
})

test('④ 两轮各自归档 → 各拿各的，不许串', async () => {
  const dir = makeRun('c-both')
  const Q2 = { id: 'Q2', question: '电弧要不要更粗？', options: ['粗', '细'], recommend: '粗' }
  for (const [r, q] of [[1, Q1], [2, Q2]]) {
    mkdirSync(join(dir, 'rounds', 'r' + r), { recursive: true })
    writeFileSync(join(dir, 'rounds', 'r' + r, 'intent.confirm.json'), JSON.stringify({ questions: [q] }))
  }
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.equal(body.rounds[0].confirm.questions[0].id, 'Q1')
    assert.equal(body.rounds[1].confirm.questions[0].id, 'Q2')
  } finally { await s.close() }
})
