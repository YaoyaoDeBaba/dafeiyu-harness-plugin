// ui-routes.test.mjs —— 宿主侧 UI 路由的判据（2026-11-17）
//
// 覆盖：state 形状、window 开合、写接口的自定义头守卫、吐槽过期标记、答案落盘。
// 用法：node --test test/ui-routes.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeHandlers, ROUTES } from '../lib/routes.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-ui-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'high', maxRounds: 1, useCritic: true, userReview: true, resupply: true }))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({
    restate: '测试需求',
    criteria: [{ id: 'C1', target: 1, howMeasured: 'x' }, { id: 'C2', noMetric: true, howMeasured: 'y' }],
    notWanted: ['别糊'],
  }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({
    findings: [
      { kind: 'environment', title: 'a', path: 'p' },
      { kind: 'paper', title: 'b', url: 'https://example.com', used: true, usedFor: 'x' },
    ],
    extracted: [{ what: 'm', value: 1, min: 0, max: 2 }],
  }))
  writeFileSync(join(dir, 'stages', '1.1-preflight.json'), JSON.stringify({ stage: '1.1-preflight', status: 'done', at: '2026-01-01T00:00:00Z' }))
  writeFileSync(join(dir, 'tickets', '1.2-translate1.json'), JSON.stringify({ stage: '1.2-translate1' }))
  return dir
}

async function boot(dir) {
  const handlers = routeHandlers({ prefix: '/plugins/dsh-selfloop', runDir: dir })
  const map = new Map(handlers.map((h) => [h.path, h.handler]))
  const server = createServer((req, res) => {
    const h = map.get((req.url || '').split('?')[0])
    if (!h) {
      res.writeHead(404)
      res.end('{}')
      return
    }
    h(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { port, close: () => new Promise((r) => server.close(r)) }
}

const get = async (port, path) => {
  const res = await fetch('http://127.0.0.1:' + port + path)
  return { status: res.status, body: await res.json() }
}
const post = async (port, path, body, headers) => {
  const res = await fetch('http://127.0.0.1:' + port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body || {}),
  })
  return { status: res.status, body: await res.json() }
}

test('GET /state 返回流程态与三块摘要', async () => {
  const dir = fixture()
  const s = await boot(dir)
  try {
    const { status, body } = await get(s.port, ROUTES.state)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.run.name, dir.split(/[\\/]/).pop())
    assert.ok(Array.isArray(body.nodes) && body.nodes.length > 5)
    assert.equal(body.nodes[0].status, 'done')
    assert.equal(body.currentNode.id, '1.2-translate1')
    assert.equal(body.intent.numeric, 1)
    assert.equal(body.intent.human, 1)
    assert.equal(body.research.total, 2)
    assert.equal(body.research.withUrl, 1)
    assert.equal(body.research.used, 1)
  } finally {
    await s.close()
  }
})

test('GET /window：worker 站未交活 → 关（交付前不弹吐槽）', async () => {
  const dir = fixture()
  // 1.1 是 program、1.2 是 manager，要让当前站落到 worker（1.3 调查员c）
  writeFileSync(join(dir, 'stages', '1.2-translate1.json'), JSON.stringify({ stage: '1.2-translate1', status: 'done' }))
  writeFileSync(join(dir, 'tickets', '1.3-research-env.json'), JSON.stringify({ stage: '1.3-research-env' }))
  const s = await boot(dir)
  try {
    const { body } = await get(s.port, ROUTES.window)
    assert.equal(body.open, false, '交付前 worker 站不弹吐槽')
    assert.equal(body.reason, 'waiting-first-delivery')
    assert.equal(body.stage, '1.3-research-env')
  } finally {
    await s.close()
  }
})

test('GET /window：主 Agent 在做但还没交付 → 关', async () => {
  const dir = fixture()
  writeFileSync(join(dir, 'active.json'), JSON.stringify({ stage: '1.2-translate1', openedAt: new Date().toISOString() }))
  const s = await boot(dir)
  try {
    const { body } = await get(s.port, ROUTES.window)
    assert.equal(body.open, false, '未交付时 manager 站也不弹')
    assert.equal(body.reason, 'waiting-first-delivery')
    assert.equal(body.stage, '1.2-translate1')
  } finally {
    await s.close()
  }
})

test('GET /window：全部做完 → 关', async () => {
  const dir = fixture()
  writeFileSync(join(dir, 'stages', '1.2-translate1.json'), JSON.stringify({ stage: '1.2-translate1', status: 'done' }))
  // 其余节点一律标 done，模拟「全部完成」
  const s = await boot(dir)
  try {
    const first = await get(s.port, ROUTES.state)
    for (const n of first.body.nodes) writeFileSync(join(dir, 'stages', n.id + '.json'), JSON.stringify({ stage: n.id, status: 'done' }))
    const { body } = await get(s.port, ROUTES.window)
    assert.equal(body.open, false)
    assert.equal(body.reason, 'done')
  } finally {
    await s.close()
  }
})

test('写接口没有 x-selfloop 头 → 403', async () => {
  const dir = fixture()
  const s = await boot(dir)
  try {
    const r1 = await post(s.port, ROUTES.interrupt, { text: 'hi' })
    assert.equal(r1.status, 403)
    assert.equal(r1.body.error, 'missing-x-selfloop')
    const r2 = await post(s.port, ROUTES.intentAnswers, { answers: [{ id: 'Q1', chosen: 'A' }] })
    assert.equal(r2.status, 403)
  } finally {
    await s.close()
  }
})

test('POST /interrupt：窗口开 → 200 且落盘', async () => {
  const dir = fixture()
  // 新契约：要"已交付 + 站在复盘位"才开窗 → 把夹具推到 2.3-verify
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ stage: '2.2-exec-r1' }))
  const s = await boot(dir)
  try {
    // 把 2.3 之前的节点全部标 done（节点表随 research 档位变，别硬编码）
    const meta = await get(s.port, ROUTES.state)
    for (const n of meta.body.nodes) {
      if (String(n.id).startsWith('2.3')) break
      writeFileSync(join(dir, 'stages', n.id + '.json'), JSON.stringify({ stage: n.id, status: 'done' }))
    }
    writeFileSync(join(dir, 'active.json'), JSON.stringify({ stage: '2.3-verify-r1', openedAt: new Date().toISOString() }))
    const { status, body } = await post(s.port, ROUTES.interrupt, { text: '电弧像纸带' }, { 'x-selfloop': '1' })
    assert.equal(status, 200)
    assert.equal(body.expired, false)
    const lines = readFileSync(join(dir, 'user-interrupt.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const rec = JSON.parse(lines[0])
    assert.equal(rec.text, '电弧像纸带')
    assert.equal(rec.stage, '2.3-verify-r1')
    assert.equal(rec.expired, false)
  } finally {
    await s.close()
  }
})

test('POST /interrupt：站点已推进 → 标记 expired 并返回 409', async () => {
  const dir = fixture()
  const s = await boot(dir)
  try {
    const { status, body } = await post(s.port, ROUTES.interrupt, { text: '迟到的吐槽', stage: '0.0-gone' }, { 'x-selfloop': '1' })
    assert.equal(status, 409)
    assert.equal(body.expired, true)
    assert.equal(body.record.expired, true)
    assert.ok(existsSync(join(dir, 'user-interrupt.jsonl')))
  } finally {
    await s.close()
  }
})

test('POST /intent-answers：答案落盘到 intent.confirm.answers.json', async () => {
  const dir = fixture()
  const s = await boot(dir)
  try {
    const { status, body } = await post(s.port, ROUTES.intentAnswers, { answers: [{ id: 'Q1', chosen: 'A 按参考' }] }, { 'x-selfloop': '1' })
    assert.equal(status, 200)
    assert.equal(body.saved, 1)
    const saved = JSON.parse(readFileSync(join(dir, 'intent.confirm.answers.json'), 'utf8'))
    assert.equal(saved.whoDecided, 'user')
    assert.equal(saved.answers[0].chosen, 'A 按参考')
  } finally {
    await s.close()
  }
})

test('非环回 Host → 403', async () => {
  const dir = fixture()
  const s = await boot(dir)
  try {
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: s.port, path: ROUTES.state, method: 'GET', headers: { host: 'evil.example.com' } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
  } finally {
    await s.close()
  }
})

test('临时目录里的 run 不许写成「当前 run」（防测试污染指针）', async () => {
  const { execFileSync } = await import('node:child_process')
  const { join: pjoin } = await import('node:path')
  const { mkdtempSync: mk, existsSync: ex, readFileSync: rd } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const run = mk(pjoin(td(), 'sl-ptr-'))
  const stateDir = mk(pjoin(td(), 'sl-state-'))
  writeFileSync(pjoin(run, 'budget.json'), JSON.stringify({ research: 'high', maxRounds: 1 }))
  execFileSync(process.execPath, [pjoin(import.meta.dirname, '..', 'harness', 'pipeline.mjs'), 'status', '--run', run], {
    env: { ...process.env, DSH_SELFLOOP_STATE: stateDir },
    stdio: 'pipe',
  })
  assert.equal(ex(pjoin(stateDir, 'active-run.json')), false, '临时 run 不该写 active-run.json')
  void rd
})
