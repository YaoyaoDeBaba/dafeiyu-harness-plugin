// Selfloop · 参考图量测（ref-probe）：把「参考长什么样」变成一张可复用的特征表
//
// 为什么有这个工具（2026-11-16 实战教训）：
//   上一次做雷暴，我没量参考就直接定了阈值（云占 45%、p99 0.97…全是拍的），
//   用户一句"这些还用我点头？"才反应过来——**调查员没干活**。
//   这个工具把"量参考"这件事从"每次现写一段 python"变成一条命令，
//   产出直接能塞进 research.json 的 extracted[]。
//
// 用法：
//   node harness/ref-probe.mjs <参考图或帧目录> [--top 0.45] [--json <输出>] [--region x0,y0,x1,y1]
//   node harness/ref-probe.mjs shots/r1.png --json research.extracted.json
//
// 输出（人看的表）：
//   mean / p50 / p95 / p99 亮度；冷色/暖色占比；光晕占比（中亮偏蓝）；亮部占比；
//   上部区域覆盖率（相对四角估计的背景）；背景中位色；非黑占比。
// 依赖：只用 node 内置（zlib），零第三方包。
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { extname, join, basename } from 'node:path'

/** 极简 PNG 解码：8bit、非隔行、RGB(2) / RGBA(6) / 灰度(0)。够用了。 */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let off = 8
  let width = 0, height = 0, colorType = 0, bitDepth = 0, interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit PNG（实际 ' + bitDepth + '）')
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (channels === 0) throw new Error('不支持的 colorType ' + colorType)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]; pos += 1
    const line = raw.subarray(pos, pos + stride); pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 0xff
    }
  }
  return { width, height, channels, data: out }
}

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))]

/** 对一张图算特征；region 是像素矩形 [x0,y0,x1,y1]（开区间），top 是"上部区域"的高度占比 */
export function probeImage(img, opts = {}) {
  const { width: W, height: H, channels: C, data: D } = img
  const top = opts.top ?? 0.45
  const region = opts.region ?? [0, 0, W, H]
  const [x0, y0, x1, y1] = region.map((v, i) => Math.max(0, Math.min(i % 2 === 0 ? W : H, Math.round(v))))

  // 背景：四角 8×8 中位
  const corners = []
  const pushCorner = (cx, cy) => {
    for (let y = cy; y < Math.min(cy + 8, H); y += 1) {
      for (let x = cx; x < Math.min(cx + 8, W); x += 1) {
        const i = (y * W + x) * C
        corners.push([D[i] / 255, D[i + 1] / 255, D[i + 2] / 255])
      }
    }
  }
  pushCorner(0, 0); pushCorner(W - 8, 0); pushCorner(0, H - 8); pushCorner(W - 8, H - 8)
  const bg = [0, 1, 2].map((ch) => {
    const arr = corners.map((c) => c[ch]).sort((a, b) => a - b)
    return arr[Math.floor(arr.length / 2)]
  })

  let sum = 0, n = 0, cold = 0, warm = 0, glow = 0, bright = 0, nonBlack = 0
  let topHit = 0, topTotal = 0
  const lums = []
  const topY1 = Math.round(H * top)
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * W + x) * C
      const r = D[i] / 255, g = D[i + 1] / 255, b = D[i + 2] / 255
      const L = lum(r, g, b)
      sum += L; n += 1; lums.push(L)
      const drb = b - r
      if (drb > 0.06) cold += 1
      if (r - b > 0.06) warm += 1
      if (L > 0.40 && L <= 0.75 && drb > 0.05) glow += 1
      if (L > 0.85 && drb > 0.03) bright += 1
      if (L > 0.02) nonBlack += 1
      if (y < topY1) {
        topTotal += 1
        const dist = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2])
        if (dist > 0.10) topHit += 1
      }
    }
  }
  lums.sort((a, b) => a - b)
  const f = (v) => Number(v.toFixed(4))
  return {
    width: W, height: H,
    mean: f(sum / Math.max(1, n)),
    p50: f(quantile(lums, 0.5)),
    p95: f(quantile(lums, 0.95)),
    p99: f(quantile(lums, 0.99)),
    coldFrac: f(cold / Math.max(1, n)),
    warmFrac: f(warm / Math.max(1, n)),
    glowFrac: f(glow / Math.max(1, n)),
    brightFrac: f(bright / Math.max(1, n)),
    topCoverage: f(topHit / Math.max(1, topTotal)),
    bg: bg.map(f),
    nonBlackFrac: f(nonBlack / Math.max(1, n))
  }
}

export function probeFile(file, opts = {}) {
  const img = decodePng(readFileSync(file))
  return { file, ...probeImage(img, opts) }
}

/** 汇总多张：给均值 + 极值，报告里一眼看出"参考的波动范围" */
export function summarize(list) {
  if (list.length === 0) return null
  const keys = ['mean', 'p50', 'p95', 'p99', 'coldFrac', 'warmFrac', 'glowFrac', 'brightFrac', 'topCoverage']
  const out = { count: list.length }
  for (const k of keys) {
    const vals = list.map((x) => x[k]).sort((a, b) => a - b)
    out[k] = { min: vals[0], med: vals[Math.floor(vals.length / 2)], max: vals[vals.length - 1] }
  }
  return out
}

const isMain = process.argv[1] && process.argv[1].endsWith('ref-probe.mjs')
if (isMain) {
  const args = process.argv.slice(2)
  const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : def }
  const target = args.find((a) => !a.startsWith('--'))
  if (!target) { console.error('用法：node harness/ref-probe.mjs <图片或帧目录> [--top 0.45] [--region x0,y0,x1,y1] [--json out.json]'); process.exit(2) }
  const opts = { top: Number(arg('top', '0.45')) }
  const region = arg('region', '')
  if (region) opts.region = region.split(',').map(Number)

  let files = []
  const st = statSync(target)
  if (st.isDirectory()) {
    files = readdirSync(target).filter((f) => /\.(png|PNG)$/.test(extname(f) || f)).map((f) => join(target, f)).sort()
  } else files = [target]
  if (files.length === 0) { console.error('目录里没有 PNG'); process.exit(2) }

  const rows = files.map((f) => {
    try { return probeFile(f, opts) } catch (e) { return { file: f, error: e.message } }
  })
  const ok = rows.filter((r) => !r.error)
  const sum = summarize(ok)

  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('file', 26) + 'mean   p50    p95    p99    cold   warm   glow   bright top    bg')
  for (const r of rows) {
    if (r.error) { console.log(pad(basename(r.file), 26) + 'ERR ' + r.error); continue }
    console.log(pad(basename(r.file), 26) +
      [r.mean, r.p50, r.p95, r.p99, r.coldFrac, r.warmFrac, r.glowFrac, r.brightFrac, r.topCoverage].map((v) => String(v.toFixed(3)).padEnd(6)).join(' ') +
      ' ' + r.bg.map((v) => v.toFixed(2)).join('/'))
  }
  if (sum) {
    console.log('\n汇总（' + sum.count + ' 张）：')
    for (const k of Object.keys(sum)) {
      if (k === 'count') continue
      const v = sum[k]
      console.log('  ' + pad(k, 12) + ' min ' + String(v.min.toFixed(3)).padEnd(7) + ' med ' + String(v.med.toFixed(3)).padEnd(7) + ' max ' + v.max.toFixed(3))
    }
  }
  const outPath = arg('json', '')
  if (outPath) {
    const extracted = []
    if (sum) {
      for (const k of Object.keys(sum)) {
        if (k === 'count') continue
        const v = sum[k]
        extracted.push({ what: k, value: v.med, min: v.min, max: v.max, source: files.length === 1 ? basename(files[0]) : files.length + ' 帧' })
      }
    }
    writeFileSync(outPath, JSON.stringify({ tool: 'ref-probe/1', files: files.length, extracted }, null, 2), 'utf8')
    console.log('\n已写 ' + outPath + '（可直接并进 research.json 的 extracted[]）')
  }
}
