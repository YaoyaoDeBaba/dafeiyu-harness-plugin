// pipeline 自测（0.20.0）：流程由程序控制——上游没信号，下游不许启动。
//
// 这条测的就是用户点出来的那件事：把流程写进 skill 挡不住人，必须让程序持有流程。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const PRE = join(ROOT, 'harness', 'preflight.mjs')
const ICON = join(ROOT, 'icon.png')

const pipe = (...a) => spawnSync(process.execPath, [PIPE, ...a], { encoding: 'utf8' })
const pre = (...a) => spawnSync(process.execPath, [PRE, ...a], { encoding: 'utf8' })

test('① 空目录：step 拒绝（缺 research.json），不下发任何票', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-pipe-empty-'))
  const r = pipe('step', '--run', dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /前置未满足/)
  assert.ok(!existsSync(join(dir, 'tickets', 'research.json')))
})

test('② preflight 过后：step 出 research 票并 exit 10（等 agent）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-pipe-research-'))
  pre('--run', dir, '--ref', ICON)
  const r = pipe('step', '--run', dir)
  assert.equal(r.status, 10, r.stdout + r.stderr)
  const ticket = JSON.parse(readFileSync(join(dir, 'tickets', 'research.json'), 'utf8'))
  assert.equal(ticket.stage, 'research')
  assert.match(ticket.prompt, /不许改工程代码/)
})

test('③ 调研不合格（没有外部来源）→ done 卡住，信号记 failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-pipe-badresearch-'))
  pre('--run', dir, '--ref', ICON)
  pipe('step', '--run', dir)
  const r = pipe('done', '--run', dir, '--stage', 'research')
  assert.equal(r.status, 1)
  const sig = JSON.parse(readFileSync(join(dir, 'stages', 'research.json'), 'utf8'))
  assert.equal(sig.status, 'failed')
  assert.ok(sig.problems.length > 0)
})

test('④ 调研合格 → done 放行 → 下一节点是 intent（再 step 出 intent 票）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-pipe-ok-'))
  pre('--run', dir, '--ref', ICON)
  pipe('step', '--run', dir)
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  rj.findings = [
    { title: 'A', url: 'https://github.com/a/b', kind: 'opensource', used: true, usedFor: '改了阈值' },
    { title: 'B', url: 'https://example.com/b', kind: 'article', used: false }
  ]
  writeFileSync(join(dir, 'research.json'), JSON.stringify(rj))
  const d = pipe('done', '--run', dir, '--stage', 'research')
  assert.equal(d.status, 0, d.stdout + d.stderr)
  assert.match(d.stdout, /下一个节点：intent/)
  const st = pipe('step', '--run', dir)
  assert.equal(st.status, 10)
  assert.ok(existsSync(join(dir, 'tickets', 'intent.json')))
})

test('⑤ intent 没 confirmed → done 卡住；confirmed 后才放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-pipe-intent-'))
  pre('--run', dir, '--ref', ICON)
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  rj.findings = [
    { title: 'A', url: 'https://github.com/a/b', kind: 'opensource', used: true, usedFor: 'x' },
    { title: 'B', url: 'https://example.com/b', kind: 'article' }
  ]
  writeFileSync(join(dir, 'research.json'), JSON.stringify(rj))
  pipe('step', '--run', dir)
  pipe('done', '--run', dir, '--stage', 'research')
  pipe('step', '--run', dir)
  // 只写半份 intent
  const intent = JSON.parse(readFileSync(join(dir, 'intent.json'), 'utf8'))
  intent.restate = '复述'; intent.anchors = [{ kind: 'image', ref: ICON, why: 'x' }]
  intent.criteria = [{ id: 'cov', anchor: 'a', userWords: 'b', howMeasured: 'c', weight: 1 }]
  intent.confirmed = false
  writeFileSync(join(dir, 'intent.json'), JSON.stringify(intent))
  const bad = pipe('done', '--run', dir, '--stage', 'intent')
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /confirmed/)
  intent.confirmed = true
  writeFileSync(join(dir, 'intent.json'), JSON.stringify(intent))
  const ok = pipe('done', '--run', dir, '--stage', 'intent')
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /下一个节点：implement/)
})
