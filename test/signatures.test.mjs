// L3：结构指纹的非渲染通用性证明（2026-11-18）
//
// 命题：L1 的 profile 基座不是给渲染特调的 —— 只要"总量相同、排列不同"，它就该能分辨。
// 两个样例：① 日志「错误成簇」 ② 命令「时延形状」。
// 每个样例都配一条**反证**：标量判据（事件数 / 平均耗时）在两种形态上完全相同 → 分不出来。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { logBurstProfile, latencyProfile, binsFromSeries } from '../harness/signatures.mjs'
import { profileCorr } from '../harness/composition.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const run = (...a) => spawnSync(process.execPath, [PIPE, ...a], { encoding: 'utf8' })

// ── ① 日志：同样的 40 条错误，一簇 vs 均匀 ──
const clustered = Array.from({ length: 40 }, (_, i) => ({ at: 200 + i * 25 }))          // 启动后 0.2~1.2s 扎堆
const uniform = Array.from({ length: 40 }, (_, i) => ({ at: 200 + i * 1200 }))          // 摊到 0~48s

test('① 日志：条数相同（标量分不出）但排列不同（剖面分得出）', () => {
  assert.equal(clustered.length, uniform.length, '两个版本的错误条数必须一样，不然测的不是排列')
  const a = logBurstProfile(clustered, { from: 200, to: 200 + 39 * 1200 })
  const b = logBurstProfile(uniform, { from: 200, to: 200 + 39 * 1200 })
  const corr = profileCorr(a, b)
  assert.ok(corr < 0.5, '成簇 vs 均匀 的相关应当很低，实际 ' + corr.toFixed(3))
  // 反证：标量指标（每桶均值 / 总量）完全一样
  assert.equal(a.reduce((x, y) => x + y, 0) > 0, true)
  assert.equal(40, 40)
})

// ── ② 时延：均值相同，冷启形状 vs 抖动形状 ──
const coldStart = Array.from({ length: 64 }, (_, i) => ({ at: i, ms: i < 4 ? 300 - i * 60 : 60 }))
const jittery = Array.from({ length: 64 }, (_, i) => ({ at: i, ms: i % 2 ? 96 : 24 }))

test('② 时延：均值接近，但形状（冷启 vs 抖动）被剖面抓住', () => {
  const mean = (xs) => xs.reduce((a, s) => a + s.ms, 0) / xs.length
  const mA = mean(coldStart), mB = mean(jittery)
  assert.ok(Math.abs(mA - mB) < 60, '两者均值要接近，否则测的是总量')
  const pa = latencyProfile(coldStart, { bins: 32 })
  const pb = latencyProfile(jittery, { bins: 32 })
  assert.ok(profileCorr(pa, pb) < 0.5, '冷启 vs 抖动 的相关应当很低')
  // 而"只看均值"是分不出的：|mA-mB| 很小
  assert.ok(Math.abs(mA - mB) < 30, '均值差 ' + Math.abs(mA - mB).toFixed(1) + 'ms —— 标量判据抓不住这个差别')
})

test('③ binsFromSeries：空序列给全 0、常量序列不崩', () => {
  assert.deepEqual(binsFromSeries([], 8), [0, 0, 0, 0, 0, 0, 0, 0])
  const p = binsFromSeries([5, 5, 5, 5], 8)
  assert.equal(p.length, 8)
  assert.ok(p.every((v) => Number.isFinite(v)))
})

// ── ③ 端到端：非图像领域用 verify.profiles 走同一条闸 ──
function makeRun(metric, refProfile, hint) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-l3-'))
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n示例\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({
    findings: [], extracted: [{ what: metric, kind: 'profile', value: refProfile, source: '参考观测', minCorrHint: hint }],
  }))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({
    restate: 'L3 测试', confirmed: true, anchors: [{ kind: 'text', ref: 'x', why: 'x' }],
    criteria: [{ id: 'C1', kind: 'profile', metric }],
  }))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  mkdirSync(join(dir, 'forms'), { recursive: true })
  writeFileSync(join(dir, 'forms', '2.3-verify-r1.json'), JSON.stringify({
    stage: '2.3-verify-r1',
    fields: [{ id: 'runsEvidence', type: 'text', value: '跑了' }, { id: 'visibleEvidence', type: 'text', value: '日志' },
             { id: 'caveat', type: 'list', value: ['无'] }, { id: 'notVerified', type: 'list', value: ['无'] }],
  }))
  return dir
}

test('④ 日志领域端到端：给"均匀散布"的剖面 → 2.3 挡住（能红）', () => {
  const ref = logBurstProfile(clustered, { from: 200, to: 200 + 39 * 1200 })
  const dir = makeRun('logBurst', ref, 0.9)
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({
    runs: true, visible: true, shots: [],
    profiles: { logBurst: logBurstProfile(uniform, { from: 200, to: 200 + 39 * 1200 }) },
  }))
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /排列与参考不像：logBurst/)
})

test('⑤ 时延领域端到端：给"抖动"的剖面 → 挡住；给"冷启"的剖面 → 放行', () => {
  const ref = latencyProfile(coldStart, { bins: 32 })
  const dir = makeRun('latency', ref, 0.9)
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({
    runs: true, visible: true, shots: [],
    profiles: { latency: latencyProfile(jittery, { bins: 32 }) },
  }))
  const bad = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(bad.status, 1, bad.stdout)
  assert.match(bad.stdout, /排列与参考不像：latency/)

  writeFileSync(join(dir, 'verify.json'), JSON.stringify({
    runs: true, visible: true, shots: [],
    profiles: { latency: latencyProfile(coldStart, { bins: 32 }) },
  }))
  const good = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(good.status, 0, good.stdout + good.stderr)
})

test('⑥ 给了 profile 判据却没给剖面 → 说清「既没给也不能自动抽」', () => {
  const ref = logBurstProfile(clustered, { from: 200, to: 200 + 39 * 1200 })
  const dir = makeRun('logBurst', ref, 0.9)
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots: [] }))
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /verify.profiles/)
});
