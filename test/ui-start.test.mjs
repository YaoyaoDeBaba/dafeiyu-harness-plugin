// ui-start.test.mjs —— 「发起 selfloop」这条链的判据（2026-11-17）
//
// 用户要的是：入口得像即梦那样能传多模态参考，且要能区分「普通任务」与「selfloop 订单」。
// 这一条链的产物就是那个区分标志：一个带 requirement.md + budget.json + refs/ 的 run 目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

// 环境要在 import 之前设好（active-run 在模块加载时读它）
const stateDir = mkdtempSync(join(tmpdir(), 'sl-start-state-'))
process.env.DSH_SELFLOOP_STATE = stateDir
const { routeHandlers, ROUTES } = await import('../lib/routes.js')

const runsRoot = mkdtempSync(join(tmpdir(), 'sl-runs-'))

async function boot() {
  const map = new Map(routeHandlers({ prefix: '/plugins/dsh-selfloop', runDir: undefined, runsRoot }).map((h) => [h.path, h.handler]))
  const server = createServer((req, res) => {
    const h = map.get((req.url || '').split('?')[0])
    if (!h) { res.writeHead(404); res.end('{}'); return }
    h(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

const post = async (port, path, body, headers) => {
  const res = await fetch('http://127.0.0.1:' + port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-selfloop': '1', ...(headers || {}) },
    body: JSON.stringify(body || {}),
  })
  return { status: res.status, body: await res.json() }
}

test('下单成功：建 run 目录、写需求与预算、落参考、写指针', async () => {
  const s = await boot()
  try {
    const { status, body } = await post(s.port, ROUTES.start, {
      requirement: '把雷暴技能的电弧做得像参考片那样自然',
      name: '雷暴',
      refs: [{ name: 'ref.png', data: PNG.toString('base64') }],
      budget: { research: 'max', maxRounds: 2 },
    })
    assert.equal(status, 200, JSON.stringify(body))
    assert.ok(existsSync(join(body.runDir, 'requirement.md')), '缺 requirement.md')
    assert.match(readFileSync(join(body.runDir, 'requirement.md'), 'utf8'), /电弧/)
    const budget = JSON.parse(readFileSync(join(body.runDir, 'budget.json'), 'utf8'))
    assert.equal(budget.research, 'max')
    assert.equal(budget.maxRounds, 2)
    assert.deepEqual(readdirSync(join(body.runDir, 'refs')), ['ref.png'])
    assert.deepEqual(body.refs, ['refs/ref.png'])
    const pointer = JSON.parse(readFileSync(join(stateDir, 'active-run.json'), 'utf8'))
    assert.equal(pointer.runDir, body.runDir, '指针应指向新建的 run')
  } finally { await s.close() }
})

test('需求太短 → 400；不许凭空建目录', async () => {
  const s = await boot()
  try {
    const before = readdirSync(runsRoot).length
    const { status, body } = await post(s.port, ROUTES.start, { requirement: '短' })
    assert.equal(status, 400)
    assert.equal(body.error, 'requirement-too-short')
    assert.equal(readdirSync(runsRoot).length, before, '不该留下空目录')
  } finally { await s.close() }
})

test('参考文件：扩展名白名单与大小上限', async () => {
  const s = await boot()
  try {
    const bad = await post(s.port, ROUTES.start, { requirement: '这是一次测试订单，用来验证白名单', refs: [{ name: 'evil.exe', data: PNG.toString('base64') }] })
    assert.equal(bad.status, 400)
    assert.match(String(bad.body.error), /ref-ext-rejected/)
    const big = await post(s.port, ROUTES.start, { requirement: '这是一次测试订单，用来验证大小上限', refs: [{ name: 'big.png', data: Buffer.alloc(9 * 1024 * 1024).toString('base64') }] })
    assert.equal(big.status, 413)
  } finally { await s.close() }
})

test('写接口缺 x-selfloop 头 → 403', async () => {
  const s = await boot()
  try {
    const res = await fetch('http://127.0.0.1:' + s.port + ROUTES.start, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requirement: '没有自定义头的请求' }),
    })
    assert.equal(res.status, 403)
  } finally { await s.close() }
})
