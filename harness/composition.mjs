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
export function autoMaskThr(img, lo = 0.02, hi = 0.20) {
  const { rgb, width, height } = lumaOf(img)
  const corner = []
  const push = (cx, cy) => {
    for (let y = cy; y < Math.min(cy + 8, height); y += 1) {
      for (let x = cx; x < Math.min(cx + 8, width); x += 1) corner.push(rgb[(y * width + x) * 3], rgb[(y * width + x) * 3 + 1], rgb[(y * width + x) * 3 + 2])
    }
  }
  push(0, 0); push(Math.max(0, width - 8), 0); push(0, Math.max(0, height - 8)); push(Math.max(0, width - 8), Math.max(0, height - 8))
  const med = (ch) => { const a = []; for (let i = ch; i < corner.length; i += 3) a.push(corner[i]); a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0 }
  const br = med(0), bg = med(1), bb = med(2)
  const BINS = 128
  const hist = new Float64Array(BINS)
  for (let i = 0; i < width * height; i += 1) {
    const d = Math.abs(rgb[i * 3] - br) + Math.abs(rgb[i * 3 + 1] - bg) + Math.abs(rgb[i * 3 + 2] - bb)
    const b = Math.max(0, Math.min(BINS - 1, Math.floor((d / 0.6) * BINS)))
    hist[b] += 1
  }
  // Otsu：在 [lo,hi] 对应的 bin 范围内找类间方差最大的阈值
  const binOf = (v) => Math.max(0, Math.min(BINS - 1, Math.round((v / 0.6) * BINS)))
  const i0 = binOf(lo), i1 = binOf(hi)
  let total = 0, sum = 0
  for (let i = 0; i < BINS; i += 1) { total += hist[i]; sum += i * hist[i] }
  let wB = 0, sumB = 0, best = -1, bestT = binOf(0.10)
  for (let i = 0; i < BINS; i += 1) {
    wB += hist[i]; if (!wB) continue
    const wF = total - wB; if (!wF) break
    sumB += i * hist[i]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (i >= i0 && i <= i1 && between > best) { best = between; bestT = i }
  }
  return (bestT / BINS) * 0.6
}

/**
 * 掩膜：默认阈值 0.10（历史口径，band 都按它标定）；传 'auto' 用 Otsu 自适应。
 * 夜场景里暗云与四角背景的通道差只有 0.088 —— 固定 0.10 会把云漏在外面，
 * 于是 topCoverage/centroidY/subjectFrac 量的是"云底那条亮带"。auto 就是为这个准备的。
 */
function maskOf(img, thr = 0.10) {
  if (thr === 'auto') thr = autoMaskThr(img)
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
export function rowProfile(img, bins = 64, topFrac = 1, maskThr = 0.10) {
  const { m, width, height } = maskOf(img, maskThr)
  // topFrac<1 时只取画面上部（云区）。原因：整幅剖面可以被"地平线亮带 / 地面雾"垫平，
  // 那样 0.9 的相关并不代表云摆得像参考。第二轮 A/B 里 B 臂就是这么拿到 0.958 的。
  const y1All = Math.max(1, Math.round(height * Math.max(0.05, Math.min(1, topFrac))))
  const rows = new Float64Array(y1All)
  for (let y = 0; y < y1All; y += 1) {
    let s = 0
    for (let x = 0; x < width; x += 1) s += m[y * width + x]
    rows[y] = s / width
  }
  const out = new Array(bins).fill(0)
  for (let b = 0; b < bins; b += 1) {
    const y0 = Math.floor((b * y1All) / bins)
    const y1 = Math.max(y0 + 1, Math.floor(((b + 1) * y1All) / bins))
    let s = 0
    for (let y = y0; y < y1 && y < y1All; y += 1) s += rows[y]
    out[b] = s / (Math.min(y1, y1All) - y0)
  }
  return out
}

/** 其余结构标量：质心 y、上部覆盖率、两侧留白、bbox 宽高比、主体占比 */
export function structureScalars(img, maskThr = 0.10) {
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

export function profileFromFile(file, bins = 64, topFrac = 1, maskThr = 0.10) {
  // topFrac 必须一路传下去 —— 第三轮 A/B 就是这个参数在中间被丢掉，导致
  // "preflight 记着 topFrac 0.45、value 却是整幅剖面"，掩膜化整轮空转（A 臂自己查出来的）。
  return rowProfile(decodePng(readFileSync(file)), bins, topFrac, maskThr)
}

export function scalarsFromFile(file, maskThr = 0.10) {
  return structureScalars(decodePng(readFileSync(file)), maskThr)
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

/**
 * 云内明暗结构（2026-11-18 复盘新增）：掩膜内亮度低于/高于阈值的占比。
 * 为什么单列：整幅 mean/p50 看不出"云是暗体还是灰雾"——实测我们 3.9% 暗部 vs 参考 25.5%，
 * 整幅指标全绿，肉眼却一眼假。这两个数是「云像不像云」的主判别量。
 */
export function toneFractions(img, darkThr = 0.25, brightThr = 0.6, maskThr = 0.10) {
  const { lum, width, height } = lumaOf(img)
  const { m } = maskOf(img, maskThr)
  let n = 0, dark = 0, bright = 0, sum = 0
  for (let i = 0; i < m.length; i += 1) {
    if (!m[i]) continue
    n += 1; sum += lum[i]
    if (lum[i] < darkThr) dark += 1
    if (lum[i] > brightThr) bright += 1
  }
  if (!n) return { cloudDarkFrac: 0, cloudBrightFrac: 0, cloudMeanLuma: 0, cloudPx: 0 }
  return {
    cloudDarkFrac: dark / n,
    cloudBrightFrac: bright / n,
    cloudMeanLuma: sum / n,
    cloudPx: n,
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


/**
 * 高频噪点率（2026-11-18 回放测试暴露的缺项）：斜视/超采样不足时，画面会碎成"雪花"，
 * 而它的**整幅亮度完全正常**——均值/分位都抓不到，肉眼一眼假（45° 海的第一版就是这样）。
 * 口径：与 3×3 均值差 > thr 的像素占比（只在亮度中低区算，避开正常的高光边缘）。
 */
export function speckleRatio(img, thr = 0.12, lo = 0.02, hi = 0.85) {
  const { lum, width, height } = lumaOf(img)
  let n = 0, hit = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      const v = lum[i]
      if (v < lo || v > hi) continue
      let s = 0
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) s += lum[i + dy * width + dx]
      const mean = s / 9
      n += 1
      if (Math.abs(v - mean) > thr) hit += 1
    }
  }
  return n ? hit / n : 0
}

/**
 * 白沫连通性：亮部像素（>thr）连成片的程度。
 * 参考里的沫是**顺浪脊的长条**（大块、少数），"糊成点"的是大量碎块。
 * 返回 foamShare（亮部占比）、foamMeanComp（平均连通块像素数）、foamMaxShare（最大块占亮部比例）。
 */
export function foamComponents(img, thr = 0.75) {
  const { lum, width, height } = lumaOf(img)
  const seen = new Uint8Array(width * height)
  let foam = 0, comps = 0, total = 0, maxComp = 0
  const stack = []
  for (let i = 0; i < lum.length; i += 1) if (lum[i] > thr) foam += 1
  for (let i = 0; i < lum.length; i += 1) {
    if (seen[i] || lum[i] <= thr) continue
    comps += 1
    let size = 0
    stack.push(i)
    seen[i] = 1
    while (stack.length) {
      const j = stack.pop()
      size += 1
      const x = j % width, y = (j - x) / width
      const nb = [x > 0 ? j - 1 : -1, x < width - 1 ? j + 1 : -1, y > 0 ? j - width : -1, y < height - 1 ? j + width : -1]
      for (const k of nb) {
        if (k < 0 || seen[k] || lum[k] <= thr) continue
        seen[k] = 1
        stack.push(k)
      }
    }
    total += size
    if (size > maxComp) maxComp = size
  }
  return {
    foamShare: lum.length ? foam / lum.length : 0,
    foamMeanComp: comps ? total / comps : 0,
    foamMaxShare: total ? maxComp / total : 0,
  }
}


/**
 * 掩膜健康度（2026-11-18 第三轮 A/B 暴露）：主体掩膜是不是"只罩住一条亮带"。
 * 现场：夜雷暴参考里，暗云与四角背景的通道差只有 0.088 < 0.10 阈值 —— **云根本不算主体**，
 * 真正的"主体"是云底那条亮带。于是 topCoverage/centroidY/subjectFrac 量的不是云。
 * 返回：maskFrac（主体占比）、rowBandMax（最集中的 20% 高度带里占了多少主体像素）、verdict。
 */
export function maskHealth(img, maskThr = 0.10) {
  const { m, width, height } = maskOf(img, maskThr)
  let total = 0
  const rows = new Float64Array(height)
  for (let y = 0; y < height; y += 1) {
    let s = 0
    for (let x = 0; x < width; x += 1) s += m[y * width + x]
    rows[y] = s
    total += s
  }
  const band = Math.max(1, Math.round(height * 0.2))
  let best = 0
  for (let y0 = 0; y0 + band <= height; y0 += 1) {
    let s = 0
    for (let y = y0; y < y0 + band; y += 1) s += rows[y]
    if (s > best) best = s
  }
  const rowBandMax = total ? best / total : 0
  return {
    maskFrac: width * height ? total / (width * height) : 0,
    rowBandMax,
    verdict: rowBandMax > 0.6 ? 'band-dominated' : 'ok',
  }
}


/**
 * 掩膜敏感性（第 1 天 hardening）：同一帧在阈值上下浮动 40% 时，主体占比变化多少。
 * 变化大 = 这个判据在这张图上"靠不住"（阈值一动结论就翻），不该拿去验收。
 */
export function maskSensitivity(img, thr = 0.10) {
  const base = thr === 'auto' ? autoMaskThr(img) : thr
  const at = (t) => {
    const { m, width, height } = maskOf(img, t)
    let hit = 0
    for (let i = 0; i < m.length; i += 1) hit += m[i]
    return hit / (width * height)
  }
  const lo = at(base * 0.6), mid = at(base), hi = at(base * 1.4)
  const delta = Math.max(Math.abs(lo - mid), Math.abs(hi - mid)) / Math.max(1e-6, mid)
  return { thr: base, fracLo: lo, fracMid: mid, fracHi: hi, delta }
}
