// 票模板：每个节点一张票 —— 只写"这一环做什么 + 不许越想界 + 怎么算交活"
import { join } from 'node:path'

const j = (...a) => join(...a)
const doneLine = (dir, id) => [
  '交活前先填表：' + j(dir, 'forms', id + '.json') + '（每项 value 都填上，空着不放行）',
  '做完：node harness/pipeline.mjs done --run ' + dir + ' --stage ' + id
].join('\\n')

const PHASE1 = {
  '1.2-translate1': (dir, id) => [
    '你是**需求转译者**（主Agent 角色）。只做初轮转译，不定稿、不等调查。',
    '读 ' + j(dir, 'requirement.md') + ' 与 ' + j(dir, 'research.json') + ' 的 extracted[]（参考实测）。',
    '写 ' + j(dir, 'intent.draft1.json') + '：{ restate, openQuestions[], assumed[] }。',
    'openQuestions 就是给后面三位调查员的线索，写得越具体越好。',
    '不要写 intent.json（那是 1.10），不要动代码。',
    doneLine(dir, id)
  ].join('\n'),
  '1.3-research-env': (dir, id) => [
    '你是**调查员c：环境 / 工具 / 指南**。只查一件事：「这个宿主里已经有什么」。',
    '要查：规范与约束、既有组件/工具/CLI、历史实现、工程地图（目录结构 + 关键文件）、已知坑。',
    '写进 ' + j(dir, 'research.json') + ' 的 findings[]，kind="environment"，path 写本地真实路径。',
    '硬约束：只追加 findings；不许改代码、不许写 intent、不许编造不存在的文件。',
    '读 ' + j(dir, 'intent.draft1.json') + ' 的 openQuestions 找方向。',
    doneLine(dir, id)
  ].join('\n'),
  '1.4-research-doc': (dir, id) => [
    '你是**调查员a：技术文献**。查算法 / 开源实现 / 论文，写进 ' + j(dir, 'research.json') + ' 的 findings[]。',
    'kind 只能是 opensource / paper / article，必须带真实 http(s) URL。',
    '每条写清 what（解决什么）、how（具体做法与参数）、usedFor（改了哪条判据/做法）。',
    '查不到就写进 gaps，不许编 URL。只追加 findings，不动代码与 intent。',
    doneLine(dir, id)
  ].join('\n'),
  '1.5-research-ref': (dir, id) => [
    '你是**调查员b：参考图 / 参考产品 / 现实知识**。把参考素材与领域常识翻译成可执行做法。',
    '参考逐帧图在 ' + j(dir, 'refs') + '；已量好的特征在 ' + j(dir, 'research.json') + ' 的 extracted[]。',
    '写进 findings[]（kind="reference" 或 "knowledge"），写清怎么落到实现上（usedFor）。',
    '硬约束：只追加 findings，不动代码与 intent，不许编造来源。',
    doneLine(dir, id)
  ].join('\n'),
  '1.7-absorb': (dir, id) => [
    '你是**主Agent**。这一轮只做吸收：读 research.json 全部 findings，判断哪几条真的改变了做法。',
    '写 ' + j(dir, 'absorbed.json') + '：{ takeaways:[{from, what, apply}], changedApproach:true|false, note }。',
    '每条 takeaway 必须指到具体 finding（from = url 或 path），apply 写它改了什么。',
    doneLine(dir, id)
  ].join('\n'),
  '1.8-translate2': (dir, id) => [
    '你是**主Agent**。第二轮转译：把 absorbed 的结论并进判据，写 ' + j(dir, 'intent.draft2.json') + '。',
    '这一轮开始写 criteria：每条带 userWords 或 howMeasured；阈值取 research.extracted 的实测区间。',
    '还不定稿，把仍有分歧的点列进 openQuestions。',
    doneLine(dir, id)
  ].join('\n'),
  '1.9-confirm': (dir, id) => [
    '你是**主Agent**。整理需要用户拍板的问题，写 ' + j(dir, 'intent.confirm.json') + '。',
    '格式：{ questions:[{id, question, options[], recommend, why}], autoConfirmed:[{what, why}] }。',
    '能自己拍板的（文档/工艺层面）放 autoConfirmed 并写理由；只有「需要用户偏好」的才进 questions。',
    doneLine(dir, id)
  ].join('\n'),
  '1.10-translate3': (dir, id) => [
    '你是**主Agent**。第三轮转译（定稿）：写 ' + j(dir, 'intent.json') + '，confirmed 改 true。',
    '硬约束：每条可测判据必须有数值 target，且要落在 research.extracted 某个 [min,max] 内；',
    '量不了的显式写 noMetric:true 并写理由（这是诚实，不是逃避）。',
    'criteria 每条带 userWords（用户原话）或 howMeasured（怎么量）。',
    doneLine(dir, id)
  ].join('\n')
}

const ROUND = {
  knowledge: (dir, r, id) => [
    '你是**调查员**（补充知识）。这一轮只做一件事：按本轮暴露的缺口做**定向**调研，写 ' + j(dir, 'research.supplement-r' + r + '.json') + '。',
    '缺口来源：' + j(dir, 'decide.json') + ' 的 nextRoundOrders（每条就是你要查的方向）。',
    '格式：{ round, targets:[缺口id或描述], findings:[{title,url,kind,what,how,usedFor}], gaps:[] }。',
    '硬约束：至少 1 条带真实 URL；查不到写进 gaps，不许编；不许改代码与上游文件。',
    doneLine(dir, id)
  ].join('\n'),
  absorb: (dir, r, id) => [
    '你是**主Agent**。只做一件事：把补充调研转成**下一轮需求**，写 ' + j(dir, 'nextRoundBrief.json') + '。',
    '读 ' + j(dir, 'research.supplement-r' + r + '.json') + ' 与 ' + j(dir, 'decide.json') + '。',
    '格式：{ round, goal, absorbed:[{from,what,apply}], criteriaDelta:{add:[],modify:[],drop:[]}, orders:[{id,task,done_when}], notDoing:[], budgetNote }。',
    '会填 ' + j(dir, 'forms', id + '.json') + ' 的表（5 项必填）。',
    doneLine(dir, id)
  ].join('\n'),
  plan: (dir, r, id) => [
    '你是**主Agent**。第 ' + r + ' 轮开工前：列工单 + 配执行员，写 ' + j(dir, 'plan.json') + '。',
    '读 requirement.md / research.json / intent.json' + (r > 1 ? '、上一轮 rounds/' + String(r - 1).padStart(2, '0') + '.json、decide.json 与 **nextRoundBrief.json**（下一轮需求就写在里面）' : '') + '。',
    '格式：{ round, orders:[{id, task, done_when}], executor:{model, why} }。',
    'executor.model 写你打算用来干这一轮的具体模型名。',
    '⚠ 先扫活性再列 variables：node harness/liveness.mjs --run ' + dir + ' --probe probe.json（死参数不许进 variables）。',
    doneLine(dir, id)
  ].join('\n'),
  // S3：票面字段化、去掉散文——契约与停止条件已经在上面的「执行员卡片」里，这里只写"做什么"
  exec: (dir, r, id) => [
    '你是**执行者**。第 ' + r + ' 轮：按 ' + j(dir, 'split.json') + ' 的窄票干活（没有就用 ' + j(dir, 'plan.json') + ' 的工单），结果写 ' + j(dir, 'rounds', String(r).padStart(2, '0') + '.json') + '。',
    '有 split.json 时：**每张窄票一份结果** → tasks:[{ id, variants[], abShots[], acceptEvidence[], changes[] }]；id 必须对上。',
    '交活前补快照：' + j(dir, 'rounds', 'r' + r, 'snapshot') + '/{code/, scene-params.json, params.md}（缺了只留痕不拦）。',
    doneLine(dir, id)
  ].join('\n'),
  verify: (dir, r, id) => [
    '你是**主Agent**。第 ' + r + ' 轮验收：只判两件事 —— 能跑吗、能看吗，写 ' + j(dir, 'verify.json') + '。',
    '能跑 = 编译/加载通过、没有报错；能看 = 有截图或可运行入口。',
    '不合格就写 false 并写原因，别和稀泥。',
    doneLine(dir, id)
  ].join('\n'),
  critique: (dir, r, id) => [
    '你是**观察员**。第 ' + r + ' 轮评审：对着 intent.json 的 criteria 逐条判，写 ' + j(dir, 'review.json') + '。',
    '硬约束：不许改代码与上游文件；必须给 vsCriteria:[{id,pass,evidence}]、verdict、vsRef（跟参考比差在哪）。',
    '不合格就写不合格。',
    doneLine(dir, id)
  ].join('\n'),
  split: (dir, r, id) => [
    '你是**主Agent**。第 ' + r + ' 轮开工前：把 plan.json 的工单拆成**窄票**，写 ' + j(dir, 'split.json') + '。',
    '每张窄票只带它自己的上下文：{ tasks:[{ id, goal, files[], refs[], accept:[{id,target,dir}], contextBudget:{docs,images} }] }。',
    '硬要求：至少 2 张；每张的 files 互不相交（冲突面小才拆得动）；每条 accept 必须带 dir（lower/upper/two-sided）。',
    '**不许**在窄票里写「怎么做」的教程——那是执行员自己的事；窄票只写「做什么 + 怎么算做完」。',
    '会填 ' + j(dir, 'forms', id + '.json') + ' 的表（若存在）。',
    doneLine(dir, id)
  ].join('\n'),
  merge: (dir, r, id) => [
    '你是**合并员**。第 ' + r + ' 轮：拿各张窄票的产物与验收表选优，写 ' + j(dir, 'merge.json') + '。',
    '只看 rounds/' + String(r).padStart(2, '0') + '.json 的 tasks[] 与 verify.json 的实测，**不要读任何一方的代码**（会被各自的实现细节带跑）。',
    '格式：{ chosen, why, evidence[] }；why 要说清「为什么是它，不是别的」。',
    doneLine(dir, id)
  ].join('\n'),
  mergeReviews: (dir, r, id) => [
    '你是**主Agent**。把观察员的评审（review.json）与用户的意见（user-review.json）合并，写 ' + j(dir, 'review.merged.json') + '。',
    '格式：{ fromCritic:[{id,pass,evidence}], fromUser:[{point,severity,impact}], conflicts:[{about, critic, user, resolved, why}],',
    '        nextRoundOrders:[{id, task, done_when}] }。',
    '硬约束：冲突不许和稀泥——要么按用户、要么按观察员，必须写理由；nextRoundOrders 就是下一轮的工单来源。',
    '会填 ' + j(dir, 'forms', id + '.json') + ' 的表。',
    doneLine(dir, id)
  ].join('\n'),
  decide: (dir, r, id) => [
    '你是**主Agent**。第 ' + r + ' 轮结束：判断要不要再来一轮，写 ' + j(dir, 'decide.json') + '。',
    '依据三样：判据还差几条（review.json）、预算还剩几轮（budget.json）、改动是否还在收敛（前几轮 round 的 metrics）。',
    '格式：{ round, action:"next"|"stop", why }。',
    doneLine(dir, id)
  ].join('\n')
}

const USER_REVIEW = (dir, r, id) => [
  '【这一步不是给 agent 的，是给用户的】',
  '把本轮产物交给用户看（截图/可运行入口），收集他的评审意见，写进 ' + j(dir, 'user-review.json') + '：',
  '{ by: "用户", shot: "他看的是哪张图", comments: [{ point, evidence, severity }], verdict: "合格|不合格|部分合格" }',
  '注意：用户说"没意见"也要写一条 comment 说明，不能留空。',
  '写完后：node harness/pipeline.mjs done --run ' + dir + ' --stage ' + id
].join('\n')

export function ticketFor(dir, node) {
  const um = String(node.id).match(/^2\.4b-userreview-r(\d+)$/)
  if (um) return USER_REVIEW(dir, um[1], node.id)
  const id = String(node.id)
  if (PHASE1[id]) return PHASE1[id](dir, id)
  const km = id.match(/^2\.6-knowledge-r(\d+)$/)
  if (km) return ROUND.knowledge(dir, km[1], id)
  const am = id.match(/^2\.7-absorb-r(\d+)$/)
  if (am) return ROUND.absorb(dir, am[1], id)
  // 2.2a-split-r1 / 2.4m-merge-r1 这类带字母后缀的 id 也要命中（2026-11-18 修：此前落进「没有票模板」兜底）
  const m = id.match(/^2\.(\d+)([a-z]?)-(\w+)-r(\d+)$/)
  if (m && ROUND[m[3]]) return ROUND[m[3]](dir, m[4], id)
  if (id === '3.1-summarize') {
    return [
      '你是**主Agent**。写对用户的总结：' + j(dir, 'summary.json') + ' = { text, whatChanged, gaps[], next[] }。',
      '要人话，能直接给用户看；写清做到哪、差哪、下一步建议。',
      doneLine(dir, id)
    ].join('\n')
  }
  return '（这个节点没有票模板：' + id + '）'
}
