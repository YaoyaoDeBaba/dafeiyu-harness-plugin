// Selfloop · 开工前检查（preflight）：一条命令给执行 agent 铺好跑道
//
// 为什么需要它（2026-11-16 受控实验）：
//   派了一个上下文干净的执行代理去跑一个真需求，8 分钟**零产出**——不建目录、不写文件、不改代码。
//   复盘结论：不是它不守规矩，是工具**没有起飞跑道**：
//   skill 不会自动加载，也没有一条命令说"第一步先干什么"。它只能干等。
//
// 这个脚本就是那条跑道：一次调用做完开场三件事，并告诉你下一步必须做什么。
//   node harness/preflight.mjs --run <run目录> --ref <参考图或帧目录> [--top 0.45]
//
// 它做四件事：
//   1) 建 run 目录骨架（refs/ rounds/ shots/）；
//   2) 对参考图跑 ref-probe，把量出来的特征写进 research.json.extracted[]；
//   3) 生成 research.json / intent.template.json 骨架（缺什么一目了然）；
//   4) 打印"接下来必须做什么"，并在 research/intent 未就绪时以非零码退出。
//
// 退出码：0 = 可以开工；2 = 参数不对；3 = 还没调研完；4 = 还没写 intent
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { probeFile, summarize } from './ref-probe.mjs'
function argVal(k, d) { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }

import { profileFromFile, scalarsFromFile, medianProfile, calibrateMinCorr, toneFractions, speckleRatio, foamComponents, maskHealth } from './composition.mjs'
import { decodePng } from './ref-probe.mjs'

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def }

const checkOnly = process.argv.includes('--check')
const runDir = arg('run', '')
const refArg = arg('ref', '')
const top = Number(arg('top', '0.45'))
if (!runDir) { console.error('用法: node harness/preflight.mjs --run <run目录> [--ref <参考图或帧目录>] [--check]'); process.exit(2) }
const dir = resolve(runDir)
// --check：只判定现状，不建目录、不写文件（给观察员/CI 用，任何执行器都过同一道闸）
if (!checkOnly) for (const d of ['refs', 'rounds', 'shots']) mkdirSync(join(dir, d), { recursive: true })

// ── 1) 量参考（没有 --ref 就跳过，但要明说）
let measured = null
if (refArg && !checkOnly) {
  const refPath = resolve(refArg)
  let files = []
  try {
    const st = statSync(refPath)
    files = st.isDirectory()
      ? readdirSync(refPath).filter((f) => /\.png$/i.test(f)).map((f) => join(refPath, f)).sort()
      : [refPath]
  } catch { files = [] }
  const rows = []
  const profiles = []
  const structs = []
  for (const f of files) {
    try { rows.push(probeFile(f, { top })) } catch { /* 跳过非 8bit/非 PNG */ }
    // 结构指纹（L2）：行剖面是 profile 型；质心/留白/bbox 是标量型
    try {
      profiles.push(profileFromFile(f, 64, Number(argVal('profile-top', '1'))))
      const sc = scalarsFromFile(f)
      const decoded = decodePng(readFileSync(f))
      Object.assign(sc, toneFractions(decoded))                      // 云内明暗结构
      sc.speckleRatio = speckleRatio(decoded)                        // 高频噪点率（回放暴露的缺项）
      const mh = maskHealth(decoded)                                  // 掩膜健康度：是不是只罩住一条亮带
      sc.maskFrac = mh.maskFrac
      sc.maskRowBandMax = mh.rowBandMax
      Object.assign(sc, foamComponents(decoded))                     // 白沫连通性
      structs.push(sc)
    } catch { /* 解不了就跳过 */ }
  }
  if (rows.length) measured = { count: rows.length, sum: summarize(rows), sample: basename(files[0]), profiles, structs }
}

// ── 2) research.json 骨架（已有就补 extracted，不覆盖 findings）
const researchPath = join(dir, 'research.json')
let research = { schema: 'research/1', findings: [], extracted: [], changed: [] }
if (existsSync(researchPath)) { try { research = JSON.parse(readFileSync(researchPath, 'utf8')) } catch { /* 坏文件就重建 */ } }
if (measured) {
  const keys = ['mean', 'p50', 'p95', 'p99', 'coldFrac', 'warmFrac', 'glowFrac', 'brightFrac', 'topCoverage']
  for (const k of keys) {
    const v = measured.sum[k]
    if (!v) continue
    const hit = research.extracted.find((e) => e.what === k)
    // 单帧量测打标（2026-11-18）：参考是序列时只量 1 帧 = 把阈值锁死在单帧上。
    // 实测代价：一整轮都在追一张偏亮帧的数（g001 mean 0.327 vs 24 帧中位 0.280）。
    const item = { what: k, value: v.med, min: v.min, max: v.max, source: measured.count === 1 ? measured.sample : measured.count + ' 帧' }
    if (measured.count === 1) item.singleFrame = true
    else delete item.singleFrame      // 改成量分布之后要把单帧标摘掉
    if (hit) Object.assign(hit, item); else research.extracted.push(item)
  }
}
// 结构指纹：行剖面（profile 型）+ 质心/上部覆盖率/留白/bbox（标量型）
if (measured && measured.profiles && measured.profiles.length) {
  const src = measured.count === 1 ? measured.sample : measured.count + ' 帧'
  const prof = { what: 'rowProfile', kind: 'profile', value: medianProfile(measured.profiles), source: src, topFrac: Number(argVal('profile-top', '1')) }
  if (measured.count === 1) prof.singleFrame = true
  // 阈值来自分布：留一法给一个 minCorr 建议值，写判据时直接抄（>=3 帧才算得出来）
  const cal = calibrateMinCorr(measured.profiles)
  if (cal) { prof.minCorrHint = cal.suggested; prof.loo = { min: cal.min, p25: cal.p25, med: cal.med, max: cal.max } }
  const hitP = research.extracted.find((e) => e.what === 'rowProfile')
  if (hitP) Object.assign(hitP, prof); else research.extracted.push(prof)

  const keys = ['centroidY', 'topCoverage', 'skyExposure', 'bboxAspect', 'subjectFrac', 'cloudDarkFrac', 'cloudBrightFrac', 'cloudMeanLuma', 'speckleRatio', 'foamShare', 'foamMeanComp', 'foamMaxShare', 'maskFrac', 'maskRowBandMax']
  for (const k of keys) {
    const vals = measured.structs.map((s) => s[k]).filter((v) => Number.isFinite(v))
    if (!vals.length) continue
    const sorted = vals.slice().sort((a, b) => a - b)
    const mid = sorted.length >> 1
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    const item = { what: k, value: med, min: sorted[0], max: sorted[sorted.length - 1], source: src, structure: true }
    if (measured.count === 1) item.singleFrame = true
    const hit = research.extracted.find((e) => e.what === k)
    if (hit) Object.assign(hit, item); else research.extracted.push(item)
  }
}

// 量的是分布就把单帧标整体摘掉（有些键的值恰为 0 会被上面的 continue 跳过，留着旧标会误报）
if (measured && measured.count > 1) research.extracted.forEach((e) => { if (e) delete e.singleFrame })
if (!checkOnly) writeFileSync(researchPath, JSON.stringify(research, null, 2), 'utf8')

// ── 3) intent 骨架（只建空模板，不替人拍判据）
const intentPath = join(dir, 'intent.json')
if (!checkOnly && !existsSync(intentPath)) {
  writeFileSync(intentPath, JSON.stringify({
    _说明: '这是 preflight 建的空壳：restate / criteria / anchors 由 agent 根据 research 与用户原话填，填完把 confirmed 改 true',
    version: '2', restate: '', anchors: [], criteria: [], notWanted: [],
    freeVsFixed: { fixed: [], free: [] },
    howWeVerify: { human: true, metrics: true, note: '' },
    uncertain: [], confirm: [], confirmed: false
  }, null, 2), 'utf8')
}

// ── 3.5) 预算：没有就写默认值（用户可改）
const budgetPath = join(dir, 'budget.json')
if (!checkOnly && !existsSync(budgetPath)) {
  writeFileSync(budgetPath, JSON.stringify({
    _说明: 'research: low|mid|high|max（调查强度）| maxRounds: 迭代轮次上限 | useCritic: 是否派观察员',
    research: 'high', maxRounds: 1, useCritic: false, userReview: false, resupply: true
  }, null, 2), 'utf8')
}

// ── 4) 判定 + 下一步
const f = Array.isArray(research.findings) ? research.findings : []
const url = f.filter((x) => /^https?:/.test(x.url || ''))
const used = f.filter((x) => x.used === true)
const verified = url.filter((x) => ['opensource', 'paper'].includes(x.kind))
const extracted = Array.isArray(research.extracted) ? research.extracted : []
let intent = null
try { intent = JSON.parse(readFileSync(intentPath, 'utf8')) } catch { intent = null }
const intentReady = Boolean(intent && intent.confirmed === true && (intent.criteria || []).length > 0)

console.log('=== preflight: ' + dir + ' ===')
console.log('参考量测: ' + (measured ? measured.count + ' 张，写进 extracted ' + extracted.length + ' 条' : '未提供 --ref（跳过）'))
if (measured && measured.profiles && measured.profiles.length) {
  const st = measured.structs[0] || {}
  const hintCal = calibrateMinCorr(measured.profiles)
  {
    const bandMax = measured.structs.map((s) => s.maskRowBandMax).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
    const med = bandMax.length ? bandMax[bandMax.length >> 1] : 0
    if (med > 0.6) console.log('⚠ 掩膜健康度：主体有 ' + (med * 100).toFixed(0) + '% 集中在 20% 高度带里 —— 掩膜可能只罩住了一条亮带（不是主体），topCoverage/centroidY/subjectFrac 可能量错了对象')
  }
  console.log('结构指纹: 行剖面 ' + measured.profiles[0].length + ' 桶 · 质心y ' + (st.centroidY || 0).toFixed(3) + ' · 上部覆盖 ' + (st.topCoverage || 0).toFixed(3) + ' · 留白 ' + (st.skyExposure || 0).toFixed(3))
  if (hintCal) console.log('  minCorr 建议 ' + hintCal.suggested + '（留一法：min ' + hintCal.min + ' / med ' + hintCal.med + '；阈值来自参考自身离散，别拍脑袋）')
}
if (measured && measured.count === 1) {
  console.log('  ⚠ 只量了 1 张。若参考是序列（refs/ 里有多张），先把目录指给 --ref 量分布：')
  console.log('    node harness/preflight.mjs --run <run> --ref <refs 目录>  —— 否则阈值会被锁死在这一帧上')
}
console.log('调研: findings ' + f.length + ' / 带URL ' + url.length + ' / used ' + used.length + ' / 可核(opensource·paper) ' + verified.length)
console.log('intent: ' + (intentReady ? '已确认，可开工' : '未完成（restate / criteria / anchors / confirmed）'))
console.log('预算: budget.json（research / maxRounds / useCritic）')

const todo = []
if (!measured) todo.push('① 量参考：node harness/preflight.mjs --run <run> --ref <参考图或帧目录>')
if (url.length < 2) todo.push('② 派调查员做外部调研（≥2 条带 http URL 的 findings），别自己随手搜')
if (verified.length < 1) todo.push('③ 至少 1 条 findings 是 opensource/paper（二手博客容易抄错）')
if (used.length < 1 || used.some((x) => !x.usedFor)) todo.push('④ 每条 used 写明 usedFor（它改了哪条判据/做法）')
if (!intentReady) todo.push('⑤ 填 intent.json 的 restate/criteria/anchors，confirmed 改 true')

if (todo.length) {
  console.log('\n还没到开工条件，按顺序补齐：')
  todo.forEach((t) => console.log('  ' + t))
  process.exit(url.length < 2 ? 3 : 4)
}
console.log('\n✓ 可以开工。下一步：按 intent.criteria 定方案、改代码，每轮写完写 rounds/NN.json')
