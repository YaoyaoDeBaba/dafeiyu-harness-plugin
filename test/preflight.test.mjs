// preflight 自测（0.18.0）：开工检查必须"铺跑道 + 说清下一步"，不能静默放行。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'harness', 'preflight.mjs')
const ICON = join(ROOT, 'icon.png')

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

test('① 缺参数 → exit 2', () => {
  const r = run()
  assert.equal(r.status, 2)
  assert.match(r.stderr, /用法/)
})

test('② --run + --ref：建骨架、量参考写进 extracted、因未调研而 exit 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-preflight-'))
  const r = run('--run', dir, '--ref', ICON)
  assert.equal(r.status, 3, r.stdout + r.stderr)
  for (const d of ['refs', 'rounds', 'shots']) assert.ok(existsSync(join(dir, d)), '要建出 ' + d)
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  assert.ok(rj.extracted.length > 0, '要自动写入量测结果')
  const intent = JSON.parse(readFileSync(join(dir, 'intent.json'), 'utf8'))
  assert.equal(intent.confirmed, false)
  assert.match(r.stdout, /派调查员/)
})

test('③ 调研齐 + intent 确认 → exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-preflight-ok-'))
  run('--run', dir, '--ref', ICON)
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  rj.findings = [
    { title: 'A', url: 'https://github.com/a/b', kind: 'opensource', used: true, usedFor: '改了阈值' },
    { title: 'B', url: 'https://example.com/b', kind: 'article', used: false }
  ]
  writeFileSync(join(dir, 'research.json'), JSON.stringify(rj))
  const intent = JSON.parse(readFileSync(join(dir, 'intent.json'), 'utf8'))
  intent.restate = 'x'; intent.anchors = [{ kind: 'image', ref: ICON, why: 'y' }]
  intent.criteria = [{ id: 'cov', anchor: 'a', userWords: 'b', howMeasured: 'c', weight: 1 }]
  intent.confirmed = true
  writeFileSync(join(dir, 'intent.json'), JSON.stringify(intent))
  const r = run('--run', dir, '--ref', ICON)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /可以开工/)
})
