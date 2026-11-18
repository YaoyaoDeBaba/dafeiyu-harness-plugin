// ui-window-timing.test.mjs —— 吐槽窗口不许早于「第一版执行结果」（待办 2）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SELFLOOP_STATE = mkdtempSync(join(tmpdir(), 'sl-win-state-'))
const { routeHandlers, ROUTES } = await import('../lib/routes.js')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sl-win-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, userReview: false, resupply: false }))
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n\n把雷云做得像参考片那样翻涌\n')
  const done = ['1.1-preflight','1.2-translate1','1.3-research-env','1.6-gate','1.7-absorb','1.8-translate2','1.9-confirm','1.10-translate3','2.1-plan-r1']
  for (const id of done) writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  writeFileSync(join(dir, 'tickets', '2.2-exec-r1.json'), JSON.stringify({ stage: '2.2-exec-r1' }))
  return dir
}

async function boot(dir) {
  const map = new Map(routeHandlers({ prefix: '/plugins/dsh-selfloop', runDir: dir }).map((h) => [h.path, h.handler]))
  const server = createServer((req, res) => { const h = map.get((req.url || '').split('?')[0]); if (!h) { res.writeHead(404); res.end('{}'); return } h(req, res) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}
const win = async (port) => (await fetch('http://127.0.0.1:' + port + ROUTES.window)).json()

test('第一轮 2.2 还没产出 → 窗口不开（交付前任何站都不开）', async () => {
  const s = await boot(fixture())
  try {
    const w = await win(s.port)
    assert.equal(w.open, false)
    assert.equal(w.reason, 'waiting-first-delivery')
  } finally { await s.close() }
})

test('第一轮执行产出落地 → 还在执行站不开窗；推进到 2.3 才开', async () => {
  const dir = fixture()
  mkdirSync(join(dir, 'rounds', 'r1'), { recursive: true })
  writeFileSync(join(dir, 'rounds', 'r1', 'plan.json'), JSON.stringify({ orders: [] }))
  let s = await boot(dir)
  try {
    const w = await win(s.port)
    assert.equal(w.open, false, '执行站不弹吐槽')
    assert.equal(w.reason, 'not-vent-stage')
  } finally { await s.close() }
  // 推进：2.1/2.2 done → 当前站 2.3-verify
  writeFileSync(join(dir, 'stages', '2.1-plan-r1.json'), JSON.stringify({ stage: '2.1-plan-r1', status: 'done' }))
  writeFileSync(join(dir, 'stages', '2.2-exec-r1.json'), JSON.stringify({ stage: '2.2-exec-r1', status: 'done' }))
  writeFileSync(join(dir, 'active.json'), JSON.stringify({ stage: '2.3-verify-r1', openedAt: new Date().toISOString() }))
  s = await boot(dir)
  try {
    const w = await win(s.port)
    assert.equal(w.open, true, '到验收站才弹')
  } finally { await s.close() }
})

test('老订单有 rounds/01.json：交付算数，但仍要复盘站才开窗', async () => {
  const dir = fixture()
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ stage: '2.2-exec-r1' }))
  let s = await boot(dir)
  try {
    const w = await win(s.port)
    assert.equal(w.open, false, '交付算数 ≠ 立刻开窗')
    assert.equal(w.reason, 'not-vent-stage')
  } finally { await s.close() }
  writeFileSync(join(dir, 'stages', '2.1-plan-r1.json'), JSON.stringify({ stage: '2.1-plan-r1', status: 'done' }))
  writeFileSync(join(dir, 'stages', '2.2-exec-r1.json'), JSON.stringify({ stage: '2.2-exec-r1', status: 'done' }))
  writeFileSync(join(dir, 'active.json'), JSON.stringify({ stage: '2.3-verify-r1', openedAt: new Date().toISOString() }))
  s = await boot(dir)
  try {
    const w = await win(s.port)
    assert.equal(w.open, true)
  } finally { await s.close() }
})
