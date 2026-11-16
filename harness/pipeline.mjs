// Selfloop Pipeline · 流程由程序控制，agent 只负责节点内的判断与执行
//
// 为什么不再把流程写进 skill（2026-11-16 两次受控实验）：
//   第一次：执行代理读了全套规范，8 分钟零产出；第二次：读了摘要就跳过闸门直接改代码。
//   结论：规范写在文档里只能劝，挡不住人。流程必须由程序持有：程序知道现在在哪、下一个是什么、上游信号到没到；
//   每个节点是单一职责的子任务，agent 只在节点内判断；节点做完由程序核对产物（不信自述），不过就卡住。
//
// 用法：
//   node harness/pipeline.mjs status --run <run目录>
//   node harness/pipeline.mjs step   --run <run目录>   # 推进一格；退出码 10 = 需要派 agent（票已生成）
//   node harness/pipeline.mjs done   --run <run目录> --stage <id>
//
// 节点：preflight(程序) → research(agent) → intent(agent) → implement(agent) → review(agent) → deliver(程序)
// 信号：<run>/stages/<id>.json；下游只认这个文件。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkResearchGate } from './research-gate.mjs'

const TICKET_DIR = 'tickets'
const STAGE_DIR = 'stages'
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const j = (...a) => join(...a)

const checks = {
  research(dir) {
    const r = readJson(j(dir, 'research.json'))
    if (!r) return ['缺 research.json']
    const out = []
    try { checkResearchGate({ outDir: dir, anchors: [{ kind: 'image', ref: 'x' }], notes: [] }) } catch (e) { out.push(String(e && e.message ? e.message : e).split('\n')[0]) }
    if (!Array.isArray(r.extracted) || r.extracted.length === 0) out.push('extracted[] 为空（没量参考）')
    return out
  },
  intent(dir) {
    const i = readJson(j(dir, 'intent.json'))
    if (!i) return ['缺 intent.json']
    const out = []
    if (!i.restate || !String(i.restate).trim()) out.push('restate 为空（没有复述需求）')
    if (!Array.isArray(i.criteria) || i.criteria.length === 0) out.push('criteria 为空')
    if (!Array.isArray(i.anchors) || i.anchors.length === 0) out.push('anchors 为空')
    if (i.confirmed !== true) out.push('confirmed 不是 true（没确认就往下走）')
    return out
  },
  implement(dir) {
    const rounds = j(dir, 'rounds')
    if (!existsSync(rounds)) return ['缺 rounds/ 目录']
    const files = readdirSync(rounds).filter((f) => f.endsWith('.json'))
    if (files.length === 0) return ['rounds/ 里没有 NN.json（没写这一轮做了什么）']
    const last = readJson(j(rounds, files.sort().pop()))
    const out = []
    if (!last) out.push('最后一轮 rounds json 读不出来')
    else {
      if (!last.shot && !last.preview) out.push('这一轮没有截图/可运行入口（人看不到东西）')
      if (!Array.isArray(last.changes) || last.changes.length === 0) out.push('没有写改了什么')
    }
    return out
  },
  review(dir) {
    const r = readJson(j(dir, 'review.json'))
    if (!r) return ['缺 review.json（观察员没评审）']
    const out = []
    if (!r.verdict) out.push('缺 verdict（评审结论）')
    if (!Array.isArray(r.vsCriteria) || r.vsCriteria.length === 0) out.push('vsCriteria 为空（没逐条对判据）')
    return out
  },
  deliver(dir) {
    const d = readJson(j(dir, 'deliver.json'))
    if (!d) return ['缺 deliver.json']
    const out = []
    if (!d.finalShot && !d.artifacts) out.push('交付里没有产物')
    if (!Array.isArray(d.suggestion) || d.suggestion.length === 0) out.push('没有建议')
    return out
  }
}

const STAGES = [
  { id: 'preflight', kind: 'program', title: '量参考 / 建骨架', produces: ['research.json'] },
  { id: 'research', kind: 'agent', title: '调查员：外部调研（只写 research.findings）', check: 'research', prompt: (dir) => [
    '你是调查员，只做这一件事：为已量好的参考补充外部调研，写进 research.json 的 findings[]。',
    '',
    '硬约束（违反即作废）：',
    '- 不许改工程代码、不许写 intent.json、不许动 rounds/；只写 ' + j(dir, 'research.json') + ' 的 findings[]。',
    '- 至少 2 条带 http(s) URL 的 findings；其中至少 1 条 kind=opensource（能读到代码）或 paper；',
    '- 每条 used=true 必须写 usedFor（它改了哪条判据 / 哪项做法）；查不到就写进 gaps，不许编 URL。',
    '- 自己用 web_search / web_fetch 查，别问人。',
    '',
    '做完：写文件，然后运行 node harness/pipeline.mjs done --run ' + dir + ' --stage research。'
  ].join('\n') },
  { id: 'intent', kind: 'agent', title: '需求转译：写成可测判据（只写 intent.json）', check: 'intent', prompt: (dir) => [
    '你是需求转译者，只做这一件事：把用户原话 + 已量好的参考写成 ' + j(dir, 'intent.json') + '。',
    '',
    '硬约束：',
    '- 判据阈值必须来自 research.json 的 extracted / findings，不许拍脑袋；找不到就写「暂无口径」。',
    '- 每条 criteria 必须带 userWords（用户原话）或 howMeasured（怎么量）。',
    '- 不许改工程代码；写完把 confirmed 改 true。',
    '',
    '做完：运行 node harness/pipeline.mjs done --run ' + dir + ' --stage intent。'
  ].join('\n') },
  { id: 'implement', kind: 'agent', title: '执行者：按判据实现，写 rounds/NN.json', check: 'implement', prompt: (dir) => [
    '你是执行者，只做这一件事：按 intent.json 的 criteria 实现，并把这一轮写进 ' + j(dir, 'rounds') + '/NN.json。',
    '',
    '硬约束：',
    '- 改代码前先读 ' + j(dir, 'intent.json') + ' 与 research.json，别信记忆。',
    '- 每轮必须产出：截图或可运行入口（shot/preview）、changes[]（改了什么）、metrics（关键指标）。',
    '- 不许改 research.json / intent.json（那是上游的产物）。',
    '',
    '做完：运行 node harness/pipeline.mjs done --run ' + dir + ' --stage implement。'
  ].join('\n') },
  { id: 'review', kind: 'agent', title: '观察员：逐条对判据评审，写 review.json', check: 'review', prompt: (dir) => [
    '你是观察员，只做这一件事：对着 intent.json 的 criteria 逐条评审上一轮产物，写 ' + j(dir, 'review.json') + '。',
    '',
    '硬约束：',
    '- 不许改任何代码、不许改上游文件；只写 review.json。',
    '- 必须逐条对判据给结论（vsCriteria: [{id, pass, evidence}]），并给 verdict 与 vsRef（跟参考比差在哪）。',
    '- 不合格就写不合格，别粉饰。',
    '',
    '做完：运行 node harness/pipeline.mjs done --run ' + dir + ' --stage review。'
  ].join('\n') },
  { id: 'deliver', kind: 'program', title: '汇总交付', produces: ['deliver.json'], check: 'deliver' }
]

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

function currentStage(dir) {
  const signals = loadSignals(dir)
  for (const st of STAGES) if (!signals[st.id] || signals[st.id].status !== 'done') return { stage: st, signals }
  return { stage: null, signals }
}

function writeSignal(dir, stage, st, extra) {
  mkdirSync(j(dir, STAGE_DIR), { recursive: true })
  writeFileSync(j(dir, STAGE_DIR, stage + '.json'), JSON.stringify(Object.assign({ stage, status: st, at: new Date().toISOString() }, extra || {}), null, 2), 'utf8')
}

function status(dir) {
  const r = currentStage(dir)
  console.log('=== pipeline: ' + dir + ' ===')
  for (const st of STAGES) {
    const s = r.signals[st.id]
    const mark = !s ? '..' : s.status === 'done' ? 'OK' : 'NO'
    console.log('  [' + mark + '] ' + st.id.padEnd(10) + (st.kind === 'agent' ? '[agent] ' : '[程序]  ') + st.title)
    if (s && s.problems && s.problems.length) s.problems.forEach((p) => console.log('        - ' + p))
  }
  console.log(r.stage ? '\n当前节点：' + r.stage.id + '（' + (r.stage.kind === 'agent' ? '需要派 agent' : '程序自己跑') + '）' : '\n全部节点已完成')
  return r.stage
}

function step(dir) {
  // 一路推进：程序节点连续跑完，直到遇到需要 agent 的节点（出票并返回 10）
  for (let guard = 0; guard < 20; guard += 1) {
    const stage = currentStage(dir).stage
    if (!stage) { console.log('全部完成'); return 0 }
    if (stage.kind === 'program') {
      if (stage.id === 'preflight') {
        const missing = []
        if (!existsSync(j(dir, 'research.json'))) missing.push('缺 research.json —— 先跑 node harness/preflight.mjs --run ' + dir + ' --ref <参考素材>')
        if (missing.length) { writeSignal(dir, stage.id, 'failed', { problems: missing }); console.log('前置未满足：\n  ' + missing.join('\n  ')); return 1 }
        writeSignal(dir, stage.id, 'done', { artifacts: ['research.json'] })
        console.log('preflight 通过')
        continue
      }
      const problems = checks[stage.check] ? checks[stage.check](dir) : []
      if (problems.length) { writeSignal(dir, stage.id, 'failed', { problems }); console.log(stage.id + ' 未通过：\n  ' + problems.join('\n  ')); return 1 }
      writeSignal(dir, stage.id, 'done', { artifacts: stage.produces || [] })
      console.log(stage.id + ' 通过')
      continue
    }
    const ticketObj = { stage: stage.id, title: stage.title, check: stage.check, prompt: stage.prompt(dir) }
    mkdirSync(j(dir, TICKET_DIR), { recursive: true })
    const ticket = j(dir, TICKET_DIR, stage.id + '.json')
    writeFileSync(ticket, JSON.stringify(ticketObj, null, 2), 'utf8')
    console.log('需要派 agent：' + stage.id + '（' + stage.title + '）')
    console.log('  票：' + ticket)
    return 10
  }
  console.log('节点表可能有环，停止')
  return 1
}

function done(dir, stageId) {
  const st = STAGES.find((x) => x.id === stageId)
  if (!st) { console.log('未知节点：' + stageId); return 2 }
  const problems = checks[st.check] ? checks[st.check](dir) : []
  if (problems.length) {
    writeSignal(dir, stageId, 'failed', { problems })
    console.log(stageId + ' 产物不合格，卡住：\n  ' + problems.join('\n  '))
    return 1
  }
  writeSignal(dir, stageId, 'done', { artifacts: [] })
  console.log(stageId + ' 产物通过程序核对')
  const next = currentStage(dir).stage
  console.log(next ? '下一个节点：' + next.id + (next.kind === 'agent' ? '（需要派 agent）' : '（程序自己跑）') : '全部完成')
  return 0
}

const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : '' }
const dir = resolve(arg('run') || '')
if (!dir || !cmd) { console.error('用法: node harness/pipeline.mjs <status|step|done> --run <run目录> [--stage <id>]'); process.exit(2) }
if (cmd === 'status') { status(dir); process.exit(0) }
if (cmd === 'step') process.exit(step(dir))
if (cmd === 'done') process.exit(done(dir, arg('stage')))
console.error('未知子命令：' + cmd)
process.exit(2)
