// ui-session.test.mjs —— 会话↔订单绑定与「等接手」（2026-11-17）
//
// 用户规则：每个会话仅限一个订单在跑。没有绑定的时候，开第二个会话会互相踩指针。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'sl-sess-state-'))
process.env.DSH_SELFLOOP_STATE = stateDir
const { routeHandlers, ROUTES } = await import('../lib/routes.js')

const runsRoot = mkdtempSync(join(tmpdir(), 'sl-sess-runs-'))

async function boot() {
  const map = new Map(routeHandlers({ prefix: '/plugins/dsh-selfloop', runsRoot }).map((h) => [h.path, h.handler]))
  const server = createServer((req, res) => {
    const h = map.get((req.url || '').split('?')[0])
    if (!h) { res.writeHead(404); res.end('{}'); return }
    h(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}
const post = async (port, path, body) => {
  const res = await fetch('http://127.0.0.1:' + port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-selfloop': '1' },
    body: JSON.stringify(body || {}),
  })
  return { status: res.status, body: await res.json() }
}

test('下单写会话指针 + 待接手标记；状态是「等接手」', async () => {
  const s = await boot()
  try {
    const { status, body } = await post(s.port, ROUTES.start, {
      requirement: '把目标效果调成参考片的样子，先跑阶段一',
      session: 'sess-A',
    })
    assert.equal(status, 200, JSON.stringify(body))
    assert.ok(existsSync(join(stateDir, 'active-run-sess-A.json')), '缺会话级指针')
    assert.ok(existsSync(join(body.runDir, 'order-pending.json')), '缺待接手标记')
    const st = await (await fetch('http://127.0.0.1:' + s.port + ROUTES.state + '?session=sess-A')).json()
    assert.equal(st.run.name, body.run, '会话 A 应看到自己那单')
    assert.equal(st.orderState, 'wait-agent', '新单还没有任何 stage，应为等接手')
  } finally { await s.close() }
})

test('两个会话各自一单，互不覆盖', async () => {
  const s = await boot()
  try {
    const a = await post(s.port, ROUTES.start, { requirement: '会话 A 的需求写够八个字', session: 'sess-A' })
    const b = await post(s.port, ROUTES.start, { requirement: '会话 B 的需求写够八个字', session: 'sess-B' })
    assert.notEqual(a.body.run, b.body.run)
    const sa = await (await fetch('http://127.0.0.1:' + s.port + ROUTES.state + '?session=sess-A')).json()
    const sb = await (await fetch('http://127.0.0.1:' + s.port + ROUTES.state + '?session=sess-B')).json()
    assert.equal(sa.run.name, a.body.run, '会话 A 的单被踩了')
    assert.equal(sb.run.name, b.body.run, '会话 B 的单被踩了')
    const ptrA = JSON.parse(readFileSync(join(stateDir, 'active-run-sess-A.json'), 'utf8'))
    assert.equal(ptrA.runDir, a.body.runDir)
  } finally { await s.close() }
})
