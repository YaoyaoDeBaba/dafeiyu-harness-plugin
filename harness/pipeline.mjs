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
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { ticketFor } from './tickets.mjs'
import { hasForm, writeBlankForm, checkForm } from './forms.mjs'

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

const checks = {
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
      const list = ext.filter((e) => e && Number.isFinite(Number(e.value)))
      if (list.length === 0) return
      const okRange = list.some((e) => {
        const v = Number(e.value)
        const mn = Number.isFinite(Number(e.min)) ? Number(e.min) : v
        const mx = Number.isFinite(Number(e.max)) ? Number(e.max) : v
        return target >= mn - 1e-9 && target <= mx + 1e-9
      })
      if (!okRange) out.push(id + '：target=' + target + ' 不在任何实测区间里')
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
    const out = []
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

export function currentNode(dir) {
  const { budget, nodes } = allNodes(dir)
  const signals = loadSignals(dir)
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
    const s = signals[n.id]
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
    const ticket = { stage: node.id, kind: node.kind, title: node.title, check: node.check, ...(node.kind === 'manager' && hasForm(node.id) ? { form: j(dir, 'forms', node.id + '.json') } : {}), prompt: ticketFor(dir, node) }
    mkdirSync(j(dir, TICKET_DIR), { recursive: true })
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
  const fn = checks[node.check]
  const problems = fn ? fn(dir, node) : []
  // 主Agent 节点：表单必填项一项都不能空（不控质量，只防遗漏）
  if (node.kind === 'manager' && hasForm(node.id)) problems.push(...checkForm(dir, node.id))
  if (problems.length) { writeSignal(dir, stageId, 'failed', { problems }); console.log(stageId + ' 产物不合格，卡住：\n  ' + problems.join('\n  ')); return 1 }
  const extra = {}
  const dec = readJson(j(dir, 'decide.json'))
  if (/^2\.5-decide-r/.test(stageId) && dec) extra.action = dec.action
  writeSignal(dir, stageId, 'done', extra)
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
    const stateDir = process.env.DSH_SELFLOOP_STATE || join(homedir(), '.dsh', 'dsh-selfloop')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'active-run.json'), JSON.stringify({ runDir: dir, at: new Date().toISOString(), cmd }, null, 2), 'utf8')
  } catch { /* 只读文件系统也能照常跑流程 */ }
  if (cmd === 'status') { status(dir); process.exit(0) }
  if (cmd === 'step') process.exit(step(dir))
  if (cmd === 'done') process.exit(done(dir, argName('stage')))
  console.error('未知子命令：' + cmd)
  process.exit(2)
}
