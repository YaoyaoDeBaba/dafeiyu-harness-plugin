// 订单按会话隔离（P2·⑲）：一个会话只许一单，且看不到别人的单。
//
// 不加隔离的后果：会议室里两个人各下一单，下拉里互相看见、指针互相踩。
// 判据：两会话各一单互不可见；本会话已有未结束订单时 /start 直接 409 session-busy。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'sl-ordersess-state-'))
process.env.DSH_SELFLOOP_STATE = stateDir
const { routeHandlers, ROUTES } = await import('../lib/routes.js')

const runsRoot = mkdtempSync(join(tmpdir(), 'sl-ordersess-runs-'))

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
const getState = async (port, session) =>
  (await fetch('http://127.0.0.1:' + port + ROUTES.state + (session ? '?session=' + encodeURIComponent(session) : ''))).json()

/** 把某单的所有节点标成 done（= 已结束），用来验证「结束之后才能再下单」。 */
function finish(dir, nodes) {
  mkdirSync(join(dir, 'stages'), { recursive: true })
  for (const n of nodes) writeFileSync(join(dir, 'stages', n + '.json'), JSON.stringify({ stage: n, status: 'done' }))
}

test('① 两会话各一单：/state 只看到自己那单', async () => {
  const s = await boot()
  try {
    const a = await post(s.port, ROUTES.start, { requirement: '会话 A 的需求写够八个字', session: 'sess-A' })
    const b = await post(s.port, ROUTES.start, { requirement: '会话 B 的需求写够八个字', session: 'sess-B' })
    assert.equal(a.status, 200, JSON.stringify(a.body))
    assert.equal(b.status, 200, JSON.stringify(b.body))
    assert.notEqual(a.body.run, b.body.run)

    const sa = await getState(s.port, 'sess-A')
    const sb = await getState(s.port, 'sess-B')
    assert.equal(sa.run.name, a.body.run, '会话 A 应看到自己那单')
    assert.equal(sb.run.name, b.body.run, '会话 B 应看到自己那单')

    const namesA = (sa.orders || []).map((o) => o.name)
    const namesB = (sb.orders || []).map((o) => o.name)
    assert.deepEqual(namesA, [a.body.run], '会话 A 的订单列表里不许有 B 的单：' + namesA.join(','))
    assert.deepEqual(namesB, [b.body.run], '会话 B 的订单列表里不许有 A 的单：' + namesB.join(','))
    assert.equal(sa.orders.filter((o) => o.current).length, 1)
  } finally { await s.close() }
})

test('② 本会话有未结束订单 → /start 直接 409 session-busy', async () => {
  const s = await boot()
  try {
    const first = await post(s.port, ROUTES.start, { requirement: '先下一单，用来挡住第二单', session: 'sess-C' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const again = await post(s.port, ROUTES.start, { requirement: '同一会话再下一单应该被挡住', session: 'sess-C' })
    assert.equal(again.status, 409, '同会话第二单必须 409：' + JSON.stringify(again.body))
    assert.equal(again.body.error, 'session-busy')
    assert.equal(again.body.run, first.body.run, '要把占着的那单告诉调用方')
    assert.ok(again.body.state && again.body.state !== 'finished')
    // 别的会话不受影响
    const other = await post(s.port, ROUTES.start, { requirement: '别的会话可以照常下单，不受影响', session: 'sess-D' })
    assert.equal(other.status, 200, JSON.stringify(other.body))
  } finally { await s.close() }
})

test('③ 上一单结束（全部节点 done）→ 同一会话能再下单', async () => {
  const s = await boot()
  try {
    const first = await post(s.port, ROUTES.start, { requirement: '这一单会被我跑完，然后重下', session: 'sess-E' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const st = await getState(s.port, 'sess-E')
    finish(first.body.runDir, st.nodes.map((n) => n.id))
    const after = await getState(s.port, 'sess-E')
    assert.equal(after.orderState, 'finished', '全部 done 之后应算已结束：' + after.orderState)
    const second = await post(s.port, ROUTES.start, { requirement: '上一单结束了，这一单应该放行', session: 'sess-E' })
    assert.equal(second.status, 200, '已结束的会话允许再下单：' + JSON.stringify(second.body))
    assert.notEqual(second.body.run, first.body.run)
    // 老单还在列表里（历史可回看），但只有新单是 current
    const list = (await getState(s.port, 'sess-E')).orders
    const names = list.map((o) => o.name)
    assert.ok(names.includes(first.body.run), '老单要留在历史里')
    assert.ok(names.includes(second.body.run))
    assert.equal(list.filter((o) => o.current).length, 1)
    assert.equal(list.find((o) => o.current).name, second.body.run)
  } finally { await s.close() }
})

test('④ 没绑会话的老订单：只在「没给 session」的请求里出现，不串进任何会话', async () => {
  const s = await boot()
  try {
    const plain = await post(s.port, ROUTES.start, { requirement: '这单没有会话，属于老客户端' })
    assert.equal(plain.status, 200, JSON.stringify(plain.body))
    assert.ok(existsSync(join(stateDir, 'active-run.json')), '无会话下单照旧写全局指针')

    const scoped = await getState(s.port, 'sess-Z')
    // sess-Z 没有任何订单 → 404 no-active-run（resolveRunDir 找不到）或空单；这里只要求看不到老单
    const scopedNames = (scoped.orders || []).map((o) => o.name)
    assert.ok(!scopedNames.includes(plain.body.run), '无会话的老单不许串进 sess-Z：' + scopedNames.join(','))

    const global = await getState(s.port)
    assert.equal(global.run.name, plain.body.run)
    assert.deepEqual((global.orders || []).map((o) => o.name), [plain.body.run])
  } finally { await s.close() }
})
