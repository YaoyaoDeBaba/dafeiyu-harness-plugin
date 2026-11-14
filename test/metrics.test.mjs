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
//
// 0.12.0 追加（第二轮实验推翻了两处设计，纪律也跟着升级）：
//   ① **掩膜不能只按亮度圈**：luma:200 在真实场景只剩枪口白芯（占屏 <1%，对主体 recall 0.09~0.38），
//      而它看起来很专业——三个不同变体在三个时刻的掩膜内指标**逐位相同**（7305.98|0.21296|0.11216）：
//      最大连通域在"枪口团"和"射线"之间跳，等于把不同变体量成同一块像素。→ 新增 roi / diff / chroma 三种口径，
//      并给 content 加 maskSuspicious（面积 <1% 或 bbox <5% 就报警）。
//   ② **正对照必须双向**：stepRatio 在模糊(−49~−80%)和锐化(−51~−81%)两个相反方向上**同向下降**——
//      只测模糊一个方向的话它完全合格，而它量的是"直方图断崖"，不是细节。→ 声称"细节"的指标必须
//      模糊↓ + 锐化↑ + 剂量单调（assertBidirectional）；量化指标（stepRatio / levelCount）另走一套对照。
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
  return pngRgb(w, h, (x, y) => { const v = fn(x, y); return [v, v, v] })
}

// fn(x, y) -> [r,g,b]（0~255）：色度类掩膜（chroma）/ "亮主体 + 亮背景"必须用真彩色图造
function pngRgb(w, h, fn) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // depth
  ihdr[9] = 2 // colorType = RGB
  const stride = 1 + w * 3
  const raw = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x, y)
      const p = y * stride + 1 + x * 3
      raw[p] = Math.max(0, Math.min(255, Math.round(c[0])))
      raw[p + 1] = Math.max(0, Math.min(255, Math.round(c[1])))
      raw[p + 2] = Math.max(0, Math.min(255, Math.round(c[2])))
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

function makeRgb(name, w, h, fn) {
  const f = join(DIR, name + '.png')
  writeFileSync(f, pngRgb(w, h, fn))
  F[name] = f
  return f
}

// ---------------------------------------------------------------- 0.12.0 新增的合成图
// 全部代码生成（不联网、不依赖素材）。每张只改一件事，断言就是判据。

// (a) 双向细节对照：一张"细节能量已知"的纹理 + 两个方向的变体（模糊 σ=1 / σ=2、锐化 unsharp）
function field(w, h, fn) {
  const a = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y)
  return a
}
function gaussBlur(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = []
  let sum = 0
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v }
  const kk = k.map((v) => v / sum)
  const tmp = new Float64Array(w * h)
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = -r; i <= r; i++) acc += src[y * w + Math.min(w - 1, Math.max(0, x + i))] * kk[i + r]
      tmp[y * w + x] = acc
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = -r; i <= r; i++) acc += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * kk[i + r]
      out[y * w + x] = acc
    }
  }
  return out
}
const DET = (() => {
  // 三个频率叠在一起：lapVar 对"边缘/高频"敏感，模糊一定掉、锐化一定涨（这正是正对照要的形状）
  const base = field(W, H, (x, y) => 128 + 40 * Math.sin(x * 0.9) * Math.cos(y * 0.55) + 25 * Math.sin((x + y) * 0.31))
  const blur1 = gaussBlur(base, W, H, 1)
  const blur2 = gaussBlur(base, W, H, 2)
  const sharp = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) sharp[i] = base[i] + 1.5 * (base[i] - blur1[i]) // unsharp mask
  return { base, blur1, blur2, sharp }
})()
const grayAt = (a) => (x, y) => a[y * W + x]
make('det_base', W, H, grayAt(DET.base))
make('det_blur1', W, H, grayAt(DET.blur1))
make('det_blur2', W, H, grayAt(DET.blur2))
make('det_sharp', W, H, grayAt(DET.sharp))

// (b) "空舞台" vs "有暖主体"：还原实验现场——天空 luma≈100（比主体亮），主体体 luma≈161，
//     只有一小块白芯过得了 luma:200。于是 content(luma:200) 只剩白芯（占屏 0.39%，recall 0.03），
//     而 diff / chroma 能圈出真主体。这是 "content 掩膜看起来很专业地量错了" 的最小复现。
const inEllipse = (x, y) => ((x - 128) / 46) ** 2 + ((y - 140) / 60) ** 2 <= 1
const inCore = (x, y) => Math.abs(x - 128) <= 7 && y >= 92 && y <= 108
const inFireSubject = (x, y) => inEllipse(x, y) || inCore(x, y)
const stageBg = (x, y) => {
  if (y < 96) return [92, 104, 124] // 天空：luma ≈ 100.7（比主体亮）
  if (y < 210) return [64, 62, 70]
  return [40, 40, 46]
}
const stageFire = (x, y) => {
  if (inCore(x, y)) return [255, 250, 245] // 白芯 luma ≈ 250（唯一过 luma:200 的东西）
  if (inEllipse(x, y)) return [232, 148, 66] // 火焰体 luma ≈ 161
  return stageBg(x, y)
}
makeRgb('stage_bg', W, H, stageBg)
makeRgb('stage_fire', W, H, stageFire)
let SUBJECT_N = 0
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inFireSubject(x, y)) SUBJECT_N++
const SUBJECT_PCT = 100 * SUBJECT_N / (W * H)

// (c) 暖主体 + 冷背景：亮度分不开、颜色分得开（chroma 的用武之地）
const inWarm = (x, y) => x >= 60 && x < 160 && y >= 70 && y < 190
makeRgb('warm_cold', W, H, (x, y) => (inWarm(x, y) ? [220, 96, 60] : [58, 92, 140]))
let WARM_N = 0
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inWarm(x, y)) WARM_N++
const WARM_PCT = 100 * WARM_N / (W * H)

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

// 掩膜这一层要"看得见像素"：直接拿 px 视图量 recall / 是否吃到背景，别只信一个数。
function pxOf(file) {
  return MOD.makePx(MOD.decodePng(readFileSync(file)))
}
// m=null（退回全图）按"整个画面都是掩膜"算——这时 recall/precision 会难看，这正是要点。
function precisionRecall(m, w, h, pred, truthN) {
  let area = 0, inter = 0, wrong = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (m && !m[y * w + x]) continue
      area++
      if (pred(x, y)) inter++
      else wrong++
    }
  }
  return { area, areaPct: 100 * area / (w * h), inter, wrong, recall: inter / truthN, precision: area ? inter / area : 0 }
}

// ---------------------------------------------------------------- 双向正对照纪律（0.12.0）
// 一条铁律：**声称"细节"的指标，必须在两个方向上都真的翻得动，而且剂量单调**。
// 为什么必须双向：stepRatio 的翻车就是"模糊和锐化**同向下降**"（−49~−80% 与 −51~−81%）——
// 只测模糊那一个方向的话，它看起来完全合格，而它实际量的是"直方图断崖"，不是细节。
const DETAIL_METRICS = ['lapVar']                     // 声称"细节"的指标
const QUANT_METRICS = ['stepRatio', 'levelCount']     // 量化代理（正对照 = 连续 vs 硬切 4 档，不许混用细节对照）
const BIDIRECTIONAL = new Set()

// m = {orig, blur1, blur2, sharp}
function assertBidirectional(name, m) {
  assert.ok(m.blur1 < 0.7 * m.orig, `${name}：模糊(σ=1) 必须显著下降（实测 ${m.blur1} vs ${m.orig}）`)
  assert.ok(m.blur2 < m.blur1, `${name}：剂量必须单调——σ=2 要比 σ=1 更平（实测 ${m.blur2} vs ${m.blur1}）`)
  assert.ok(m.sharp > 1.2 * m.orig, `${name}：锐化必须显著上升（实测 ${m.sharp} vs ${m.orig}）——只测一个方向不算标定`)
  BIDIRECTIONAL.add(name)
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
// 0.12.0 追加 levelCount（量化代理），正对照仍是"连续 vs 硬切 4 档"，不许拿模糊/锐化当它的对照
const EXTRACTORS_WITH_POSITIVE_CONTROL = ['stepRatio', 'levelCount', 'speckleFrac']

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

// ---------------------------------------------------------------- 6. 掩膜四兄弟（0.12.0）
// 上一版只有 content，实验证明它"看起来很专业地量错了"：luma:200 在真实场景只剩枪口白芯，
// 三个不同变体在三个时刻的掩膜内指标逐位相同（7305.98|0.21296|0.11216）——最大连通域在
// "枪口团"和"射线"之间跳，等于把不同变体量成同一块像素。下面这四条把三种新口径各钉一遍。

test('掩膜 · roi：同一 ROI 在两帧上掩膜逐像素相同；越界自动夹紧并 warn（不许静默裁/静默全图）', () => {
  const rect = [40, 40, 100, 100]
  const ro = { mode: 'roi', rect, dilate: 1, minAreaPct: 0.01 }
  const a = pxOf(F.stage_fire).contentMask(ro)
  const b = pxOf(F.stage_bg).contentMask(ro)
  const c = pxOf(F.warm_cold).contentMask(ro)
  console.log(`    实测 roi=${JSON.stringify(rect)} 面积: fire=${a.areaPct}% bg=${b.areaPct}% warmcold=${c.areaPct}%  count=${a.count}/${b.count}/${c.count}`)
  // 三帧内容完全不同（暖主体 / 空舞台 / 冷暖块），ROI 口径下掩膜必须一个像素都不动
  assert.equal(a.count, b.count, '同一 ROI 在两张图上掩膜面积必须完全相同')
  assert.equal(a.count, c.count)
  assert.deepEqual(Array.from(a.m), Array.from(b.m), '同一 ROI 的掩膜必须逐像素相同（跨帧/跨变体唯一稳的口径）')
  assert.deepEqual(a.roi, { x: 40, y: 40, w: 100, h: 100 }, '回执里要能看出实际生效的矩形')
  assert.equal(a.maskSuspicious, false, 'roi 是用户自己钉的，不该被"圈太小"规则报警')
  // 越界：夹紧到画面内 + 把请求与实际都写出来
  const clamped = pxOf(F.stage_fire).contentMask({ mode: 'roi', rect: [-20, 200, 400, 200], dilate: 0, minAreaPct: 0.01 })
  console.log(`    实测 越界 rect[-20,200,400,200] → ${JSON.stringify(clamped.roi)}  warn=${JSON.stringify(clamped.maskWarn)}`)
  assert.deepEqual([clamped.roi.x, clamped.roi.y, clamped.roi.w, clamped.roi.h], [0, 200, 256, 56])
  assert.equal(clamped.roi.clamped, true)
  assert.ok(clamped.maskWarn.length >= 1 && /夹紧/.test(clamped.maskWarn[0]), '夹紧必须带一条 warn')
  // warn 得能从 extractOne 一路带到返回值上（否则报告里看不见，等于没报）
  const out = bag(F.stage_fire, [{ id: 'v', extract: 'cov', opts: { mask: { mode: 'roi', rect: [-20, 200, 400, 200], dilate: 0, minAreaPct: 0.01 } } }])
  assert.equal(out.maskInfo.mode, 'roi')
  assert.deepEqual(out.maskInfo.roi.requested, [-20, 200, 400, 200], '请求值要留在回执里')
  assert.ok(out.maskWarn && /夹紧/.test(out.maskWarn[0]), 'extractOne 的返回对象上必须有 maskWarn')
})

test('掩膜 · diff：与"空舞台"差分能圈出真主体，recall 远优于 content(luma:200)', () => {
  const px = pxOf(F.stage_fire)
  const c200 = px.contentMask({ mode: 'content', luma: 200, dilate: 0, minAreaPct: 0.01 })
  const d = px.contentMask({ mode: 'diff', ref: F.stage_bg, delta: 12, dilate: 0, minAreaPct: 0.01 })
  const cr = precisionRecall(c200.m, W, H, inFireSubject, SUBJECT_N)
  const dr = precisionRecall(d.m, W, H, inFireSubject, SUBJECT_N)
  console.log(`    实测 真主体=${SUBJECT_PCT.toFixed(3)}%  content(luma:200): 面积=${c200.areaPct}% recall=${cr.recall.toFixed(3)}  diff: 面积=${d.areaPct}% recall=${dr.recall.toFixed(3)}`)
  assert.ok(dr.recall > 0.95, `diff 必须圈住真主体（recall 实测 ${dr.recall.toFixed(3)}）`)
  assert.ok(cr.recall < 0.2, `content(luma:200) 只圈到白芯，recall 必然很低（实测 ${cr.recall.toFixed(3)}）`)
  assert.ok(dr.recall > 3 * cr.recall, `diff 的 recall 必须明显优于 content（${dr.recall.toFixed(3)} vs ${cr.recall.toFixed(3)}）`)
  // 与真值差 < 2 倍（两边都算，diff 不该漏一大块、也不该把背景吃进来）
  assert.ok(d.areaPct > SUBJECT_PCT / 2 && d.areaPct < SUBJECT_PCT * 2, `diff 面积要与真值同量级（${d.areaPct}% vs ${SUBJECT_PCT.toFixed(3)}%）`)
  assert.equal(d.maskSuspicious, false)
  assert.equal(c200.maskSuspicious, true, '圈到白芯必须被标出来')
  // 回执口径：报告里要能看出"用的是 diff + 哪张 ref + delta 多少"
  const out = bag(F.stage_fire, [{ id: 'v', extract: 'cov', opts: { mask: { mode: 'diff', ref: F.stage_bg, delta: 12, dilate: 0, minAreaPct: 0.01 } } }])
  assert.equal(out.maskInfo.mode, 'diff')
  assert.equal(out.maskInfo.delta, 12)
  assert.ok(/stage_bg\.png$/.test(out.maskInfo.ref), '回执里要带解析后的 ref 绝对路径')
})

test('掩膜 · chroma：暖色谓词只圈暖主体，冷背景一个像素都不许进', () => {
  const m = pxOf(F.warm_cold).contentMask({ mode: 'chroma', predicate: { channel: 'blue-minus-red', op: '<', value: -20 }, dilate: 0, minAreaPct: 0.01 })
  const r = precisionRecall(m.m, W, H, inWarm, WARM_N)
  console.log(`    实测 chroma(b-r<-20)：面积=${m.areaPct}%（真值 ${WARM_PCT.toFixed(3)}%） 命中=${r.inter}/${WARM_N} 误收=${r.wrong} precision=${r.precision.toFixed(3)}`)
  assert.equal(r.wrong, 0, '冷背景（b-r=+48）一个像素都不许进掩膜')
  assert.equal(r.inter, WARM_N, '暖主体必须全圈住')
  assert.ok(Math.abs(m.areaPct - WARM_PCT) < WARM_PCT * 0.01, `面积要与真值一致（${m.areaPct}% vs ${WARM_PCT.toFixed(3)}%）`)
  assert.equal(m.maskSuspicious, false)
  // 谓词写错必须硬错，不许静默变成全图/空图
  assert.throws(() => pxOf(F.warm_cold).contentMask({ mode: 'chroma', predicate: { channel: 'yy', op: '<', value: 0 } }), /predicate\.channel/)
  assert.throws(() => pxOf(F.warm_cold).contentMask({ mode: 'chroma', predicate: { channel: 'r', op: '≠', value: 0 } }), /predicate\.op/)
})

test('content 健全性：luma 门限只圈到小白芯 → maskSuspicious:true（圈错比没掩膜更危险）', () => {
  const bad = bag(F.stage_fire, [{ id: 'v', extract: 'cov', opts: { mask: { mode: 'content', luma: 200, dilate: 0, minAreaPct: 0.01 } } }])
  console.log(`    实测 content(luma:200) 面积=${bad.maskInfo.areaPct}% bbox=${bad.maskInfo.bboxPct}% suspicious=${bad.maskSuspicious} reasons=${JSON.stringify(bad.maskSuspectReasons)}`)
  assert.equal(bad.maskSuspicious, true, '面积 0.39% 的掩膜必须被标成"可疑"')
  assert.ok(Array.isArray(bad.maskSuspectReasons) && bad.maskSuspectReasons.length >= 1, '可疑必须带原因，不许只给一个布尔')
  assert.ok(/< 1%/.test(bad.maskSuspectReasons.join(' ')), '原因里要写清踩了哪条门槛')
  // 反方向：同一个 content 口径，门限落对位置时不许乱报警（否则这条告警会被当噪音忽略）
  const good = bag(F.stage_fire, [{ id: 'v', extract: 'cov', opts: { mask: { mode: 'content', luma: 155, dilate: 0, minAreaPct: 0.01 } } }])
  console.log(`    实测 content(luma:155) 面积=${good.maskInfo.areaPct}% bbox=${good.maskInfo.bboxPct}% suspicious=${good.maskSuspicious === true}`)
  assert.equal(good.maskSuspicious, undefined, '圈到整块主体时不许报警（阈值 1% / 5%）')
})

// ---------------------------------------------------------------- 7. 量化指标的正对照 + 口径限制
test('正对照 · levelCount（量化代理）：连续渐变 ≫ 4 档硬切（量化越重，取值个数越少）', () => {
  positiveControl('levelCount')
  const sm = val(F.smooth, 'levelCount')
  const bd = val(F.banded4, 'levelCount')
  console.log(`    实测 levelCount  smooth=${sm}  banded4=${bd}  比值=${(sm / bd).toFixed(1)}×`)
  assert.ok(sm >= 200, `连续渐变应有接近满值的取值个数（实测 ${sm}）`)
  assert.ok(bd <= 8, `4 档硬切只剩 4 个取值（实测 ${bd}）`)
  assert.ok(sm > 20 * bd, `连续 vs 硬切必须拉开一个数量级（实测 ${sm} vs ${bd}）`)
})

test('口径 · stepRatio 不是细节指标：模糊/锐化两个方向都不显著变化（拿它判"更平/更细"必翻车）', () => {
  const sr = {
    base: val(F.det_base, 'stepRatio'), blur1: val(F.det_blur1, 'stepRatio'),
    blur2: val(F.det_blur2, 'stepRatio'), sharp: val(F.det_sharp, 'stepRatio'),
  }
  const lap = {
    base: val(F.det_base, 'lapVar'), blur1: val(F.det_blur1, 'lapVar'),
    blur2: val(F.det_blur2, 'lapVar'), sharp: val(F.det_sharp, 'lapVar'),
  }
  const spread = Math.max(sr.base, sr.blur1, sr.blur2, sr.sharp) - Math.min(sr.base, sr.blur1, sr.blur2, sr.sharp)
  console.log(`    实测 stepRatio  base=${sr.base} blur1=${sr.blur1} blur2=${sr.blur2} sharp=${sr.sharp} 波动=${spread.toFixed(4)}`)
  console.log(`    同一组图 lapVar  base=${lap.base} blur1=${lap.blur1} blur2=${lap.blur2} sharp=${lap.sharp}`)
  // 口径钉死：它不测细节——两个方向都不该"翻得动"（这里连方向都对不上）
  assert.ok(spread <= 0.05, `stepRatio 在模糊/锐化上的波动必须很小（实测波动 ${spread.toFixed(4)}，>0.05 说明它在跟着细节跑）`)
  assert.ok(!(sr.sharp > 1.2 * sr.base), `锐化不该让 stepRatio 上升（${sr.sharp} vs ${sr.base}）——它量的是断崖，不是细节`)
  // 但同一组图上 lapVar 两个方向都翻得动 → 不是"图没变"，是 stepRatio 看不见
  assert.ok(lap.blur1 < 0.7 * lap.base, '对照组：同一组模糊图上 lapVar 显著下降')
  assert.ok(lap.sharp > 1.2 * lap.base, '对照组：同一组锐化图上 lapVar 显著上升')
  // 口径归属：stepRatio / levelCount 是量化指标，详情见文件头 DETAIL_METRICS
  assert.ok(!DETAIL_METRICS.includes('stepRatio'), 'stepRatio 不许被当成细节指标')
})

// ---------------------------------------------------------------- 8. 双向正对照（细节指标）
test('正对照（双向）· lapVar：模糊↓、锐化↑、剂量单调（σ=2 比 σ=1 更平）', () => {
  const lap = {
    orig: val(F.det_base, 'lapVar'), blur1: val(F.det_blur1, 'lapVar'),
    blur2: val(F.det_blur2, 'lapVar'), sharp: val(F.det_sharp, 'lapVar'),
  }
  console.log(`    实测 lapVar  原图=${lap.orig}  模糊σ1=${lap.blur1}（${(100 * (lap.blur1 / lap.orig - 1)).toFixed(1)}%）  模糊σ2=${lap.blur2}（${(100 * (lap.blur2 / lap.orig - 1)).toFixed(1)}%）  锐化=${lap.sharp}（+${(100 * (lap.sharp / lap.orig - 1)).toFixed(1)}%）`)
  assertBidirectional('lapVar', lap)
  // 剂量单调的"硬"版本：σ=2 必须比 σ=1 掉得更多（不是"差不多平"）
  assert.ok(lap.blur2 < 0.5 * lap.blur1, `σ=2 要比 σ=1 更平一个量级（实测 ${lap.blur2} vs ${lap.blur1}）`)
})

test('纪律 · 双向正对照：只测单方向 / 剂量不单调的"细节指标"必须当场被拒（机制自检）', () => {
  // 这正是 stepRatio 翻车的形状：模糊降、锐化**也降**（只测一边就完全合格）
  assert.throws(
    () => assertBidirectional('zzOneWay', { orig: 100, blur1: 40, blur2: 20, sharp: 99 }),
    /锐化必须显著上升/,
  )
  // 剂量不单调：σ=2 反而比 σ=1 高
  assert.throws(
    () => assertBidirectional('zzNoDose', { orig: 100, blur1: 60, blur2: 70, sharp: 200 }),
    /剂量必须单调/,
  )
  // 清单对账：每个声称"细节"的指标都必须真被双向标定过
  const missing = DETAIL_METRICS.filter((n) => !BIDIRECTIONAL.has(n))
  assert.deepEqual(missing, [], `声称细节但没做双向正对照：${missing.join(' / ')}（只测模糊一个方向不算标定）`)
  // 量化指标不许混进细节清单（两套正对照不许混用）
  assert.deepEqual(DETAIL_METRICS.filter((n) => QUANT_METRICS.includes(n)), [], '量化指标不能同时算细节指标')
  console.log(`    实测 细节指标清单=[${DETAIL_METRICS.join(',')}] 双向已标定=[${[...BIDIRECTIONAL].sort().join(',')}] 量化指标清单=[${QUANT_METRICS.join(',')}]`)
})

// ---------------------------------------------------------------- 9. 纪律：新指标必须带正对照
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
  } else if (kind === 'noContentSanity') {
    // 把"圈太小 → 可疑"两条门槛都降成 0（= 检查失效）：content(luma:200) 圈到白芯也不会被标出来。
    const before = src
    src = src.replace('const MASK_SUSPECT_MIN_AREA_PCT = 1;', 'const MASK_SUSPECT_MIN_AREA_PCT = 0;')
    src = src.replace('const MASK_SUSPECT_MIN_BBOX_PCT = 5;', 'const MASK_SUSPECT_MIN_BBOX_PCT = 0;')
    assert.notEqual(src, before, '变异没落到源码上（健全性门槛常量对不上）')
  } else if (kind === 'diffAsContent') {
    // 把 diff 退回 content 的实现（luma>=200）：diff 的 recall 会当场塌成 0.03
    const before = src
    src = src.replace(
      'for (let i = 0; i < n; i++) seed[i] = Math.abs(lum[i] - ref.lum[i]) > delta ? 1 : 0;',
      'for (let i = 0; i < n; i++) seed[i] = lum[i] >= 200 ? 1 : 0;   // 变异：退回 content(luma:200)',
    )
    assert.notEqual(src, before, '变异没落到源码上（diff 的种子那一行对不上）')
  } else if (kind === 'stepAsDetail') {
    // 把 stepRatio 改成随"唯一取值个数"变化（= 拿它当细节量）：模糊/锐化就都翻得动了，口径测试必须红
    const before = src
    src = src.replace(
      'return nonEmpty ? +(cliffs / nonEmpty).toFixed(5) : 0;',
      'return +(nonEmpty / 256).toFixed(5);   // 变异：改成"取值个数"= 当细节指标用',
    )
    assert.notEqual(src, before, '变异没落到源码上（stepRatio 的返回那一行对不上）')
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
  assert.throws(() => checkLedger(Object.keys(MOD.EXTRACTORS), [...EXTRACTORS_WITH_POSITIVE_CONTROL, 'ghostMetric']), /清单注水/)
})

// ---------------------------------------------------------------- 0.12.0 的三条：掩膜与口径的牙
test('弄坏能红 ④：删掉 content 健全性门槛 → maskSuspicious 断言必红（不报错不崩，只是悄悄量错）', () => {
  const mut = loadMutant('noContentSanity')
  const opts = { mask: { mode: 'content', luma: 200, dilate: 0, minAreaPct: 0.01 } }
  const out = mut.M2.extractOne(F.stage_fire, mut.M2.resolvePlan({ metrics: [{ id: 'v', extract: 'cov', opts }] }), null, false)
  console.log(`    变异后 content(luma:200) 面积=${out.maskInfo.areaPct}% suspicious=${out.maskSuspicious === true} reasons=${JSON.stringify(out.maskSuspectReasons)}`)
  // 变异版照样给数、不崩、不抛错——只是不再把人往"圈错了"上引。这恰恰是最危险的形态。
  assert.ok(typeof out.v === 'number', '变异版仍给数（不是崩了，是它不报了）')
  assert.throws(() => assert.equal(out.maskSuspicious, true, '面积 0.39% 的掩膜必须被标成"可疑"'), /可疑/)
})

test('弄坏能红 ⑤：diff 退回 content(luma:200) 的实现 → 掩膜 recall 断言必红', () => {
  const mut = loadMutant('diffAsContent')
  const px = mut.M2.makePx(mut.M2.decodePng(readFileSync(F.stage_fire)))
  const c200 = px.contentMask({ mode: 'content', luma: 200, dilate: 0, minAreaPct: 0.01 })
  const d = px.contentMask({ mode: 'diff', ref: F.stage_bg, delta: 12, dilate: 0, minAreaPct: 0.01 })
  const cr = precisionRecall(c200.m, W, H, inFireSubject, SUBJECT_N)
  const dr = precisionRecall(d.m, W, H, inFireSubject, SUBJECT_N)
  console.log(`    变异后 diff 面积=${d.areaPct}% recall=${dr.recall.toFixed(3)}（真身 1.000）  content recall=${cr.recall.toFixed(3)}`)
  assert.throws(
    () => assert.ok(dr.recall > 3 * cr.recall, `diff 的 recall 必须明显优于 content（${dr.recall.toFixed(3)} vs ${cr.recall.toFixed(3)}）`),
    /diff 的 recall 必须明显优于/,
  )
})

test('弄坏能红 ⑥：把 stepRatio 改成随"取值个数"变化（= 当细节指标用）→ 口径断言必红', () => {
  const mut = loadMutant('stepAsDetail')
  const pm = (file) => mut.M2.extractOne(file, mut.M2.resolvePlan({ metrics: [{ id: 'v', extract: 'stepRatio' }] }), null, false).v
  const sr = { base: pm(F.det_base), blur1: pm(F.det_blur1), blur2: pm(F.det_blur2), sharp: pm(F.det_sharp) }
  const spread = Math.max(sr.base, sr.blur1, sr.blur2, sr.sharp) - Math.min(sr.base, sr.blur1, sr.blur2, sr.sharp)
  console.log(`    变异后 stepRatio  base=${sr.base} blur1=${sr.blur1} blur2=${sr.blur2} sharp=${sr.sharp} 波动=${spread.toFixed(4)}（门槛 0.05）`)
  assert.throws(() => assert.ok(spread <= 0.05, 'stepRatio 在模糊/锐化上的波动必须很小'), /波动必须很小/)
})


