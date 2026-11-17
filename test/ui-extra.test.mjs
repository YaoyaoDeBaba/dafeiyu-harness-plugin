// ui-extra.test.mjs —— 图片路由与「能用」相关的判据（2026-11-17）
//
// 覆盖：/shot 只放行 shots/ 与 refs/（防穿越）、缺文件 404、state 带 shots/refs/confirm。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeHandlers, ROUTES } from '../lib/routes.js'

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-extra-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  mkdirSync(join(dir, 'shots'), { recursive: true })
  mkdirSync(join(dir, 'refs', 'frames'), { recursive: true })
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'high', maxRounds: 1 }))
  writeFileSync(join(dir, 'shots', 'v2_play.png'), PNG_1x1)
  writeFileSync(join(dir, 'refs', 'frames', 'g001.png'), PNG_1x1)
  writeFileSync(join(dir, 'intent.confirm.json'), JSON.stringify({
    questions: [{ id: 'Q1', question: '选哪个？', options: ['A', 'B'], recommend: 'A', why: '因为' }],
  }))
  return dir
}

async function boot(dir) {
  const map = new Map(routeHandlers({ prefix: '/plugins/dsh-selfloop', runDir: dir }).map((h) => [h.path, h.handler]))
  const server = createServer((req, res) => {
    const h = map.get((req.url || '').split('?')[0])
    if (!h) { res.writeHead(404); res.end('{}'); return }
    h(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

test('state 带 shots / refs / confirm 三块', async () => {
  const dir = fixture()
  const s = await boot(dir)
  try {
    const body = await (await fetch('http://127.0.0.1:' + s.port + ROUTES.state)).json()
    assert.deepEqual(body.shots, ['shots/v2_play.png'])
    assert.deepEqual(body.refs, ['refs/frames/g001.png'])
    assert.equal(body.confirm.questions.length, 1)
    assert.equal(body.confirm.questions[0].recommend, 'A')
    assert.deepEqual(body.confirm.answered, [])
  } finally { await s.close() }
})

test('GET /shot 能取到 png（shots 与 refs 都行）', async () => {
  const dir = fixture()
  const s = await boot(dir)
  try {
    for (const name of ['shots/v2_play.png', 'refs/frames/g001.png']) {
      const res = await fetch('http://127.0.0.1:' + s.port + ROUTES.shot + '?name=' + encodeURIComponent(name))
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/png')
      const buf = Buffer.from(await res.arrayBuffer())
      assert.ok(buf.length > 50, '拿到的图太小')
    }
  } finally { await s.close() }
})

test('GET /shot 拒绝穿越与非法前缀', async () => {
  const dir = fixture()
  const s = await boot(dir)
  try {
    const bad = ['../../secret.png', 'shots/../../x.png', 'budget.json', 'refs/../budget.png', 'shots/a.jpg']
    for (const name of bad) {
      const res = await fetch('http://127.0.0.1:' + s.port + ROUTES.shot + '?name=' + encodeURIComponent(name))
      assert.ok(res.status === 400 || res.status === 404, name + ' 应被拒，实际 ' + res.status)
    }
  } finally { await s.close() }
})

test('GET /shot 缺文件 → 404', async () => {
  const dir = fixture()
  const s = await boot(dir)
  try {
    const res = await fetch('http://127.0.0.1:' + s.port + ROUTES.shot + '?name=shots/nope.png')
    assert.equal(res.status, 404)
  } finally { await s.close() }
})
