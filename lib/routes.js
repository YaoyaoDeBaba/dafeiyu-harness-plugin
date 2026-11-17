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
import { fileURLToPath } from 'node:url'
import { allNodes, currentNode } from '../harness/pipeline.mjs'
import { resolveRunDir, STATE_DIR, writePointer } from './active-run.js'

const STAGES = 'stages'
const TICKETS = 'tickets'
const ORDER = 'order.json'
// 插件根目录：config/models.json 跟着包走，不跟用户 cwd 走
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODELS_FILE = join(PLUGIN_ROOT, 'config', 'models.json')
const MODELS_DEFAULT = '由主 Agent 分配'
// 订单标题上限：标题是给人扫下拉用的，不是需求摘要
const TITLE_MAX = 12
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

/** 需求首句前 12 字：订单标题的缺省值（用户填了 title 就用用户的）。 */
export function titleFromRequirement(requirement, max) {
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : TITLE_MAX
  const text = String(requirement || '')
    .replace(/^\s*#.*$/gm, '')          // 去掉 markdown 标题行（requirement.md 里带）
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  // 首句：先按中英文句末标点切，切不出来就整段截
  const first = text.split(/[。！？!?；;\n]/)[0].trim() || text
  return first.slice(0, cap).trim()
}

/** 下单时用户填的表单（标题 / 调查模型 / 执行模型），落在 <run>/order.json */
function readOrder(dir) {
  const o = readJson(join(dir, ORDER))
  return o && typeof o === 'object' ? o : null
}

/** 订单标题：order.json > 需求首句截 12 字 > 目录名 */
function titleOf(dir) {
  const o = readOrder(dir)
  if (o && typeof o.title === 'string' && o.title.trim()) return o.title.trim()
  const req = readRequirement(dir)
  const derived = titleFromRequirement(req)
  return derived || dir.split(/[\\/]/).pop()
}

function readRequirement(dir) {
  try {
    return existsSync(join(dir, 'requirement.md')) ? readFileSync(join(dir, 'requirement.md'), 'utf8').replace(/^#.*$/gm, '').trim() : ''
  } catch {
    return ''
  }
}

// ── 可派活的模型清单 ─────────────────────────────────────────────────────
// 唯一事实源是宿主的 llm 服务（和 DSH 模型选择器同源）。config/models.json 只是兜底：
// 拿不到 llm 服务、或者服务里一个模型都没列出来时，才用它，并在 source 里标明。
const MODELS_TTL_MS = 45 * 1000
// 按 llm 实例缓存：listModels 可能打网络，不能每次 /state 都拉。
const modelsCache = new WeakMap()

export function clearModelsCache(llm) {
  if (llm) modelsCache.delete(llm)
}

async function listDispatchableModels(llm) {
  if (!llm || typeof llm.listProviders !== 'function') return []
  let providers
  try {
    providers = await llm.listProviders()
  } catch {
    return []
  }
  const out = []
  for (const p of Array.isArray(providers) ? providers : []) {
    const pid = String((p && (p.id || p.name)) || '')
    if (!pid || typeof llm.listModels !== 'function') continue
    let models
    try {
      models = await llm.listModels(pid)
    } catch {
      continue
    }
    for (const m of Array.isArray(models) ? models : []) {
      const mid = String((m && m.id) || '')
      if (!mid) continue
      out.push({ provider: pid, model: mid, label: String((m && m.name) || mid) + '（' + pid + '）' })
    }
  }
  return out
}

async function liveModels(llm) {
  if (!llm || typeof llm.listProviders !== 'function') return []
  const hit = modelsCache.get(llm)
  if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.options
  const options = await listDispatchableModels(llm)
  modelsCache.set(llm, { at: Date.now(), options })
  return options
}

/** 兜底清单：config/models.json；文件没了就只剩「由主 Agent 分配」。 */
export function readStaticModels(modelsFile) {
  const file = modelsFile || process.env.DSH_SELFLOOP_MODELS || MODELS_FILE
  const j = readJson(file)
  const list = Array.isArray(j && j.models) ? j.models : []
  const options = list
    .map((m) => ({ provider: String((m && m.provider) || ''), model: String((m && m.model) || ''), label: String((m && m.label) || (m && m.model) || '') }))
    .filter((m) => m.provider && m.model)
  return { default: MODELS_DEFAULT, source: 'fallback', options }
}

/** /state.models：live（宿主 llm 服务）优先，fallback 才是静态清单。 */
export async function readModels(modelsFile, llm) {
  const live = await liveModels(llm)
  if (live.length) return { default: MODELS_DEFAULT, source: 'live', options: live }
  return readStaticModels(modelsFile)
}

/** 规范化请求体里的 {provider, model}；不合法一律当「没指定」。 */
function normalizeModel(v) {
  if (!v || typeof v !== 'object') return null
  const provider = typeof v.provider === 'string' ? v.provider.trim() : ''
  const model = typeof v.model === 'string' ? v.model.trim() : ''
  return provider && model ? { provider, model } : null
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
  const stageDir = join(dir, 'stages')
  let hasStages = false
  try { hasStages = readdirSync(stageDir).some((f) => f.endsWith('.json')) } catch { hasStages = false }
  if (!hasStages) return 'wait-agent'
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
    // 标题：以 order.json 为准（/start 时落的）；老订单没有 order.json 就用目录名
    const order = readOrder(dir)
    const title = order && typeof order.title === 'string' && order.title.trim() ? order.title.trim() : name
    out.push({
      name,
      dir,
      title,
      state: orderStateOf(dir),
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined,
      current: currentDir ? dir === currentDir : false,
    })
  }
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}


/** 节点 → 人话状态（用户要"知道 Agent 在干嘛"，而不是看节点 id） */
const NODE_TEXT = [
  [/^1\.1-preflight/, '量参考、建骨架'],
  [/^1\.2-translate1|^1\.8-translate2|^1\.10-translate3/, '正在转译需求'],
  [/^1\.3-research-env|^1\.4-research-doc|^1\.5-research-ref/, '等待子代理调查'],
  [/^1\.6-gate/, '核对调研完整性'],
  [/^1\.7-absorb/, '吸收调查报告'],
  [/^1\.9-confirm/, '等待用户确认意向'],
  [/^2\.1-plan/, '列工单'],
  [/^2\.2-exec/, '等待子代理执行'],
  [/^2\.3-verify/, '验收中'],
  [/^2\.4-critique/, '等待观察员评审'],
  [/^2\.4b-userreview/, '等待用户评审'],
  [/^2\.5-decide/, '决定要不要下一轮'],
  [/^2\.6-knowledge/, '等待补充调查'],
  [/^2\.7-absorb/, '吸收调研结论'],
  [/^3\.1-summarize/, '写总结'],
  [/^3\.2-deliver/, '交付校验'],
]

function nodeText(id) {
  for (const [re, text] of NODE_TEXT) if (re.test(String(id))) return text
  return id ? '处理 ' + id : '未知'
}

/** 子代理名册：主 Agent 派活时写 <run>/active-agents.json，UI 直接读；没有就是空。 */
function readAgents(dir) {
  const j = readJson(join(dir, 'active-agents.json'))
  if (!j || !Array.isArray(j.agents)) return []
  return j.agents.map((a) => ({ name: String(a.name || ''), task: String(a.task || '') })).filter((a) => a.name)
}

/** 每轮归档目录（rounds/r1, r2, ...） */
function roundDirs(dir) {
  const base = join(dir, 'rounds')
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter((f) => /^r\d+$/.test(f))
    .map((f) => ({ round: Number(f.slice(1)), dir: join(base, f) }))
    .sort((a, b) => a.round - b.round)
}

/** 吐槽归属哪一轮：stage 形如 2.4-critique-r1 → 1；1.x → 0 */
function roundOfStage(stage) {
  const m = String(stage || '').match(/-r(\d+)$/)
  if (m) return Number(m[1])
  if (/^1\./.test(String(stage))) return 0
  return null
}

async function buildState(dir, cfg) {
  const { budget, nodes } = allNodes(dir)
  const models = await readModels(cfg && cfg.modelsFile, cfg && typeof cfg.getLlm === 'function' ? cfg.getLlm() : undefined)
  const requirementText = readRequirement(dir)
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
    title: titleOf(dir),
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
    requirement: requirementText,
    models,
    status: {
      text: nodeText(cur.node && cur.node.id),
      node: cur.node ? cur.node.id : null,
      agents: readAgents(dir),
      windowOpen: windowState(dir).open,
    },
    rounds: roundDirs(dir).map(({ round, dir: rd }) => {
      const plan = readJson(join(rd, 'plan.json'))
      const verify = readJson(join(rd, 'verify.json'))
      const review = readJson(join(rd, 'review.json'))
      const decide = readJson(join(rd, 'decide.json'))
      const confirm = readJson(join(rd, 'intent.confirm.json'))
      const answers = readJson(join(rd, 'intent.confirm.answers.json'))
      const ints = existsSync(join(rd, 'user-interrupt.jsonl'))
        ? readFileSync(join(rd, 'user-interrupt.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return undefined } }).filter(Boolean)
        : interrupts.filter((it) => roundOfStage(it.stage) === round)
      return {
        round,
        confirm: confirm ? { questions: confirm.questions || [], answers: answers ? answers.answers || [] : [] } : null,
        interrupts: ints,
        plan: plan ? { orders: plan.orders || [], executor: plan.executor && plan.executor.model } : null,
        verify: verify ? { pass: verify.pass || [], fail: verify.fail || [] } : null,
        review: review ? { verdict: review.verdict } : null,
        decide: decide ? { action: decide.action, gapsForNextRound: decide.gapsForNextRound || [], nextRoundOrders: decide.nextRoundOrders || [] } : null,
      }
    }),
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
  const sessionKey = searchParams.get('session') || ''
  const dir = needsRun ? resolveRunDir(searchParams.get('run') || cfg.runDir, sessionKey) : undefined
  if (needsRun && !dir) {
    send(res, 404, { ok: false, error: 'no-active-run' })
    return true
  }
  try {
    if (method === 'GET' && route === 'state') return send(res, 200, await buildState(dir, cfg)), true
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
      // 下单表单：标题 + 用户指定的调查/执行模型（没指定就是 null = 由主 Agent 分配）
      // 契约 v2 §2：落 <run>/order.json，UI 的 orders[].title 与 /state.title 都从它读
      const titleGiven = typeof body.title === 'string' ? body.title.trim().slice(0, 40) : ''
      const title = titleGiven || titleFromRequirement(requirement) || runDir.split(/[\\/]/).pop()
      const researchModel = normalizeModel(body.researchModel)
      const execModel = normalizeModel(body.execModel)
      writeFileSync(join(runDir, ORDER), JSON.stringify({
        title,
        researchModel,
        execModel,
        session: body.session || null,
        at: new Date().toISOString(),
      }, null, 2), 'utf8')
      // 待接手标记：Agent 侧靠它知道「有单等着开跑」（用户在界面下单 ≠ 流程已开跑）
      writeFileSync(join(runDir, 'order-pending.json'), JSON.stringify({
        at: new Date().toISOString(),
        title,
        requirementPreview: requirement.slice(0, 200),
        refs: saved,
        session: body.session || null,
        researchModel,
        execModel,
      }, null, 2), 'utf8')
      try {
        if (!writePointer(runDir, { cmd: 'ui-start', session: body.session || null }, body.session)) throw new Error('pointer failed')
      } catch (e) {
        return send(res, 500, { ok: false, error: 'pointer-write-failed: ' + String(e && e.message) }), true
      }
      return send(res, 200, { ok: true, runDir, run: runDir.split(/[\\/]/).pop(), title, refs: saved, researchModel, execModel }), true
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

export { buildState, windowState, handle, titleOf, readAgents }