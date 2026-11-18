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
import { profileFromFile, profileCorr, medianProfile, scalarsFromFile, toneFractions } from './composition.mjs'
import { probeFile, decodePng } from './ref-probe.mjs'

const STAGE_DIR = 'stages'
const TICKET_DIR = 'tickets'
const DEFAULT_BUDGET = { research: 'high', maxRounds: 1, useCritic: false, userReview: false, resupply: true, split: false, probe: true }

// ── 执行员的工作量下限 + 上下文上限（2026-11-18，P1/P2）
// 为什么加：A/B 实测里，两条臂都只拍 10~12 帧就交（预算 40），因为「多试几个想法」从来不是通过条件。
// 模型会优先花预算在「离它最近的可测目标」上——那就把这个目标写进票面并**硬校验**。
// budget.exec 可覆盖（minVariants: 0 / requireAB: false 可关掉）。
const DEFAULT_EXEC = { minVariants: 3, requireAB: true, maxDocs: 2, maxImages: 1, enforceReadFiles: true, requireBaseline: true }
// 领域先验区间（R2，2026-11-18）：把「听到名字就知道大概怎么画」外置成表，判据靶必须落在里面
const PRIORS = (() => {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('./priors.json', import.meta.url)), 'utf8')) } catch { return {} }
})()
const execRules = (budget) => Object.assign({}, DEFAULT_EXEC, (budget && budget.exec) || {})
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
  // exec 是执行员契约（P1/P2）的覆盖口；只有写了才透传，免得老 budget 的形状变
  const split = b.split === undefined ? Boolean(DEFAULT_BUDGET.split) : Boolean(b.split)
  const probe = b.probe === undefined ? Boolean(DEFAULT_BUDGET.probe) : Boolean(b.probe)
  const requireSnapshot = b.requireSnapshot === undefined ? true : Boolean(b.requireSnapshot)
  return Object.assign({ research, maxRounds, useCritic, userReview, resupply, split, probe, requireSnapshot }, b.exec && typeof b.exec === 'object' ? { exec: b.exec } : {})
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
    const ext = Array.isArray(r.extracted) ? r.extracted : []
    if (ext.length === 0) return ['extracted[] 为空（参考没量过）']
    // 参考是序列却只量了 1 帧 → 阈值会被锁死在单帧上（2026-11-18 实测：一整轮追错数）
    let refs = []
    try { refs = readdirSync(j(dir, 'refs')).filter((f) => /\.png$/i.test(f)) } catch { refs = [] }
    const numeric = ext.filter((e) => e && Number.isFinite(Number(e.value)))
    const single = numeric.filter((e) => e.singleFrame === true || /[.]png$/i.test(String(e.source || '')))
    if (refs.length > 1 && numeric.length > 0 && single.length === numeric.length) {
      return [
        'refs/ 里有 ' + refs.length + ' 张帧，但 extracted[] 全部来自 1 张（' + String(single[0].source || '单帧') + '）',
        '→ 先量分布再定阈值：node harness/preflight.mjs --run ' + dir + ' --ref ' + j(dir, 'refs'),
        '（只量单帧会把整轮锁死在那一帧的亮度上：实测 g001 mean 0.327 / 24 帧中位 0.280）'
      ]
    }
    return []
  },
  loaded(dir) {
    const out = []
    if (!existsSync(j(dir, 'requirement.md'))) out.push('缺 requirement.md（用户原话没录进来）')
    const refs = j(dir, 'refs')
    if (!existsSync(refs) || readdirSync(refs).length === 0) out.push('refs/ 是空的（没有多模态参考）')
    return out
  },
  /**
   * R1（2026-11-18）：调研必须交「可落地配方」——不是文献搬运。
   * 实测教训：知道"体积云/raymarch"这些名字不等于会调；云做到暗部 3.9%（参考 25.5%），
   * 整幅指标全绿。所以 tier≥2 时要求 recipe{steps,params,antiPatterns}，且 source 能 grep 到。
   */
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

    // 配方校验（tier≥2）
    if (TIER[b.research] >= 2) {
      const used = f.filter((x) => x && x.used === true)
      const withRecipe = used.filter((x) => x && x.recipe && typeof x.recipe === 'object')
      const okParams = withRecipe.filter((x) => {
        const p = (x.recipe && x.recipe.params) || {}
        const keys = Object.keys(p)
        return (Array.isArray(x.recipe.steps) && x.recipe.steps.length >= 2)
          && keys.length >= 3
          && keys.every((k) => {
            const v = p[k] || {}
            return Array.isArray(v.range) && v.range.length === 2
              && Number.isFinite(Number(v.range[0])) && Number.isFinite(Number(v.range[1]))
              && String(v.unit || '').trim() && String(v.source || '').trim()
          })
      })
      if (withRecipe.length === 0) out.push('没人为实现类 findings 写 recipe（steps / params / antiPatterns）——只写"用了什么"帮不了"调对"')
      else if (okParams.length === 0) out.push('没有一条 recipe 合格：需要 steps[]≥2 且 params 里 ≥3 个带 range/unit/source 的区间')
      const withAnti = used.filter((x) => x && x.recipe && Array.isArray(x.recipe.antiPatterns) && x.recipe.antiPatterns.length > 0)
      if (withAnti.length === 0) out.push('没有一条 recipe 写反例 antiPatterns（症状 → 病因）——这正是"一动手就露馅"的那部分')
      // discriminators 必须是可测的键（在 priors 或 extracted 里存在）
      const domain = String((readJson(j(dir, 'intent.json')) || {}).domain || '')
      const priorKeys = domain && PRIORS[domain] ? Object.keys(PRIORS[domain]) : []
      const extKeys = (Array.isArray(r.extracted) ? r.extracted : []).map((e) => String(e && e.what))
      const measurable = new Set([...priorKeys, ...extKeys])
      const badDisc = []
      for (const x of used) {
        const dis = x && x.recipe && Array.isArray(x.recipe.discriminators) ? x.recipe.discriminators : []
        for (const d of dis) {
          const key = String(d && (d.key || d.id || d))
          if (!key) continue
          if (measurable.size && !measurable.has(key)) badDisc.push(key)
        }
      }
      if (badDisc.length) out.push('recipe 里的判别量不可测（不在 priors 也不在 extracted）：' + [...new Set(badDisc)].join('、'))
    }
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
      // L1（2026-11-18）：profile 型判据——比"排列"而不是"总量"（行剖面/时间序列/树形……）
      // 目标不是数值而是一条参考序列 + 一个相关下限。图像只是首个实现，别的领域照同样的形状写提取器。
      if (String((c && c.kind) || '') === 'profile') {
        const metric = String((c && (c.metric || c.id)) || '')
        const ref = ext.find((e) => e && e.what === metric && e.kind === 'profile' && Array.isArray(e.value))
        if (!ref) { out.push(id + '：research.extracted 里没有 kind=profile 的 ' + metric + '（先 preflight 量参考）'); return }
        // minCorr 没写就用 preflight 按留一法算出来的建议值（阈值来自分布，别拍肚子）
        const minCorr = Number.isFinite(Number(c && c.minCorr)) ? Number(c.minCorr) : Number(ref.minCorrHint)
        if (!Number.isFinite(minCorr) || minCorr <= 0 || minCorr > 1) {
          out.push(id + '：profile 型判据要写 minCorr（0~1）；若参考 ≥3 帧，preflight 会给出 minCorrHint 可直接抄'); return
        }
        if (ref.value.length < 8) { out.push(id + '：参考 ' + metric + ' 只有 ' + ref.value.length + ' 个桶，太粗（≥8）'); return }
        return
      }
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

    // ── 领域先验（R2，2026-11-18）：靶必须落在「合理量级」里，且先验里每条判别量都要有判据
    const domain = String(i.domain || '')
    const prior = domain && PRIORS[domain] ? PRIORS[domain] : null
    if (prior) {
      const waived = new Set((Array.isArray(i.priorWaived) ? i.priorWaived : []).map((x) => String((x && x.key) || x || '')))
      const covered = new Set()
      for (const c of i.criteria || []) {
        const cid = c && c.id ? c.id : '(无id)'
        const key = String((c && (c.metric || c.id)) || '')
        if (!prior[key] || !Array.isArray(prior[key].range)) continue
        covered.add(key)
        if (String(c.kind || '') === 'profile' || Array.isArray(c.target)) continue
        const t = Number(c.target)
        const lo = Number(prior[key].range[0]), hi = Number(prior[key].range[1])
        if (Number.isFinite(t) && (t < lo || t > hi) && !String(c.priorException || '').trim()) {
          out.push(cid + '：target=' + t + ' 不在先验区间 [' + lo + ', ' + hi + ']（' + (prior[key].why || key)
            + '）——要么改靶，要么写 priorException 说明为什么这次要破例')
        }
      }
      // 只有「判别量」必须有判据；「参数」（sigma/ambient/lightSteps…）是旋钮，不该逼人写判据
      const discriminators = Object.keys(prior).filter((k) => (prior[k] && prior[k].role) === 'discriminator')
      const missing = discriminators.filter((k) => !covered.has(k) && !waived.has(k))
      if (missing.length) {
        out.push('先验里有判别量没有对应判据：' + missing.join('、')
          + '（加上判据；真不测就写 priorWaived 说明为什么不测——这一条就是治「判据缺项」的）')
      }
    }
    return out
  },
  plan(dir) {
    const p = readJson(j(dir, 'plan.json'))
    if (!p) return ['缺 plan.json（没列工单）']
    const out = []
    if (!Array.isArray(p.orders) || p.orders.length === 0) out.push('orders 为空')
    if (!p.executor || !p.executor.model) out.push('没配执行员模型')

    // ── 活性扫描（2026-11-18 试刀教训）：没证明旋钮会动，不许开搜
    // 现场：按配方把 lightSteps 6→1，抓出来的帧逐字节相同；20 张候选里有 5 张死在空转。
    const budget = getBudget(dir)
    if (budget.probe !== false) {
      const lv = readJson(j(dir, 'params-liveness.json'))
      if (!lv) {
        out.push('缺 params-liveness.json —— 先扫活性：node harness/liveness.mjs --run ' + dir + ' --probe probe.json')
      } else {
        const vars = (Array.isArray(p.variables) ? p.variables : []).map(String)
        if (vars.length === 0) out.push('plan.variables 为空（这一轮打算动哪几根轴？）')
        const table = new Map((Array.isArray(lv.params) ? lv.params : []).map((x) => [String(x && x.name), x && x.status]))
        const unknown = vars.filter((v) => !table.has(v))
        if (unknown.length) out.push('这些变量没做过活性扫描：' + unknown.join('、') + '（在 probe.json 的 params 里补上）')
        const dead = vars.filter((v) => table.get(v) === 'dead')
        if (dead.length) out.push('这些变量是死参数（改了逐字节相同），别放进 variables：' + dead.join('、'))
        const live = vars.filter((v) => table.get(v) === 'live' || table.get(v) === 'weak')
        if (vars.length && live.length === 0) out.push('variables 里没有一根活轴——先找一根会动的参数再开搜')
        if (!lv.capture) out.push('params-liveness.json 没记 capture 命令（无法证明是真跑出来的）')
      }
    }
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
    // 反早停硬闸（2026-11-18）：工作量下限。实测两条臂都只拍 10~12 帧就跑，
    // 因为「多试」从来没被校验过。这里把它变成通过条件（budget.exec 可关）。
    const rules = execRules(getBudget(dir))
    // ── 上下文预算可校验（S2，2026-11-18）：执行员只许读票面声明的文件，交活时自报 readFiles[]
    if (rules.enforceReadFiles !== false) {
      const allow = allowedReadPaths(dir, last)
      if (!Array.isArray(last.readFiles)) {
        out.push('缺 readFiles[]：交活时列出你真读过的文件（票面声明之外的一律不许读）')
      } else {
        const bad = last.readFiles.map(String).filter((f) => f.trim() && !allow.some((a) => f === a || f.startsWith(a.replace(/[\\/]$/, '') + '/') || f.startsWith(a.replace(/[\\/]$/, '') + '\\')))
        if (bad.length) out.push('读了票面之外的文件：' + bad.slice(0, 3).join('、') + (bad.length > 3 ? ' 等 ' + bad.length + ' 个' : '') + '（上下文预算要靠这个兜住）')
      }
    }
    // 有 split.json（拆窄票）时，工作量下限按**每张窄票**算，并要求结果覆盖所有票 id
    const split = readJson(j(dir, 'split.json'))
    const splitTasks = split && Array.isArray(split.tasks) ? split.tasks : []
    if (splitTasks.length > 0) {
      const results = Array.isArray(last.tasks) ? last.tasks : []
      if (results.length === 0) out.push('有 split.json 但 rounds/' + name + ' 缺 tasks[]（每张窄票都要交一份结果）')
      for (const st of splitTasks) {
        const tid = String((st && st.id) || '')
        const got = results.find((x) => x && String(x.id) === tid)
        if (!got) { out.push('窄票 ' + (tid || '(无id)') + ' 没有结果（tasks[] 里缺这一项）'); continue }
        if (rules.minVariants > 0) {
          const v = Array.isArray(got.variants) ? got.variants : []
          if (v.length < rules.minVariants) out.push('窄票 ' + tid + '：变体只有 ' + v.length + ' 个，少于下限 ' + rules.minVariants)
          if (rules.requireBaseline !== false && v.length && !v.some((x) => x && x.isBaseline === true)) {
            out.push('窄票 ' + tid + '：变体里没有 isBaseline:true（先照参考默认参数跑一遍当锚点）')
          }
        }
        if (rules.requireAB) {
          const ab = Array.isArray(got.abShots) ? got.abShots : []
          if (ab.length === 0) out.push('窄票 ' + tid + '：缺 abShots[]（至少 1 张单变量 A/B 判别帧）')
        }
        // S4：票面 accept 每一项都要有一条实测（治「注意力没覆盖完整需求」）
        const accIds = (Array.isArray(st.accept) ? st.accept : []).map((a) => String((a && (a.id || a.metric)) || '')).filter(Boolean)
        if (accIds.length) {
          const ev = Array.isArray(got.acceptEvidence) ? got.acceptEvidence : []
          const missing = accIds.filter((id) => !ev.some((e) => e && String(e.id) === id && Number.isFinite(Number(e.measured))))
          if (missing.length) out.push('窄票 ' + tid + '：这些验收没给实测 acceptEvidence：' + missing.join('、'))
        }
      }
      if (splitTasks.length > 0) return out   // 拆了窄票就按窄票算，不再要求整轮级别的 variants
    }
    if (rules.minVariants > 0) {
      const variants = Array.isArray(last.variants) ? last.variants : null
      if (!variants) out.push('rounds/' + name + ' 缺 variants[]（本轮至少 ' + rules.minVariants + ' 个变体，每个写 name + 抓帧）')
      else if (variants.length < rules.minVariants) {
        out.push('变体只有 ' + variants.length + ' 个，少于本轮下限 ' + rules.minVariants + ' 个（凑数不如多试：预算没用完就别交活）')
      } else {
        const noShot = variants.filter((v) => !v || !(v.shot || v.png))
        if (noShot.length) out.push(noShot.length + ' 个变体没写抓帧（variants[].shot）')
        // R5：必须有一个「照参考默认参数」的 baseline——否则全是相对自己错误区间的漂移
        if (rules.requireBaseline !== false && !variants.some((v) => v && v.isBaseline === true)) {
          out.push('variants 里没有一个 isBaseline:true 的变体（照参考实现的默认参数先跑一遍，再谈偏移）')
        }
      }
    }
    if (rules.requireAB) {
      const ab = Array.isArray(last.abShots) ? last.abShots : []
      if (ab.length === 0) out.push('缺 abShots[]：至少要 1 张单变量 A/B 判别帧（只动一个变量、命名带 _ab_<变量>）')
    }
    return out
  },
  verified(dir) {
    const v = readJson(j(dir, 'verify.json'))
    if (!v) return ['缺 verify.json（没验收）']
    // 快照三件套**硬拦**（2026-11-18 教训：昨晚 mimo 余额耗尽、成果没存下来，无法复原）。
    // 以前只写 verify.caveat 留痕 —— 留痕不解决问题，验收这一关必须挡住。
    const out0 = []
    const budgetV = getBudget(dir)
    if (budgetV.requireSnapshot !== false) {
      const rounds = j(dir, 'rounds')
      let nums = []
      try { nums = readdirSync(rounds).filter((f) => /^\d+\.json$/.test(f)).map((f) => String(Number(f.split('.')[0]))) } catch { nums = [] }
      for (const r of [...new Set(nums)]) {
        const missing = snapshotMissing(dir, Number(r))
        if (missing.length) {
          out0.push('r' + r + ' 快照不全（缺 ' + missing.join('、') + '）——没有快照 = 这版成果无法复原，先补：'
            + 'node harness/snapshot.mjs --run ' + dir + ' --tag r' + r + ' --file <改过的源文件>...')
        }
      }
    }
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
    const out = [...out0, ...crash]
    if (v.runs !== true) out.push('没有确认能跑（编译/加载通过）')
    if (v.visible !== true) out.push('没有确认能看（有图或入口）')

    // 结构指纹验收（L1+L2/L3，2026-11-18）：intent 里有 profile 判据时自动量候选剖面并比相关。
    // **候选剖面的来源与领域解耦**：
    //   ① verify.profiles[<metric>] —— 任意领域自己写的提取器（日志/时延/树形…），最通用；
    //   ② 没给 profiles 且 metric==='rowProfile' 时，回退到"量第一张帧"（图像实现）。
    // 为什么必须解耦：这一层正是"分布判据全绿、构图/排列全错"的漏网处，而渲染只是它的第一个使用者。
    const it = readJson(j(dir, 'intent.json'))
    const profCrit = it && Array.isArray(it.criteria) ? it.criteria.filter((c) => c && String(c.kind) === 'profile') : []
    if (profCrit.length) {
      const rj = readJson(j(dir, 'research.json')) || { extracted: [] }
      const provided = v.profiles && typeof v.profiles === 'object' ? v.profiles : {}
      const shot = (Array.isArray(v.shots) ? v.shots : []).map(String).find((x) => x.trim())
      let imageProfile = null
      const needImage = profCrit.some((c) => String(c.metric || c.id) === 'rowProfile' && !Array.isArray(provided.rowProfile))
      if (needImage) {
        if (!shot) out.push('有 rowProfile 判据但没有 verify.shots[0]，也没在 verify.profiles 里给剖面：无法量结构')
        else {
          const file = isAbsolute(shot) ? shot : j(dir, shot)
          try { imageProfile = profileFromFile(file, 64) } catch (e) { out.push('结构指纹：读不了 ' + shot + '（' + (e && e.message) + '）') }
        }
      }
      for (const c of profCrit) {
        const metric = String(c.metric || c.id)
        const ref = (rj.extracted || []).find((e) => e && e.what === metric && Array.isArray(e.value))
        if (!ref) continue
        const candProf = Array.isArray(provided[metric]) ? provided[metric] : (metric === 'rowProfile' ? imageProfile : null)
        if (!Array.isArray(candProf)) { out.push('结构指纹 ' + metric + '：既没在 verify.profiles 里给，也不是可自动抽取的 rowProfile'); continue }
        const corr = profileCorr(ref.value, candProf)
        // 与 checks.intent 同口径：没写 minCorr 就用留一法建议值
        const need = Number.isFinite(Number(c.minCorr)) ? Number(c.minCorr) : Number(ref.minCorrHint)
        if (!(corr >= need)) {
          out.push('排列与参考不像：' + metric + ' 相关 ' + corr.toFixed(3) + ' < 下限 ' + need
            + '（参考带 ' + need + '~1；总量对得上但"摆法"不对，这条就是抓这个的）')
        }
      }
    }
    // ── 标量判据也进闸（2026-11-18 回放测试暴露的洞）：
    // 灰雾云（cloudDarkFrac 0.039，靶 0.2532）在 2.3 被**放行**，因为 verify 只查了 profile 与崩坏。
    // 结论：判据只要写进了 intent，就必须在交付前被真的量一遍 —— 否则"判据缺项"会变成"判据摆设"。
    const intentV = readJson(j(dir, 'intent.json')) || {}
    const researchV = readJson(j(dir, 'research.json')) || {}
    const bandsV = new Map()
    for (const e of (Array.isArray(researchV.extracted) ? researchV.extracted : [])) {
      if (e && e.what && Number.isFinite(Number(e.min)) && Number.isFinite(Number(e.max))) bandsV.set(String(e.what), [Number(e.min), Number(e.max)])
    }
    const MEASURE_V = {
      cloudDarkFrac: (f) => toneFractions(decodePng(readFileSync(f))).cloudDarkFrac,
      cloudBrightFrac: (f) => toneFractions(decodePng(readFileSync(f))).cloudBrightFrac,
      cloudMeanLuma: (f) => toneFractions(decodePng(readFileSync(f))).cloudMeanLuma,
      topCoverage: (f) => scalarsFromFile(f).topCoverage,
      centroidY: (f) => scalarsFromFile(f).centroidY,
      subjectFrac: (f) => scalarsFromFile(f).subjectFrac,
      skyExposure: (f) => scalarsFromFile(f).skyExposure,
      bboxAspect: (f) => scalarsFromFile(f).bboxAspect,
      mean: (f) => probeFile(f).mean,
      p50: (f) => probeFile(f).p50,
      p95: (f) => probeFile(f).p95,
      p99: (f) => probeFile(f).p99,
      glowFrac: (f) => probeFile(f).glowFrac,
      brightFrac: (f) => probeFile(f).brightFrac,
    }
    const shotV = shots.map((x) => String(x || '').trim()).filter(Boolean).map((n) => (isAbsolute(n) ? n : j(dir, n))).find((f) => existsSync(f))
    if (shotV) {
      for (const c of (Array.isArray(intentV.criteria) ? intentV.criteria : [])) {
        if (!c || String(c.kind || '') === 'profile') continue
        const metric = String(c.metric || c.id || '')
        const fn = MEASURE_V[metric]
        const band = bandsV.get(metric)
        if (!fn || !band) continue
        let v
        try { v = Number(fn(shotV)) } catch { continue }
        if (!Number.isFinite(v)) continue
        const [lo, hi] = band
        const dirn = String(c.dir || 'two-sided')
        const ok = dirn === 'lower' ? v <= hi : dirn === 'upper' ? v >= lo : (v >= lo && v <= hi)
        if (!ok) {
          out.push('判据 ' + String(c.id || metric) + ' 出带：' + metric + '=' + v.toFixed(4) + '（参考带 ' + lo + ' ~ ' + hi + '，方向 ' + dirn + '）')
        }
      }
    }
    return out
  },
  // 拆分票（P3，2026-11-18）：把一个大工单派成 N 张窄票，每张自带上下文与验收。
  split(dir) {
    const sp = readJson(j(dir, 'split.json'))
    if (!sp) return ['缺 split.json（拆分票：tasks[] 每张写 goal / files / accept / contextBudget）']
    const out = []
    const tasks = Array.isArray(sp.tasks) ? sp.tasks : []
    if (tasks.length < 2) out.push('tasks 少于 2 张（不拆就别开 split 节点；拆就至少 2 张窄票）')
    tasks.forEach((t, i) => {
      const id = (t && (t.id || '#' + (i + 1))) || ('#' + (i + 1))
      if (!t || !String(t.goal || '').trim()) out.push(id + '：缺 goal（这张票要改哪一块、算做完是什么）')
      if (!Array.isArray(t && t.files) || t.files.length === 0) out.push(id + '：缺 files[]（只许动这几个文件，冲突面才小）')
      const accept = Array.isArray(t && t.accept) ? t.accept : []
      if (accept.length === 0) out.push(id + '：缺 accept[]（这张票自己的验收，1~2 条）')
      else if (accept.length > 2) out.push(id + '：accept 有 ' + accept.length + ' 条——一张票超过 2 个目标，注意力必然摊薄（拆票而不是加目标）')
      const itIds = (() => {
        const it = readJson(j(dir, 'intent.json'))
        const set = new Set()
        for (const c of (it && Array.isArray(it.criteria) ? it.criteria : [])) {
          if (!c) continue
          if (c.id) set.add(String(c.id))
          if (c.metric) set.add(String(c.metric))
        }
        return set
      })()
      for (const c of accept) {
        const cid = String((c && (c.id || c.metric)) || '')
        if (critIdSetCheck(itIds, cid) === false) out.push(id + '：验收 ' + cid + ' 不在 intent.criteria 里（窄票只能引用判据，不许自己另立目标）')
      }
      accept.forEach((c) => {
        if (!c || !c.id) out.push(id + '：有验收项没写 id')
        else if (String(c.kind || '') !== 'profile' && !['lower', 'upper', 'two-sided'].includes(String(c.dir || ''))) out.push(id + '：验收 ' + c.id + ' 缺 dir（lower/upper/two-sided）')
      })
    })
    return out
  },
  // 合并选优（P3）：合并员只拿各张票的产物 + 验收表，不拿任何一方的代码
  mergedTickets(dir) {
    const m = readJson(j(dir, 'merge.json'))
    if (!m) return ['缺 merge.json（{ chosen, why, evidence[] }）']
    const out = []
    if (!String(m.chosen || '').trim()) out.push('没写 chosen（选了哪个变体/哪张票的结果）')
    if (!Array.isArray(m.evidence) || m.evidence.length === 0) out.push('缺 evidence[]（凭什么选它：数值/图/对照）')
    if (String(m.why || '').trim().length < 8) out.push('why 太短：要说清「为什么是它，不是别的」')
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
    { id: '2.1-plan-r' + r, kind: 'manager', title: '列工单 + 配执行员', check: 'plan' }
  ]
  // budget.split：把一个大工单拆成 N 张窄票（每张自带上下文与验收），再各自派窄执行员
  pushIf(n, budget.split, { id: '2.2a-split-r' + r, kind: 'manager', title: '拆窄票：每张只带自己的文件/参考切片/验收', check: 'split' })
  n.push({ id: '2.2-exec-r' + r, kind: 'worker', title: '按工单执行', check: 'executed' })
  pushIf(n, budget.split, { id: '2.4m-merge-r' + r, kind: 'manager', title: '合并选优：只拿产物与验收表，不拿代码', check: 'mergedTickets' })
  n.push({ id: '2.3-verify-r' + r, kind: 'manager', title: '验收：能跑 / 能看', check: 'verified' })
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

  }
  if (id === '1.10-translate3') {
    const it = readJson(j(dir, 'intent.json'))
    if (it) for (const w of capabilityPrecheck(it.criteria)) out.push(w)
  }
  return out
}

/**
 * 票面契约（P1，2026-11-18）：执行员的上下文**只有这张票**。
 * 所以票里必须写清「能读什么、必须交几个变体、怎么算没偷懒」——
 * 不写，模型就会拿预算去读文档、然后交 1 个变体回来（A/B 实测：12/40 张就交活）。
 */
/**
 * 执行员「允许读」的路径（S2）：窄票的 files+refs，其次 plan 的 orders[].files，最后 intent 的图锚。
 * 空集合表示"票面没声明"，此时不拦（免得老 run 全被挡）。
 */
function allowedReadPaths(dir) {
  const out = []
  const sp = readJson(j(dir, 'split.json'))
  if (sp && Array.isArray(sp.tasks)) {
    for (const t of sp.tasks) {
      for (const f of (Array.isArray(t && t.files) ? t.files : [])) out.push(String(f))
      for (const r of (Array.isArray(t && t.refs) ? t.refs : [])) out.push(String(r))
    }
  }
  const plan = readJson(j(dir, 'plan.json'))
  if (plan && Array.isArray(plan.orders)) {
    for (const o of plan.orders) for (const f of (Array.isArray(o && o.files) ? o.files : [])) out.push(String(f))
  }
  const it = readJson(j(dir, 'intent.json'))
  if (it && Array.isArray(it.anchors)) for (const a of it.anchors) if (a && a.kind === 'image' && a.ref) out.push(String(a.ref))
  return [...new Set(out.filter((x) => x.trim()))]
}

/** 窄票的验收只能引用 intent 里已存在的判据（记 id，也记 metric 名）；intent 没判据时不拦 */
function critIdSetCheck(set, cid) {
  if (!set || set.size === 0) return true
  return set.has(cid)
}

function contractLines(contract, extra) {
  if (!contract || !contract.mustProduce) return ''
  const mp = contract.mustProduce
  const cb = contract.contextBudget || {}
  const ex = extra || {}
  const L = []
  L.push('【执行员卡片 · 票面就是全部上下文，不必去读技能文档】')
  L.push('· 工作量：至少 ' + mp.variants + ' 个变体（每个都要抓帧，写 variants[]）'
    + (mp.abFrames ? '；另加 ' + mp.abFrames + ' 张单变量 A/B 判别帧（*_ab_<变量>）' : ''))
  L.push('· 上下文：额外文档 ≤' + (cb.docs ?? 0) + ' 篇、参考图 ≤' + (cb.images ?? 0) + ' 张；交活时用 readFiles[] 列出你真读过的文件')
  if (Array.isArray(ex.allowed) && ex.allowed.length) L.push('· 允许读（读别的一律算越界）：' + ex.allowed.slice(0, 8).join(' · '))
  L.push('· 停止条件（任一即停）：① 达标　② 用满自调轮次　③ 连续 2 轮无显著提升（主判据改善 <5% 或帧差 <2%）')
  L.push('· 停下如实交：当前值 + 差多少 + 卡在哪个约束（禁止「已优化」）')
  L.push('· 交活字段：changes[] / shot / variants[] / abShots[] / readFiles[]'
    + (Array.isArray(ex.narrow) && ex.narrow.length ? ' / tasks[]（每张窄票一份，含 acceptEvidence[]）' : ''))
  if (Array.isArray(ex.narrow) && ex.narrow.length) {
    for (const t of ex.narrow) {
      const acc = (Array.isArray(t.accept) ? t.accept : []).map((a) => a && (a.id || a.metric)).filter(Boolean).join('/')
      L.push('· 窄票 ' + (t.id || '?') + '：' + String(t.goal || '') + (acc ? '（验收 ' + acc + '）' : '') + ' → 只改 ' + (Array.isArray(t.files) ? t.files.join('、') : '?'))
    }
  }
  L.push('')
  return L.join('\n')
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
    const rules = execRules(getBudget(dir))
    const isExec = node.kind === 'worker' && String(node.id).startsWith('2.2-exec')
    const splitDef = isExec ? readJson(j(dir, 'split.json')) : null
    const narrow = splitDef && Array.isArray(splitDef.tasks) ? splitDef.tasks : []
    const contract = isExec
      ? {
          contextBudget: { docs: rules.maxDocs, images: rules.maxImages },
          mustProduce: { variants: rules.minVariants, abFrames: rules.requireAB ? 1 : 0 },
        }
      : {}
    const ticket = { stage: node.id, kind: node.kind, title: node.title, check: node.check, ...(node.kind === 'manager' && hasForm(node.id) ? { form: j(dir, 'forms', node.id + '.json') } : {}), prompt: contractLines(contract, { allowed: isExec ? allowedReadPaths(dir) : [], narrow }) + ticketFor(dir, node), ...contract }
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
