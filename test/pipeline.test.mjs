// pipeline v2 自测（0.21.0）：流程由程序控制 + 预算档位 + 轮循环
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const PRE = join(ROOT, 'harness', 'preflight.mjs')
const ICON = join(ROOT, 'icon.png')
const run = (...a) => spawnSync(process.execPath, [PIPE, ...a], { encoding: 'utf8' })
const pre = (...a) => spawnSync(process.execPath, [PRE, ...a], { encoding: 'utf8' })

function makeRun(budget) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-v2-'))
  mkdirSync(join(dir, 'refs'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n示例\n')
  copyFileSync(ICON, join(dir, 'refs', 'ref.png'))
  if (budget) writeFileSync(join(dir, 'budget.json'), JSON.stringify(budget))
  pre('--run', dir, '--ref', join(dir, 'refs', 'ref.png'))
  return dir
}
const ids = (dir) => {
  const r = run('status', '--run', dir)
  return r.stdout.split('\n').map((l) => (l.match(/\[..\] (\S+)/) || [])[1]).filter(Boolean)
}

test('① 默认预算：research=high、1 轮、观察员开；节点表含 1.3/1.4/2.4', () => {
  const dir = makeRun()
  const list = ids(dir)
  assert.ok(list.includes('1.3-research-env'))
  assert.ok(list.includes('1.4-research-doc'))
  assert.ok(!list.includes('1.5-research-ref'), 'high 档不含参考调查')
  assert.ok(list.includes('2.4-critique-r1'))
  assert.ok(!list.includes('2.2-exec-r2'), '默认只 1 轮')
})

test('② low 档：跳过全部调查，只剩转译与执行', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: true })
  const list = ids(dir)
  for (const id of ['1.3-research-env', '1.4-research-doc', '1.5-research-ref']) assert.ok(!list.includes(id), id + ' 不该出现')
  assert.ok(list.includes('1.6-gate'), '闸仍在（只是档位低）')
})

test('③ mid 档：只有环境调查；max 档三个调查员都在', () => {
  const mid = ids(makeRun({ research: 'mid', maxRounds: 1, useCritic: true }))
  assert.ok(mid.includes('1.3-research-env'))
  assert.ok(!mid.includes('1.4-research-doc'))
  const max = ids(makeRun({ research: 'max', maxRounds: 1, useCritic: true }))
  assert.ok(max.includes('1.3-research-env') && max.includes('1.4-research-doc') && max.includes('1.5-research-ref'))
})

test('④ maxRounds=2 → 生成两轮；useCritic=false → 没有评审节点', () => {
  const list = ids(makeRun({ research: 'high', maxRounds: 2, useCritic: false }))
  assert.ok(list.includes('2.2-exec-r2'))
  assert.ok(!list.includes('2.4-critique-r1'))
})

test('⑤ step：1.1 自动过（量过参考），停在 1.2 出票 exit 10', () => {
  const dir = makeRun()
  const r = run('step', '--run', dir)
  assert.equal(r.status, 10, r.stdout + r.stderr)
  assert.match(r.stdout, /1\.2-translate1/)
  assert.ok(existsSync(join(dir, 'tickets', '1.2-translate1.json')))
})

test('⑥ 调研闸（1.6-gate）：mid 档缺 environment finding 时卡住', () => {
  const dir = makeRun({ research: 'mid', maxRounds: 1, useCritic: true })
  // 手动把 1.2~1.5 全部标记完成，直接撞闸
  mkdirSync(join(dir, 'stages'), { recursive: true })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.3-research-env', '1.4-research-doc', '1.5-research-ref']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done', at: new Date().toISOString() }))
  }
  const r = run('step', '--run', dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /environment/)
})

test('⑦ decide stop → 后续轮次被跳过，直接进交付阶段', () => {
  const dir = makeRun({ research: 'high', maxRounds: 2, useCritic: true })
  mkdirSync(join(dir, 'stages'), { recursive: true })
  const done = (id, extra) => writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify(Object.assign({ stage: id, status: 'done' }, extra || {})))
  // 阶段 1 全部完成
  for (const id of ['1.1-preflight', '1.2-translate1', '1.3-research-env', '1.4-research-doc', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3']) done(id)
  // 第 1 轮全部完成，且决定不再来一轮
  for (const id of ['2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1', '2.4-critique-r1']) done(id)
  done('2.5-decide-r1', { action: 'stop' })
  const r = run('status', '--run', dir)
  assert.match(r.stdout, /当前节点：3\.1-summarize/, '应直接进交付：' + r.stdout.slice(-200))
  assert.match(r.stdout, /\[--\] 2\.1-plan-r2/, '第 2 轮节点应标成跳过')
})

test('⑧ 顺序闸：上游没跑就交下游 → 拒绝（exit 3）', () => {
  const dir = makeRun()
  const r = run('done', '--run', dir, '--stage', '1.2-translate1')
  assert.equal(r.status, 3, r.stdout)
  assert.match(r.stdout, /顺序不对/)
})

test('⑨ manager 节点不再裸奔：没写 draft1 就交活 → 卡住', () => {
  const dir = makeRun()
  run('step', '--run', dir)            // 1.1 程序节点自动过，停在 1.2
  const r = run('done', '--run', dir, '--stage', '1.2-translate1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /intent\.draft1\.json/)
})

test('⑩ 写了 draft1 但 openQuestions 为空 → 仍卡（调查员会没线索）', () => {
  const dir = makeRun()
  run('step', '--run', dir)
  writeFileSync(join(dir, 'intent.draft1.json'), JSON.stringify({ restate: '复述', openQuestions: [], assumed: [] }))
  const r = run('done', '--run', dir, '--stage', '1.2-translate1')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /openQuestions/)
})

test('⑪ 主Agent 表单：空表不放行，逐项列出未填', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: true })
  run('step', '--run', dir)                    // 1.1 过，停在 1.2 并发空表
  assert.ok(existsSync(join(dir, 'forms', '1.2-translate1.json')), '应自动发空表')
  writeFileSync(join(dir, 'intent.draft1.json'), JSON.stringify({ restate: 'x', openQuestions: ['a', 'b', 'c'], assumed: ['y'] }))
  const r = run('done', '--run', dir, '--stage', '1.2-translate1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /表单未填/)
})

test('⑫ 主Agent 表单填全 → 放行', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: true })
  run('step', '--run', dir)
  writeFileSync(join(dir, 'intent.draft1.json'), JSON.stringify({ restate: 'x', openQuestions: ['a', 'b', 'c'], assumed: ['y'] }))
  const f = JSON.parse(readFileSync(join(dir, 'forms', '1.2-translate1.json'), 'utf8'))
  const vals = {
    restate: '复述', openQuestions: ['q1', 'q2', 'q3'], assumed: ['a1'],
    notInScope: ['n1'], metricHints: ['m1', 'm2']
  }
  for (const x of f.fields) x.value = vals[x.id]
  writeFileSync(join(dir, 'forms', '1.2-translate1.json'), JSON.stringify(f))
  const r = run('done', '--run', dir, '--stage', '1.2-translate1')
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /通过程序核对/)
})

test('⑬ userReview 开关打开 → 评审后多出「用户评审(human)」与「合并(manager)」两个节点', () => {
  const list = ids(makeRun({ research: 'low', maxRounds: 1, useCritic: true, userReview: true }))
  assert.ok(list.includes('2.4b-userreview-r1'), '缺用户评审节点')
  assert.ok(list.includes('2.4c-merge-r1'), '缺合并节点')
})

test('⑭ userReview 关（默认）→ 不出现这两个节点', () => {
  const list = ids(makeRun({ research: 'low', maxRounds: 1, useCritic: true }))
  assert.ok(!list.includes('2.4b-userreview-r1'))
  assert.ok(!list.includes('2.4c-merge-r1'))
})

test('⑮ 用户评审节点：step 返回 11（等人），没意见文件不放行', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: true, userReview: true })
  mkdirSync(join(dir, 'stages'), { recursive: true })
  const done = (id) => writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done', by: 'pipeline' }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1', '2.4-critique-r1']) done(id)
  const r = run('step', '--run', dir)
  assert.equal(r.status, 11, r.stdout)
  assert.match(r.stdout, /等待用户/)
  const d = run('done', '--run', dir, '--stage', '2.4b-userreview-r1')
  assert.equal(d.status, 1)
  assert.match(d.stdout, /user-review\.json/)
})

test('⑯ 合并节点：缺 conflicts / nextRoundOrders 不放行', () => {
  const dir = makeRun({ research: 'low', maxRounds: 1, useCritic: true, userReview: true })
  mkdirSync(join(dir, 'stages'), { recursive: true })
  const done = (id) => writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done', by: 'pipeline' }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1', '2.4-critique-r1']) done(id)
  writeFileSync(join(dir, 'user-review.json'), JSON.stringify({ by: '用户', shot: 'shots/a.png', comments: [{ point: '云是矩形', severity: 'high' }], verdict: '不合格' }))
  done('2.4b-userreview-r1')
  writeFileSync(join(dir, 'review.merged.json'), JSON.stringify({ fromCritic: [{ id: 'C1', pass: false }], fromUser: [{ point: '云是矩形' }] }))
  const r = run('done', '--run', dir, '--stage', '2.4c-merge-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /conflicts|nextRoundOrders/)
})
