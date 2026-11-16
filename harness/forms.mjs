// 主Agent 表单：必办事项由程序发空表，填不完不放行
//
// 为什么（2026-11-16）：主Agent 的节点原来没有 checker，写不写、写多少全凭自觉；
// 实测还出过「引用了不存在的条目」这种事没人发现。
// 表单不能保证质量（那是 skill 与 agent 的事），但能保证**不遗漏**：
// 该回答的每一条都在表上，空着就是没做，程序一眼能看出来。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const j = (...a) => join(...a)
const FORM_DIR = 'forms'

// 字段类型：text（非空字符串）/ list（非空数组，可设 minItems）/ number / enum / bool
const FORMS = {
  '1.2-translate1': {
    title: '初轮转译：把需求读成"可调查的问题"',
    fields: [
      { id: 'restate', label: '用你自己的话复述需求（含用户点名的毛病）', type: 'text' },
      { id: 'openQuestions', label: '要调查员回答的问题（至少 3 条，越具体越好）', type: 'list', minItems: 3 },
      { id: 'assumed', label: '先按什么假设往下走（错了会怎样）', type: 'list', minItems: 1 },
      { id: 'notInScope', label: '本轮明确不做什么（防止范围蔓延）', type: 'list', minItems: 1 },
      { id: 'metricHints', label: '预判哪些指标能当判据、哪些不能', type: 'list', minItems: 2 }
    ]
  },
  '1.7-absorb': {
    title: '吸收：判断哪几条调研真的改变了做法',
    fields: [
      { id: 'takeaways', label: '每条写明 来源(from) / 说了什么(what) / 改了什么(apply)', type: 'list', minItems: 3 },
      { id: 'rejected', label: '哪些调研结论被否掉，为什么（防照单全收）', type: 'list', minItems: 1 },
      { id: 'conflicts', label: '调研之间互相矛盾的地方，你怎么取舍', type: 'list' },
      { id: 'changedApproach', label: '这次调研是否改变了做法？改了什么', type: 'text' }
    ]
  },
  '1.8-translate2': {
    title: '第二轮转译：把判据写成可测的',
    fields: [
      { id: 'criteriaCount', label: '判据条数（数值判据 + 主观判据各几条）', type: 'text' },
      { id: 'thresholdSource', label: '每个阈值来自哪条实测（写 extracted 的 what）', type: 'list', minItems: 1 },
      { id: 'mapsTo', label: '每条判据对应哪个可调旋钮（执行者据此下手）', type: 'list', minItems: 1 },
      { id: 'subjective', label: '哪些判据量不了、为什么（要显式 noMetric）', type: 'list' }
    ]
  },
  '1.9-confirm': {
    title: '确认意向：哪些必须问用户，哪些自己拍',
    fields: [
      { id: 'questions', label: '要问用户的（每个必须给建议答案 recommend + 理由）', type: 'list' },
      { id: 'autoConfirmed', label: '自己拍的板（每条写依据）', type: 'list', minItems: 1 },
      { id: 'askTone', label: '打算怎么向用户提问（一句话，别把选择题原样丢回去）', type: 'text' }
    ]
  },
  '1.10-translate3': {
    title: '第三轮转译：定稿判据',
    fields: [
      { id: 'numericCriteria', label: '数值判据：每条写 id / target / 量法 / 对应旋钮', type: 'list', minItems: 1 },
      { id: 'noMetricCriteria', label: '量不了的判据：写为什么量不了、交给谁判', type: 'list' },
      { id: 'anchors', label: '锚：参考图 / 参考产品 / 实测依据', type: 'list', minItems: 1 },
      { id: 'notWanted', label: '明确不要的（防止调偏）', type: 'list', minItems: 1 }
    ]
  },
  '2.1-plan': {
    title: '列工单 + 配执行员',
    fields: [
      { id: 'orders', label: '每张工单：任务 / 完成判据 / 涉及文件', type: 'list', minItems: 1 },
      { id: 'executor', label: '派谁干（模型名 + 理由）', type: 'text' },
      { id: 'variables', label: '本轮只动哪几个变量（保证可归因）', type: 'list', minItems: 1 },
      { id: 'risks', label: '预判会坏的地方与退路', type: 'list', minItems: 1 }
    ]
  },
  '2.3-verify': {
    title: '验收：只判能跑 / 能看',
    fields: [
      { id: 'runsEvidence', label: '能跑的证据（编译/加载/运行分别怎么验的）', type: 'text' },
      { id: 'visibleEvidence', label: '能看的证据（图在哪、抓的是哪一帧）', type: 'text' },
      { id: 'caveat', label: '你看到但不在验收范围内的问题（留给评审）', type: 'list', minItems: 1 },
      { id: 'notVerified', label: '没验的部分 + 为什么', type: 'list' }
    ]
  },
  '2.4c-merge': {
    title: '合并观察员与用户的评审意见',
    fields: [
      { id: 'fromCritic', label: '观察员的结论（逐条：判据 / 过没过 / 证据）', type: 'list', minItems: 1 },
      { id: 'fromUser', label: '用户的意见（逐条：说了什么 / 严重度 / 影响哪一部分）', type: 'list', minItems: 1 },
      { id: 'conflicts', label: '两者冲突的地方：各说什么、你按谁、为什么（不许和稀泥）', type: 'list' },
      { id: 'nextRoundOrders', label: '合并后得出的下一轮工单（任务 / 完成判据）', type: 'list', minItems: 1 }
    ]
  },
  '2.5-decide': {
    title: '评估：要不要再来一轮',
    fields: [
      { id: 'action', label: '下一步动作', type: 'enum', options: ['next', 'stop'] },
      { id: 'why', label: '依据（判据还差几条 / 预算剩多少 / 是否还在收敛）', type: 'text' },
      { id: 'gapsForNextRound', label: '下一轮要打的缺口（逐条）', type: 'list' },
      { id: 'budgetNote', label: '预算状态（轮数用了几轮、还剩几轮）', type: 'text' }
    ]
  },
  '3.1-summarize': {
    title: '写对用户的总结',
    fields: [
      { id: 'text', label: '人话总结：做到哪、差哪、下一步', type: 'text' },
      { id: 'whatChanged', label: '这轮实际改了什么', type: 'list', minItems: 1 },
      { id: 'gaps', label: '还没做到的（别粉饰）', type: 'list', minItems: 1 },
      { id: 'next', label: '下一步建议', type: 'list', minItems: 1 }
    ]
  }
}

export function hasForm(nodeId) {
  return Boolean(FORMS[nodeId])
}

export function blankForm(nodeId) {
  const def = FORMS[nodeId]
  if (!def) return null
  return {
    stage: nodeId,
    title: def.title,
    _说明: '把每项的 value 填上（列表填数组）。必填项空着，程序不放行。',
    fields: def.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, required: true, ...(f.minItems ? { minItems: f.minItems } : {}), ...(f.options ? { options: f.options } : {}), value: f.type === 'list' ? [] : null }))
  }
}

export function writeBlankForm(dir, nodeId) {
  mkdirSync(j(dir, FORM_DIR), { recursive: true })
  writeFileSync(j(dir, FORM_DIR, nodeId + '.json'), JSON.stringify(blankForm(nodeId), null, 2), 'utf8')
  return j(dir, FORM_DIR, nodeId + '.json')
}

export function checkForm(dir, nodeId) {
  const def = FORMS[nodeId]
  if (!def) return []
  const p = j(dir, FORM_DIR, nodeId + '.json')
  if (!existsSync(p)) return ['缺表单 forms/' + nodeId + '.json（主Agent 的必办事项没填）']
  let form = null
  try { form = JSON.parse(readFileSync(p, 'utf8')) } catch { return ['表单 forms/' + nodeId + '.json 不是合法 JSON'] }
  const out = []
  const values = {}
  for (const f of (form.fields || [])) values[f.id] = f.value
  for (const f of def.fields) {
    const v = values[f.id]
    const empty = v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)
    if (empty) { out.push('表单未填：' + f.label); continue }
    if (f.type === 'list' && f.minItems && Array.isArray(v) && v.length < f.minItems) out.push('表单条数不够：' + f.label + '（要 ≥' + f.minItems + '，现在 ' + v.length + '）')
    if (f.type === 'enum' && f.options && !f.options.includes(v)) out.push('表单取值非法：' + f.label + '（只能 ' + f.options.join('/') + '）')
    if (f.type === 'list' && Array.isArray(v) && v.every((x) => typeof x === 'string' && !x.trim())) out.push('表单条目是空的：' + f.label)
  }
  return out
}
