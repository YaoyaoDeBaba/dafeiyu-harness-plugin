// routes —— selfloop 的宿主侧 HTTP 路由（2026-11-17，供右侧栏 UI 使用）
//
// 四条同源路由（前缀 /plugins/dsh-selfloop）：
//   GET  /state            流程态 + 需求/调研/验收摘要（聚合 run 目录里的产物）
//   GET  /window           乱入窗口状态（开/关、当前站、开始时间）
//   POST /intent-answers   写 intent.confirm.answers.json（用户在表单里选完）
//   POST /interrupt        写 user-interrupt.jsonl（吐槽），服务端强校验窗口
//
// 安全姿态照抄大肥鱼那套七条路由的判据：
//   - 只读（GET）：Host 必须环回；Origin 缺席放过（桌面宿主转发层会删 Origin）
//   - 写（POST）：要求同源脚本才发得出的自定义头 x-selfloop: 1
// 这里不响应 OPTIONS、不发 Access-Control-*，跨站自然被浏览器拦下。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allNodes, currentNode } from '../harness/pipeline.mjs'
import { resolveRunDir, STATE_DIR } from './active-run.js'

const STAGES = 'stages'
const TICKETS = 'tickets'
// 下单请求要带多模态参考（base64），所以上限放到 48MB；单文件 8MB、总量 40MB 另有校验。
// 原来 256KB 会让 9MB 的参考直接 ECONNRESET，而不是回一个说人话的 413。
const JSON_LIMIT = 48 * 1024 * 1024

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}

function readSignals(dir) {
  const d = join(dir, STAGES)
  if (!existsSync(d)) return {}
  const out = {}
  for (const f of readdirSync(d).filter((x) => x.endsWith('.json'))) {
    const s = readJson(join(d, f))
    if (s && s.stage) out[s.stage] = s
  }
  return out
}

function nodeStatus(node, signal) {
  if (!signal) return 'todo'
  if (signal.status === 'done') return 'done'
  if (signal.status === 'failed') return 'failed'
  return 'running'
}

function isLoopbackHost(host) {
  if (!host) return false
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '').split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

function send(res, code, body, type) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > JSON_LIMIT) {
        const err = new Error('body too large')
        err.code = 'BODY_TOO_LARGE'
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (e) {
        reject(new Error('bad json: ' + e.message))
      }
    })
    req.on('error', reject)
  })
}

/** 窗口判定：当前站已出票/正在做、还没交活 → 开；主 Agent 处理中（active.json 在）→ 也开。 */
function windowState(dir) {
  const { nodes } = allNodes(dir)
  const cur = currentNode(dir)
  const signals = readSignals(dir)
  const active = readJson(join(dir, 'active.json'))
  if (!cur.node) return { open: false, reason: 'done', stage: null }
  const node = cur.node
  const sig = signals[node.id]
  const isHuman = node.kind === 'human'
  const isWorker = node.kind === 'worker'
  const isManager = node.kind === 'manager'
  const ticketPath = join(dir, TICKETS, node.id + '.json')
  let openedAt
  try {
    openedAt = statSync(existsSync(ticketPath) ? ticketPath : join(dir, 'budget.json')).mtime.toISOString()
  } catch {
    openedAt = undefined
  }
  if (active && active.stage === node.id && active.openedAt) openedAt = active.openedAt
  const pending = !sig || sig.status !== 'done'
  if (pending && (isWorker || isHuman)) {
    return { open: true, reason: isHuman ? 'human' : 'worker', stage: node.id, title: node.title, openedAt, closesOn: 'stage-done' }
  }
  if (pending && isManager && active && active.stage === node.id) {
    return { open: true, reason: 'manager', stage: node.id, title: node.title, openedAt, closesOn: 'stage-done' }
  }
  return { open: false, reason: pending ? 'manager-idle' : 'advanced', stage: node.id, title: node.title, openedAt }
}

/** 订单状态：等需求 / 等回复 / 来吐槽 / 请验收 / 运行中 / 已结束（一个会话一个在跑） */
function orderStateOf(dir) {
  const reqPath = join(dir, 'requirement.md')
  let requirement = ''
  try { requirement = existsSync(reqPath) ? readFileSync(reqPath, 'utf8').replace(/^#.*$/gm, '').trim() : '' } catch { requirement = '' }
  if (!requirement) return 'wait-requirement'
  const cur = currentNode(dir)
  if (!cur.node) return 'finished'
  if (/^1\.9-/.test(String(cur.node.id))) return 'wait-reply'
  if (cur.node.kind === 'human') return 'review'
  const w = windowState(dir)
  if (w.open) return 'vent'
  return 'running'
}

/** 列目录里的历史订单（谁在跑、谁结束了、哪些是当前） */
function listOrders(runsRoot, currentDir) {
  if (!runsRoot || !existsSync(runsRoot)) return []
  const out = []
  for (const name of readdirSync(runsRoot)) {
    const dir = join(runsRoot, name)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    if (!existsSync(join(dir, 'budget.json'))) continue
    let updatedAt = 0
    for (const f of ['budget.json', 'intent.json', 'verify.json', 'decide.json', 'requirement.md']) {
      try { const m = statSync(join(dir, f)).mtimeMs; if (m > updatedAt) updatedAt = m } catch { /* 缺就跳过 */ }
    }
    out.push({
      name,
      dir,
      state: orderStateOf(dir),
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined,
      current: currentDir ? dir === currentDir : false,
    })
  }
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

function buildState(dir) {
  const { budget, nodes } = allNodes(dir)
  const signals = readSignals(dir)
  const cur = currentNode(dir)
  const intent = readJson(join(dir, 'intent.json'))
  const research = readJson(join(dir, 'research.json'))
  const verify = readJson(join(dir, 'verify.json'))
  const review = readJson(join(dir, 'review.json'))
  const decide = readJson(join(dir, 'decide.json'))
  const plan = readJson(join(dir, 'plan.json'))
  const findings = Array.isArray(research?.findings) ? research.findings : []
  const byKind = {}
  for (const f of findings) byKind[f.kind || 'other'] = (byKind[f.kind || 'other'] || 0) + 1
  const usedTop = findings.filter((f) => f.used === true).slice(0, 8).map((f) => String(f.title || '').slice(0, 160))
  const listPng = (sub, cap) => {
    try {
      return readdirSync(join(dir, sub)).filter((f) => /\.png$/i.test(f)).sort().slice(0, cap).map((f) => sub + '/' + f)
    } catch {
      return []
    }
  }
  const cfgRunsRoot = (d) => join(d, '..')
  const confirm = readJson(join(dir, 'intent.confirm.json'))
  const confirmAnswers = readJson(join(dir, 'intent.confirm.answers.json'))
  const interruptsPath = join(dir, 'user-interrupt.jsonl')
  const interrupts = existsSync(interruptsPath)
    ? readFileSync(interruptsPath, 'utf8').split('\n').filter(Boolean).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      }).filter(Boolean)
    : []
  return {
    ok: true,
    run: { dir, name: dir.split(/[\\/]/).pop() },
    budget,
    currentNode: cur.node ? { id: cur.node.id, kind: cur.node.kind, title: cur.node.title } : null,
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      status: nodeStatus(n, signals[n.id]),
      at: signals[n.id]?.at,
    })),
    intent: intent
      ? {
          restate: intent.restate,
          criteria: Array.isArray(intent.criteria) ? intent.criteria.length : 0,
          numeric: Array.isArray(intent.criteria) ? intent.criteria.filter((c) => !c.noMetric).length : 0,
          human: Array.isArray(intent.criteria) ? intent.criteria.filter((c) => c.noMetric).length : 0,
          notWanted: intent.notWanted || [],
        }
      : null,
    research: research
      ? { total: findings.length, byKind, withUrl: findings.filter((f) => typeof f.url === 'string' && /^https?:\/\//i.test(f.url)).length, used: findings.filter((f) => f.used === true).length, top: usedTop, extracted: (research.extracted || []).slice(0, 24) }
      : null,
    plan: plan ? { round: plan.round, orders: (plan.orders || []).map((o) => ({ id: o.id, task: String(o.task || '').slice(0, 120) })), executor: plan.executor?.model } : null,
    verify: verify ? { runs: verify.runs, visible: verify.visible, pass: verify.pass || [], fail: verify.fail || [], measuredBy: verify.measuredBy } : null,
    review: review ? { verdict: review.verdict, failCount: (review.vsCriteria || []).filter((c) => c.pass === false).length, total: (review.vsCriteria || []).length } : null,
    decide: decide ? { action: decide.action } : null,
    interrupts,
    orderState: orderStateOf(dir),
    orders: listOrders(cfgRunsRoot(dir), dir),
    shots: listPng('shots', 24),
    refs: listPng('refs/frames', 12),
    confirm: confirm
      ? {
          questions: (confirm.questions || []).map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options || [],
            recommend: q.recommend,
            why: q.why,
          })),
          answered: confirmAnswers ? confirmAnswers.answers || [] : [],
          source: confirmAnswers ? confirmAnswers.whoDecided : undefined,
        }
      : null,
  }
}

async function handle(method, url, req, res, cfg) {
  const { pathname, searchParams } = new URL(url, 'http://127.0.0.1')
  const prefix = cfg.prefix
  if (!pathname.startsWith(prefix)) return false
  const route = pathname.slice(prefix.length).replace(/^\//, '')
  const host = req.headers.host
  if (!isLoopbackHost(host)) {
    send(res, 403, { ok: false, error: 'host-not-loopback' })
    return true
  }
  const isWrite = method === 'POST'
  if (isWrite && req.headers['x-selfloop'] !== '1') {
    send(res, 403, { ok: false, error: 'missing-x-selfloop' })
    return true
  }
  // /start 是用来**创建** run 的，所以它不能受「必须先有活跃 run」这条约束
  const needsRun = !(method === 'POST' && route === 'start')
  const dir = needsRun ? resolveRunDir(searchParams.get('run') || cfg.runDir) : undefined
  if (needsRun && !dir) {
    send(res, 404, { ok: false, error: 'no-active-run' })
    return true
  }
  try {
    if (method === 'GET' && route === 'state') return send(res, 200, buildState(dir)), true
    if (method === 'GET' && route === 'window') return send(res, 200, { ok: true, ...windowState(dir) }), true
    if (method === 'POST' && route === 'start') {
      const body = await readBody(req)
      const requirement = typeof body.requirement === 'string' ? body.requirement.trim() : ''
      if (requirement.length < 8) return send(res, 400, { ok: false, error: 'requirement-too-short' }), true
      const runsRoot = cfg.runsRoot || join(process.cwd(), 'runs')
      const slugRaw = String(body.name || requirement.slice(0, 12)).replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 24) || 'run'
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
      const runDir = join(runsRoot, 'sl-' + slugRaw + '-' + stamp)
      if (!runDir.startsWith(runsRoot)) return send(res, 400, { ok: false, error: 'bad-name' }), true
      mkdirSync(join(runDir, 'refs'), { recursive: true })
      // 多模态参考：界面里选的文件按 base64 传上来，落到 run/refs/
      // 只收白名单扩展名、单文件 ≤8MB、总 ≤40MB、文件名强制安全化（判据见 test/ui-start.test.mjs）
      // 只收通用类型；题材专属的扩展名不放骨架里，需要时由执行者人工放进 refs/
      const ALLOW = /\.(png|jpe?g|gif|webp|bmp|mp4|mov|webm|mkv|txt|md|json|csv|cs|js|ts|ps1|py)$/i
      const refs = Array.isArray(body.refs) ? body.refs.slice(0, 24) : []
      let totalBytes = 0
      const saved = []
      for (const ref of refs) {
        const rawName = String((ref && ref.name) || 'ref')
        const safe = rawName.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-80)
        if (!ALLOW.test(safe)) return send(res, 400, { ok: false, error: 'ref-ext-rejected: ' + safe }), true
        let buf
        try { buf = Buffer.from(String((ref && ref.data) || ''), 'base64') } catch { return send(res, 400, { ok: false, error: 'ref-bad-base64' }), true }
        if (!buf.length) return send(res, 400, { ok: false, error: 'ref-empty: ' + safe }), true
        if (buf.length > 8 * 1024 * 1024) return send(res, 413, { ok: false, error: 'ref-too-large: ' + safe }), true
        totalBytes += buf.length
        if (totalBytes > 40 * 1024 * 1024) return send(res, 413, { ok: false, error: 'refs-too-large' }), true
        writeFileSync(join(runDir, 'refs', safe), buf)
        saved.push('refs/' + safe)
      }
      mkdirSync(join(runDir, 'stages'), { recursive: true })
      mkdirSync(join(runDir, 'tickets'), { recursive: true })
      writeFileSync(join(runDir, 'requirement.md'), '# 需求（用户原话）\n\n' + requirement + '\n', 'utf8')
      const b = body.budget || {}
      writeFileSync(join(runDir, 'budget.json'), JSON.stringify({
        research: ['low', 'mid', 'high', 'max'].includes(b.research) ? b.research : 'high',
        maxRounds: Number.isFinite(Number(b.maxRounds)) ? Math.min(20, Math.max(1, Number(b.maxRounds))) : 3,
        useCritic: b.useCritic !== false,
        userReview: b.userReview !== false,
        resupply: b.resupply !== false,
      }, null, 2), 'utf8')
      try {
        mkdirSync(STATE_DIR, { recursive: true })
        writeFileSync(join(STATE_DIR, 'active-run.json'), JSON.stringify({ runDir, at: new Date().toISOString(), cmd: 'ui-start' }, null, 2), 'utf8')
      } catch (e) {
        return send(res, 500, { ok: false, error: 'pointer-write-failed: ' + String(e && e.message) }), true
      }
      return send(res, 200, { ok: true, runDir, run: runDir.split(/[\\/]/).pop(), refs: saved }), true
    }
    if (method === 'GET' && route === 'shot') {
      const name = String(searchParams.get('name') || '')
      // 只放行 run 目录下的 shots/ 与 refs/，且不许 ..（穿越判据见 test/ui-routes.test.mjs）
      const normalized = name.replace(/\\/g, '/')
      if (!/^(shots|refs)\//.test(normalized) || normalized.includes('..') || !/\.png$/i.test(normalized)) {
        return send(res, 400, { ok: false, error: 'bad-name' }), true
      }
      const file = join(dir, normalized)
      if (!existsSync(file)) return send(res, 404, { ok: false, error: 'not-found' }), true
      const buf = readFileSync(file)
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(buf)
      return true
    }
    if (method === 'POST' && route === 'intent-answers') {
      const body = await readBody(req)
      const answers = Array.isArray(body.answers) ? body.answers : []
      if (!answers.length) return send(res, 400, { ok: false, error: 'answers-empty' }), true
      writeFileSync(join(dir, 'intent.confirm.answers.json'), JSON.stringify({ answers, whoDecided: 'user', source: 'ui', at: new Date().toISOString() }, null, 2), 'utf8')
      return send(res, 200, { ok: true, saved: answers.length })
    }
    if (method === 'POST' && route === 'interrupt') {
      const body = await readBody(req)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) return send(res, 400, { ok: false, error: 'text-empty' }), true
      const w = windowState(dir)
      // `false || (undefined && x)` 会得到 undefined，JSON 里整条字段消失 —— 必须布尔化
      const expired = !w.open || Boolean(body.stage && body.stage !== w.stage)
      const rec = { at: new Date().toISOString(), stage: body.stage || w.stage || null, text: text.slice(0, 1000), severity: body.severity || 'comment', expired }
      mkdirSync(STATE_DIR, { recursive: true })
      appendFileSync(join(dir, 'user-interrupt.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
      return send(res, expired ? 409 : 200, { ok: !expired, expired, record: rec })
    }
    send(res, 404, { ok: false, error: 'unknown-route', route })
    return true
  } catch (e) {
    const code = e && e.code === 'BODY_TOO_LARGE' ? 413 : 500
    if (!res.headersSent) send(res, code, { ok: false, error: String(e?.message ?? e) })
    return true
  }
}

export const ROUTES = {
  state: '/plugins/dsh-selfloop/state',
  window: '/plugins/dsh-selfloop/window',
  intentAnswers: '/plugins/dsh-selfloop/intent-answers',
  interrupt: '/plugins/dsh-selfloop/interrupt',
  shot: '/plugins/dsh-selfloop/shot',
  start: '/plugins/dsh-selfloop/start',
}

/** 给宿主 webServer 用的注册表：每条 path 一个 exact handler。 */
export function routeHandlers(cfg) {
  const out = []
  for (const path of Object.values(ROUTES)) {
    out.push({
      path,
      handler: (req, res) => {
        Promise.resolve(handle(req.method || 'GET', req.url || '/', req, res, { prefix: '/plugins/dsh-selfloop', ...cfg })).catch((e) =>
          send(res, 500, { ok: false, error: String(e?.message ?? e) }),
        )
      },
    })
  }
  return out
}

export { buildState, windowState, handle }