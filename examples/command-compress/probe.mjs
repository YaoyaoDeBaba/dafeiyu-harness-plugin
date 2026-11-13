// examples/command-compress/probe.mjs —— 非图形目标（包体积预算）：把一份语料压到「目标体积比例」
//
// 观测入口约定与引擎（harness/cmdloop.mjs）一致：
//   ① 参数从 SELFLOOP_PARAMS 指向的文件读（也可 argv[2] 显式给），文件形如 {"params":{...}}；
//   ② 结果打到 stdout，一行 JSON：{ ratio, roundtrip, ms, ...诊断字段 }；
//   ③ 无随机、无外部依赖：同一组参数 → 同一份语料 → 同一个 ratio。
//
// 语料是**当场生成的**（固定 seed 的 mulberry32 + 词表），不读任何外部文件：
// 换台机器、换个日子跑，语料逐字节相同 —— 否则「ratio 变了」到底是参数变了还是语料变了就说不清。
//
// 4 个参数（zlib 的真实旋钮）：
//   level      0-9   压缩级别
//   strategy   0-3   DEFAULT / FILTERED / HUFFMAN_ONLY / RLE
//   windowBits 9-15  滑动窗口大小（log2）
//   memLevel   1-9   内部内存/哈希表大小
// 引擎按「相对步长」扰动（10%），落到整数档位上会先四舍五入 —— 所以这里也按 round+clamp 解释参数，
// 让「引擎以为改了」和「zlib 实际收到什么」是一回事（活性扫描里哪些档位是假的，原因就在这一层）。
// 已知边界：引擎是在**未取整的向量**上继续 ±10% 的（12 -> 13.2 -> 14.52），所以 14 这一档可能整轮都没被评估过。
import { readFileSync } from 'node:fs'
import { constants as zc, deflateSync, inflateSync } from 'node:zlib'

const CORPUS_BYTES = 256 * 1024 // 目标约 256KB，实际会略超（按整行拼）

// ---------------------------------------------------------------- 语料（固定 seed）
function mulberry32(seed) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildCorpus() {
  const rnd = mulberry32(0x5eed2026)
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
  const hex = (n) => {
    let s = ''
    for (let i = 0; i < n; i += 1) s += '0123456789abcdef'[Math.floor(rnd() * 16)]
    return s
  }

  const LEVELS = ['debug', 'info', 'info', 'info', 'warn', 'error']
  const SERVICES = ['api-gateway', 'order-svc', 'payment-svc', 'inventory-svc', 'user-svc', 'notify-svc']
  const ROUTES = ['/v1/orders', '/v1/orders/{id}', '/v1/pay/confirm', '/v1/stock/reserve', '/v1/users/{id}', '/v1/notify/push']
  const VERBS = ['handled', 'rejected', 'retried', 'cached', 'queued', 'flushed', 'timed out', 'ok']
  const REASONS = [
    'upstream timeout after 2 retries',
    'idempotency key replayed',
    'payload schema mismatch at field items[3].qty',
    'rate limit exceeded window=60s',
    'db pool exhausted, waited 340ms',
    'signature verify failed',
    'downstream 502 from payment-svc',
    'cold start, cache miss',
  ]

  const parts = []
  let bytes = 0
  let i = 0
  while (bytes < CORPUS_BYTES) {
    i += 1
    // 时间戳也是合成的（不取真实时间 —— 否则语料每天都变，ratio 就不可复现了）
    const sec = 1762000000 + i * 3
    const ts = new Date(sec * 1000).toISOString()
    const line =
      JSON.stringify({
        ts,
        lvl: pick(LEVELS),
        svc: pick(SERVICES),
        route: pick(ROUTES),
        msg: pick(VERBS) + ': ' + pick(REASONS),
        status: pick([200, 200, 200, 201, 204, 400, 404, 429, 500, 502]),
        ms: Math.floor(rnd() * 900) + 1,
        // 高熵部分：这两个字段决定了语料不可能被压成 0（真实日志里也是它们撑住体积）。
        // blob 的长度是按「让压缩率落在 37% 一带」实测调的（见 skills/selfloop/references/command-observe.md 第 8 节）：
        // 短了语料太可压、目标一点就到；长了熵地板高于目标、怎么调都够不到。
        trace: hex(24),
        uid: hex(8) + '-' + hex(4),
        blob: hex(232),
      }) + '\n'
    parts.push(line)
    bytes += Buffer.byteLength(line, 'utf8')
  }
  return Buffer.from(parts.join(''), 'utf8')
}

// ---------------------------------------------------------------- 读参数
const file = process.argv[2] || process.env.SELFLOOP_PARAMS
if (!file) {
  console.error('probe: 缺参数文件（argv[2] 或环境变量 SELFLOOP_PARAMS）')
  process.exit(2)
}

let doc
try {
  doc = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error(`probe: 读不到/不是合法 JSON: ${file}（${e.message}）`)
  process.exit(3)
}

const params = doc && typeof doc === 'object' && doc.params && typeof doc.params === 'object' ? doc.params : doc
const need = (k) => {
  const v = Number(params?.[k])
  if (!Number.isFinite(v)) {
    console.error(`probe: 参数 ${k} 不是数（收到 ${JSON.stringify(params?.[k])}）`)
    process.exit(4)
  }
  return v
}
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)))

const level = clampInt(need('level'), 0, 9)
const strategyIdx = clampInt(need('strategy'), 0, 3)
const windowBits = clampInt(need('windowBits'), 9, 15)
const memLevel = clampInt(need('memLevel'), 1, 9)

const STRATEGIES = [zc.Z_DEFAULT_STRATEGY, zc.Z_FILTERED, zc.Z_HUFFMAN_ONLY, zc.Z_RLE]

const corpus = buildCorpus()
const t0 = process.hrtime.bigint()
const packed = deflateSync(corpus, {
  level,
  strategy: STRATEGIES[strategyIdx],
  windowBits,
  memLevel,
})
let roundtrip = 0
try {
  roundtrip = Buffer.compare(inflateSync(packed), corpus) === 0 ? 1 : 0
} catch {
  roundtrip = 0
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6

const round6 = (v) => Number(Number(v).toFixed(6))

process.stdout.write(
  JSON.stringify({
    ratio: round6(packed.length / corpus.length),
    roundtrip,
    ms: round6(ms),
    // 诊断字段（不进 metrics，只留在 outputs/ 里当"这轮到底吃了什么参数"的证据）
    originalBytes: corpus.length,
    packedBytes: packed.length,
    reqLevel: round6(level),
    reqStrategy: round6(strategyIdx),
    reqWindowBits: round6(windowBits),
    reqMemLevel: round6(memLevel),
  }) + '\n',
)


