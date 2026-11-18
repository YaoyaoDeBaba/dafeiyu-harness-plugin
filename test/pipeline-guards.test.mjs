// pipeline 程序约束自测（2026-11-18 · N4 落地）
//   ① 判据方向 dir：缺 / 非法 / lower 低于实测 / upper 高于实测 / two-sided 出区间 → 都要卡
//   ② 出票时先打「交活前自查」（rounds 字段形状、判据可测性）——只提示不拦
//   ③ decide=next 之后 3.1/3.2 的旧信号作废（新版删除 + 老 run 时间兜底）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { capabilityPrecheck } from '../harness/intent.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const PRE = join(ROOT, 'harness', 'preflight.mjs')
const ICON = join(ROOT, 'icon.png')
const run = (...a) => spawnSync(process.execPath, [PIPE, ...a], { encoding: 'utf8' })
const pre = (...a) => spawnSync(process.execPath, [PRE, ...a], { encoding: 'utf8' })

const OLD = '2026-11-18T00:00:00.000Z'   // 上一轮的信号时间
const NEW = '2026-11-18T01:00:00.000Z'   // 本轮循环之后的信号时间

function makeRun(budget) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-guard-'))
  mkdirSync(join(dir, 'refs'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n示例\n')
  copyFileSync(ICON, join(dir, 'refs', 'ref.png'))
  writeFileSync(join(dir, 'budget.json'), JSON.stringify(budget || { research: 'low', maxRounds: 1, useCritic: false, resupply: false }))
  pre('--run', dir, '--ref', join(dir, 'refs', 'ref.png'))
  return dir
}

function signal(dir, id, extra) {
  mkdirSync(join(dir, 'stages'), { recursive: true })
  writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify(Object.assign({ stage: id, status: 'done', by: 'pipeline', at: OLD }, extra || {})))
}

// 让 currentNode 停在 1.10-translate3
function upToIntent(dir) {
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm']) signal(dir, id)
}

function writeIntent(dir, criteria) {
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ extracted: [{ what: '实测 p50', value: 0.19, min: 0.155, max: 0.233 }] }))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({
    restate: '把云的观感做到参考那样',
    criteria,
    anchors: [{ kind: 'text', ref: '参考帧', why: '判据锚点' }],
    confirmed: true,
  }))
}

// 1.10 有必填表单：先出一次票拿表单再填满
function fillIntentForm(dir) {
  run('step', '--run', dir)
  const f = JSON.parse(readFileSync(join(dir, 'forms', '1.10-translate3.json'), 'utf8'))
  const vals = {
    numericCriteria: ['C1 / 0.19 / 掩膜内亮度 p50 / coverage'],
    noMetricCriteria: ['无'],
    anchors: ['参考帧'],
    notWanted: ['蓝 tint'],
  }
  for (const x of f.fields) x.value = vals[x.id]
  writeFileSync(join(dir, 'forms', '1.10-translate3.json'), JSON.stringify(f))
}

// 2.5-decide 的表单（表 key 不带轮次，文件按节点 id 落）
function fillDecideForm(dir, action, gaps) {
  const f = JSON.parse(readFileSync(join(dir, 'forms', '2.5-decide-r1.json'), 'utf8'))
  assert.ok(Array.isArray(f.fields) && f.fields.length > 0, '轮次节点的表单应为真表单而不是 null')
  const vals = { action, why: '测试填的', gapsForNextRound: gaps.length ? gaps : ['无'], budgetNote: '用 1 轮' }
  for (const x of f.fields) x.value = vals[x.id]
  writeFileSync(join(dir, 'forms', '2.5-decide-r1.json'), JSON.stringify(f))
}

function doneIntent(dir) {
  return run('done', '--run', dir, '--stage', '1.10-translate3')
}

const CRIT = (extra) => Object.assign({ id: 'C1', target: 0.19, howMeasured: '掩膜内亮度 p50' }, extra)

// ───────────── ① dir ─────────────
test('① 判据缺 dir → 卡住，并说清三档语义', () => {
  const dir = makeRun(); upToIntent(dir); writeIntent(dir, [CRIT()]); fillIntentForm(dir)
  const r = doneIntent(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /缺 dir/)
  assert.match(r.stdout, /lower \/ upper \/ two-sided/)
})

test('② dir 写错（lt）→ 卡住', () => {
  const dir = makeRun(); upToIntent(dir); writeIntent(dir, [CRIT({ dir: 'lt' })]); fillIntentForm(dir)
  const r = doneIntent(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /不认识/)
})

test('③ dir=lower 但 target 低于实测 min → 卡住（点名下限型）', () => {
  const dir = makeRun(); upToIntent(dir); writeIntent(dir, [CRIT({ target: 0.10, dir: 'lower' })]); fillIntentForm(dir)
  const r = doneIntent(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /下限型/)
})

test('④ dir=lower 且 target ≥ 实测 min → 放行', () => {
  const dir = makeRun(); upToIntent(dir); writeIntent(dir, [CRIT({ target: 0.20, dir: 'lower' })]); fillIntentForm(dir)
  const r = doneIntent(dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /通过程序核对/)
})

test('⑤ dir=upper 但 target 高于实测 max → 卡住（点名上限型）', () => {
  const dir = makeRun(); upToIntent(dir); writeIntent(dir, [CRIT({ target: 0.30, dir: 'upper' })]); fillIntentForm(dir)
  const r = doneIntent(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /上限型/)
})

test('⑥ dir=upper 且 target ≤ 实测 max → 放行', () => {
  const dir = makeRun(); upToIntent(dir); writeIntent(dir, [CRIT({ target: 0.20, dir: 'upper' })]); fillIntentForm(dir)
  const r = doneIntent(dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('⑦ dir=two-sided 出区间 → 卡住（旧行为不变）', () => {
  const dir = makeRun(); upToIntent(dir); writeIntent(dir, [CRIT({ target: 0.30, dir: 'two-sided' })]); fillIntentForm(dir)
  const r = doneIntent(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /不在任何实测区间/)
})

test('⑧ direction 是 dir 的别名，也被认', () => {
  const dir = makeRun(); upToIntent(dir); writeIntent(dir, [CRIT({ target: 0.20, direction: 'lower' })]); fillIntentForm(dir)
  const r = doneIntent(dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

// ───────────── ② 出票前自查 ─────────────
test('⑨ 2.2-exec-r1 出票时就提示 rounds/01.json 缺字段（不拦，仍出票 exit 10）', () => {
  const dir = makeRun()
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) signal(dir, id)
  const r = run('step', '--run', dir)
  assert.equal(r.status, 10, r.stdout)
  assert.match(r.stdout, /交活前自查/)
  assert.match(r.stdout, /rounds\/01\.json/)
})

test('⑩ 1.10 出票时按判据文字提示「本机位能不能测」', () => {
  const dir = makeRun(); upToIntent(dir)
  writeIntent(dir, [CRIT({ howMeasured: '沿天际线扫天空亮带的亮度差' })])
  const r = run('step', '--run', dir)
  assert.equal(r.status, 10, r.stdout)
  assert.match(r.stdout, /地平线|天空区域/)
})

test('⑪ capabilityPrecheck：命中与不命中', () => {
  assert.equal(capabilityPrecheck([{ id: 'C1', howMeasured: '掩膜内亮度 p50' }]).length, 0)
  const hit = capabilityPrecheck([{ id: 'C2', howMeasured: '地平线上方的亮带' }])
  assert.equal(hit.length, 1)
  assert.match(hit[0], /^C2：/)
  // 没有 id 也要能用
  assert.match(capabilityPrecheck([{ howMeasured: '背景亮度 vs 云亮度' }])[0], /^\(无id\)：/)
})

// ───────────── ③ decide=next 后 3.1/3.2 作废 ─────────────
test('⑫ 老 run 时间兜底：本轮循环比 3.1/3.2 新 → 当前节点回到本轮执行，不再跳过收尾', () => {
  const dir = makeRun({ research: 'low', maxRounds: 2, useCritic: false, resupply: false })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3']) signal(dir, id)
  for (const id of ['2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1']) signal(dir, id)
  signal(dir, '2.5-decide-r1', { action: 'next' })
  signal(dir, '3.1-summarize'); signal(dir, '3.2-deliver')            // 上一轮留下的
  signal(dir, '2.1-plan-r2', { at: NEW })                              // 本轮循环已经开始
  const r = run('status', '--run', dir)
  assert.match(r.stdout, /当前节点：2\.2-exec-r2/, r.stdout.slice(-300))
})

test('⑬ done 2.5-decide-r1(action=next) → 直接删掉 3.1/3.2 的旧信号', () => {
  const dir = makeRun({ research: 'low', maxRounds: 2, useCritic: false, resupply: false })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3']) signal(dir, id)
  for (const id of ['2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1']) signal(dir, id)
  signal(dir, '3.1-summarize'); signal(dir, '3.2-deliver')
  writeFileSync(join(dir, 'decide.json'), JSON.stringify({ action: 'next', why: '还差两条判据', nextRoundOrders: [{ task: '改云' }] }))
  run('step', '--run', dir)   // 出 2.5 的票（表单）
  fillDecideForm(dir, 'next', ['云顶被裁'])
  const r = run('done', '--run', dir, '--stage', '2.5-decide-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /旧信号作废/)
  assert.ok(!existsSync(join(dir, 'stages', '3.1-summarize.json')), '3.1 旧信号应被删')
  assert.ok(!existsSync(join(dir, 'stages', '3.2-deliver.json')), '3.2 旧信号应被删')
})

test('⑭ decide=stop 时不动 3.1/3.2（收尾照常）', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: false, resupply: false })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1']) signal(dir, id)
  writeFileSync(join(dir, 'decide.json'), JSON.stringify({ action: 'stop', why: '够好了' }))
  run('step', '--run', dir)
  fillDecideForm(dir, 'stop', [])
  const r = run('done', '--run', dir, '--stage', '2.5-decide-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout, /旧信号作废/)
})


// ───────────── ④ 执行员契约（P1）与反早停硬闸（P2）─────────────
test('⑮ 2.2-exec 出票自带契约：contextBudget / mustProduce / 票面写清下限', () => {
  const dir = makeRun()
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) signal(dir, id)
  run('step', '--run', dir)
  const t = JSON.parse(readFileSync(join(dir, 'tickets', '2.2-exec-r1.json'), 'utf8'))
  assert.deepEqual(t.mustProduce, { variants: 3, abFrames: 1 })
  assert.deepEqual(t.contextBudget, { docs: 2, images: 1 })
  assert.match(t.prompt, /本轮契约/)
  assert.match(t.prompt, /至少 3 个变体/)
  assert.match(t.prompt, /上下文上限/)
})

test('⑯ 交活不带 variants[] → 被反早停闸挡住', () => {
  const dir = makeRun()
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) signal(dir, id)
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ changes: ['改了 A'], shot: 'shots/a.png' }))
  const r = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /缺 variants/)
})

test('⑰ 变体数量不足 → 挡住并说清下限', () => {
  const dir = makeRun()
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) signal(dir, id)
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ changes: ['改了 A'], shot: 'shots/a.png', variants: [{ name: 'v1', shot: 'shots/v1.png' }], abShots: ['shots/ab.png'] }))
  const r = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /少于本轮下限 3/)
})

test('⑱ 变体够 + A/B 帧够 → 放行', () => {
  const dir = makeRun()
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) signal(dir, id)
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({
    changes: ['改了 A'], shot: 'shots/a.png',
    variants: [{ name: 'v1', shot: 'shots/v1.png' }, { name: 'v2', shot: 'shots/v2.png' }, { name: 'v3', shot: 'shots/v3.png' }],
    abShots: ['shots/ab_bite.png'],
  }))
  const r = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('⑲ budget.exec 关掉下限 → 老形状的 round 文件仍能过（向后兼容）', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, exec: { minVariants: 0, requireAB: false } })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) signal(dir, id)
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ changes: ['改了 A'], shot: 'shots/a.png' }))
  const r = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})


// ───────────── ⑤ 判据靶必须来自分布（P4）─────────────
test('⑳ 单帧量测 → extracted 打 singleFrame 标，preflight 打提示', () => {
  const dir = makeRun()
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  assert.ok(rj.extracted.length > 0, '要先有量测')
  assert.ok(rj.extracted.every((e) => e.singleFrame === true), '单帧量测必须打标：' + JSON.stringify(rj.extracted[0]))
  const out = pre('--run', dir, '--ref', join(dir, 'refs', 'ref.png'))
  assert.match(out.stdout + out.stderr, /只量了 1 张/)
})

test('㉑ 参考目录量测 → extracted 有 min/max 且不打单帧标', () => {
  const dir = makeRun()
  for (const n of ['b.png', 'c.png']) copyFileSync(ICON, join(dir, 'refs', n))   // 目录里要有 >1 张才算分布
  const r = pre('--run', dir, '--ref', join(dir, 'refs'))
  assert.ok(existsSync(join(dir, 'research.json')))
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  assert.ok(rj.extracted.length > 0)
  assert.ok(rj.extracted.every((e) => e.singleFrame !== true), '目录量测不该打单帧标')
  // 三张同图 → min==max；这里断言「来源写了 N 帧」，即确实按分布量的（不是只量一张）
  assert.ok(rj.extracted.some((e) => /[0-9]+ 帧/.test(String(e.source))), '来源要写「N 帧」：' + JSON.stringify(rj.extracted[0]))
})

test('㉒ refs/ 有多张帧但只量了 1 张 → 1.1 就卡住，并给出补救命令', () => {
  const dir = makeRun()                       // makeRun 用单帧 preflight → extracted 全 singleFrame
  for (const n of ['b.png', 'c.png']) copyFileSync(ICON, join(dir, 'refs', n))
  const r = run('step', '--run', dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /全部来自 1 张/)
  assert.match(r.stdout, /--ref .*refs/)
})


// ───────────── ⑥ 拆窄票 / 合并选优（P3）─────────────
test('㉓ budget.split=true → 节点表里出现 2.2a-split 与 2.4m-merge，且顺序对', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, split: true })
  const out = run('status', '--run', dir).stdout
  const order = (out.match(/\[..\] (\S+)/g) || []).map((x) => x.split(' ')[1])
  const iPlan = order.indexOf('2.1-plan-r1')
  const iSplit = order.indexOf('2.2a-split-r1')
  const iExec = order.indexOf('2.2-exec-r1')
  const iMerge = order.indexOf('2.4m-merge-r1')
  const iVerify = order.indexOf('2.3-verify-r1')
  assert.ok(iSplit > iPlan && iExec > iSplit && iMerge > iExec && iVerify > iMerge, '顺序应为 plan→split→exec→merge→verify：' + order.join(','))
})

test('㉔ 没写 split.json → 2.2a-split 卡住', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, split: true })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) signal(dir, id)
  const r = run('done', '--run', dir, '--stage', '2.2a-split-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /缺 split\.json/)
})

test('㉕ split.json 只有 1 张票 / 验收缺 dir → 卡住；补全 → 放行', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, split: true })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) signal(dir, id)
  writeFileSync(join(dir, 'split.json'), JSON.stringify({ tasks: [{ id: 'T1', goal: '只改云剪影', files: ['src/cloud.js'], accept: [{ id: 'topCoverage', target: 0.72 }] }] }))
  const r1 = run('done', '--run', dir, '--stage', '2.2a-split-r1')
  assert.equal(r1.status, 1, r1.stdout)
  assert.match(r1.stdout, /少于 2 张/)
  writeFileSync(join(dir, 'split.json'), JSON.stringify({ tasks: [
    { id: 'T1', goal: '只改云剪影', files: ['src/cloud.js'], accept: [{ id: 'topCoverage', target: 0.72, dir: 'two-sided' }], contextBudget: { docs: 0, images: 1 } },
    { id: 'T2', goal: '只改闪电辉光', files: ['src/bolt.js'], accept: [{ id: 'p99', target: 0.70, dir: 'two-sided' }] }
  ] }))
  const r2 = run('done', '--run', dir, '--stage', '2.2a-split-r1')
  assert.equal(r2.status, 0, r2.stdout + r2.stderr)
})

test('㉖ merge.json 缺 chosen / evidence → 卡住', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, split: true })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2a-split-r1', '2.2-exec-r1']) signal(dir, id)
  writeFileSync(join(dir, 'merge.json'), JSON.stringify({ why: '短' }))
  const r = run('done', '--run', dir, '--stage', '2.4m-merge-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /chosen/)
  assert.match(r.stdout, /evidence/)
})


// ───────────── ⑦ 拆窄票的票模板与结果覆盖（补结构漏洞）─────────────
test('㉗ 2.2a-split / 2.4m-merge 有票模板（不许落进「没有票模板」兜底）', async () => {
  const { ticketFor } = await import('../harness/tickets.mjs')
  const a = ticketFor('X', { id: '2.2a-split-r1' })
  const b = ticketFor('X', { id: '2.4m-merge-r1' })
  assert.ok(!a.includes('没有票模板'), 'split 票缺模板：' + a.slice(0, 60))
  assert.match(a, /split\.json/)
  assert.ok(!b.includes('没有票模板'), 'merge 票缺模板：' + b.slice(0, 60))
  assert.match(b, /merge\.json/)
})

test('㉘ 有 split.json 时：exec 票指向窄票，且结果必须覆盖每张票', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, split: true })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2a-split-r1']) signal(dir, id)
  writeFileSync(join(dir, 'split.json'), JSON.stringify({ tasks: [
    { id: 'T1', goal: '云剪影', files: ['a.js'], accept: [{ id: 'topCoverage', target: 0.72, dir: 'two-sided' }] },
    { id: 'T2', goal: '闪电辉光', files: ['b.js'], accept: [{ id: 'p99', target: 0.70, dir: 'two-sided' }] }
  ] }))
  const stepOut = run('step', '--run', dir).stdout
  assert.match(stepOut, /2\.2-exec-r1/)
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  // 只交了一张票的结果 → 要挡住并点名缺哪张
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ changes: ['x'], shot: 'a.png', tasks: [{ id: 'T1', variants: [1, 2, 3], abShots: ['ab.png'] }] }))
  const r1 = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(r1.status, 1, r1.stdout)
  assert.match(r1.stdout, /窄票 T2 没有结果/)
  // 两张都交齐 → 通过
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ changes: ['x'], shot: 'a.png', tasks: [
    { id: 'T1', variants: [1, 2, 3], abShots: ['ab.png'] },
    { id: 'T2', variants: [1, 2, 3], abShots: ['ab.png'] }
  ] }))
  const r2 = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(r2.status, 0, r2.stdout + r2.stderr)
})
