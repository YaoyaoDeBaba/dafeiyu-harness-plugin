// 活性扫描（2026-11-18）：搜索之前先证明「你要调的旋钮真的会动」。
//
// 为什么单列一个工具：一次试刀里按配方把 lightSteps 6→1，抓出来的帧**逐字节相同**——
// 20 张候选里有 5 张在死参数上空转。SKILL 里早写着「没扫活性不许搜索」，但一直只是规矩。
//
// 用法：
//   node harness/liveness.mjs --run <run目录> --probe probe.json [--shots <抓帧目录>]
// probe.json：
//   { "capture": "node <shoot.mjs> --out {out} --query '{params}'",
//     "baseline": "sigma=0.08&ambient=0.02",
//     "params": { "sigma": ["0.02", "0.15"], "lightSteps": ["1", "8"] } }
// 产出 <run>/params-liveness.json：
//   { at, capture, baseline, params:[{ name, status: 'live'|'weak'|'dead', evidence }] }
//
// 判定：两端都与 baseline 逐字节相同 = dead；有差异但亮度均值差 < 0.004 = weak；否则 live。
// 注意：这里是**观测通道无关**的——capture 可以换成任何"给参数拍一张"的命令。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { probeFile } from './ref-probe.mjs'

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const runDir = arg('run', '')
const probePath = arg('probe', '')
if (!runDir || !probePath) { console.error('用法: node harness/liveness.mjs --run <run目录> --probe probe.json'); process.exit(2) }

const probe = JSON.parse(readFileSync(probePath, 'utf8'))
if (!probe.capture || !probe.baseline || !probe.params) { console.error('probe.json 需要 capture / baseline / params'); process.exit(2) }
const shotsDir = resolve(runDir, arg('shots', 'shots/liveness'))
mkdirSync(shotsDir, { recursive: true })

function capture(params, name) {
  const out = join(shotsDir, name + '.png')
  const cmd = String(probe.capture).replace(/\{out\}/g, out).replace(/\{params\}/g, params)
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' })
  if (!existsSync(out)) return { ok: false, out, err: (r.stderr || r.stdout || '').slice(0, 200) }
  const buf = readFileSync(out)
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16)
  let luma = null
  try { luma = probeFile(out).mean } catch { /* 非 PNG 或解不开就只用哈希 */ }
  return { ok: true, out, sha, luma }
}

const base = capture(probe.baseline, 'baseline')
if (!base.ok) { console.error('baseline 抓帧失败：' + base.err); process.exit(1) }

const results = []
for (const [name, [lo, hi]] of Object.entries(probe.params)) {
  const left = capture(probe.baseline + '&' + name + '=' + lo, name + '_lo')
  const right = capture(probe.baseline + '&' + name + '=' + hi, name + '_hi')
  const shaChanged = [left.sha !== base.sha, right.sha !== base.sha]
  const lumaDiff = [left.luma, right.luma].map((v) => (v == null || base.luma == null ? null : Math.abs(v - base.luma)))
  const maxLuma = Math.max(...lumaDiff.map((v) => (v == null ? 0 : v)))
  let status = 'live'
  if (!shaChanged[0] && !shaChanged[1]) status = 'dead'
  else if (maxLuma !== 0 && maxLuma < 0.004) status = 'weak'
  results.push({ name, range: [lo, hi], status, evidence: { sha: [left.sha, right.sha], baseSha: base.sha, shaChanged, lumaDiff, maxLuma } })
  console.log(name.padEnd(14) + ' ' + status.padEnd(5) + '  sha变化=' + shaChanged.join('/') + '  maxLumaDiff=' + maxLuma.toFixed(4))
}

const out = { at: new Date().toISOString(), capture: probe.capture, baseline: probe.baseline, shotsDir, params: results }
writeFileSync(join(runDir, 'params-liveness.json'), JSON.stringify(out, null, 2), 'utf8')
const dead = results.filter((r) => r.status === 'dead').map((r) => r.name)
console.log('\n写盘：' + join(runDir, 'params-liveness.json'))
if (dead.length) { console.log('死参数：' + dead.join('、') + '（改它们逐字节不变——别放进 plan.variables）'); process.exit(3) }
process.exit(0)
