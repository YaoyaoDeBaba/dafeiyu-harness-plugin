// pipeline-summary.test.mjs —— 3.1 交活时把「说过但没进工单」的吐槽列出来（待办 15 第二消费点）
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const OK = new Set([0, 10, 11])

function fixture(text) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-sum-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'tickets'), { recursive: true })
  mkdirSync(join(dir, 'forms'), { recursive: true })
  // research=low 只产生 1.3；关掉观察员/用户评审/补调研，节点表最小
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, userReview: false, resupply: false }))
  // 把所有阶段标 done，只留 3.1
  const ids = ['1.1-preflight','1.2-translate1','1.3-research-env','1.6-gate','1.7-absorb','1.8-translate2','1.9-confirm','1.10-translate3','2.1-plan-r1','2.2-exec-r1','2.3-verify-r1','2.5-decide-r1']
  for (const id of ids) writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ stage: '3.1-summarize', text }))
  writeFileSync(join(dir, 'user-interrupt.jsonl'),
    JSON.stringify({ at: '2026-11-17T09:00:00Z', stage: '2.2-exec-r1', text: '云还是像墨水', expired: false }) + '\n')
  return dir
}

const fillForm = (dir, stageId) => {
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

const cli = (dir, args) => {
  const r = spawnSync(process.execPath, [PIPE, ...args, '--run', dir], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SELFLOOP_STATE: join(dir, '.state'), DSH_SELFLOOP_NO_POINTER: '1' },
  })
  const out = (r.stdout || '') + (r.stderr || '')
  if (!OK.has(r.status)) throw new Error('pipeline 异常退出 ' + r.status + '：' + out)
  return out
}

test('总结没提到那条吐槽 → 列进 unhandledInterrupts', () => {
  const dir = fixture('本轮跑完了，云仍然不合格。')
  cli(dir, ['step'])
  fillForm(dir, '3.1-summarize')
  cli(dir, ['done', '--stage', '3.1-summarize'])
  const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
  assert.equal((s.unhandledInterrupts || []).length, 1)
  assert.match(s.unhandledInterrupts[0].text, /云还是像墨水/)
})

test('总结已经提到 → 不重复列', () => {
  const dir = fixture('云还是像墨水，这条已经写进总结了。')
  cli(dir, ['step'])
  fillForm(dir, '3.1-summarize')
  cli(dir, ['done', '--stage', '3.1-summarize'])
  const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
  assert.equal((s.unhandledInterrupts || []).length, 0)
})
