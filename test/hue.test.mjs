// 色相判据（hueHist / hueMean / 环形 L1）的判据测试。
// 单独一份：plugin.test.mjs 的 54 条是"包结构 + 执行器契约"，这里是"这条新指标本身对不对"。
// 跑法：node test/hue.test.mjs
//   HUE_MUTANT=linear|noSatWeight node test/hue.test.mjs   ← 用变异版跑，核心断言必须变红（人工演示用）
import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAdapter } from '../core/adapter.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = join(ROOT, 'harness')
const require = createRequire(import.meta.url)
const REAL = { M2: require(join(HARNESS, 'metrics2.js')), SC: require(join(HARNESS, 'score.js')) }

// ---------------------------------------------------------------- 合成 PNG（8bit RGB、非隔行、filter 0）
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const t = Buffer.from(type, 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function pngSolid(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colorType = RGB
  const stride = 1 + w * 3
  const raw = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * stride + 1 + x * 3
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// HSB → RGB（S=1,V=1），只用来造"纯色相"样本：H 就是我们要断言的那个角度
function hue2rgb(h) {
  const f = (n) => {
    const k = (n + h / 60) % 6
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))))
  }
  return [f(5), f(3), f(1)]
}

const IMG_DIR = mkdtempSync(join(tmpdir(), 'hue-imgs-'))
const FILES = {}
function makeImage(name, rgb) {
  const f = join(IMG_DIR, name + '.png')
  writeFileSync(f, pngSolid(24, 24, rgb))
  FILES[name] = f
  return f
}

makeImage('red', [255, 0, 0]) // H = 0   → 桶 0
makeImage('red10', hue2rgb(10)) // H = 10  → 桶 0（和红同桶，20° 分辨率下的"近似红"）
makeImage('blue', hue2rgb(210)) // H = 210 → 桶 10
makeImage('h350', hue2rgb(350)) // H = 350 → 桶 17（跨边界的那一侧）
makeImage('h10', hue2rgb(10)) // H = 10  → 桶 0
makeImage('h180', hue2rgb(180)) // H = 180 → 桶 9（正对面）
makeImage('gray', [128, 128, 128]) // S = 0：整张无彩色
makeImage('white', [255, 255, 255]) // S = 0 且很亮：不许被"亮度过关"放进直方图

// ---------------------------------------------------------------- 变异源（改文本 → 另一个目录里的模块）
const M2_SRC = readFileSync(join(HARNESS, 'metrics2.js'), 'utf8')
const SC_SRC = readFileSync(join(HARNESS, 'score.js'), 'utf8')

function loadMutant(kind) {
  const dir = mkdtempSync(join(tmpdir(), 'hue-mut-' + kind + '-'))
  let m2 = M2_SRC
  if (kind === 'linear') {
    const before = m2
    // 把环形 L1 换成朴素线性 L1（不做环形搬运）：0° 与 340° 就成了两端
    m2 = m2.replace(
      /function circularL1\(a, b\) \{[\s\S]*?\n\}/,
      'function circularL1(a, b) {\n    let d = 0;\n    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);\n    return d;\n}',
    )
    assert.notEqual(m2, before, 'linear 变异没落到源码上（circularL1 的函数体对不上）')
  } else if (kind === 'noSatWeight') {
    const before = m2
    // 去掉饱和度权重（低饱和/灰不再被拦）：灰图会开始计数到桶 0
    m2 = m2.replace('const wgt = (sat >= minSat) ? sat * val : 0;', 'const wgt = val;')
    assert.notEqual(m2, before, 'noSatWeight 变异没落到源码上（saturation 权重那一行对不上）')
  } else if (kind === 'oneBin') {
    const before = m2
    // 不分桶（全丢进桶 0）：红和蓝会变成同一张直方图
    m2 = m2.replace(/let k = Math\.floor\(h \/ HUE_BIN_DEG\);/, 'let k = 0;')
    assert.notEqual(m2, before, 'oneBin 变异没落到源码上（分桶那行对不上）')
  } else {
    throw new Error('未知变异 ' + kind)
  }
  writeFileSync(join(dir, 'metrics2.js'), m2)
  writeFileSync(join(dir, 'score.js'), SC_SRC) // score.js 原样拷过去，它的 require('./metrics2.js') 就吃到变异版
  return { M2: require(join(dir, 'metrics2.js')), SC: require(join(dir, 'score.js')) }
}

// HUE_MUTANT=... 时整份测试改用变异版跑（红→绿的人工演示）
const MODE = process.env.HUE_MUTANT || ''
const MOD = MODE ? loadMutant(MODE) : REAL

// ---------------------------------------------------------------- 取指标的小工具
const PLAN = { metrics: [{ id: 'hueHist', extract: 'hueHist' }, { id: 'hueMean', extract: 'hueMean' }] }

function bagOf(M2, name) {
  return M2.extractOne(FILES[name], M2.resolvePlan(PLAN), null, true)
}
const H = (name) => bagOf(MOD.M2, name).hueHist
const D = (a, b) => MOD.M2.circularL1(a, b)

function huePlan(extra = {}) {
  return MOD.SC.plan({
    metrics: [{ id: 'hue', extract: 'hueHist', norm: { mode: 'abs', scale: 9 } }],
    score: { type: 'l1', penalties: [] },
    ...extra,
  })
}

// ================================================================ 1. 基本形态
test('hueHist：18 桶、和为 1、非负；纯红整团落在桶 0', () => {
  const h = H('red')
  assert.equal(h.length, 18)
  assert.ok(Math.abs(h.reduce((a, b) => a + b, 0) - 1) < 1e-9, '直方图必须归一化到 1')
  assert.ok(h.every((x) => Number.isFinite(x) && x >= 0), '不许有 NaN/负数')
  assert.ok(Math.abs(h[0] - 1) < 1e-9, '纯红 H=0 应全在桶 0')
})

test('hueMean：纯红 ≈ 0°、纯蓝 ≈ 210°，没有 NaN', () => {
  assert.ok(Math.abs(bagOf(MOD.M2, 'red').hueMean) < 0.01, '纯红的圆均值应贴 0°')
  // 合成 RGB 的量化误差让 210° 落到 209.88°，容差给 0.5°
  assert.ok(Math.abs(bagOf(MOD.M2, 'blue').hueMean - 210) < 0.5, `纯蓝的圆均值应贴 210°，实测 ${bagOf(MOD.M2, 'blue').hueMean}`)
})

// ================================================================ 2. 红 ≈ 红 vs 蓝
test('红 vs 近似红(10°) 的距离远小于 红 vs 蓝（同桶近似不拉开距离，跨色相才拉）', () => {
  const drn = D(H('red'), H('red10'))
  const drb = D(H('red'), H('blue'))
  assert.ok(drn < drb * 0.2, `红→近似红 ${drn} 应远小于 红→蓝 ${drb}`)
  assert.ok(drb >= 7, `红→蓝应该接近半圈（≥7 桶），实测 ${drb}`)
})

// ================================================================ 3. 环形边界（这条是线性距离的死穴）
test('环形距离不吃边界：350° vs 10° 必须比 350° vs 180° 近', () => {
  const d1 = D(H('h350'), H('h10'))
  const d2 = D(H('h350'), H('h180'))
  assert.ok(Math.abs(d1 - 1) < 1e-6, `350°→10° 跨边界只该花 1 桶，实测 ${d1}`)
  assert.ok(Math.abs(d2 - 8) < 1e-6, `350°→180° 该花 8 桶，实测 ${d2}`)
  assert.ok(d1 < d2)
  // score 层同一条边界：normalize 不许把环绕吃掉（abs/9 → 1/9 vs 8/9）
  const P = huePlan()
  const s1 = MOD.SC.dist({ hue: H('h350') }, { hue: H('h10') }, P).parts.hue
  const s2 = MOD.SC.dist({ hue: H('h350') }, { hue: H('h180') }, P).parts.hue
  assert.ok(s1 < s2, `score 层：${s1} 应 < ${s2}`)
  assert.ok(Math.abs(s1 - 1 / 9) < 1e-6 && Math.abs(s2 - 8 / 9) < 1e-6, `归一化后应是 1/9 与 8/9（实测 ${s1} / ${s2}）`)
})

// ================================================================ 4. 灰图：不 NaN、不炸、明确空直方图
test('整张灰/整张白：空直方图（不是 NaN），hueMean 0，score 端给出"满距离"而不是假装一样', () => {
  for (const name of ['gray', 'white']) {
    const b = bagOf(MOD.M2, name)
    assert.deepEqual(b.hueHist, new Array(18).fill(0), `${name} 应回 18 个 0`)
    assert.equal(b.hueMean, 0)
  }
  const P = huePlan()
  const red = { hue: H('red') }
  const gray = { hue: H('gray') }
  const r = MOD.SC.dist(gray, red, P)
  assert.ok(Number.isFinite(r.base), '灰 vs 红：不许 NaN')
  assert.equal(r.base, 1, '空直方图 vs 有颜色 = 满距离（9/9 = 1），不假装"差不多"')
  assert.equal(MOD.SC.dist(gray, gray, P).base, 0, '灰 vs 灰 = 0')
})

// ================================================================ 5. score 接入：权重/归一化语义不变
test('直方图指标吃现成的 norm/权重：混在标量指标里也不 NaN、分量落在 0~1', () => {
  const P = MOD.SC.plan({
    metrics: [
      { id: 'cov', extract: 'cov', norm: { mode: 'range', range: [0, 0.3] }, weight: 0.8 },
      { id: 'hue', extract: 'hueHist', norm: { mode: 'abs', scale: 9 }, weight: 0.2 },
    ],
    score: { type: 'l1', penalties: [] },
  })
  const row = { cov: 0.1, hue: H('h180') }
  const trow = { cov: 0.1, hue: H('red') }
  const r = MOD.SC.dist(row, trow, P)
  assert.equal(r.parts.cov, 0)
  assert.ok(Math.abs(r.parts.hue - 1) < 1e-9, '红→正对面(180°) = 半圈 9 桶 → 归一化到 1')
  assert.ok(Math.abs(r.base - 0.2) < 1e-9, `权重 0.8/0.2 应按 Σw·nd/Σw 摊：0.2×1 = ${r.base}`)
  // range 也能给直方图用（等价写法）
  const P2 = MOD.SC.plan({
    metrics: [{ id: 'hue', extract: 'hueHist', norm: { mode: 'range', range: [0, 9] } }],
    score: { type: 'l1', penalties: [] },
  })
  assert.ok(Math.abs(MOD.SC.dist({ hue: H('h350') }, { hue: H('h10') }, P2).parts.hue - 1 / 9) < 1e-6)
})

test('直方图口径的坏输入要硬错（长度不一致 / 桶里有负数或非数 / 一边标量一边直方图）', () => {
  const P = huePlan()
  assert.throws(() => MOD.SC.dist({ hue: new Array(18).fill(0) }, { hue: new Array(17).fill(0) }, P), /长度不一致/)
  assert.throws(() => MOD.SC.dist({ hue: [1, 'x'] }, { hue: [1, 0] }, P), /不是非负数/)
  assert.throws(() => MOD.SC.dist({ hue: [1, -1] }, { hue: [1, 0] }, P), /不是非负数/)
  assert.throws(() => MOD.SC.dist({ hue: 0.5 }, { hue: [1, 0] }, P), /直方图/)
  // pctrel 对直方图没意义（分母是目标值 = 0）：应当明确拒绝，而不是除出 Infinity
  const Pct = MOD.SC.plan({
    metrics: [{ id: 'hue', extract: 'hueHist', norm: { mode: 'pctrel', floor: 0 } }],
    score: { type: 'l1', penalties: [] },
  })
  assert.throws(() => MOD.SC.dist({ hue: [1, 0] }, { hue: [0, 1] }, Pct), /pctrel/)
})

// ================================================================ 6. 示例 adapter
test('示例 adapter：hueHist 是第 4 条、权重 0.2，其余三条按 0.8 等比例让位，能两边解析', () => {
  const file = join(ROOT, 'domains', 'vfx-render', 'example-fire-ray-hue.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(raw.metrics.map((m) => m.extract), ['cov', 'lapVar', 'warmFrac', 'hueHist'])
  const ws = raw.metrics.map((m) => m.weight)
  assert.deepEqual(ws, [0.28, 0.28, 0.24, 0.2])
  assert.ok(Math.abs(ws.reduce((a, b) => a + b, 0) - 1) < 1e-9, '权重和应为 1（老三条等比例 ×0.8）')
  assert.equal(MOD.M2.resolvePlan(raw).length, 4)
  const P = MOD.SC.plan(raw)
  assert.equal(P.metrics[3].id, 'hue')
  assert.equal(P.metrics[3].norm.mode, 'abs')
  const a = parseAdapter(file, HARNESS)
  assert.equal(a.metricsCount, 4)
  assert.deepEqual(a.warnings.filter((w) => /未知提取器|metrics/.test(w)), [], a.warnings.join(' | '))
})

test('示例 adapter 端到端：红→红 距离 0，红→蓝 明显大于 0（四条指标一起算）', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'domains', 'vfx-render', 'example-fire-ray-hue.json'), 'utf8'))
  const P = MOD.SC.plan(raw)
  const mplan = MOD.M2.resolvePlan(raw)
  const row = (name) => {
    const b = MOD.M2.extractOne(FILES[name], mplan, null, true)
    return { cov: b.cov, lapVar: b.lapVar, tone: b.warmFrac, hue: b.hue, diag: b.diag }
  }
  // 纯色图很暗（纯红 luma≈54），coreGone 闸门对"同一张图"也会命中 +0.5——这是既有口径，所以看 base 不看 d
  const same = MOD.SC.dist(row('red'), row('red'), P)
  assert.equal(same.base, 0, '同图 base 必须是 0')
  assert.deepEqual(same.pens, ['coreGone'], '同图的 +0.5 只来自 coreGone（既有闸门，不是新指标）')
  const drb = MOD.SC.dist(row('blue'), row('red'), P)
  assert.ok(drb.base > 0.1, `红→蓝四条指标合起来应明显 > 0，实测 base=${drb.base}`)
  assert.ok(drb.pens.length > 0, '纯色图的 coreGone 闸门会命中，这是既有口径（不在这里改）')
})

// ================================================================ 7. 弄坏能红（自检：断言本身有牙）
test('弄坏能红：环形距离换成线性距离 → 边界那条必须红（实测 350→10 与 350→180 打平）', () => {
  const mut = loadMutant('linear')
  const h = (n) => mut.M2.extractOne(FILES[n], mut.M2.resolvePlan(PLAN), null, false).hueHist
  let seen = []
  assert.throws(() => {
    const d1 = mut.M2.circularL1(h('h350'), h('h10'))
    const d2 = mut.M2.circularL1(h('h350'), h('h180'))
    seen = [d1, d2]
    assert.ok(Math.abs(d1 - 1) < 1e-6, `线性距离下 350→10 应被算成 ${d1}，断言"只花 1 桶"过期`)
    assert.ok(d1 < d2)
  })
  assert.deepEqual(seen, [2, 2], '线性距离把跨边界与正对面算成一样远 —— 死区就在这里')
})

test('弄坏能红：去掉饱和度权重 → 灰图那条必须红（整张灰开始进桶 0）', () => {
  const mut = loadMutant('noSatWeight')
  const g = mut.M2.extractOne(FILES.gray, mut.M2.resolvePlan(PLAN), null, false).hueHist
  assert.throws(() => {
    assert.deepEqual(g, new Array(18).fill(0), '灰图应给空直方图')
  })
  assert.ok(Math.abs(g.reduce((a, b) => a + b, 0) - 1) < 1e-9, '去掉权重后整张灰变成"全在桶 0"')
})

test('弄坏能红：不分桶（全进桶 0）→ 红 vs 近红 vs 蓝 那条必须红（红和蓝变成同一张图）', () => {
  const mut = loadMutant('oneBin')
  const h = (n) => mut.M2.extractOne(FILES[n], mut.M2.resolvePlan(PLAN), null, false).hueHist
  let seen = []
  assert.throws(() => {
    const drn = mut.M2.circularL1(h('red'), h('red10'))
    const drb = mut.M2.circularL1(h('red'), h('blue'))
    seen = [drn, drb]
    assert.ok(drb >= 7, `红→蓝应该接近半圈（≥7 桶），实测 ${drb}`)
  })
  assert.deepEqual(seen, [0, 0], '不分桶时红/近红/蓝全是同一张直方图 —— 色相判据等于没接')
})
