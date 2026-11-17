// ui-models.test.mjs —— /state.models 与「下单时指定模型」（契约 v2 §1 / §2 / §5，待办 17）
//
// 唯一事实源是宿主 llm 服务（与 DSH 模型选择器同源）；config/models.json 只是兜底。
// 三条判据：① 有 llm → source=live 且选项非空；② 没有 llm → source=fallback 且仍非空；
//          ③ /start 收到的 researchModel / execModel 原样进 order.json，并由 /state 读回来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SELFLOOP_STATE = mkdtempSync(join(tmpdir(), 'sl-models-state-'))
const { routeHandlers, ROUTES, clearModelsCache } = await import('../lib/routes.js')

const runsRoot = mkdtempSync(join(tmpdir(), 'sl-models-runs-'))
const runDir = join(runsRoot, 'sl-models-1')
const { mkdirSync, writeFileSync } = await import('node:fs')
mkdirSync(join(runDir, 'stages'), { recursive: true })
writeFileSync(join(runDir, 'budget.json'), JSON.stringify({ research: 'high', maxRounds: 1 }))
writeFileSync(join(runDir, 'requirement.md'), '# 需求\n\n把雷云的电弧做得像参考片那样自然\n')

/** 假 llm：形状照宿主 cordis 的 llm 服务（listProviders / listModels）。 */
function fakeLlm(providers) {
  return {
    calls: { providers: 0, models: 0 },
    async listProviders() {
      this.calls.providers += 1
      return providers.map((p) => ({ id: p.id }))
    },
    async listModels(pid) {
      this.calls.models += 1
      const p = providers.find((x) => x.id === pid)
      return (p ? p.models : []).map((m) => ({ id: m.id, name: m.name }))
    },
  }
}

async function boot(cfg) {
  const map = new Map(routeHandlers({ prefix: '/plugins/dsh-selfloop', runDir, runsRoot, ...(cfg || {}) }).map((h) => [h.path, h.handler]))
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

const post = async (port, path, body) => {
  const res = await fetch('http://127.0.0.1:' + port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-selfloop': '1' },
    body: JSON.stringify(body || {}),
  })
  return { status: res.status, body: await res.json() }
}

test('① 宿主有 llm 服务 → source=live，选项来自服务', async () => {
  const llm = fakeLlm([
    { id: 'haituo', models: [{ id: 'mimo-v2.6-pro', name: 'mimo-v2.6-pro' }, { id: 'kimi-k3.1-pro' }] },
    { id: 'deepseek', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
  ])
  clearModelsCache(llm)
  const s = await boot({ getLlm: () => llm })
  try {
    const body = await getState(s.port)
    assert.equal(body.models.source, 'live')
    assert.equal(body.models.default, '由主 Agent 分配')
    const keys = body.models.options.map((o) => o.provider + '/' + o.model)
    assert.deepEqual(keys, ['haituo/mimo-v2.6-pro', 'haituo/kimi-k3.1-pro', 'deepseek/deepseek-v4-pro'])
    assert.equal(body.models.options[0].label, 'mimo-v2.6-pro（haituo）', 'label 带 provider 后缀')
  } finally { await s.close() }
})

test('①b live 清单有缓存：连拉两次 /state 只打一次 listProviders', async () => {
  const llm = fakeLlm([{ id: 'haituo', models: [{ id: 'm', name: 'm' }] }])
  clearModelsCache(llm)
  const s = await boot({ getLlm: () => llm })
  try {
    await getState(s.port)
    await getState(s.port)
    assert.equal(llm.calls.providers, 1, 'listModels 可能打网络，45s 内不许重复拉')
  } finally { await s.close() }
})

test('② 没有 llm 服务 → source=fallback，仍返回 config/models.json 的清单', async () => {
  const s = await boot({})
  try {
    const body = await getState(s.port)
    assert.equal(body.models.source, 'fallback')
    assert.ok(body.models.options.length >= 1, '兜底清单不许是空的')
    assert.ok(body.models.options.some((o) => o.model === 'deepseek-v4-pro'))
    assert.ok(body.models.options.every((o) => o.provider && o.model && o.label))
  } finally { await s.close() }
})

test('②b llm 服务在但一个模型都没有 → 也退回 fallback', async () => {
  const llm = fakeLlm([{ id: 'haituo', models: [] }])
  clearModelsCache(llm)
  const s = await boot({ getLlm: () => llm })
  try {
    const body = await getState(s.port)
    assert.equal(body.models.source, 'fallback')
    assert.ok(body.models.options.length >= 1)
  } finally { await s.close() }
})

test('②c llm 服务抛错 → 不 500，退 fallback', async () => {
  const llm = { async listProviders() { throw new Error('没登录') }, async listModels() { throw new Error('x') } }
  clearModelsCache(llm)
  const s = await boot({ getLlm: () => llm })
  try {
    const body = await getState(s.port)
    assert.equal(body.ok, true)
    assert.equal(body.models.source, 'fallback')
  } finally { await s.close() }
})

test('③ /start 的 title / researchModel / execModel 原样进 order.json，/state 读得回来', async () => {
  const s = await boot({ runDir: undefined })
  let created
  try {
    const { status, body } = await post(s.port, ROUTES.start, {
      requirement: '下次跑「mimo 执行 + kimi 调查」，把雷云电弧做得像参考片',
      title: '雷云优化',
      researchModel: { provider: 'haituo', model: 'kimi-k3.1-pro' },
      execModel: { provider: 'haituo', model: 'mimo-v2.6-pro' },
      budget: { research: 'high', maxRounds: 2 },
    })
    assert.equal(status, 200, JSON.stringify(body))
    created = body.runDir
    assert.ok(existsSync(join(created, 'order.json')), '缺 order.json')
    const order = JSON.parse(readFileSync(join(created, 'order.json'), 'utf8'))
    assert.equal(order.title, '雷云优化')
    assert.deepEqual(order.researchModel, { provider: 'haituo', model: 'kimi-k3.1-pro' })
    assert.deepEqual(order.execModel, { provider: 'haituo', model: 'mimo-v2.6-pro' })
    assert.equal(typeof order.at, 'string')
    assert.equal(body.title, '雷云优化')
    // 待接手标记也要带上，否则主 Agent 派活时看不到用户指定
    const pending = JSON.parse(readFileSync(join(created, 'order-pending.json'), 'utf8'))
    assert.deepEqual(pending.execModel, { provider: 'haituo', model: 'mimo-v2.6-pro' })
  } finally { await s.close() }
  const s2 = await boot({ runDir: created })
  try {
    const body = await getState(s2.port)
    assert.equal(body.title, '雷云优化')
    assert.equal(body.orders.find((o) => o.current).title, '雷云优化')
  } finally { await s2.close() }
})

test('③b 没给 title → 需求首句截 12 字；没给模型 → null（由主 Agent 分配）', async () => {
  const s = await boot({ runDir: undefined })
  try {
    const { body } = await post(s.port, ROUTES.start, { requirement: '把雷云的电弧做得像参考片那样自然。颜色也要暖一点' })
    const order = JSON.parse(readFileSync(join(body.runDir, 'order.json'), 'utf8'))
    assert.equal(order.title, '把雷云的电弧做得像参考片')
    assert.equal(order.researchModel, null)
    assert.equal(order.execModel, null)
  } finally { await s.close() }
})

test('③c 模型字段不合法 → 一律当没指定，不写坏数据', async () => {
  const s = await boot({ runDir: undefined })
  try {
    const { body } = await post(s.port, ROUTES.start, {
      requirement: '这次下单是为了验证模型字段的校验逻辑',
      researchModel: { provider: '', model: 'x' },
      execModel: '把字符串当模型',
    })
    const order = JSON.parse(readFileSync(join(body.runDir, 'order.json'), 'utf8'))
    assert.equal(order.researchModel, null)
    assert.equal(order.execModel, null)
  } finally { await s.close() }
})
