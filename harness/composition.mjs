// 结构指纹（composition signature）—— L2 的图像实现
//
// 为什么需要它（2026-11-18 实测）：一次干净 A/B 里，两条臂的**分布类**判据（mean/p50/p95/p99/glow）
// 全在参考带内，但一条的云是「横贯画面的天花板」、另一条是「一团紧凑云体」。判据测不出这件事。
// 补的是一类**对排列敏感**的判据：行覆盖率剖面（row profile）+ 质心 + 留白 + bbox。
// 实测分离度：对参考的剖面相关性，构图错的那条 0.094，构图对的那条 0.538，参考自身 1.000。
//
// L1（通用基座）在 pipeline 里：extracted[].kind='profile' + criteria[].kind='profile' + minCorr。
// 本文件只负责「图像 → 剖面」这一种提取器；别的领域（日志/接口/UI）照同样的形状自己写提取器即可。

import { readFileSync } from 'node:fs'
import { decodePng } from './ref-probe.mjs'

const LUM = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b

/** 亮度数组（0~1），宽高由调用方给 */
function lumaOf(img) {
  const { width, height, channels, data } = img
  const out = new Float64Array(width * height)
  const rgb = new Float64Array(width * height * 3)
  for (let i = 0, p = 0; i < out.length; i += 1, p += channels) {
    const r = data[p], g = channels >= 3 ? data[p + 1] : r, b = channels >= 3 ? data[p + 2] : r
    out[i] = LUM(r, g, b) / 255
    rgb[i * 3] = r / 255; rgb[i * 3 + 1] = g / 255; rgb[i * 3 + 2] = b / 255
  }
  return { lum: out, rgb, width, height }
}

function quantile(arr, q) {
  const a = Array.from(arr).sort((x, y) => x - y)
  if (a.length === 0) return 0
  const pos = (a.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return a[lo] + (a[hi] - a[lo]) * (pos - lo)
}

/**
 * 主体掩膜：**相对背景**（四角 8×8 中位色）的通道差 > thr，与 ref-probe 的 topCoverage 同口径。
 *
 * 为什么不用「自身分位」：分位掩膜恒选出固定比例像素，对"总量"完全免疫——
 * 实测翻车过：云团半径 1800→1400、coverage 0.34→0.30，topCoverage 只从 0.726 动到 0.717。
 * 结构指纹要抓的是「排列 + 多少」，所以掩膜必须锚在背景上，而不是锚在自己的直方图上。
 */
function maskOf(img, thr = 0.10) {
  const { lum, width, height, rgb } = lumaOf(img)
  const corners = []
  const push = (cx, cy) => {
    for (let y = cy; y < Math.min(cy + 8, height); y += 1) {
      for (let x = cx; x < Math.min(cx + 8, width); x += 1) corners.push(rgb[(y * width + x) * 3], rgb[(y * width + x) * 3 + 1], rgb[(y * width + x) * 3 + 2])
    }
  }
  push(0, 0); push(Math.max(0, width - 8), 0); push(0, Math.max(0, height - 8)); push(Math.max(0, width - 8), Math.max(0, height - 8))
  const med = (ch) => {
    const arr = []
    for (let i = ch; i < corners.length; i += 3) arr.push(corners[i])
    arr.sort((a, b) => a - b)
    return arr.length ? arr[Math.floor(arr.length / 2)] : 0
  }
  const br = med(0), bg = med(1), bb = med(2)
  const m = new Uint8Array(width * height)
  for (let i = 0; i < m.length; i += 1) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2]
    m[i] = Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) > thr ? 1 : 0
  }
  return { m, width, height }
}

/**
 * 行覆盖率剖面（默认 64 桶）：每行「有多少比例是主体」。
 * 这是最能区分「一团紧凑主体」与「横贯画面的天花板」的量。
 */
export function rowProfile(img, bins = 64) {
  const { m, width, height } = maskOf(img)
  const rows = new Float64Array(height)
  for (let y = 0; y < height; y += 1) {
    let s = 0
    for (let x = 0; x < width; x += 1) s += m[y * width + x]
    rows[y] = s / width
  }
  const out = new Array(bins).fill(0)
  for (let b = 0; b < bins; b += 1) {
    const y0 = Math.floor((b * height) / bins)
    const y1 = Math.max(y0 + 1, Math.floor(((b + 1) * height) / bins))
    let s = 0
    for (let y = y0; y < y1 && y < height; y += 1) s += rows[y]
    out[b] = s / (Math.min(y1, height) - y0)
  }
  return out
}

/** 其余结构标量：质心 y、上部覆盖率、两侧留白、bbox 宽高比、主体占比 */
export function structureScalars(img) {
  const { m, width, height } = maskOf(img)
  let tot = 0, sy = 0, sx = 0
  let minX = width, maxX = -1, minY = height, maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!m[y * width + x]) continue
      tot += 1; sy += y; sx += x
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const frac = (x0, y0, x1, y1) => {
    let s = 0, n = 0
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) { s += m[y * width + x]; n += 1 }
    }
    return n ? s / n : 0
  }
  const topCov = frac(0, 0, width, Math.floor(height * 0.45))
  const leftSky = 1 - frac(0, Math.floor(height * 0.10), Math.floor(width * 0.12), Math.floor(height * 0.45))
  const rightSky = 1 - frac(Math.floor(width * 0.88), Math.floor(height * 0.10), width, Math.floor(height * 0.45))
  const bw = maxX >= 0 ? (maxX - minX + 1) / width : 0
  const bh = maxY >= 0 ? (maxY - minY + 1) / height : 0
  return {
    centroidY: tot ? (sy / tot) / height : 0.5,
    centrowX: tot ? (sx / tot) / width : 0.5,
    topCoverage: topCov,
    skyExposure: (leftSky + rightSky) / 2,
    bboxAspect: bh > 0 ? bw / bh : 0,
    subjectFrac: tot / (width * height),
  }
}

export function profileFromFile(file, bins = 64) {
  return rowProfile(decodePng(readFileSync(file)), bins)
}

export function scalarsFromFile(file) {
  return structureScalars(decodePng(readFileSync(file)))
}

/** 皮尔逊相关；任一序列方差为 0 时返回 0（别把常量当"完美匹配"） */
export function profileCorr(a, b) {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  let sa = 0, sb = 0
  for (let i = 0; i < n; i += 1) { sa += a[i]; sb += b[i] }
  const ma = sa / n, mb = sb / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i += 1) {
    const u = a[i] - ma, v = b[i] - mb
    num += u * v; da += u * u; db += v * v
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

/**
 * 用「留一法」校准 minCorr：每张参考帧 vs 其余帧的中位剖面。
 * 这样得到的是**同一构图族内部**的自然离散度——阈值必须从这个分布来，不许拍脑袋。
 * 建议值 = 下限 - 0.05 余量，且不低于 0.5。
 */
export function calibrateMinCorr(profiles, margin = 0.05) {
  if (!Array.isArray(profiles) || profiles.length < 3) return null
  const loo = profiles.map((p, i) => {
    const others = profiles.filter((_, j) => j !== i)
    return profileCorr(medianProfile(others), p)
  }).sort((a, b) => a - b)
  const q = (t) => loo[Math.min(loo.length - 1, Math.max(0, Math.round((loo.length - 1) * t)))]
  const round2 = (v) => Math.round(v * 100) / 100
  return {
    n: loo.length,
    min: round2(loo[0]),
    p25: round2(q(0.25)),
    med: round2(q(0.5)),
    max: round2(loo[loo.length - 1]),
    suggested: Math.max(0.5, round2(loo[0] - margin)),
  }
}

/** 多帧聚合成一条参考剖面（逐桶取中位） */
export function medianProfile(list) {
  if (!list.length) return []
  const bins = list[0].length
  const out = new Array(bins).fill(0)
  for (let b = 0; b < bins; b += 1) {
    const col = list.map((p) => p[b]).sort((x, y) => x - y)
    const mid = col.length >> 1
    out[b] = col.length % 2 ? col[mid] : (col[mid - 1] + col[mid]) / 2
  }
  return out
}
