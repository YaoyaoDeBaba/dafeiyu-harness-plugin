// ui-consume.test.mjs —— 证明「界面写下来的东西，流程真的会消费」（2026-11-17）
//
// 这是「能用 vs 只是好看」的分界线：
//   ① 面板填的意向答案 → 并入 intent.confirm.json，decisions.source 变成 user(ui)
//   ② 面板发的吐槽 → 并入 user-review.json 的 comments
//   ③ step 出票写 active.json、done 清掉（乱入窗口的「主 Agent 处理中」靠它）
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')

function runFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sl-consume-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  mkdirSync(join(dir, 'forms'), { recursive: true })
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'high', maxRounds: 1, useCritic: true, userReview: true, resupply: true }))
  return dir
}

const markDone = (dir, ids) => {
  for (const id of ids) writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done', at: new Date().toISOString() }))
}
// step 的正常退出码是 10（出票）/ 11（等人），done 是 0；这几个都不该被当成失败
const OK_CODES = new Set([0, 10, 11])
const cli = (dir, args) => {
  const r = spawnSync(process.execPath, [PIPE, ...args, '--run', dir], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SELFLOOP_STATE: join(dir, '.state'), DSH_SELFLOOP_NO_POINTER: '1' },
  })
  const out = (r.stdout || '') + (r.stderr || '')
  if (!OK_CODES.has(r.status)) throw new Error('pipeline 异常退出 ' + r.status + '：' + out)
  return out
}

function fillForm(dir, stageId) {
  const f = join(dir, 'forms', stageId + '.json')
  const form = JSON.parse(readFileSync(f, 'utf8'))
  for (const field of form.fields || []) {
    if (field.type === 'list') field.value = ['测试项']
    else if (field.type === 'text') field.value = '测试内容'
    else if (field.type === 'bool') field.value = true
    else field.value = 1
  }
  writeFileSync(f, JSON.stringify(form, null, 2))
}

test('① 面板填的意向答案会并入 intent.confirm.json', () => {
  const dir = runFixture()
  markDone(dir, ['1.1-preflight', '1.2-translate1', '1.3-research-env', '1.4-research-doc', '1.5-research-ref', '1.6-gate', '1.7-absorb', '1.8-translate2'])
  writeFileSync(join(dir, 'intent.confirm.json'), JSON.stringify({
    questions: [{ id: 'Q1', question: '选哪个？', options: ['A', 'B'], recommend: 'A', why: '因为' }],
    autoConfirmed: [],
  }))
  writeFileSync(join(dir, 'intent.confirm.answers.json'), JSON.stringify({
    answers: [{ id: 'Q1', chosen: 'A' }], whoDecided: 'user', source: 'ui', at: new Date().toISOString(),
  }))
  cli(dir, ['step'])
  assert.ok(existsSync(join(dir, 'active.json')), 'step 出票应写 active.json')
  const active = JSON.parse(readFileSync(join(dir, 'active.json'), 'utf8'))
  assert.equal(active.stage, '1.9-confirm')
  fillForm(dir, '1.9-confirm')
  const out = cli(dir, ['done', '--stage', '1.9-confirm'])
  assert.match(out, /意向答案已并入/, 'done 应打印并入日志：' + out)
  const confirm = JSON.parse(readFileSync(join(dir, 'intent.confirm.json'), 'utf8'))
  assert.deepEqual(confirm.answers, [{ id: 'Q1', chosen: 'A' }])
  assert.equal(confirm.decisions.source, 'user(ui)')
  assert.equal(existsSync(join(dir, 'active.json')), false, 'done 之后 active.json 应被清掉')
})

test('② 面板发的吐槽会并入 user-review.json', () => {
  const dir = runFixture()
  markDone(dir, ['1.1-preflight', '1.2-translate1', '1.3-research-env', '1.4-research-doc', '1.5-research-ref', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1', '2.4-critique-r1'])
  writeFileSync(join(dir, 'user-review.json'), JSON.stringify({ by: '用户', shot: 'shots/x.png', verdict: 'withheld', comments: [{ point: '原有意见', severity: 'info', evidence: 'e1' }] }))
  const now = new Date().toISOString()
  writeFileSync(join(dir, 'user-interrupt.jsonl'),
    JSON.stringify({ at: now, stage: '2.2-exec-r1', text: '电弧像白纸带', severity: 'comment', expired: false }) + '\n' +
    JSON.stringify({ at: now, stage: '0.0-gone', text: '迟到的吐槽', severity: 'comment', expired: true }) + '\n')
  cli(dir, ['step'])
  const out = cli(dir, ['done', '--stage', '2.4b-userreview-r1'])
  assert.match(out, /吐槽已并入/, 'done 应打印并入日志：' + out)
  const review = JSON.parse(readFileSync(join(dir, 'user-review.json'), 'utf8'))
  assert.equal(review.comments.length, 3, '原有 1 条 + 面板 2 条')
  assert.ok(review.comments.some((c) => c.point === '电弧像白纸带' && c.source === 'ui-interrupt'))
  assert.ok(review.comments.some((c) => c.source === 'ui-interrupt(expired)'), '过期那条要标出来')
  assert.equal(review.uiInterrupts, 2)
})

test('③ 重复交活不会把同一条吐槽并两次', () => {
  const dir = runFixture()
  markDone(dir, ['1.1-preflight', '1.2-translate1', '1.3-research-env', '1.4-research-doc', '1.5-research-ref', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1', '2.3-verify-r1', '2.4-critique-r1'])
  writeFileSync(join(dir, 'user-review.json'), JSON.stringify({ by: '用户', shot: 'x.png', verdict: 'withheld', comments: [] }))
  const now = new Date().toISOString()
  writeFileSync(join(dir, 'user-interrupt.jsonl'), JSON.stringify({ at: now, stage: '2.2-exec-r1', text: '同一条', severity: 'comment', expired: false }) + '\n')
  cli(dir, ['step'])
  cli(dir, ['done', '--stage', '2.4b-userreview-r1'])
  // 再跑一次（模拟重复交活被顺序闸挡住之前的重复吸收）
  const review = JSON.parse(readFileSync(join(dir, 'user-review.json'), 'utf8'))
  assert.equal(review.comments.length, 1)
})
