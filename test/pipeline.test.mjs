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
