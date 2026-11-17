// 自唤醒（A1·㉒）：票出了、Agent 停手 → watcher 喊人。
//
// 事故：pipeline 出票后只等 Agent 交活；Agent 一停手流程就永久卡住（今夜断了 4 次，2 次因为这个）。
// 判据：mock 时钟下「出票不交活」→ watcher 退出码 0 且写 need-agent.json；交活后 → 不写。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'harness', 'watch-ticket.mjs')
const { ticketState, DEFAULT_IDLE_MS, needAgentOf } = await import('../harness/watch-ticket.mjs')
const { allNodes } = await import('../harness/pipeline.mjs')

process.env.DSH_SELFLOOP_STATE = mkdtempSync(join(tmpdir(), 'sl-watch-state-'))
const { routeHandlers, ROUTES } = await import('../lib/routes.js')

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** 把 run 推到「当前节点 = 1.9-confirm」（low 档阶段 1 只剩它），并出一张票。 */
function makeRun(tag) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-watch-' + tag + '-'))
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n把雷云做得像参考片\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, userReview: false, resupply: true }))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done', at: new Date().toISOString() }))
  }
  return dir
}

function ticket(dir, node = '1.9-confirm') {
  const p = join(dir, 'tickets', node + '.json')
  writeFileSync(p, JSON.stringify({ stage: node, kind: 'manager', title: '向用户确认意向', prompt: '…' }))
  return p
}

async function boot(runDir) {
  const map = new Map(routeHandlers({ prefix: '/plugins/dsh-selfloop', runDir }).map((h) => [h.path, h.handler]))
  const server = (await import('node:http')).createServer((req, res) => {
    const h = map.get((req.url || '').split('?')[0])
    if (!h) { res.writeHead(404); res.end('{}'); return }
    h(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

test('① 出票但不动：mock 时钟 +120s → needed、waitedMs 对得上、hint 是人话', () => {
  const dir = makeRun('state')
  const p = ticket(dir)
  const at = statSync(p).mtimeMs
  const st = ticketState(dir, { now: at + 120000 })
  assert.equal(st.node, '1.9-confirm')
  assert.equal(st.needed, true, '120s 没进展必须判停滞')
  assert.ok(st.waitedMs >= 119000 && st.waitedMs <= 121000, 'waitedMs 应该是 ~120s，实际 ' + st.waitedMs)
  assert.equal(st.thresholdMs, DEFAULT_IDLE_MS, '默认阈值 90s')
  assert.match(st.hint, /1\.9-confirm/)
  assert.match(st.hint, /没有(任何)?进展|停手/, 'hint 要说人话：' + st.hint)
})

test('② 没到阈值（30s）→ 不喊人；进展会重置计时', async () => {
  const dir = makeRun('threshold')
  const p = ticket(dir)
  const at = statSync(p).mtimeMs
  assert.equal(ticketState(dir, { now: at + 30000 }).needed, false, '30s 不该喊')

  // 票之后动过东西（哪怕只是别的阶段的产物）= 有新进展，计时从那一刻重算
  await new Promise((r) => setTimeout(r, 20))
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ shot: 'shots/r1.png' }))
  const moved = statSync(join(dir, 'rounds', '01.json')).mtimeMs
  const st = ticketState(dir, { now: moved + 60000 })
  assert.equal(st.needed, false, '刚有进展 60s，不该喊')
  assert.equal(ticketState(dir, { now: moved + 120000 }).needed, true, '进展后又空转 120s，该喊')
})

test('③ 交活后（信号 done、当前节点换人）→ 不写 need-agent.json，退出码 3', () => {
  const dir = makeRun('delivered')
  const p = ticket(dir)
  const at = statSync(p).mtimeMs
  assert.equal(ticketState(dir, { now: at + 120000 }).needed, true)
  // 交活：写 1.9 的信号 → 当前节点变成 1.10-translate3（没有票）
  writeFileSync(join(dir, 'stages', '1.9-confirm.json'), JSON.stringify({ stage: '1.9-confirm', status: 'done' }))
  const st = ticketState(dir, { now: at + 120000 })
  assert.equal(st.needed, false, '交活后不许再喊：' + JSON.stringify(st))
  const r = spawnSync(process.execPath, [CLI, '--run', dir, '--once', '--now', String(Math.round(at + 120000))], { encoding: 'utf8' })
  assert.equal(r.status, 3, '不需要叫醒时应 exit 3：' + r.stdout + r.stderr)
  assert.equal(existsSync(join(dir, 'need-agent.json')), false, '交活后不该留 need-agent.json')
})

test('④ CLI 检测到停滞：exit 0 + need-agent.json 带 node/ticketAt/waitedMs/hint', () => {
  const dir = makeRun('cli')
  const p = ticket(dir)
  const at = statSync(p).mtimeMs
  const r = spawnSync(process.execPath, [CLI, '--run', dir, '--once', '--now', String(Math.round(at + 120000))], { encoding: 'utf8' })
  assert.equal(r.status, 0, '检测到停滞必须 exit 0（后台跑的主 Agent 靠退出码接活）：' + r.stdout + r.stderr)
  assert.match(r.stdout, /需要主 Agent/)
  const j = readJson(join(dir, 'need-agent.json'))
  assert.equal(j.needAgent, true)
  assert.equal(j.node, '1.9-confirm')
  assert.ok(j.ticketAt, '要写 ticketAt')
  assert.ok(j.waitedMs >= 119000, '要写等了多久：' + j.waitedMs)
  assert.match(j.hint, /1\.9-confirm/)
})

test('⑤ /state.status.needAgent：watcher 喊过 → true；交活 → 旧标记自动失效', async () => {
  const dir = makeRun('status')
  ticket(dir) // 票比 watcher 早一步，保证「当前节点仍是它」
  const r = spawnSync(process.execPath, [CLI, '--run', dir, '--once', '--now', String(Date.now() + 120000)], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(needAgentOf(dir), true)

  const s = await boot(dir)
  try {
    const body = await (await fetch('http://127.0.0.1:' + s.port + ROUTES.state)).json()
    assert.equal(body.status.needAgent, true, '/state.status 要带 needAgent')
  } finally { await s.close() }

  writeFileSync(join(dir, 'stages', '1.9-confirm.json'), JSON.stringify({ stage: '1.9-confirm', status: 'done' }))
  assert.equal(needAgentOf(dir), false, '交活后旧标记必须失效（不然横幅一直挂着）')
  const s2 = await boot(dir)
  try {
    const body = await (await fetch('http://127.0.0.1:' + s2.port + ROUTES.state)).json()
    assert.equal(body.status.needAgent, false)
  } finally { await s2.close() }
})

test('⑥ 当前节点没票 / 全部做完 → 不喊（不误报）', () => {
  const dir = makeRun('quiet')
  ticket(dir)
  writeFileSync(join(dir, 'stages', '1.9-confirm.json'), JSON.stringify({ stage: '1.9-confirm', status: 'done' }))
  writeFileSync(join(dir, 'stages', '1.10-translate3.json'), JSON.stringify({ stage: '1.10-translate3', status: 'done' }))
  // 程序节点出票前就自己过：当前节点（2.1-plan-r1）没有票 → 不该喊
  const mid = ticketState(dir, { now: Date.now() + 600000 })
  assert.equal(mid.needed, false)
  assert.equal(mid.reason, 'no-ticket', '没有票就不该喊：' + JSON.stringify(mid))

  // 全部节点 done → 没有当前节点，更不该喊
  for (const n of allNodes(dir).nodes) {
    writeFileSync(join(dir, 'stages', n.id + '.json'), JSON.stringify({ stage: n.id, status: 'done' }))
  }
  const end = ticketState(dir, { now: Date.now() + 600000 })
  assert.equal(end.needed, false)
  assert.equal(end.reason, 'no-current-node')
})
