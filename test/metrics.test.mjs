// 指标层的**正对照**纪律（0.11.0）。
//
// 为什么要单开一份：两条实验的结论都是"指标先瞎了"——
//   ① 老的 posterize 类量（posterizeRatio / hueBands / flatNoise，实验侧临时实现，不在本仓库）对**肉眼可见**
//      的人造硬切档只有噪声级反应；flatNoise 甚至是零响应，因为"3×3 极差 <8"这个门限把噪点/台阶边自己的
//      像素排除掉了（结构性盲区）。
//   ② 全帧统计被背景稀释（主体只占 3.8~6.4% 的画面）。
// 教训写成本文件的硬纪律：**每个新指标都必须先在一张"已知变坏的合成图"上翻得动**，否则它只是一串好看的数。
// 合成图全在本文件里用代码生成，不联网、不依赖素材。
//
// 跑法：node test/metrics.test.mjs
//   SELFLOOP_METRICS_MUTANT=stepAlwaysCliff   node test/metrics.test.mjs  ← 断崖判据放宽到永真 → 必须红
//   SELFLOOP_METRICS_MUTANT=legacy3x3Speckle  node test/metrics.test.mjs  ← 换回老的 3×3 门限 → 必须红
import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = join(ROOT, 'harness')
const require = createRequire(import.meta.url)
const REAL = require(join(HARNESS, 'metrics2.js'))

const MUTANT = process.env.SELFLOOP_METRICS_MUTANT || ''
// MUTANT 给了就整份改用变异版跑（正对照当场变红的演示）；不给就是真身
let MOD = REAL

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

// fn(x, y) -> 灰度 0~255（写成灰 RGB：三个通道同值，luma 就恰好等于它）
function pngGray(w, h, fn) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // depth
  ihdr[9] = 2 // colorType = RGB
  const stride = 1 + w * 3
  const raw = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y))))
      const p = y * stride + 1 + x * 3
      raw[p] = v
      raw[p + 1] = v
      raw[p + 2] = v
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- 四张合成图（每张只改一件事）
const W = 256
const H = 256
const DIR = mkdtempSync(join(tmpdir(), 'metrics-imgs-'))
const F = {}
function make(name, w, h, fn) {
  const f = join(DIR, name + '.png')
  writeFileSync(f, pngGray(w, h, fn))
  F[name] = f
  return f
}

// 连续渐变：每列一个亮度，0..255 全覆盖 → 直方图 256 桶全满且相邻桶等量（无断崖、无孤立点）
make('smooth', W, H, (x) => x)

// 人造 posterize：把上面的渐变硬切 4 档 → 直方图只剩 4 个桶，台阶之间是空档（断崖）
make('banded4', W, H, (x) => Math.min(3, Math.floor(x / 64)) * 64 + 32)

// 人造噪点：渐变 + 间隔 5px 的孤立点（+90 / −90，远大于 speckleDelta=24，彼此 8 邻域不重叠）
const SPECKLE_STRIDE = 5
const SPECKLE_OFFSET = 2
const isSpeckle = (x, y) => x % SPECKLE_STRIDE === SPECKLE_OFFSET && y % SPECKLE_STRIDE === SPECKLE_OFFSET
make('speckled', W, H, (x, y) => (isSpeckle(x, y) ? (x <= 128 ? x + 90 : x - 90) : x))

// 主体占 5%：背景是**大面积平坦但过得了 lapVar 的 luma 门限**的灰(60)，
// 主体是 57×57 的 2px 细格（160/200）——这正是"全帧被背景稀释"的最小复现。
const SUBJ = 57
const subjX0 = Math.floor((W - SUBJ) / 2)
const subjY0 = Math.floor((H - SUBJ) / 2)
const subjPattern = (x, y) => (((x >> 1) + (y >> 1)) & 1 ? 200 : 160)
const inSubj = (x, y) => x >= subjX0 && x < subjX0 + SUBJ && y >= subjY0 && y < subjY0 + SUBJ
make('small_subject', W, H, (x, y) => (inSubj(x, y) ? subjPattern(x, y) : 60))
// 同一套纹理铺满整帧：掩膜内 lapVar 的"真值"（拿它当尺子，而不是拿我手算的数字当尺子）
make('subject_only', W, H, (x, y) => subjPattern(x, y))

// 主体极小（6×6，占 0.009%）：给"掩膜太小 → 退回全图 + maskFallback"用
make('tiny_subject', W, H, (x, y) => (x >= 100 && x < 106 && y >= 100 && y < 106 ? 200 : 5))

// ---------------------------------------------------------------- 取数
function plan(metrics) {
  return MOD.resolvePlan({ metrics })
}
function bag(file, metrics, withDiag = false) {
  return MOD.extractOne(file, plan(metrics), null, withDiag)
}
function val(file, extract, opts) {
  return bag(file, [{ id: 'v', extract, opts }]).v
}

// ---------------------------------------------------------------- 正对照清单（纪律用）
// 老 10 条是 E1 / P2.5 时代标定的量，本文件不要求再给它们补合成对照；
// **新加的任何提取器必须进清单，并且本文件里要真有一条断言在标定它**（缺了 test 里最后那条会红）。
const LEGACY_EXTRACTORS = new Set(['mean', 'p160', 'lapVar', 'warmFrac', 'coldFrac', 'hueHist', 'hueMean', 'cov', 'maskIoU', 'bbox'])
const COVERED = new Set()
function positiveControl(name) {
  COVERED.add(name)
}

function checkLedger(names, ledger = EXTRACTORS_WITH_POSITIVE_CONTROL, covered = COVERED) {
  const missing = names.filter((n) => !LEGACY_EXTRACTORS.has(n) && !ledger.includes(n))
  if (missing.length) throw new Error('新增提取器没正对照：' + missing.join(' / ') + ' —— 先在合成图上证明它翻得动')
  const hollow = ledger.filter((n) => !covered.has(n))
  if (hollow.length) throw new Error('清单注水：' + hollow.join(' / ') + ' 在清单里，但本文件没有断言真的标定它')
}

// 0.11.0 新增的两个量都在这里；以后加指标，往这个数组里加名字 + 在下面写一条合成对照
const EXTRACTORS_WITH_POSITIVE_CONTROL = ['stepRatio', 'speckleFrac']

// ---------------------------------------------------------------- 1. 正对照：剁档
test('正对照 · stepRatio：4 档硬切 > 3 × 连续渐变（这是它能当"剁档"判据的唯一理由）', () => {
  positiveControl('stepRatio')
  const sm = val(F.smooth, 'stepRatio')
  const bd = val(F.banded4, 'stepRatio')
  console.log(`    实测 stepRatio  smooth=${sm}  banded4=${bd}  比值=${sm > 0 ? (bd / sm).toFixed(1) + '×' : '∞（smooth=0）'}`)
  assert.ok(bd > 3 * sm, `banded4 的 stepRatio 必须 > 3×smooth（实测 ${bd} vs ${sm}）`)
  assert.ok(bd >= 0.5, `4 档硬切的断崖占比应接近 1（实测 ${bd}）`)
  assert.ok(sm <= 0.01, `连续渐变的断崖占比应≈0（实测 ${sm}）`)
})

// ---------------------------------------------------------------- 2. 正对照：噪点
test('正对照 · speckleFrac：孤立点 > 3 × 连续渐变（没有 3×3 门限，孤立点自己就是证据）', () => {
  positiveControl('speckleFrac')
  const sm = val(F.smooth, 'speckleFrac')
  const sp = val(F.speckled, 'speckleFrac')
  console.log(`    实测 speckleFrac  smooth=${sm}  speckled=${sp}  比值=${sm > 0 ? (sp / sm).toFixed(1) + '×' : '∞（smooth=0）'}`)
  assert.ok(sp > 3 * sm, `speckled 的 speckleFrac 必须 > 3×smooth（实测 ${sp} vs ${sm}）`)
  assert.ok(sp > 0.02, `人造孤立点占 4% 左右，speckleFrac 应量得到（实测 ${sp}）`)
  assert.ok(sm <= 0.001, `连续渐变没有孤立点（实测 ${sm}）`)
})

// ---------------------------------------------------------------- 3. 掩膜：5% 主体下全帧 vs 掩膜内
test('正对照 · 掩膜：主体只占 5% 时，全帧 lapVar 被背景稀释，掩膜内能还原主体细节', () => {
  const maskOpts = { mask: { mode: 'content', luma: 150, dilate: 1, minAreaPct: 0.5 } }
  const full = bag(F.small_subject, [{ id: 'v', extract: 'lapVar' }])
  const masked = bag(F.small_subject, [{ id: 'v', extract: 'lapVar', opts: maskOpts }])
  const truth = bag(F.subject_only, [{ id: 'v', extract: 'lapVar' }]).v
  const pct = (masked.maskInfo && masked.maskInfo.areaPct) || -1
  console.log(`    实测 lapVar  全帧=${full.v}  掩膜内=${masked.v}  主体纯图=${truth}  掩膜面积=${pct}%  稀释倍数=${(masked.v / full.v).toFixed(1)}×  掩膜/纯图=${(masked.v / truth).toFixed(2)}×`)
  assert.equal(full.maskFallback, undefined, '面积够大时不许标 maskFallback')
  assert.ok(pct > 4 && pct < 12, `掩膜面积应≈主体面积 5%（实测 ${pct}%）`)
  assert.ok(masked.v > 10 * full.v, `掩膜内 lapVar 必须显著高于全帧（实测 ${masked.v} vs ${full.v}）`)
  // 掩膜内要还原到"主体自己"的量级。容差 0.8~1.6 不是放水：方差对边界极敏感——主体嵌在别的底色里，
  // 它外沿那一圈像素的 lap 值是离群点（这条环 = 周长/面积 ≈ 7%），把方差往上抬了十几个百分点；
  // 主体纯图里没有这条环。要的是"同一个量级、不是被背景稀释到 1/18"，不是小数点后几位。
  assert.ok(masked.v / truth > 0.8 && masked.v / truth < 1.6, `掩膜内 lapVar 要还原到主体纯图的量级（${masked.v} vs ${truth}）`)
  positiveControl('lapVar')
})

// ---------------------------------------------------------------- 4. 掩膜回退：不许静默
test('掩膜回退：主体面积 < minAreaPct → 返回 maskFallback:true 且不崩（退回全图）', () => {
  const fallback = bag(F.tiny_subject, [{ id: 'v', extract: 'stepRatio', opts: { mask: { mode: 'content', luma: 100, dilate: 1, minAreaPct: 0.2 } } }])
  const applied = bag(F.tiny_subject, [{ id: 'v', extract: 'stepRatio', opts: { mask: { mode: 'content', luma: 100, dilate: 1, minAreaPct: 0.05 } } }])
  console.log(`    实测 主体占比=${fallback.maskInfo.largestPct}%（膨胀后 ${fallback.maskInfo.areaPct}%）  minAreaPct=0.2 → fallback=${fallback.maskFallback === true}  minAreaPct=0.05 → fallback=${applied.maskFallback === true}`)
  assert.equal(fallback.maskFallback, true, '面积 0.009% < 0.2% 时必须标 maskFallback:true（不许静默退回全图）')
  assert.equal(typeof fallback.v, 'number', '回退后仍要给一个数（不崩）')
  assert.ok(fallback.maskInfo && fallback.maskInfo.areaPct < 0.2, '回执里要带实际面积占比，人能自己看')
  assert.equal(applied.maskFallback, undefined, '把门限降到 0.05% 后同一个主体不该再回退')
})

// ---------------------------------------------------------------- 5. 向后兼容：不写 mask 就与升级前逐字节一致
test('向后兼容：不写 opts.mask 时所有老提取器的数值与"显式全图"完全一致', () => {
  const legacy = ['mean', 'p160', 'lapVar', 'warmFrac', 'coldFrac', 'cov', 'bbox']
  for (const ex of legacy) {
    const a = val(F.small_subject, ex)
    const b = val(F.small_subject, ex, { mask: { mode: 'none' } })
    assert.deepEqual(a, b, `${ex}：不写 mask 与 mode:"none" 必须同值（升级前行为不许漂）`)
  }
  const h1 = val(F.small_subject, 'hueHist')
  const h2 = val(F.small_subject, 'hueHist', { mask: { mode: 'none' } })
  assert.deepEqual(h1, h2)
})

// ---------------------------------------------------------------- 6. 纪律：新指标必须带正对照
test('纪律：每个新增提取器都在正对照清单里，且清单里每一条都有真断言（缺了就红）', () => {
  checkLedger(Object.keys(MOD.EXTRACTORS))
  const covered = [...COVERED].sort()
  console.log(`    实测 注册表 ${Object.keys(MOD.EXTRACTORS).length} 个提取器；本文件真标定过：${covered.join(', ')}`)
  // 新增提取器的"清单 ↔ 真断言"必须一一对应；老 10 条允许额外被标定（掩膜那条就顺带标了 lapVar）
  assert.deepEqual(covered.filter((n) => !LEGACY_EXTRACTORS.has(n)), [...EXTRACTORS_WITH_POSITIVE_CONTROL].sort(), '新增提取器的清单与真断言必须一一对应')
})

// ---------------------------------------------------------------- 7. 弄坏能红（自检：断言有牙）
function loadMutant(kind) {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-mut-' + kind + '-'))
  let src = readFileSync(join(HARNESS, 'metrics2.js'), 'utf8')
  if (kind === 'stepAlwaysCliff') {
    // 把"断崖"判据放宽到永真：只要桶里有点就算一次断崖（丢掉"掉到上一桶 10% 以下"这一条）
    const before = src
    src = src.replace(
      'if (bins[i] > minCnt && bins[i + 1] < bins[i] * drop) cliffs++;',
      'if (bins[i] > minCnt) cliffs++;',
    )
    assert.notEqual(src, before, '变异没落到源码上（stepRatio 的断崖判据那一行对不上）')
  } else if (kind === 'legacy3x3Speckle') {
    // 换回实验里那个老实现的门限：只在"3×3 极差 < 8"的平坦像素里数——孤立点会亲手把自己的邻域撑爆，
    // 于是噪点越多、它反而越看不见（结构性盲区）。
    const before = src
    src = src.replace(
      'if (Math.abs(L[i] - med) > d) isol++;',
      [
        'let mxv = -1e9, mnv = 1e9;',
        '                    for (let dy = -1; dy <= 1; dy++) { for (let dx = -1; dx <= 1; dx++) { const v = L[i + dy * w + dx]; if (v > mxv) mxv = v; if (v < mnv) mnv = v; } }',
        '                    if (mxv - mnv < 8) isol++;',
      ].join('\n                    '),
    )
    assert.notEqual(src, before, '变异没落到源码上（speckleFrac 的孤立判定那一行对不上）')
  } else {
    throw new Error('不认识的变异：' + kind)
  }
  const f = join(dir, 'metrics2.js')
  writeFileSync(f, src)
  return { M2: require(f) }
}

const MUT = MUTANT ? loadMutant(MUTANT) : null
if (MUT) MOD = MUT.M2   // 变异版接管整份测试：正对照必须当场变红

test('弄坏能红 ①：stepRatio 的断崖判据放宽到永真 → 剁档正对照必红（砍之前先看见它怎么塌）', () => {
  const mut = loadMutant('stepAlwaysCliff')
  const pm = (file) => mut.M2.extractOne(file, mut.M2.resolvePlan({ metrics: [{ id: 'v', extract: 'stepRatio' }] }), null, false).v
  const sm = pm(F.smooth)
  const bd = pm(F.banded4)
  console.log(`    变异后 stepRatio  smooth=${sm}  banded4=${bd}  → 3×smooth=${(3 * sm).toFixed(3)}，banded4 ${bd > 3 * sm ? '仍能过' : '塌了'}`)
  assert.throws(
    () => assert.ok(bd > 3 * sm, `banded4 的 stepRatio 必须 > 3×smooth（实测 ${bd} vs ${sm}）`),
    /stepRatio 必须/,
  )
})

test('弄坏能红 ②：speckleFrac 换回老的 3×3 门限 → 噪点正对照必红（门限把噪点自己排除掉）', () => {
  const mut = loadMutant('legacy3x3Speckle')
  const pm = (file) => mut.M2.extractOne(file, mut.M2.resolvePlan({ metrics: [{ id: 'v', extract: 'speckleFrac' }] }), null, false).v
  const sm = pm(F.smooth)
  const sp = pm(F.speckled)
  console.log(`    变异后 speckleFrac  smooth=${sm}  speckled=${sp}  → 3×smooth=${(3 * sm).toFixed(3)}，speckled ${sp > 3 * sm ? '仍能过' : '塌了'}`)
  assert.throws(
    () => assert.ok(sp > 3 * sm, `speckled 的 speckleFrac 必须 > 3×smooth（实测 ${sp} vs ${sm}）`),
    /speckleFrac 必须/,
  )
})

test('弄坏能红 ③：往注册表里塞一个不带正对照的新提取器 → 纪律那条必红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-mut-uncal-'))
  const src = readFileSync(join(HARNESS, 'metrics2.js'), 'utf8')
  const before = src
  const injected = src.replace(
    '    stepRatio: {',
    '    zzBrandNew: { desc: "没标定的新指标", defaults: {}, fn() { return 0; } },\n    stepRatio: {',
  )
  assert.notEqual(injected, before, '注入没落到源码上（注册表里找不到 stepRatio 那一项）')
  const f = join(dir, 'metrics2.js')
  writeFileSync(f, injected)
  const mut = { M2: require(f) }
  assert.ok(Object.keys(mut.M2.EXTRACTORS).includes('zzBrandNew'))
  assert.throws(() => checkLedger(Object.keys(mut.M2.EXTRACTORS)), /没正对照/)
  // 反方向也要有牙：清单里挂个名字但没有断言 → "清单注水"也算红
  assert.throws(() => checkLedger(Object.keys(MOD.EXTRACTORS), ['stepRatio', 'speckleFrac', 'ghostMetric']), /清单注水/)
})


