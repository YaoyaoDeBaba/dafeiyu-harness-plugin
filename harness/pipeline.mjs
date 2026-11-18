// Selfloop Pipeline v2 · 流程由程序控制；节点三类：program / manager(主Agent) / worker(子代理)
//
// 阶段0 录单(程序) → 阶段1 需求建立(三路调查 + 三轮转译) → 阶段2 执行(按轮循环) → 阶段3 交付
// 每一步都是「系统 → 主Agent/子代理 → 提交给系统」，程序只认提交上来的文件。
//
// 预算 <run>/budget.json：
//   research: low(跳过) | mid(环境/工具/指南) | high(默认：+技术文献) | max(+参考图/现实知识)
//   maxRounds: 迭代轮次上限   useCritic: 是否派观察员(false 则主Agent 直接验收)
//
// 用法：status / step(exit 10 = 需要执行节点，票已生成) / done --stage <id>
//
// 【子代理名册的约定】本文件**不写** <run>/active-agents.json。
// 谁派子代理谁写：主 Agent 每次派活（1.3/1.4/1.5 调查员、2.2 执行员、2.4 观察员…）时，
// 把「当前在跑的子代理及其在干什么」写进 <run>/active-agents.json，形状见 docs/ui-contract-v2.md §3：
//   { "at": "2026-11-17T…", "agents": [ { "name": "exec-cloud4", "task": "云改 ParticleSystem" } ] }
// 右侧栏只读这个文件展示「卡在谁身上」；不写就是空名册（UI 不会报错）。
// 流水线这边只在 step 出票时写 active.json（主 Agent 正在处理哪个节点），两者不是一回事。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { ticketFor } from './tickets.mjs'
import { hasForm, writeBlankForm, checkForm } from './forms.mjs'
import { missingPieces as snapshotMissing } from './snapshot.mjs'
import { crashCheck } from './crash-check.mjs'
import { capabilityPrecheck } from './intent.mjs'

const STAGE_DIR = 'stages'
const TICKET_DIR = 'tickets'
const DEFAULT_BUDGET = { research: 'high', maxRounds: 1, useCritic: false, userReview: false, resupply: true }
const TIER = { low: 0, mid: 1, high: 2, max: 3 }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const j = (...a) => join(...a)

export function getBudget(dir) {
  const b = readJson(j(dir, 'budget.json')) || {}
  const research = ['low', 'mid', 'high', 'max'].includes(b.research) ? b.research : DEFAULT_BUDGET.research
  const mr = Number(b.maxRounds)
  const maxRounds = Number.isFinite(mr) && mr > 0 ? Math.min(20, Math.round(mr)) : DEFAULT_BUDGET.maxRounds
  const useCritic = b.useCritic === undefined ? DEFAULT_BUDGET.useCritic : Boolean(b.useCritic)
  const userReview = b.userReview === undefined ? DEFAULT_BUDGET.userReview : Boolean(b.userReview)
  const resupply = b.resupply === undefined ? DEFAULT_BUDGET.resupply : Boolean(b.resupply)
  return { research, maxRounds, useCritic, userReview, resupply }
}

// ── 面板吐槽（user-interrupt.jsonl）的消费 ───────────────────────────────
// 吐槽只落 jsonl 不消费 = 用户白说（待办 15）。统一三件事：
//   ① 读；② 判「这条到底进没进 decide」（比文本，不看 at+text 的精确键）；
//   ③ 去重按「前 8 字 + 相似度」——同一个意思换个标点不算两条，改口的另算一条。
const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, '').trim()

function bigramDice(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const A = grams(a)
  const B = grams(b)
  const total = a.length - 1 + (b.length - 1)
  if (!total) return 0
  let hit = 0
  for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0)
  return (2 * hit) / total
}

/** 两条吐槽是不是同一件事：前 8 字相同，或整体足够像。 */
export function sameComplaint(a, b) {
  const x = normText(a)
  const y = normText(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.slice(0, 8) === y.slice(0, 8)) return true
  if (Math.min(x.length, y.length) < 4) return false // 太短不做相似度，免得把两句话并成一条
  // 「出现在某条 field 里」也算消费了：用户原话常被主 Agent 扩写成一句话
  if (x.includes(y) || y.includes(x)) return true
  return bigramDice(x, y) >= 0.72
}

function readInterrupts(dir) {
  const p = j(dir, 'user-interrupt.jsonl')
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (!rec || typeof rec.text !== 'string' || !rec.text.trim()) continue
    out.push(rec)
  }
  return out
}

/** 把一个对象里所有字符串摊平（含 nextRoundOrders[].task 这类嵌套值）。 */
function stringsOf(value, out) {
  const acc = out || []
  if (typeof value === 'string') acc.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, acc)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsOf(v, acc)
  return acc
}

/** jsonl 里有、但 decide.json 任何字段都没出现的吐槽。 */
export function unconsumedInterrupts(dir, decide) {
  const d = decide === undefined ? readJson(j(dir, 'decide.json')) : decide
  const list = readInterrupts(dir)
  if (!d) return list
  const hay = stringsOf(d, [])
  return list.filter((rec) => !hay.some((s) => sameComplaint(s, rec.text)))
}

export const checks = {
  userReview(dir) {
    const u = readJson(j(dir, 'user-review.json'))
    if (!u) return ['缺 user-review.json（用户参与评审，但没收到意见）']
    const out = []
    const c = Array.isArray(u.comments) ? u.comments : []
    if (c.length === 0) out.push('comments 为空（用户没留意见也要明确写"无意见"）')
    if (!u.by) out.push('缺 by（谁给的评审：用户本人？）')
    if (!u.shot || !String(u.shot).trim()) out.push('缺 shot（用户评审时看的是哪张图/哪个入口）')
    return out
  },
  knowledge(dir) {
    const m = String(dir).match(/knowledge-r(\d+)$/) ? null : null
    const node = arguments[1] || {}
    const rm = String(node.id || '').match(/2\.6-knowledge-r(\d+)/)
    const r = rm ? rm[1] : '1'
    const f = readJson(j(dir, 'research.supplement-r' + r + '.json'))
    if (!f) return ['缺 research.supplement-r' + r + '.json（没做补充知识调查）']
    const out = []
    const fd = Array.isArray(f.findings) ? f.findings : []
    if (fd.length === 0) out.push('findings 为空')
    const url = fd.filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
    if (url.length < 1) out.push('补充调研至少要有 1 条带真实 URL 的 finding')
    const noTarget = fd.filter((x) => x && x.usedFor !== undefined && !String(x.usedFor).trim())
    if (noTarget.length) out.push('有 finding 的 usedFor 为空')
    if (!Array.isArray(f.targets) || f.targets.length === 0) out.push('缺 targets（这次补调研是针对哪些缺口）')
    return out
  },
  nextBrief(dir) {
    const b = readJson(j(dir, 'nextRoundBrief.json'))
    if (!b) return ['缺 nextRoundBrief.json（补调研没被吸收成下一轮需求）']
    const out = []
    if (!b.goal || !String(b.goal).trim()) out.push('goal 为空（下一轮要打成什么样没说）')
    if (!Array.isArray(b.absorbed) || b.absorbed.length === 0) out.push('absorbed 为空（调研没转成做法）')
    if (!b.criteriaDelta || typeof b.criteriaDelta !== 'object') out.push('缺 criteriaDelta（判据增删改）')
    if (!Array.isArray(b.orders) || b.orders.length === 0) out.push('orders 为空（下一轮没有候选工单）')
    return out
  },
  merged(dir) {
    const m = readJson(j(dir, 'review.merged.json'))
    if (!m) return ['缺 review.merged.json（没把观察员与用户的意见合并）']
    const out = []
    if (!Array.isArray(m.fromCritic) || m.fromCritic.length === 0) out.push('fromCritic 为空（观察员的结论没并进来）')
    if (!Array.isArray(m.fromUser) || m.fromUser.length === 0) out.push('fromUser 为空（用户的意见没并进来）')
    if (!Array.isArray(m.conflicts)) out.push('缺 conflicts（观察员与用户冲突时怎么取舍要写清）')
    if (!Array.isArray(m.nextRoundOrders) || m.nextRoundOrders.length === 0) out.push('nextRoundOrders 为空（合并结果要变成下一轮工单）')
    return out
  },
  draft1(dir) {
    const d = readJson(j(dir, 'intent.draft1.json'))
    if (!d) return ['缺 intent.draft1.json（初轮转译没有产出）']
    const out = []
    if (!d.restate || !String(d.restate).trim()) out.push('restate 为空')
    if (!Array.isArray(d.openQuestions) || d.openQuestions.length === 0) out.push('openQuestions 为空（那调查员就没有线索）')
    return out
  },
  draft2(dir) {
    const d = readJson(j(dir, 'intent.draft2.json'))
    if (!d) return ['缺 intent.draft2.json（第二轮转译没有产出）']
    const out = []
    if (!Array.isArray(d.criteria) || d.criteria.length === 0) out.push('criteria 为空')
    const noMeas = (d.criteria || []).filter((c) => !(c && (c.userWords || c.howMeasured)))
    if (noMeas.length) out.push(noMeas.length + ' 条 criteria 既没 userWords 也没 howMeasured')
    return out
  },
  confirm(dir) {
    const c = readJson(j(dir, 'intent.confirm.json'))
    if (!c) return ['缺 intent.confirm.json（没有整理待确认问题）']
    const out = []
    const q = Array.isArray(c.questions) ? c.questions : []
    const a = Array.isArray(c.autoConfirmed) ? c.autoConfirmed : []
    if (q.length === 0 && a.length === 0) out.push('questions 与 autoConfirmed 都是空的（等于没做这一步）')
    const noRec = q.filter((x) => !x || !x.recommend)
    if (noRec.length) out.push(noRec.length + ' 个问题没给建议答案（把选择题原样丢给用户）')
    return out
  },
  measured(dir) {
    const r = readJson(j(dir, 'research.json'))
    if (!r) return ['缺 research.json —— 先跑 node harness/preflight.mjs --run ' + dir + ' --ref <参考素材>']
    return (Array.isArray(r.extracted) && r.extracted.length > 0) ? [] : ['extracted[] 为空（参考没量过）']
  },
  loaded(dir) {
    const out = []
    if (!existsSync(j(dir, 'requirement.md'))) out.push('缺 requirement.md（用户原话没录进来）')
    const refs = j(dir, 'refs')
    if (!existsSync(refs) || readdirSync(refs).length === 0) out.push('refs/ 是空的（没有多模态参考）')
    return out
  },
  researchTier(dir) {
    const b = getBudget(dir)
    const r = readJson(j(dir, 'research.json'))
    if (!r) return ['缺 research.json']
    const out = []
    if (!Array.isArray(r.extracted) || r.extracted.length === 0) out.push('extracted[] 为空（没量参考）')
    const f = Array.isArray(r.findings) ? r.findings : []
    const env = f.filter((x) => x && x.kind === 'environment')
    const url = f.filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
    const ver = url.filter((x) => ['opensource', 'paper'].includes(x.kind))
    const used = f.filter((x) => x && x.used === true)
    const noWhy = used.filter((x) => !(typeof x.usedFor === 'string' && x.usedFor.trim() !== ''))
    if (TIER[b.research] >= 1 && env.length === 0) out.push('research=' + b.research + ' 要求至少 1 条 kind=environment 的 finding')
    if (TIER[b.research] >= 2 && url.length < 2) out.push('research=' + b.research + ' 要求至少 2 条带 URL 的 findings')
    if (TIER[b.research] >= 2 && ver.length < 1) out.push('要至少 1 条 kind=opensource/paper')
    if (TIER[b.research] >= 1 && used.length < 1) out.push('至少 1 条 used=true（调研要改变做法）')
    if (noWhy.length > 0) out.push('有 ' + noWhy.length + ' 条 used=true 没写 usedFor')
    return out
  },
  absorbed(dir) {
    const a = readJson(j(dir, 'absorbed.json'))
    if (!a) return ['缺 absorbed.json（调查结果没被吸收）']
    const out = []
    if (!Array.isArray(a.takeaways) || a.takeaways.length === 0) out.push('takeaways 为空')
    if (a.changedApproach !== true && !String(a.note || '').trim()) out.push('没说明调查是否改变了做法')
    return out
  },
  intent(dir) {
    const i = readJson(j(dir, 'intent.json'))
    if (!i) return ['缺 intent.json']
    const rj = readJson(j(dir, 'research.json')) || { extracted: [] }
    const ext = Array.isArray(rj.extracted) ? rj.extracted : []
    const out = []
    if (!i.restate || !String(i.restate).trim()) out.push('restate 为空')
    if (!Array.isArray(i.criteria) || i.criteria.length === 0) out.push('criteria 为空')
    if (!Array.isArray(i.anchors) || i.anchors.length === 0) out.push('anchors 为空')
    if (i.confirmed !== true) out.push('confirmed 不是 true')
    ;(i.criteria || []).forEach((c) => {
      const id = c && c.id ? c.id : '(无id)'
      const meas = String((c && (c.howMeasured || c.how)) || '')
      if (c && c.noMetric === true) { if (!meas.trim()) out.push(id + '：标了 noMetric 却没写理由'); return }
      const target = Number(c && c.target)
      if (!Number.isFinite(target)) { out.push(id + '：没有数值 target（阈值要来自实测，或显式 noMetric）'); return }
      // dir（2026-11-18）：**判据方向必须显式写**，不许把「参考实测的近似区间」当双侧门。
      // 踩过的坑：p99 ≥0.045（下限）被写成 ≤0.0523（上限），第 3 轮为一个不存在的上限牺牲了 p50 与 C4。
      // 语义：lower = 下限型（target 不低于某条实测 min）；upper = 上限型（不高于某条实测 max）；
      //       two-sided = 区间型（落在某条实测 [min,max] 内，旧行为）。
      const dir = String((c && (c.dir || c.direction)) || '').trim().toLowerCase()
      if (!dir) { out.push(id + '：缺 dir（lower / upper / two-sided）——判据方向不能省，写反过一次，代价是一整轮'); return }
      if (!['lower', 'upper', 'two-sided'].includes(dir)) {
        out.push(id + '：dir=' + dir + ' 不认识（只能是 lower / upper / two-sided）'); return
      }
      const list = ext.filter((e) => e && Number.isFinite(Number(e.value)))
      if (list.length === 0) return
      const okRange = list.some((e) => {
        const v = Number(e.value)
        const mn = Number.isFinite(Number(e.min)) ? Number(e.min) : v
        const mx = Number.isFinite(Number(e.max)) ? Number(e.max) : v
        if (dir === 'lower') return target >= mn - 1e-9
        if (dir === 'upper') return target <= mx + 1e-9
        return target >= mn - 1e-9 && target <= mx + 1e-9
      })
      if (!okRange) {
        const why = dir === 'lower'
          ? 'target=' + target + ' 低于所有实测 min（下限型：不许比实测的最弱者还低）'
          : dir === 'upper'
            ? 'target=' + target + ' 高于所有实测 max（上限型：不许比实测的最强者还高）'
            : 'target=' + target + ' 不在任何实测区间里'
        out.push(id + '：' + why)
      }
    })
    return out
  },
  plan(dir) {
    const p = readJson(j(dir, 'plan.json'))
    if (!p) return ['缺 plan.json（没列工单）']
    const out = []
    if (!Array.isArray(p.orders) || p.orders.length === 0) out.push('orders 为空')
    if (!p.executor || !p.executor.model) out.push('没配执行员模型')
    return out
  },
  executed(dir, node) {
    const m = String(node.id).match(/2\.2-exec-r(\d+)/)
    const rounds = j(dir, 'rounds')
    if (!existsSync(rounds)) return ['缺 rounds/ 目录']
    const files = readdirSync(rounds).filter((f) => f.endsWith('.json')).sort()
    if (files.length === 0) return ['rounds/ 里没有 NN.json']
    const name = m ? m[1].padStart(2, '0') + '.json' : files[files.length - 1]
    const last = readJson(j(rounds, name))
    if (!last) return ['第 ' + name + ' 轮读不出来']
    const out = []
    if (!last.shot && !last.preview) out.push('没有截图或可运行入口')
    if (!Array.isArray(last.changes) || last.changes.length === 0) out.push('没写改了什么')
    return out
  },
  verified(dir) {
    const v = readJson(j(dir, 'verify.json'))
    if (!v) return ['缺 verify.json（没验收）']
    // ㉞ 崩坏自检**优先于任何数值判据**：列进 verify.shots 的帧先证明没崩（洋红 / 纯色大块 / 全黑全白），
    // 崩了的帧再"接近目标"也是废图 —— 数值判据不许放行它。
    const crash = []
    const shots = Array.isArray(v.shots) ? v.shots : []
    for (const s of shots) {
      const name = String(s || '').trim()
      if (!name) continue
      const file = isAbsolute(name) ? name : j(dir, name)
      if (!existsSync(file)) {
        crash.push('崩坏自检：' + name + ' 不存在（列进 verify.shots 就要能查到）')
        continue
      }
      const r = crashCheck(file)
      if (r.fail) crash.push('崩坏自检不通过：' + name + ' → ' + r.reasons.join('；'))
    }
    const out = crash
    if (v.runs !== true) out.push('没有确认能跑（编译/加载通过）')
    if (v.visible !== true) out.push('没有确认能看（有图或入口）')
    return out
  },
  critiqued(dir) {
    const c = readJson(j(dir, 'review.json'))
    if (!c) return ['缺 review.json']
    const out = []
    if (!c.verdict) out.push('缺 verdict')
    if (!Array.isArray(c.vsCriteria) || c.vsCriteria.length === 0) out.push('vsCriteria 为空')
    return out
  },
  decided(dir) {
    const d = readJson(j(dir, 'decide.json'))
    if (!d) return ['缺 decide.json']
    if (!['next', 'stop'].includes(d.action)) return ['decide.action 只能是 next 或 stop']
    const out = []
    if (d.action === 'next' && (!Array.isArray(d.nextRoundOrders) || d.nextRoundOrders.length === 0)) {
      out.push('决定 next 却没给 nextRoundOrders（下一轮打什么不说，等于空转）')
    }
    // 吐槽必须有去处：jsonl 里有一条就要求它在 decide.json 里出现（gapsForNextRound / nextRoundOrders / 任何字段都算）
    const pending = unconsumedInterrupts(dir, d)
    if (pending.length) {
      out.push('有 ' + pending.length + ' 条面板吐槽没进 decide.json（先并进 gapsForNextRound 再交活）：' + pending.map((p) => String(p.text).slice(0, 24)).join('｜'))
    }
    return out
  },
  summarized(dir) {
    const s = readJson(j(dir, 'summary.json'))
    if (!s) return ['缺 summary.json']
    return (!s.text || !String(s.text).trim()) ? ['summary.text 为空'] : []
  },
  delivered(dir) {
    const d = readJson(j(dir, 'deliver.json'))
    if (!d) return ['缺 deliver.json']
    const out = []
    if (!d.finalShot && !d.artifacts) out.push('交付里没有产物')
    if (!Array.isArray(d.suggestion) || d.suggestion.length === 0) out.push('没有建议')
    return out
  }
}

const pushIf = (arr, cond, node) => { if (cond) arr.push(node) }

export function phase1Nodes(budget) {
  const t = TIER[budget.research] ?? 2
  const n = []
  n.push({ id: '1.1-preflight', kind: 'program', title: '量参考 / 建骨架', check: 'measured' })
  n.push({ id: '1.2-translate1', kind: 'manager', title: '初轮需求转译（只看需求+实测）', check: 'draft1' })
  pushIf(n, t >= 1, { id: '1.3-research-env', kind: 'worker', title: '调查员c：环境/工具/指南' })
  pushIf(n, t >= 2, { id: '1.4-research-doc', kind: 'worker', title: '调查员a：技术文献（GitHub/论文/算法）' })
  pushIf(n, t >= 3, { id: '1.5-research-ref', kind: 'worker', title: '调查员b：参考图/参考产品/现实知识' })
  n.push({ id: '1.6-gate', kind: 'program', title: '调研闸：按预算档位核调研完整性', check: 'researchTier' })
  n.push({ id: '1.7-absorb', kind: 'manager', title: '吸收调查结果', check: 'absorbed' })
  n.push({ id: '1.8-translate2', kind: 'manager', title: '第二轮转译（吸收后）', check: 'draft2' })
  n.push({ id: '1.9-confirm', kind: 'manager', title: '向用户确认意向', check: 'confirm' })
  n.push({ id: '1.10-translate3', kind: 'manager', title: '第三轮转译（定稿判据）', check: 'intent' })
  return n
}

export function roundNodes(r, budget) {
  const n = [
    { id: '2.1-plan-r' + r, kind: 'manager', title: '列工单 + 配执行员', check: 'plan' },
    { id: '2.2-exec-r' + r, kind: 'worker', title: '按工单执行', check: 'executed' },
    { id: '2.3-verify-r' + r, kind: 'manager', title: '验收：能跑 / 能看', check: 'verified' }
  ]
  pushIf(n, budget.useCritic, { id: '2.4-critique-r' + r, kind: 'worker', title: '观察员：逐条对判据评审', check: 'critiqued' })
  pushIf(n, budget.userReview, { id: '2.4b-userreview-r' + r, kind: 'human', title: '用户评审（等人给意见）', check: 'userReview' })
  n.push({ id: '2.5-decide-r' + r, kind: 'manager', title: '判断是否下一轮（吸收观察员/用户意见）', check: 'decided' })
  // 只有  决定 next 才有意义：定向补调研 + 主Agent 转成下一轮需求
  pushIf(n, budget.resupply, { id: '2.6-knowledge-r' + r, kind: 'worker', title: '补充知识调查（按本轮缺口定向查）', check: 'knowledge' })
  pushIf(n, budget.resupply, { id: '2.7-absorb-r' + r, kind: 'manager', title: '吸收调研 → 输出下一轮需求', check: 'nextBrief' })
  return n
}

export function phase3Nodes() {
  return [
    { id: '3.1-summarize', kind: 'manager', title: '写对用户的总结', check: 'summarized' },
    { id: '3.2-deliver', kind: 'program', title: '产物齐全校验', check: 'delivered' }
  ]
}

export function allNodes(dir) {
  const budget = getBudget(dir)
  const nodes = phase1Nodes(budget)
  for (let r = 1; r <= budget.maxRounds; r += 1) nodes.push(...roundNodes(r, budget))
  nodes.push(...phase3Nodes())
  return { budget, nodes }
}

function loadSignals(dir) {
  const p = j(dir, STAGE_DIR)
  if (!existsSync(p)) return {}
  const out = {}
  for (const f of readdirSync(p).filter((x) => x.endsWith('.json'))) {
    const s = readJson(j(p, f))
    if (s && s.stage) out[s.stage] = s
  }
  return out
}

/**
 * phase3 的两个信号是「一轮跑完才写」的：decide=next 之后它们属于上一轮，必须重跑。
 * 新版 done() 会直接删掉它们；这里用**时间兜底**，管老版本跑过的 run（文件还在，信号过期）：
 * 只要「本轮循环」的 2.1-plan-rN（N≥2 且晚于它们）已经 done，就把 3.1/3.2 当成没写。
 * 没有 at 字段的老测试夹具保持原行为（不判 stale）。
 */
function stalePhase3Signals(signals) {
  let lastPlanAt = 0
  for (const k of Object.keys(signals)) {
    if (!k.startsWith('2.1-plan-r')) continue
    const s = signals[k]
    if (!s || s.status !== 'done') continue
    const at = Date.parse(String(s.at || '')) || 0
    if (at > lastPlanAt) lastPlanAt = at
  }
  const out = {}
  for (const id of ['3.1-summarize', '3.2-deliver']) {
    const s = signals[id]
    const at = s ? (Date.parse(String(s.at || '')) || 0) : 0
    out[id] = Boolean(s && s.status === 'done' && at > 0 && lastPlanAt > at)
  }
  return out
}

export function currentNode(dir) {
  const { budget, nodes } = allNodes(dir)
  const signals = loadSignals(dir)
  const stalePhase3 = stalePhase3Signals(signals)
  let stoppedAt = 0
  Object.keys(signals).forEach((k) => {
    const m = k.match(/^2\.5-decide-r(\d+)$/)
    if (m && signals[k].action === 'stop') stoppedAt = Math.max(stoppedAt, Number(m[1]))
  })
  for (const n of nodes) {
    const rm = String(n.id).match(/-r(\d+)$/)
    if (rm && stoppedAt > 0) {
      const rr = Number(rm[1])
      // 后续轮次整轮跳过；本轮里 decide 之后的补调研/吸收也跳过
      if (rr > stoppedAt) continue
      if (rr === stoppedAt && /^2\.(6|7)-/.test(String(n.id))) continue
    }
    let s = signals[n.id]
    if (s && stalePhase3[n.id]) s = undefined
    if (!s || s.status !== 'done') return { node: n, signals, budget }
  }
  return { node: null, signals, budget }
}

function writeSignal(dir, stage, st, extra) {
  mkdirSync(j(dir, STAGE_DIR), { recursive: true })
  writeFileSync(j(dir, STAGE_DIR, stage + '.json'), JSON.stringify(Object.assign({ stage, status: st, by: 'pipeline', at: new Date().toISOString() }, extra || {}), null, 2), 'utf8')
}

function status(dir) {
  const { budget, nodes } = allNodes(dir)
  const r = currentNode(dir)
  console.log('=== pipeline: ' + dir + ' ===')
  console.log('预算：research=' + budget.research + ' | maxRounds=' + budget.maxRounds + ' | 观察员=' + (budget.useCritic ? '开' : '关'))
  let stopAt = 0
  Object.keys(r.signals).forEach((k) => {
    const m = k.match(/^2\.5-decide-r(\d+)$/)
    if (m && r.signals[k].action === 'stop') stopAt = Math.max(stopAt, Number(m[1]))
  })
  for (const n of nodes) {
    const s = r.signals[n.id]
    const rm = String(n.id).match(/-r(\d+)$/)
    const skippedByStop = rm && stopAt > 0 && (
      Number(rm[1]) > stopAt ||
      (Number(rm[1]) === stopAt && /^2\.(6|7)-/.test(String(n.id)))
    )
    const mark = skippedByStop ? '--' : !s ? '..' : s.status === 'done' ? 'OK' : 'NO'
    const owner = n.kind === 'manager' ? '[主Agent]' : n.kind === 'worker' ? '[子代理]' : n.kind === 'human' ? '[用户]  ' : '[程序]  '
    console.log('  [' + mark + '] ' + n.id.padEnd(20) + ' ' + owner + ' ' + n.title)
    if (s && s.problems && s.problems.length) s.problems.forEach((p) => console.log('        - ' + p))
  }
  console.log(r.node ? '\n当前节点：' + r.node.id + '（' + r.node.kind + '）' : '\n全部节点已完成')
  return r.node
}

/** 写「主 Agent 正在处理哪个环节」——乱入窗口靠它判断「主 Agent 处理中」。失败只吞。 */
/**
 * 每轮产物归档：plan/verify/review/decide 都是**同一个文件名每轮覆盖**，历史会丢。
 * 这里在对应节点交活时复制一份到 rounds/r<N>/，供 UI 按轮展示与回看。
 * 失败只警告（归档丢了不该挡住流水线）。
 */
function archiveRoundArtifact(dir, stageId, artifact) {
  const m = String(stageId).match(/-r(\d+)$/)
  const round = m ? m[1] : (/^1\.9-confirm$/.test(stageId) ? '1' : '')
  if (!round) return
  try {
    const src = j(dir, artifact)
    if (!existsSync(src)) return
    const outDir = j(dir, 'rounds', 'r' + round)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(j(outDir, artifact), readFileSync(src))
  } catch (e) {
    console.warn('  归档失败（不影响流程）：' + artifact + ' → r' + round + '：' + (e && e.message))
  }
}

/**
 * A5·㊱ 交活即快照：2.2-exec-rN 交活时 `rounds/r<N>/snapshot/` 要有三件套
 * （code/ + scene-params.json + params.md）。
 * 缺了**不硬拦** —— 写进 verify.caveat 留痕，让主 Agent 与用户看见；2.3-verify 交活时再补一次
 * （2.3 的执行者会重写 verify.json，把 caveat 冲掉）。
 */
function recordSnapshotCaveat(dir, round) {
  const missing = snapshotMissing(dir, round)
  if (missing.length === 0) return []
  const file = j(dir, 'verify.json')
  const v = readJson(file) || {}
  const caveat = Array.isArray(v.caveat) ? v.caveat.slice() : []
  const added = []
  for (const m of missing) {
    const line = 'r' + round + ' 快照不全：缺 rounds/r' + round + '/snapshot/' + m + '（交活即快照三件套：code/ + scene-params.json + params.md，见 skills/selfloop/references/executor-brief.md）'
    if (!caveat.includes(line)) {
      caveat.push(line)
      added.push(line)
    }
  }
  if (added.length === 0) return []
  v.caveat = caveat
  v.caveatAt = new Date().toISOString()
  v.caveatRound = round
  try {
    writeFileSync(file, JSON.stringify(v, null, 2), 'utf8')
  } catch {
    return []
  }
  return added
}

function touchActive(dir, stage, kind) {
  try {
    writeFileSync(j(dir, 'active.json'), JSON.stringify({ stage, kind, openedAt: new Date().toISOString() }, null, 2), 'utf8')
  } catch { /* 只读目录也能照常跑 */ }
}

function clearActive(dir) {
  try {
    const p = j(dir, 'active.json')
    if (existsSync(p)) rmSync(p)
  } catch { /* 同上 */ }
}

/** 消费 UI 写下来的东西：意向答案并入确认单、吐槽并入用户评审。 */
function absorbUiArtifacts(dir, stageId) {
  const notes = []
  // 1.9：意向确认单 + 面板提交的答案
  if (/^1\.9-confirm$/.test(stageId)) {
    const answers = readJson(j(dir, 'intent.confirm.answers.json'))
    const confirm = readJson(j(dir, 'intent.confirm.json'))
    if (answers && Array.isArray(answers.answers) && answers.answers.length && confirm) {
      confirm.answers = answers.answers
      confirm.decisions = Object.assign({}, confirm.decisions || {}, {
        source: answers.whoDecided === 'user' ? 'user(ui)' : 'default(no-ui)',
        answers: answers.answers,
        answeredAt: answers.at,
      })
      writeFileSync(j(dir, 'intent.confirm.json'), JSON.stringify(confirm, null, 2), 'utf8')
      notes.push('意向答案已并入 intent.confirm.json（source=' + confirm.decisions.source + '，' + answers.answers.length + ' 条）')
    }
  }
  // 2.5：把还没被消费的面板吐槽并进 decide.gapsForNextRound
  // （吐槽不能只挂在 2.4b 一个钩子上：预算里 userReview=false 时 2.4b 根本不存在）
  if (/^2\.5-decide-r(\d+)$/.test(stageId)) {
    const decide = readJson(j(dir, 'decide.json'))
    if (decide) {
      const gaps = Array.isArray(decide.gapsForNextRound) ? decide.gapsForNextRound.slice() : []
      // 逐条收：既要和 decide 里已有的比，也要和刚收进来的比（同一条说了两遍只算一条）
      const added = []
      for (const rec of unconsumedInterrupts(dir, decide)) {
        const text = String(rec.text).trim()
        if (gaps.some((g) => sameComplaint(g, text))) continue
        if (added.some((t) => sameComplaint(t, text))) continue
        added.push(text)
      }
      if (added.length) {
        decide.gapsForNextRound = gaps.concat(added)
        decide.uiInterrupts = (Number(decide.uiInterrupts) || 0) + added.length
        decide.gapsSource = decide.gapsSource || 'ui-interrupt(2.5-decide)'
        writeFileSync(j(dir, 'decide.json'), JSON.stringify(decide, null, 2), 'utf8')
        notes.push('面板吐槽已并入 decide.gapsForNextRound（' + added.length + ' 条）')
      }
    }
  }
  // 3.1：把「说过但总结里没提到的」吐槽列进 summary.unhandledInterrupts
  // 用户在界面吐槽过、但最终没进任何一轮工单的，必须被交到用户眼前（待办 15 的第二个消费点）
  if (/^3\.1-summarize$/.test(stageId)) {
    const lines = existsSync(j(dir, 'user-interrupt.jsonl')) ? readFileSync(j(dir, 'user-interrupt.jsonl'), 'utf8').split('\n').filter(Boolean) : []
    const summary = readJson(j(dir, 'summary.json'))
    if (lines.length && summary) {
      const text = String(summary.text || '')
      const unhandled = []
      const seen = []
      for (const line of lines) {
        let rec
        try { rec = JSON.parse(line) } catch { continue }
        if (sameComplaint(rec.text, text)) continue
        if (seen.some((x) => sameComplaint(x.text, rec.text))) continue
        seen.push(rec)
        unhandled.push({ at: rec.at, stage: rec.stage, text: rec.text, expired: !!rec.expired })
      }
      if (unhandled.length) {
        summary.unhandledInterrupts = unhandled
        writeFileSync(j(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
        notes.push('有 ' + unhandled.length + ' 条吐槽没进任何工单，已列进 summary.unhandledInterrupts')
      }
    }
  }
  // 2.4b：把面板吐槽并入用户评审意见
  if (/^2\.4b-userreview-r(\d+)$/.test(stageId)) {
    const lines = existsSync(j(dir, 'user-interrupt.jsonl')) ? readFileSync(j(dir, 'user-interrupt.jsonl'), 'utf8').split('\n').filter(Boolean) : []
    const review = readJson(j(dir, 'user-review.json'))
    if (lines.length && review) {
      const seen = new Set((review.comments || []).map((c) => String(c.evidence || c.point || '')))
      const added = []
      for (const line of lines) {
        let rec
        try { rec = JSON.parse(line) } catch { continue }
        const key = 'ui-interrupt:' + rec.at + ':' + rec.text
        if (seen.has(key)) continue
        seen.add(key)
        added.push({
          point: rec.text,
          severity: 'user-ui',
          evidence: key,
          source: 'ui-interrupt' + (rec.expired ? '(expired)' : ''),
          stage: rec.stage,
        })
      }
      if (added.length) {
        review.comments = (review.comments || []).concat(added)
        review.uiInterrupts = (review.uiInterrupts || 0) + added.length
        writeFileSync(j(dir, 'user-review.json'), JSON.stringify(review, null, 2), 'utf8')
        notes.push('面板吐槽已并入 user-review.json（' + added.length + ' 条）')
      }
    }
  }
  return notes
}

/**
 * 交活前自查提示（2026-11-18，只提示不拦）：
 *   · 2.2-exec-rN：看本轮 rounds/NN.json 的字段形状（changes 数组 / shot 或 preview）；
 *   · 1.10-translate3：看判据「本机位能不能测」（capabilityPrecheck，纯提示）。
 * 返回字符串数组，由 step() 打印到出票那一步。
 */
function hintsFor(dir, node) {
  const out = []
  const id = String((node && node.id) || '')
  if (id.startsWith('2.2-exec-r')) {
    const name = String(id.slice('2.2-exec-r'.length)).padStart(2, '0') + '.json'
    const last = readJson(j(dir, 'rounds', name))
    const problems = []
    if (!last) {
      problems.push('还没写（交活必须有：changes[] / metrics / leftovers / shot 或 preview）')
    } else {
      if (!last.shot && !last.preview) problems.push('没有截图或可运行入口（shot / preview 二选一）')
      if (!Array.isArray(last.changes) || last.changes.length === 0) problems.push('changes 要是数组且至少 1 条（改了什么）')
    }
    if (problems.length) out.push('rounds/' + name + '：' + problems.join('；'))
    out.push('本轮至少拍一组单变量 A/B 判别帧（只动一个变量、命名带 _ab_<变量>）—— 否则主指标变化归因不了（executor-brief 五-7）')
  }
  if (id === '1.10-translate3') {
    const it = readJson(j(dir, 'intent.json'))
    if (it) for (const w of capabilityPrecheck(it.criteria)) out.push(w)
  }
  return out
}

function step(dir) {
  for (let guard = 0; guard < 60; guard += 1) {
    const { node } = currentNode(dir)
    if (!node) { console.log('全部完成'); return 0 }
    if (node.kind === 'program') {
      const fn = checks[node.check]
      const problems = fn ? fn(dir, node) : []
      if (problems.length) { writeSignal(dir, node.id, 'failed', { problems }); console.log(node.id + ' 未通过：\n  ' + problems.join('\n  ')); return 1 }
      writeSignal(dir, node.id, 'done')
      console.log(node.id + ' 通过')
      continue
    }
    // 交活前自查（2026-11-18）：把「交活才报」的字段问题提前到**出票那一刻**说，不拦。
    // 上一单执行员被打了 3 次回票，全是 rounds/NN.json 形状不对（changes 不是数组、没 shot）——
    // 这些在拿票的时候就该看见，不必等 done 才被告知。
    const hints = hintsFor(dir, node)
    if (hints.length) {
      console.log('交活前自查（不拦，但交活时会被挡）：')
      for (const h of hints) console.log('  · ' + h)
    }
    const ticket = { stage: node.id, kind: node.kind, title: node.title, check: node.check, ...(node.kind === 'manager' && hasForm(node.id) ? { form: j(dir, 'forms', node.id + '.json') } : {}), prompt: ticketFor(dir, node) }
    mkdirSync(j(dir, TICKET_DIR), { recursive: true })
    touchActive(dir, node.id, node.kind)
    const p = j(dir, TICKET_DIR, node.id + '.json')
    writeFileSync(p, JSON.stringify(ticket, null, 2), 'utf8')
    if (node.kind === 'manager' && hasForm(node.id)) {
      const formPath = writeBlankForm(dir, node.id)
      console.log('表单：' + formPath + '（必办事项，填不完不放行）')
    }
    if (node.kind === 'human') {
      console.log('等待用户：' + node.id + '（把用户的评审意见写进 user-review.json 后调 done）')
      console.log('  票：' + p)
      return 11
    }
    console.log('需要执行节点：' + node.id + '（' + (node.kind === 'manager' ? '主Agent 自己做' : '派子代理') + '）')
    console.log('  票：' + p)
    return 10
  }
  console.log('节点表可能有环')
  return 1
}

function done(dir, stageId) {
  const { nodes } = allNodes(dir)
  const node = nodes.find((x) => x.id === stageId)
  if (!node) { console.log('未知节点：' + stageId); return 2 }
  // 顺序闸：只能交「当前节点」，不许提前交活（2026-11-16 实测：1.1 没跑就能交 1.2）
  const cur = currentNode(dir).node
  if (!cur || cur.id !== stageId) {
    console.log('顺序不对：当前节点是 ' + (cur ? cur.id : '(已完成)') + '，不是 ' + stageId + '。上游信号没到，不许提前交活。')
    return 3
  }
  const absorbed = absorbUiArtifacts(dir, stageId)
  if (absorbed.length) absorbed.forEach((n) => console.log('  · ' + n))
  const fn = checks[node.check]
  const problems = fn ? fn(dir, node) : []
  // 主Agent 节点：表单必填项一项都不能空（不控质量，只防遗漏）
  if (node.kind === 'manager' && hasForm(node.id)) problems.push(...checkForm(dir, node.id))
  if (problems.length) { writeSignal(dir, stageId, 'failed', { problems }); console.log(stageId + ' 产物不合格，卡住：\n  ' + problems.join('\n  ')); return 1 }
  // 交活即快照：2.2 交活、2.3 验收交活都核一遍（缺件写 verify.caveat，不拦）
  const snapRound = stageId.match(/^2\.(?:2-exec|3-verify)-r(\d+)$/)
  if (snapRound) {
    const caveat = recordSnapshotCaveat(dir, Number(snapRound[1]))
    caveat.forEach((c) => console.log('  · 快照留痕：' + c))
  }
  const extra = {}
  const dec = readJson(j(dir, 'decide.json'))
  if (/^2\.5-decide-r/.test(stageId) && dec) extra.action = dec.action
  writeSignal(dir, stageId, 'done', extra)
  // decide=next 之后 phase3 的旧信号必须作废（2026-11-18）：
  // 上一单实测——第 1 轮写完 3.1/3.2，决定再来一轮；走到收尾时 currentNode 看到旧 done 直接跳过，
  // 总结还是上一轮的（当时的临时办法是手删这两个文件，见 pitfalls）。这里自动作废。
  if (dec && stageId.startsWith('2.5-decide-r') && dec.action === 'next') {
    for (const sid of ['3.1-summarize', '3.2-deliver']) {
      const f = j(dir, STAGE_DIR, sid + '.json')
      if (existsSync(f)) {
        rmSync(f)
        console.log('  · 旧信号作废：' + sid + '（decide=next，收尾要重跑）')
      }
    }
  }
  clearActive(dir)
  // 每轮产物归档（供 UI 按轮回看；plan/verify/review/decide 每轮同名覆盖）
  if (/^2\.1-plan-r\d+$/.test(stageId)) archiveRoundArtifact(dir, stageId, 'plan.json')
  if (/^2\.3-verify-r\d+$/.test(stageId)) archiveRoundArtifact(dir, stageId, 'verify.json')
  if (/^2\.4-critique-r\d+$/.test(stageId)) archiveRoundArtifact(dir, stageId, 'review.json')
  if (/^2\.5-decide-r\d+$/.test(stageId)) archiveRoundArtifact(dir, stageId, 'decide.json')
  if (/^1\.9-confirm$/.test(stageId)) {
    archiveRoundArtifact(dir, stageId, 'intent.confirm.json')
    if (existsSync(j(dir, 'intent.confirm.answers.json'))) archiveRoundArtifact(dir, stageId, 'intent.confirm.answers.json')
    if (existsSync(j(dir, 'user-interrupt.jsonl'))) archiveRoundArtifact(dir, stageId, 'user-interrupt.jsonl')
  }
  console.log(stageId + ' 通过程序核对')
  const next = currentNode(dir).node
  console.log(next ? '下一个节点：' + next.id + '（' + next.kind + '）' : '全部完成')
  return 0
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────
// 只有「被当成脚本跑」时才执行；被 import（插件路由要复用 allNodes/currentNode）
// 时不许碰 argv，更不许 process.exit —— 2026-11-17 实测：routes.js 一 import 它，
// 整个插件进程直接按「用法」退出。
function isMainModule() {
  try {
    if (!process.argv[1]) return false
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const argName = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : '' }
  const dir = resolve(argName('run') || '')
  if (!dir || !cmd) { console.error('用法: node harness/pipeline.mjs <status|step|done> --run <run> [--stage <id>]'); process.exit(2) }
  // 记下「现在在跑哪个 run」——插件侧 UI 路由只读这个指针，不在插件里猜路径。
  // 失败一律吞掉：写指针不该影响流水线本身。
  try {
    // 不许被测试污染：跑在系统临时目录里的 run（fixture / 单测）不配当「当前 run」。
    // 2026-11-17 实测：npm test 里的 pipeline.test.mjs 把 Temp 下的 fixture 写成了 active run，
    // 界面上于是显示了一个根本不存在的实验。
    const inTemp = resolve(dir).toLowerCase().startsWith(tmpdir().toLowerCase())
    if (!inTemp && process.env.DSH_SELFLOOP_NO_POINTER !== '1') {
      const stateDir = process.env.DSH_SELFLOOP_STATE || join(homedir(), '.dsh', 'dsh-selfloop')
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'active-run.json'), JSON.stringify({ runDir: dir, at: new Date().toISOString(), cmd }, null, 2), 'utf8')
    }
  } catch { /* 只读文件系统也能照常跑流程 */ }
  if (cmd === 'status') { status(dir); process.exit(0) }
  if (cmd === 'step') process.exit(step(dir))
  if (cmd === 'done') process.exit(done(dir, argName('stage')))
  console.error('未知子命令：' + cmd)
  process.exit(2)
}
