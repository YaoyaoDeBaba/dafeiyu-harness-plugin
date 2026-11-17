// harness/crash-check.mjs —— 崩坏自检（A3 · ㉞）：一张帧先证明「没崩」，再谈数值。
//
// 为什么有它：数值判据只认数。图要是崩成洋红（shader 编译失败 / 丢材质）、崩成纯色大块
// （组件没加载 / 相机没渲染）、崩成全黑全白（曝光或后处理炸了），距离算出来可能"更近"，
// 于是闭环会非常认真地收敛到一张废图上。所以崩坏自检**优先于任何数值判据**。
//
// 三条规则（任一命中 → fail）：
//   ① 洋红像素：R>0.9 且 G<0.1 且 B>0.9 的占比 > 0.1%
//   ② 纯色大块：某个连通区域方差 < 0.002 且面积 > 整帧 1%（按 8×8 块做连通域，块内像素方差）
//   ③ 全黑 / 全白：全帧均值 < 0.01（黑）；或全帧均值 > 0.97 且方差 < 0.002（白）
//
// 用法：node harness/crash-check.mjs <帧.png> [--json]     exit 0 = 没崩 / 1 = 崩了 / 2 = 读不了
// 依赖：只用 node 内置（zlib，经 ref-probe 的极简 PNG 解码），零第三方包。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './ref-probe.mjs'

export const RULES = {
  /** 洋红像素占比上限（0.1%） */
  magentaRatioMax: 0.001,
  /** 纯色块的饱和度下限：低于它的算「中性灰/灰白」，地板与天空不算崩坏 */
  flatSatMin: 0.25,

  /** 纯色块的块内方差上限 */
  flatVarMax: 0.002,
  /** 纯色块的面积下限（整帧占比） */
  flatAreaMin: 0.01,
  /** 全黑：全帧均值低于它 */
  blackMean: 0.01,
  /** 全白：全帧均值高于它，且方差低于 whiteVarMax */
  whiteMean: 0.97,
  whiteVarMax: 0.002,
  /** 连通域的块边长（像素） */
  block: 8,
}

const LUM = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b
const pct = (v) => (v * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%'

/** 连通域：块网格上 4 邻接的"方差低于阈值"的块，合并成区域，返回最大面积占整帧比例。 */
function largestFlatArea(bw, bh, sums, sumSq, satSum, counts, pixelTotal) {
  const seen = new Uint8Array(bw * bh)
  let best = 0
  const stack = []
  for (let start = 0; start < bw * bh; start += 1) {
    if (seen[start]) continue
    const n0 = counts[start]
    let flat0 = false
    if (n0 > 0) {
      const m = sums[start] / n0
      const sat0 = satSum[start] / n0
      flat0 = sumSq[start] / n0 - m * m < RULES.flatVarMax && sat0 > RULES.flatSatMin
    }
    seen[start] = 1
    if (!flat0) continue
    let area = 0
    stack.length = 0
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()
      area += counts[i]
      const x = i % bw
      const y = (i - x) / bw
      const push = (j) => {
        if (j < 0 || j >= bw * bh || seen[j]) return
        seen[j] = 1
        const n = counts[j]
        if (n <= 0) return
        const m = sums[j] / n
        const satJ = satSum[j] / n
        if (sumSq[j] / n - m * m < RULES.flatVarMax && satJ > RULES.flatSatMin) stack.push(j)
      }
      if (x > 0) push(i - 1)
      if (x + 1 < bw) push(i + 1)
      if (y > 0) push(i - bw)
      if (y + 1 < bh) push(i + bw)
    }
    if (area > best) best = area
  }
  return pixelTotal > 0 ? best / pixelTotal : 0
}

/**
 * 崩坏自检。
 * @returns {{ magenta:number, magentaHit:boolean, flatBlock:boolean, flatBlockArea:number,
 *             black:boolean, white:boolean, fail:boolean, reasons:string[], mean:number,
 *             variance:number, width:number, height:number, error?:string }}
 *   magenta = 洋红像素占比（0~1，判据是 > 0.001 就崩）
 */
export function crashCheck(pngPath) {
  const out = {
    magenta: 0,
    magentaHit: false,
    flatBlock: false,
    flatBlockArea: 0,
    black: false,
    white: false,
    fail: false,
    reasons: [],
    mean: 0,
    variance: 0,
    width: 0,
    height: 0,
  }
  let img
  try {
    img = decodePng(readFileSync(pngPath))
  } catch (e) {
    out.fail = true
    out.error = String((e && e.message) || e)
    out.reasons.push('读不出这张图：' + out.error)
    return out
  }
  const { width: W, height: H, channels: C, data: D } = img
  out.width = W
  out.height = H
  const total = W * H
  if (!total) {
    out.fail = true
    out.reasons.push('空图（0 像素）')
    return out
  }

  const B = RULES.block
  const bw = Math.ceil(W / B)
  const bh = Math.ceil(H / B)
  const sums = new Float64Array(bw * bh)
  const sumSq = new Float64Array(bw * bh)
  const counts = new Uint32Array(bw * bh)
  // 饱和度：纯色大块只统计「高饱和」区域——洋红/绿幕这类错误色会命中，灰色地板/天空不会
  const satSum = new Float64Array(bw * bh)

  let magentaCount = 0
  let sum = 0
  let sumSqAll = 0
  for (let y = 0; y < H; y += 1) {
    const by = Math.floor(y / B)
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * C
      const r = D[i] / 255
      const g = D[i + 1] / 255
      const b = D[i + 2] / 255
      if (r > 0.9 && g < 0.1 && b > 0.9) magentaCount += 1
      const L = LUM(r, g, b)
      sum += L
      sumSqAll += L * L
      const bi = by * bw + Math.floor(x / B)
      sums[bi] += L
      sumSq[bi] += L * L
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      satSum[bi] += mx - mn
      counts[bi] += 1
    }
  }

  out.mean = sum / total
  out.variance = Math.max(0, sumSqAll / total - out.mean * out.mean)
  out.magenta = magentaCount / total
  out.magentaHit = out.magenta > RULES.magentaRatioMax
  if (out.magentaHit) out.reasons.push('洋红像素 ' + pct(out.magenta) + ' > ' + pct(RULES.magentaRatioMax) + '（shader / 材质没加载）')

  out.flatBlockArea = largestFlatArea(bw, bh, sums, sumSq, satSum, counts, total)
  out.flatBlock = out.flatBlockArea > RULES.flatAreaMin
  if (out.flatBlock) out.reasons.push('纯色大块 ' + pct(out.flatBlockArea) + ' > ' + pct(RULES.flatAreaMin) + '（方差 < ' + RULES.flatVarMax + '）')

  out.black = out.mean < RULES.blackMean
  if (out.black) out.reasons.push('全帧均值 ' + out.mean.toFixed(4) + ' < ' + RULES.blackMean + '（全黑）')

  out.white = out.mean > RULES.whiteMean && out.variance < RULES.whiteVarMax
  if (out.white) out.reasons.push('全帧均值 ' + out.mean.toFixed(4) + ' > ' + RULES.whiteMean + ' 且方差 ' + out.variance.toFixed(5) + ' < ' + RULES.whiteVarMax + '（全白）')

  out.fail = out.reasons.length > 0
  return out
}

function main(argv) {
  const json = argv.includes('--json')
  const file = argv.find((a) => !a.startsWith('-'))
  if (!file) {
    console.error('用法：node harness/crash-check.mjs <帧.png> [--json]')
    process.exit(2)
    return
  }
  const r = crashCheck(resolve(file))
  if (json) {
    console.log(JSON.stringify(r, null, 2))
  } else if (r.error) {
    console.log('读不了：' + file + ' —— ' + r.error)
  } else if (r.fail) {
    console.log('崩了：' + file + '（' + r.width + '×' + r.height + '）')
    r.reasons.forEach((x) => console.log('  - ' + x))
  } else {
    console.log('没崩：' + file + '（' + r.width + '×' + r.height + '，均值 ' + r.mean.toFixed(3) + '，洋红 ' + pct(r.magenta) + '，最大纯色块 ' + pct(r.flatBlockArea) + '）')
  }
  process.exit(r.error ? 2 : r.fail ? 1 : 0)
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main(process.argv.slice(2))
