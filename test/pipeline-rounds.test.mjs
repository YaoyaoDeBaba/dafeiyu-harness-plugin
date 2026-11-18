// pipeline-rounds.test.mjs —— 每轮归档 + 吐槽必须被消费（2026-11-17，待办 15）
//
// 判据三件事：
//   ① 跑 done --stage 2.1-plan-r1 后应出现 rounds/r1/plan.json（每轮同名产物不再互相覆盖）
//   ② 2.5-decide 交活时把还没消费的吐槽并进 decide.gapsForNextRound（去重按前 8 字 + 相似度）
//   ③ checks.decided：jsonl 有条目但 decide 里没出现 → 不放行
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blankForm } from '../harness/forms.mjs'
import { checks, sameComplaint, unconsumedInterrupts } from '../harness/pipeline.mjs'

const ROOT = join(import.meta.dirname, '..')
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const OK_CODES = new Set([0, 10, 11])

function fixture(budget) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-rounds-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  mkdirSync(join(dir, 'forms'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n\n把雷云的电弧做得像参考片那样自然\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify(Object.assign({ research: 'low', maxRounds: 2, useCritic: true, userReview: true, resupply: true }, budget || {})))
  return dir
}

const markDone = (dir, ids) => {
  for (const id of ids) writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done', at: new Date().toISOString() }))
}

const cli = (dir, args) => {
  const r = spawnSync(process.execPath, [PIPE, ...args, '--run', dir], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SELFLOOP_STATE: join(dir, '.state'), DSH_SELFLOOP_NO_POINTER: '1' },
  })
  const out = (r.stdout || '') + (r.stderr || '')
  if (!OK_CODES.has(r.status)) throw new Error('pipeline 异常退出 ' + r.status + '：' + out)
  return out
}

/** 主 Agent 的表单必办事项：按空表把每项填上（否则 done 会卡在表单上）。 */
function fillForm(dir, stageId) {
  // 表单按「基名」定义（2.5-decide / 2.1-plan），节点 id 带轮次后缀
  const form = blankForm(String(stageId).replace(/-r\d+$/, ''))
  assert.ok(form, stageId + ' 没有表单定义')
  for (const f of form.fields) {
    if (f.type === 'list') f.value = ['测试项']
    else if (f.type === 'enum') f.value = f.options[0]
    else if (f.type === 'bool') f.value = true
    else if (f.type === 'number') f.value = 1
    else f.value = '测试内容'
  }
  writeFileSync(join(dir, 'forms', stageId + '.json'), JSON.stringify(form, null, 2))
}

const PHASE1_LOW = ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3']

test('① 2.1-plan-r1 交活后出现 rounds/r1/plan.json', () => {
  // 2026-11-18：2.1 现在还要过活性扫描闸；本用例只测归档，用 probe:false 跳过
  const dir = fixture({ maxRounds: 1, probe: false })
  markDone(dir, PHASE1_LOW)
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ round: 1, orders: [{ id: 'A', task: '改云生成' }], executor: { model: 'deepseek-v4-pro' } }))
  fillForm(dir, '2.1-plan-r1')
  const out = cli(dir, ['done', '--stage', '2.1-plan-r1'])
  assert.match(out, /2\.1-plan-r1 通过程序核对/)
  const archived = join(dir, 'rounds', 'r1', 'plan.json')
  assert.ok(existsSync(archived), '缺 rounds/r1/plan.json：' + out)
  assert.deepEqual(JSON.parse(readFileSync(archived, 'utf8')).orders, [{ id: 'A', task: '改云生成' }])
  // 同名文件每轮覆盖 → 归档必须留得住历史
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ round: 2, orders: [{ id: 'B', task: '压亮度' }], executor: { model: 'deepseek-v4-pro' } }))
  markDone(dir, ['2.2-exec-r1', '2.3-verify-r1', '2.4-critique-r1', '2.4b-userreview-r1'])
  writeFileSync(join(dir, 'decide.json'), JSON.stringify({ action: 'stop' }))
  // 2026-11-18：轮次节点的表单开始真正校验了（之前按带后缀的 id 查表永远查不到，等于没校验）
  fillForm(dir, '2.5-decide-r1')
  cli(dir, ['done', '--stage', '2.5-decide-r1'])
  assert.deepEqual(JSON.parse(readFileSync(archived, 'utf8')).orders, [{ id: 'A', task: '改云生成' }], '第 1 轮归档不许被后来的 plan.json 覆盖')
})

test('② 2.5-decide 交活：未消费的吐槽并进 gapsForNextRound，重复的只算一条', () => {
  const dir = fixture({ maxRounds: 2 })
  markDone(dir, PHASE1_LOW)
  markDone(dir, ['2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1', '2.4-critique-r1', '2.4b-userreview-r1'])
  const t = '2026-11-17T01:00:00Z'
  const t2 = '2026-11-17T02:00:00Z'
  writeFileSync(join(dir, 'user-interrupt.jsonl'), [
    JSON.stringify({ at: t, stage: '2.2-exec-r1', text: '电弧边缘太亮', severity: 'comment', expired: false }),
    // 同一句、不同时间 → 老办法（at+text 做键）会并两次，新办法按前 8 字/相似度只算一条
    JSON.stringify({ at: t2, stage: '2.2-exec-r1', text: '电弧边缘太亮了', severity: 'comment', expired: false }),
    JSON.stringify({ at: t, stage: '2.2-exec-r1', text: '云的颜色偏灰', severity: 'comment', expired: true }),
  ].join('\n') + '\n')
  writeFileSync(join(dir, 'decide.json'), JSON.stringify({ action: 'next', nextRoundOrders: [{ id: 'B', task: '压电弧亮度' }] }))
  fillForm(dir, '2.5-decide-r1')
  const out = cli(dir, ['done', '--stage', '2.5-decide-r1'])
  assert.match(out, /面板吐槽已并入 decide\.gapsForNextRound（2 条）/, out)
  const decide = JSON.parse(readFileSync(join(dir, 'decide.json'), 'utf8'))
  assert.equal(decide.gapsForNextRound.length, 2, JSON.stringify(decide.gapsForNextRound))
  assert.equal(decide.gapsForNextRound[0], '电弧边缘太亮')
  assert.equal(decide.gapsForNextRound[1], '云的颜色偏灰', '过期的那条也要留下来：用户说过的话不能消失')
  assert.equal(decide.uiInterrupts, 2)
  assert.equal(decide.action, 'next')
  // 归档里也是并过之后的版本（UI 按轮读的是它）
  const archived = JSON.parse(readFileSync(join(dir, 'rounds', 'r1', 'decide.json'), 'utf8'))
  assert.equal(archived.gapsForNextRound.length, 2)
})

test('②b 已经进过 decide 的吐槽不会重复并入', () => {
  const dir = fixture({ maxRounds: 1 })
  markDone(dir, PHASE1_LOW)
  markDone(dir, ['2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1', '2.4-critique-r1', '2.4b-userreview-r1'])
  writeFileSync(join(dir, 'user-interrupt.jsonl'), JSON.stringify({ at: 'x', stage: '2.2-exec-r1', text: '电弧边缘太亮' }) + '\n')
  writeFileSync(join(dir, 'decide.json'), JSON.stringify({ action: 'stop', gapsForNextRound: ['电弧边缘太亮（用户原话）'] }))
  fillForm(dir, '2.5-decide-r1')
  cli(dir, ['done', '--stage', '2.5-decide-r1'])
  const decide = JSON.parse(readFileSync(join(dir, 'decide.json'), 'utf8'))
  assert.equal(decide.gapsForNextRound.length, 1, '已经在 decide 里出现过的，不许再加一条')
})

test('③ checks.decided：jsonl 有条目但 decide 里没出现 → 不放行', () => {
  const dir = fixture({ maxRounds: 1 })
  writeFileSync(join(dir, 'user-interrupt.jsonl'), JSON.stringify({ at: 'x', stage: '2.2-exec-r1', text: '电弧像纸带' }) + '\n')
  writeFileSync(join(dir, 'decide.json'), JSON.stringify({ action: 'stop', why: '收敛了' }))
  const problems = checks.decided(dir)
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /面板吐槽/)
  assert.match(problems[0], /电弧像纸带/)

  // 进了任意字段（哪怕是 nextRoundOrders 里的任务描述）就放行
  writeFileSync(join(dir, 'decide.json'), JSON.stringify({ action: 'stop', nextRoundOrders: [{ id: 'A', task: '电弧像纸带 → 改成细丝' }] }))
  assert.deepEqual(checks.decided(dir), [])
})

test('④ sameComplaint / unconsumedInterrupts：按前 8 字 + 相似度，不看 at+text', () => {
  assert.equal(sameComplaint('电弧像纸带', '电弧像纸带。'), true)
  assert.equal(sameComplaint('电弧边缘太亮', '电弧边缘太亮了'), true, '前 8 字相近 + 高相似度 → 同一条')
  assert.equal(sameComplaint('电弧太亮', '云太灰了'), false)
  assert.equal(sameComplaint('', '电弧'), false)
  // 前 8 字完全相同就算同一条（用户复述同一件事，标点/尾巴可能不一样）
  assert.equal(sameComplaint('一二三四五六七八九十甲', '一二三四五六七八九十乙'), true)

  const dir = fixture({ maxRounds: 1 })
  writeFileSync(join(dir, 'user-interrupt.jsonl'), [
    JSON.stringify({ at: 'a', text: 'a1' }),
    JSON.stringify({ at: 'b', text: '把云的底色压冷' }),
    JSON.stringify({ at: 'c' }), // 没有 text 的记录：跳过，不许当成「未消费」卡住流程
    '{ 这不是 json',
  ].join('\n'))
  const pending = unconsumedInterrupts(dir, { action: 'stop', why: '把云的底色压冷一点' })
  assert.equal(pending.length, 1, JSON.stringify(pending))
  assert.equal(pending[0].text, 'a1')
})

test('⑤ 2.4b 那条老钩子仍在（两个消费点并存）', () => {
  const dir = fixture({ maxRounds: 1 })
  markDone(dir, PHASE1_LOW)
  markDone(dir, ['2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1', '2.4-critique-r1'])
  writeFileSync(join(dir, 'user-review.json'), JSON.stringify({ by: '用户', shot: 'shots/x.png', verdict: 'withheld', comments: [] }))
  writeFileSync(join(dir, 'user-interrupt.jsonl'), JSON.stringify({ at: 'x', stage: '2.2-exec-r1', text: '电弧像纸带' }) + '\n')
  cli(dir, ['done', '--stage', '2.4b-userreview-r1'])
  const review = JSON.parse(readFileSync(join(dir, 'user-review.json'), 'utf8'))
  assert.equal(review.comments.length, 1)
  assert.equal(review.comments[0].source.startsWith('ui-interrupt'), true)
})
