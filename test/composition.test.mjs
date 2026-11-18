// 结构指纹（L1 基座 + L2 图像实现）自测（2026-11-18）
// 判据：① 剖面/相关性的纯函数行为；② preflight 会写 profile 型 extracted + 结构标量；
//      ③ 2.3-verify 在 profile 判据不达标时**真的挡**，达标时放行（闸门要能红能绿）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readFileSync as readB } from 'node:fs'
import { decodePng } from '../harness/ref-probe.mjs'
import { profileFromFile, profileCorr, medianProfile, calibrateMinCorr, scalarsFromFile, speckleRatio, foamComponents, rowProfile } from '../harness/composition.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const PRE = join(ROOT, 'harness', 'preflight.mjs')
const ICON = join(ROOT, 'icon.png')

// ── 极简 PNG 编码（只给测试造夹具；8bit RGB、filter 0）──
import { deflateSync } from 'node:zlib'
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(h * (w * 3 + 1))
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
/** 合成一张「上半亮、下半暗」的测试帧（有结构、不是纯色 → 崩坏自检能过） */
function syntheticFrame(w = 64, h = 64) {
  const rgb = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inBand = y > h * 0.12 && y < h * 0.52
      const v = inBand ? 150 + ((x * 7 + y * 3) % 40) : 40 + ((x * 5 + y * 9) % 25)
      const i = (y * w + x) * 3
      rgb[i] = v; rgb[i + 1] = v + 6; rgb[i + 2] = v + 14
    }
  }
  return encodePng(w, h, rgb)
}

const run = (...a) => spawnSync(process.execPath, [PIPE, ...a], { encoding: 'utf8' })
const pre = (...a) => spawnSync(process.execPath, [PRE, ...a], { encoding: 'utf8' })

test('① profileCorr：相同=1，反向=-1，常量=0', () => {
  const a = [0, 1, 2, 3, 4, 5, 6, 7]
  assert.ok(Math.abs(profileCorr(a, a) - 1) < 1e-9)
  assert.ok(Math.abs(profileCorr(a, a.slice().reverse()) + 1) < 1e-9)
  assert.equal(profileCorr(a, a.map(() => 3)), 0, '常量序列不算匹配')
  assert.equal(profileCorr([1, 2], [1, 2]), 0, '样本太少返回 0')
})

test('② rowProfile：64 桶、值域 0~1、且能读出「上亮下暗」的结构', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-comp-img-'))
  const f = join(dir, 'syn.png')
  writeFileSync(f, syntheticFrame())
  const p = profileFromFile(f, 64)
  assert.equal(p.length, 64)
  assert.ok(p.every((v) => v >= 0 && v <= 1), '桶值要归一')
  const upper = p.slice(8, 30).reduce((a, b) => a + b, 0) / 22
  const lower = p.slice(40, 62).reduce((a, b) => a + b, 0) / 22
  assert.ok(upper > lower + 0.2, '上半应明显更「实」：upper=' + upper.toFixed(3) + ' lower=' + lower.toFixed(3))
})

test('③ medianProfile：逐桶取中位', () => {
  const m = medianProfile([[0, 10], [2, 20], [4, 30]])
  assert.deepEqual(m, [2, 20])
})

function makeRun() {
  const dir = mkdtempSync(join(tmpdir(), 'sl-comp-'))
  mkdirSync(join(dir, 'refs'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n示例\n')
  writeFileSync(join(dir, 'refs', 'ref.png'), syntheticFrame())
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false }))
  pre('--run', dir, '--ref', join(dir, 'refs'))
  return dir
}

test('④ preflight 写出 profile 型 extracted 与结构标量', () => {
  const dir = makeRun()
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  const prof = rj.extracted.find((e) => e.what === 'rowProfile')
  assert.ok(prof, '缺 rowProfile：' + rj.extracted.map((e) => e.what).join(','))
  assert.equal(prof.kind, 'profile')
  assert.equal(prof.value.length, 64)
  for (const k of ['centroidY', 'topCoverage', 'skyExposure', 'bboxAspect']) {
    const e = rj.extracted.find((x) => x.what === k)
    assert.ok(e && Number.isFinite(Number(e.value)), '缺结构标量 ' + k)
  }
})

function reachedVerify(dir, minCorr, refProfile) {
  mkdirSync(join(dir, 'stages'), { recursive: true })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done', by: 'pipeline' }))
  }
  const rjPath = join(dir, 'research.json')
  const rj = JSON.parse(readFileSync(rjPath, 'utf8'))
  const prof = rj.extracted.find((e) => e.what === 'rowProfile')
  prof.value = refProfile
  writeFileSync(rjPath, JSON.stringify(rj, null, 2))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({
    restate: '测试', confirmed: true, anchors: [{ kind: 'text', ref: 'icon', why: 'x' }],
    criteria: [{ id: 'C1', kind: 'profile', metric: 'rowProfile', ...(minCorr === undefined ? {} : { minCorr }) }],
  }))
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots: ['refs/ref.png'] }))
  mkdirSync(join(dir, 'forms'), { recursive: true })
  writeFileSync(join(dir, 'forms', '2.3-verify-r1.json'), JSON.stringify({
    stage: '2.3-verify-r1',
    fields: [
      { id: 'runsEvidence', type: 'text', value: 'node 起页面并抓帧 exit 0' },
      { id: 'visibleEvidence', type: 'text', value: 'refs/ref.png' },
      { id: 'caveat', type: 'list', value: ['无'] },
      { id: 'notVerified', type: 'list', value: ['未验动态'] },
    ],
  }))
  return dir
}

test('⑤ 结构指纹不达标 → 2.3-verify 挡住（能红）', () => {
  const dir = makeRun()
  const actual = profileFromFile(join(dir, 'refs', 'ref.png'), 64)
  const wrong = actual.slice().reverse()   // 剖面完全反向 = 构图不是一回事
  reachedVerify(dir, 0.9, wrong)
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /排列与参考不像/)
  assert.match(r.stdout, /rowProfile 相关 -?[0-9.]+ < 下限 0.9/)
})

test('⑥ 结构指纹达标 → 放行（能绿）', () => {
  const dir = makeRun()
  const actual = profileFromFile(join(dir, 'refs', 'ref.png'), 64)
  reachedVerify(dir, 0.9, actual)
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('⑦ profile 判据缺 minCorr → 1.10 挡住并说清', () => {
  const dir = makeRun()
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({
    restate: '测试', confirmed: true, anchors: [{ kind: 'text', ref: 'icon', why: 'x' }],
    criteria: [{ id: 'C1', kind: 'profile', metric: 'rowProfile' }],
  }))
  // 1.10 有必填表单
  run('step', '--run', dir)
  const fp = join(dir, 'forms', '1.10-translate3.json')
  if (existsSync(fp)) {
    const f = JSON.parse(readFileSync(fp, 'utf8'))
    for (const x of f.fields) x.value = x.type === 'list' ? ['x'] : 'x'
    writeFileSync(fp, JSON.stringify(f))
  }
  const r = run('done', '--run', dir, '--stage', '1.10-translate3')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /minCorr/)
})


// ───────── 阈值来自分布（留一法校准）─────────
test('⑧ calibrateMinCorr：同族剖面 → 建议值高；互相不相关 → 建议值贴近下限 0.5', () => {
  const base = Array.from({ length: 32 }, (_, i) => Math.sin(i / 3) * 0.2 + 0.4)
  const near = [base, base.map((v, i) => v + (i % 2 ? 0.01 : -0.01)), base.map((v, i) => v + (i % 3 ? 0.005 : -0.005))]
  const good = calibrateMinCorr(near)
  assert.ok(good && good.suggested >= 0.9, '同族应给出 ≥0.9 的建议：' + JSON.stringify(good))

  const rnd = (seed) => Array.from({ length: 32 }, (_, i) => Math.sin((i * i + seed * 13) / 1.7) * 0.5 + 0.5)
  const bad = calibrateMinCorr([rnd(1), rnd(2), rnd(3)])
  assert.ok(bad && bad.suggested <= 0.6, '互不相关应贴近下限：' + JSON.stringify(bad))
  assert.equal(calibrateMinCorr([base, base]), null, '少于 3 帧不算')
})

test('⑨ preflight：≥3 帧时写 minCorrHint + loo，并打印建议值', () => {
  const dir = makeRun()
  for (const n of ['b.png', 'c.png']) writeFileSync(join(dir, 'refs', n), syntheticFrame(64, 64))
  const out = pre('--run', dir, '--ref', join(dir, 'refs'))
  assert.match(out.stdout + out.stderr, /minCorr 建议/)
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  const prof = rj.extracted.find((e) => e.what === 'rowProfile')
  assert.ok(Number.isFinite(prof.minCorrHint), '缺 minCorrHint：' + JSON.stringify(prof).slice(0, 200))
  assert.ok(prof.loo && Number.isFinite(prof.loo.min), '缺 loo 分布')
})

test('⑩ profile 判据不写 minCorr → 自动用留一法建议值（能过）', () => {
  const dir = makeRun()
  for (const n of ['b.png', 'c.png']) writeFileSync(join(dir, 'refs', n), syntheticFrame(64, 64))
  pre('--run', dir, '--ref', join(dir, 'refs'))
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  const prof = rj.extracted.find((e) => e.what === 'rowProfile')
  reachedVerify(dir, undefined, prof.value)   // 不传 minCorr → 走 hint；参考剖面 = 自身 → 相关≈1
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})


// ───────── 掩膜必须锚在背景上（否则对"总量"免疫，本轮实验翻车的地方）─────────
function frameWithBand(w, h, bandFrac, bright = 200) {
  const rgb = Buffer.alloc(w * h * 3)
  const y0 = Math.floor(h * 0.05), y1 = Math.floor(h * (0.05 + bandFrac * 0.9))
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inBand = y >= y0 && y < y1
      const v = inBand ? bright : 30
      const i = (y * w + x) * 3
      rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v + 8
    }
  }
  return encodePng(w, h, rgb)
}

test('⑪ 掩膜锚在背景上：主体占比 20% vs 60% 必须量出明显差别', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-mask-'))
  const small = join(dir, 'small.png'), big = join(dir, 'big.png')
  writeFileSync(small, frameWithBand(64, 64, 0.2))
  writeFileSync(big, frameWithBand(64, 64, 0.6))
  const s1 = scalarsFromFile(small), s2 = scalarsFromFile(big)
  assert.ok(s2.subjectFrac - s1.subjectFrac > 0.3, '主体占比要明显不同：' + s1.subjectFrac.toFixed(3) + ' vs ' + s2.subjectFrac.toFixed(3))
  assert.ok(s2.topCoverage - s1.topCoverage > 0.2, '上部覆盖率也要跟着变（旧的分位掩膜在这里是恒等的）')
})

test('⑫ 与 ref-probe 的 topCoverage 同口径（同一张图，两者差 < 0.03）', async () => {
  const { probeFile } = await import('../harness/ref-probe.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'sl-mask2-'))
  const f = join(dir, 'x.png')
  writeFileSync(f, syntheticFrame())
  const a = probeFile(f).topCoverage
  const b = scalarsFromFile(f).topCoverage
  assert.ok(Math.abs(a - b) < 0.03, 'ref-probe=' + a.toFixed(3) + ' composition=' + b.toFixed(3))
});

// ── 回放暴露的两条缺项（2026-11-18）──
function noisyFrame(w = 64, h = 64, amp = 90) {
  const rgb = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      // 逐像素伪随机（线性同余再用低位打散）——线性图案在 3×3 里偏差小，测不出噪点
      let hh = ((x * 73856093) ^ (y * 19349663) ^ 0x9e3779b9) | 0
      hh = Math.imul(hh ^ (hh >>> 13), 1274126177)
      const n = ((hh >>> 7) & 1023) / 1023
      const v = Math.max(0, Math.min(255, Math.round(90 + amp * (n - 0.5))))
      const i = (y * w + x) * 3
      rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v
    }
  }
  return encodePng(w, h, rgb)
}
function smoothFrame(w = 64, h = 64) {
  const rgb = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = Math.round(80 + 60 * (x / w))
      const i = (y * w + x) * 3
      rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v
    }
  }
  return encodePng(w, h, rgb)
}

test('⑬ speckleRatio 能分开「雪花噪点」和「平滑渐变」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-spk-'))
  const a = join(dir, 'noisy.png'), b = join(dir, 'smooth.png')
  writeFileSync(a, noisyFrame()); writeFileSync(b, smoothFrame())
  const s1 = speckleRatio(decodePng(readFileSync(a)))
  const s2 = speckleRatio(decodePng(readFileSync(b)))
  assert.ok(s1 > 0.2, '噪点帧要 >0.2，实测 ' + s1.toFixed(3))
  assert.ok(s2 < 0.02, '平滑帧要 <0.02，实测 ' + s2.toFixed(3))
})

test('⑭ foamComponents 能分开「成片白沫」和「碎点」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-foam-'))
  const big = join(dir, 'big.png'), dust = join(dir, 'dust.png')
  // 一大块白 vs 散点白
  const W = 64, H = 64
  const mk = (fn) => { const rgb = Buffer.alloc(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = fn(x, y) ? 250 : 20; const i = (y * W + x) * 3; rgb[i] = v; rgb[i+1] = v; rgb[i+2] = v } return encodePng(W, H, rgb) }
  writeFileSync(big, mk((x, y) => x > 8 && x < 56 && y > 8 && y < 56))
  writeFileSync(dust, mk((x, y) => x % 8 === 0 && y % 8 === 0))
  const f1 = foamComponents(decodePng(readFileSync(big)))
  const f2 = foamComponents(decodePng(readFileSync(dust)))
  assert.ok(f1.foamMaxShare > 0.95, '整块白沫最大块占比应 >0.95，实测 ' + f1.foamMaxShare.toFixed(3))
  assert.ok(f2.foamMeanComp < 4, '碎点平均连通块应 <4，实测 ' + f2.foamMeanComp.toFixed(2))
})

test('⑮ rowProfile(topFrac)：只看画面上部时，下半部分的亮带不该再影响剖面', () => {
  // 上部留空（纯背景），下半一条亮带 —— 正是"地平线加亮带把整幅剖面垫平"的形态
  const W = 64, H = 64
  const rgb = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const inBand = y > H * 0.6 && y < H * 0.78
      const v = inBand ? 240 : 24
      const i = (y * W + x) * 3
      rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v
    }
  }
  const img = decodePng(encodePng(W, H, rgb))
  const full = rowProfile(img, 8, 1)
  const top = rowProfile(img, 8, 0.45)
  assert.ok(Math.max(...full) > 0.8, '整幅剖面里亮带必须显形，实测 max=' + Math.max(...full).toFixed(2))
  assert.ok(Math.max(...top) < 0.1, '只取上部时亮带应完全不计入，实测 max=' + Math.max(...top).toFixed(2))
})
