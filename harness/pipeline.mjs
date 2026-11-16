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
import { ticketFor } from './tickets.mjs'

const STAGE_DIR = 'stages'
const TICKET_DIR = 'tickets'
const DEFAULT_BUDGET = { research: 'high', maxRounds: 1, useCritic: true }
const TIER = { low: 0, mid: 1, high: 2, max: 3 }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const j = (...a) => join(...a)

export function getBudget(dir) {
  const b = readJson(j(dir, 'budget.json')) || {}
  const research = ['low', 'mid', 'high', 'max'].includes(b.research) ? b.research : DEFAULT_BUDGET.research
  const mr = Number(b.maxRounds)
  const maxRounds = Number.isFinite(mr) && mr > 0 ? Math.min(20, Math.round(mr)) : DEFAULT_BUDGET.maxRounds
  const useCritic = b.useCritic === undefined ? DEFAULT_BUDGET.useCritic : Boolean(b.useCritic)
  return { research, maxRounds, useCritic }
}

const checks = {
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
    return []
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
  n.push({ id: '1.2-translate1', kind: 'manager', title: '初轮需求转译（只看需求+实测）' })
  pushIf(n, t >= 1, { id: '1.3-research-env', kind: 'worker', title: '调查员c：环境/工具/指南' })
  pushIf(n, t >= 2, { id: '1.4-research-doc', kind: 'worker', title: '调查员a：技术文献（GitHub/论文/算法）' })
  pushIf(n, t >= 3, { id: '1.5-research-ref', kind: 'worker', title: '调查员b：参考图/参考产品/现实知识' })
  n.push({ id: '1.6-gate', kind: 'program', title: '调研闸：按预算档位核调研完整性', check: 'researchTier' })
  n.push({ id: '1.7-absorb', kind: 'manager', title: '吸收调查结果', check: 'absorbed' })
  n.push({ id: '1.8-translate2', kind: 'manager', title: '第二轮转译（吸收后）' })
  n.push({ id: '1.9-confirm', kind: 'manager', title: '向用户确认意向' })
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
  n.push({ id: '2.5-decide-r' + r, kind: 'manager', title: '评估是否派下一轮', check: 'decided' })
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
    if (rm && stoppedAt > 0 && Number(rm[1]) > stoppedAt) continue
    const s = signals[n.id]
    if (!s || s.status !== 'done') return { node: n, signals, budget }
  }
  return { node: null, signals, budget }
}

function writeSignal(dir, stage, st, extra) {
  mkdirSync(j(dir, STAGE_DIR), { recursive: true })
  writeFileSync(j(dir, STAGE_DIR, stage + '.json'), JSON.stringify(Object.assign({ stage, status: st, at: new Date().toISOString() }, extra || {}), null, 2), 'utf8')
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
    const skippedByStop = rm && stopAt > 0 && Number(rm[1]) > stopAt
    const mark = skippedByStop ? '--' : !s ? '..' : s.status === 'done' ? 'OK' : 'NO'
    const owner = n.kind === 'manager' ? '[主Agent]' : n.kind === 'worker' ? '[子代理]' : '[程序]  '
    console.log('  [' + mark + '] ' + n.id.padEnd(18) + owner + ' ' + n.title)
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
    const ticket = { stage: node.id, kind: node.kind, title: node.title, check: node.check, prompt: ticketFor(dir, node) }
    mkdirSync(j(dir, TICKET_DIR), { recursive: true })
    const p = j(dir, TICKET_DIR, node.id + '.json')
    writeFileSync(p, JSON.stringify(ticket, null, 2), 'utf8')
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
  const fn = checks[node.check]
  const problems = fn ? fn(dir, node) : []
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

const argv = process.argv.slice(2)
const cmd = argv[0]
const argName = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : '' }
const dir = resolve(argName('run') || '')
if (!dir || !cmd) { console.error('用法: node harness/pipeline.mjs <status|step|done> --run <run> [--stage <id>]'); process.exit(2) }
if (cmd === 'status') { status(dir); process.exit(0) }
if (cmd === 'step') process.exit(step(dir))
if (cmd === 'done') process.exit(done(dir, argName('stage')))
console.error('未知子命令：' + cmd)
process.exit(2)
