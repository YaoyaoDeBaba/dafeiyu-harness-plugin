// 子代理吞吐监控（A2·㉘㉑）：名册要能看出「2/3 已返回」和「谁已经静默太久」。
//
// 之前 active-agents.json 只有 name/task：来了 3 个只回了 2 个，界面上看不出来（吞斥），
// 也看不出卡了多久（进度）。现在每项可带 status（running|done|failed）与 lastSeenAt。
// 判据：2 done + 1 running → returned:2, total:3, stale:false；把 running 的 lastSeenAt 调到 11 分钟前 → stale:true。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.DSH_SELFLOOP_STATE = mkdtempSync(join(tmpdir(), 'sl-agents-state-'))
const { routeHandlers, ROUTES } = await import('../lib/routes.js')

const runsRoot = mkdtempSync(join(tmpdir(), 'sl-agents-runs-'))

function makeRun(name) {
  const dir = join(runsRoot, name)
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, userReview: false, resupply: true }))
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n把雷云做得像参考片那样自然\n')
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

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString()
const MIN = 60 * 1000

test('① 2 done + 1 running → returned:2 / total:3 / stale:false', async () => {
  const dir = makeRun('r-mix')
  writeFileSync(join(dir, 'active-agents.json'), JSON.stringify({
    at: isoAgo(2 * MIN),
    agents: [
      { name: 'exec-cloud4', task: '云改 ParticleSystem', status: 'done', lastSeenAt: isoAgo(3 * MIN) },
      { name: 'exec-arc3', task: '电弧段数', status: 'done', lastSeenAt: isoAgo(90 * 1000) },
      { name: 'exec-hue2', task: '色温', status: 'running', lastSeenAt: isoAgo(30 * 1000) },
    ],
  }))
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.equal(body.status.returned, 2, '已返回的条数')
    assert.equal(body.status.total, 3, '名册总数')
    assert.equal(body.status.stale, false, '刚 30s 前还见过，不该算静默')
    assert.ok(body.status.silentForMs < 10 * MIN)
    assert.equal(body.status.agents.length, 3)
    assert.equal(body.status.agents[0].status, 'done', '名册要带上 status')
    assert.equal(body.status.agents[2].status, 'running')
    assert.ok(body.status.agents[2].lastSeenAt, '名册要带上 lastSeenAt')
  } finally { await s.close() }
})

test('② 把 running 的 lastSeenAt 调到 11 分钟前 → stale:true，silentForMs ≥ 10 分钟', async () => {
  const dir = makeRun('r-stale')
  writeFileSync(join(dir, 'active-agents.json'), JSON.stringify({
    at: isoAgo(11 * MIN),
    agents: [
      { name: 'exec-cloud4', task: '云改', status: 'done', lastSeenAt: isoAgo(30 * MIN) },
      { name: 'exec-arc3', task: '电弧', status: 'done', lastSeenAt: isoAgo(25 * MIN) },
      { name: 'exec-hue2', task: '色温', status: 'running', lastSeenAt: isoAgo(11 * MIN) },
    ],
  }))
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.equal(body.status.returned, 2)
    assert.equal(body.status.total, 3)
    assert.equal(body.status.stale, true, '有 running 且静默 11 分钟 → stale')
    assert.ok(body.status.silentForMs >= 10 * MIN, 'silentForMs 至少 10 分钟，实际 ' + body.status.silentForMs)
  } finally { await s.close() }
})

test('③ 全都返回 → stale:false、silentForMs:0', async () => {
  const dir = makeRun('r-done')
  writeFileSync(join(dir, 'active-agents.json'), JSON.stringify({
    at: isoAgo(40 * MIN),
    agents: [
      { name: 'a', task: 'x', status: 'done', lastSeenAt: isoAgo(40 * MIN) },
      { name: 'b', task: 'y', status: 'failed', lastSeenAt: isoAgo(39 * MIN) },
    ],
  }))
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.equal(body.status.returned, 1, 'returned 只数 done（failed 是失败了，不算返回）')
    assert.equal(body.status.failed, 1)
    assert.equal(body.status.total, 2)
    assert.equal(body.status.stale, false, '没有 running 就不该 stale')
    assert.equal(body.status.silentForMs, 0)
  } finally { await s.close() }
})

test('④ 老写法（只有 name/task）照旧能读：多出来的字段不许硬塞（会炸老客户端深比较）', async () => {
  const dir = makeRun('r-legacy')
  writeFileSync(join(dir, 'active-agents.json'), JSON.stringify({
    at: new Date().toISOString(),
    agents: [{ name: 'exec-cloud4', task: '云改 ParticleSystem' }],
  }))
  const s = await boot(dir)
  try {
    const body = await getState(s.port)
    assert.deepEqual(body.status.agents, [{ name: 'exec-cloud4', task: '云改 ParticleSystem' }], '没写 status 就不许加字段')
    assert.equal(body.status.total, 1)
    assert.equal(body.status.returned, 0)
    // 没有 status 的老条目按 running 算（否则「吞斥」就漏了），刚写过名册 → 不算静默
    assert.equal(body.status.stale, false)
  } finally { await s.close() }
})

test('⑤ 没有名册 / 文件坏了 → 全 0，不抛错', async () => {
  const dir = makeRun('r-empty')
  const s = await boot(dir)
  try {
    let body = await getState(s.port)
    assert.deepEqual(body.status.agents, [])
    assert.equal(body.status.total, 0)
    assert.equal(body.status.returned, 0)
    assert.equal(body.status.stale, false)
    assert.equal(body.status.silentForMs, 0)

    writeFileSync(join(dir, 'active-agents.json'), '{ 这不是 json', 'utf8')
    body = await getState(s.port)
    assert.deepEqual(body.status.agents, [])
    assert.equal(body.status.total, 0)
  } finally { await s.close() }
})
