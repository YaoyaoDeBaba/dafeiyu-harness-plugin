// 活性扫描的纯函数（可被测试/别的工具 import，无副作用）
/** 把 base 查询串里同名键替换成 value（没有就追加）——直接追加会被 URLSearchParams 取首个，等于没改 */
export function withParam(base, key, value) {
  const parts = String(base).split('&').filter(Boolean)
  let hit = false
  const out = parts.map((p) => {
    const k = p.split('=')[0]
    if (k === key) { hit = true; return key + '=' + value }
    return p
  })
  if (!hit) out.push(key + '=' + value)
  return out.join('&')
}

/** 分类：两端逐字节相同 = dead；有差异但亮度均值差 < 0.004 = weak；否则 live */
export function classifyStatus(shaChanged, maxLuma, weakThreshold = 0.004) {
  if (!shaChanged[0] && !shaChanged[1]) return 'dead'
  if (maxLuma !== 0 && maxLuma < weakThreshold) return 'weak'
  return 'live'
}
