// 非图像领域的「结构指纹」示例（L3，2026-11-18）
//
// 为什么要有这两个：L1 的基座（extracted.kind='profile' + criteria.minCorr + verify.profiles）
// 如果只能配图像提取器，那它就是个渲染专用件——**总量判据抓不到的"排列"问题，各领域都有**。
// 这两个提取器故意做成"总量完全相同、排列不同"的对照，用来证明判据抓的是排列而不是数量。
//
// 用法：领域作者照这个形状写自己的 extractor —— f(观测) → 定长数组（每桶 0~1）；
// 然后把候选剖面写进 verify.json 的 { profiles: { <metric>: [...] } } 即可，不需要改引擎。

/** 把任意序列分桶（默认取每桶均值），再按最大值归一；空序列返回全 0 */
export function binsFromSeries(values, bins = 32) {
  const out = new Array(bins).fill(0)
  if (!values.length) return out
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const counts = new Array(bins).fill(0)
  const totals = new Array(bins).fill(0)
  for (const v of values) {
    let b = Math.floor(((v - min) / span) * bins)
    if (b >= bins) b = bins - 1
    if (b < 0) b = 0
    counts[b] += 1
  }
  const maxCount = Math.max(...counts, 1)
  for (let i = 0; i < bins; i += 1) out[i] = counts[i] / maxCount
  totals.fill(0)
  return out
}

/**
 * 日志指纹：把事件按时间轴分桶，得到「每桶里有多少事件」的形状。
 * @param events [{ at: 毫秒 }]
 * @param opts { bins, from, to }
 * 参考形态：错误扎堆在启动后几秒（一簇）。劣化形态：同样的条数，均匀散布在整个窗口。
 * 注意：这两种形态的 **事件总数完全相同** —— 只数条数的标量判据分不出来。
 */
export function logBurstProfile(events, opts = {}) {
  const bins = opts.bins || 32
  const list = (events || []).map((e) => Number(e && e.at)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const out = new Array(bins).fill(0)
  if (!list.length) return out
  const from = Number.isFinite(opts.from) ? opts.from : list[0]
  const to = Number.isFinite(opts.to) ? opts.to : list[list.length - 1]
  const span = (to - from) || 1
  const counts = new Array(bins).fill(0)
  for (const at of list) {
    let b = Math.floor(((at - from) / span) * bins)
    if (b >= bins) b = bins - 1
    if (b < 0) b = 0
    counts[b] += 1
  }
  const maxCount = Math.max(...counts, 1)
  for (let i = 0; i < bins; i += 1) out[i] = counts[i] / maxCount
  return out
}

/**
 * 时延指纹：把「每次调用的耗时」按时间顺序分桶，得到「延迟随时间的形状」。
 * 参考形态：前几次冷启高、之后平稳；劣化形态：**均值相同**但每桶都在抖（形状变平/变毛）。
 * @param samples [{ at, ms }]
 */
export function latencyProfile(samples, opts = {}) {
  const bins = opts.bins || 32
  const list = (samples || [])
    .map((s, i) => ({ at: Number.isFinite(Number(s && s.at)) ? Number(s.at) : i, ms: Number(s && s.ms) }))
    .filter((s) => Number.isFinite(s.ms))
    .sort((a, b) => a.at - b.at)
  const out = new Array(bins).fill(0)
  if (!list.length) return out
  const sums = new Array(bins).fill(0)
  const counts = new Array(bins).fill(0)
  for (let i = 0; i < list.length; i += 1) {
    let b = Math.floor((i / list.length) * bins)
    if (b >= bins) b = bins - 1
    sums[b] += list[i].ms
    counts[b] += 1
  }
  const means = sums.map((s, i) => (counts[i] ? s / counts[i] : 0))
  const max = Math.max(...means, 1e-9)
  for (let i = 0; i < bins; i += 1) out[i] = means[i] / max
  return out
}
