// quick.mjs · 单靶快速搜索（2026-11-18 A/B 后瘦身）
//
// 为什么有它：A/B 里流水线臂 95 分钟只拍了 20 张真帧 —— 力气都花在建 13 个节点、填表单、写票上。
// 这个工具把「判据 → 抓帧 → 量测 → 算 err → 记 trace」压成一条命令，**每拍一张就立刻知道差在哪**。
//
// 用法：
//   node harness/quick.mjs --run <run目录> --url <页面> --ref <参考帧目录> \
//        [--params '{"sigma":[0.04,0.06,0.08],"ambient":[0.02,0.04]}'] \
//        [--base 'freeze=1&t=12'] [--max 20] [--w 400] [--h 448] [--tol 0.12] [--capture <capture.mjs>]
//
// 行为：
//   1. 读 <run>/intent.json 的判据 + <run>/research.json 的实测带；
//   2. 坐标扫描（一次只动一个参数），每次抓帧后立刻量测、算 err、写 <run>/trace.jsonl；
//   3. err==0 或预算用完即停，把最优参数写 <run>/quick/best.json 与 <run>/verify.json。
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { probeFile } from './ref-probe.mjs'
import { profileFromFile, profileCorr, medianProfile, scalarsFromFile, toneFractions, speckleRatio, foamComponents } from './composition.mjs'
import { decodePng } from './ref-probe.mjs'

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const runDir = resolve(arg('run', ''))
const url = arg('url', '')
const refDir = arg('ref', '')
if (!runDir || !url) { console.error('用法: node harness/quick.mjs --run <run> --url <页面> [--ref <参考目录>] [--params json]'); process.exit(2) }
const CAPTURE = arg('capture', process.env.WEBCAPTURE || 'C:/Users/htsd/Documents/deepseek-harness/default-workspace/_tools/webcapture/capture.mjs')
const base = arg('base', 'freeze=1&t=12')
const maxShots = Number(arg('max', '20'))
const W = Number(arg('w', '400')), H = Number(arg('h', '448'))
const tol = Number(arg('tol', '0.12'))          // 没有实测带时，用靶 ±tol 当带
const shotsDir = join(runDir, arg('outdir', 'quick/shots'))
mkdirSync(shotsDir, { recursive: true })
mkdirSync(join(runDir, 'quick'), { recursive: true })

const intent = JSON.parse(readFileSync(join(runDir, 'intent.json'), 'utf8'))
const research = existsSync(join(runDir, 'research.json')) ? JSON.parse(readFileSync(join(runDir, 'research.json'), 'utf8')) : { extracted: [] }
const band = new Map((research.extracted || []).filter((e) => e && e.what && Number.isFinite(e.min) && Number.isFinite(e.max)).map((e) => [e.what, [e.min, e.max]]))
const refs = refDir && existsSync(refDir) ? readdirPng(refDir) : []
// 参考侧 topFrac：第三轮起 rowProfile 只算云区（preflight --profile-top 0.45 会写进 extracted）
const profEntry = (research.extracted || []).find((e) => e && e.what === 'rowProfile' && Array.isArray(e.value))
const topFrac = profEntry && Number.isFinite(Number(profEntry.topFrac)) ? Number(profEntry.topFrac) : 1
const refProf = refs.length ? medianProfile(refs.map((f) => profileFromFile(f, 64, topFrac))) : null
function readdirPng(d) {
  const out = []
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name)
      if (e.isDirectory()) walk(q)
      else if (e.name.toLowerCase().endsWith('.png')) out.push(q)
    }
  }
  walk(d)
  return out
}

const MEASURERS = {
  cloudDarkFrac: (f) => toneFractions(decodePng(readFileSync(f))).cloudDarkFrac,
  cloudBrightFrac: (f) => toneFractions(decodePng(readFileSync(f))).cloudBrightFrac,
  cloudMeanLuma: (f) => toneFractions(decodePng(readFileSync(f))).cloudMeanLuma,
  topCoverage: (f) => scalarsFromFile(f).topCoverage,
  centroidY: (f) => scalarsFromFile(f).centroidY,
  subjectFrac: (f) => scalarsFromFile(f).subjectFrac,
  skyExposure: (f) => scalarsFromFile(f).skyExposure,
  bboxAspect: (f) => scalarsFromFile(f).bboxAspect,
  mean: (f) => probeFile(f).mean,
  p50: (f) => probeFile(f).p50,
  p95: (f) => probeFile(f).p95,
  p99: (f) => probeFile(f).p99,
  glowFrac: (f) => probeFile(f).glowFrac,
  brightFrac: (f) => probeFile(f).brightFrac,
  speckleRatio: (f) => speckleRatio(decodePng(readFileSync(f))),
  foamShare: (f) => foamComponents(decodePng(readFileSync(f))).foamShare,
  foamMaxShare: (f) => foamComponents(decodePng(readFileSync(f))).foamMaxShare,
  foamMeanComp: (f) => foamComponents(decodePng(readFileSync(f))).foamMeanComp,
}

function measure(file, criteria) {
  const m = {}
  let err = 0
  for (const c of criteria) {
    if (c && c.kind === 'profile') {
      const corr = refProf ? profileCorr(refProf, profileFromFile(file, 64, topFrac)) : 0
      m[c.metric || 'rowProfile'] = +corr.toFixed(4)
      err += Math.max(0, ((c.minCorr ?? 0.83) - corr) / (1 - (c.minCorr ?? 0.83)))
      continue
    }
    const metric = c && (c.metric || c.id)
    const fn = MEASURERS[metric]
    if (!fn) continue
    let v
    try { v = fn(file) } catch { continue }
    m[metric] = +Number(v).toFixed(4)
    const b = band.get(metric)
    const lo = b ? b[0] : (c.target - tol)
    const hi = b ? b[1] : (c.target + tol)
    const half = Math.max(1e-6, (hi - lo) / 2)
    err += v < lo ? (lo - v) / half : v > hi ? (v - hi) / half : 0
  }
  return { metrics: m, err: +(err / Math.max(1, criteria.length)).toFixed(4) }
}

function capture(params, name) {
  const q = base + '&' + Object.entries(params).map(([k, v]) => k + '=' + v).join('&')
  const out = join(shotsDir, name + '.png')
  execFileSync(process.execPath, [CAPTURE, '--url', url, '--out', out, '--query', q, '--w', String(W), '--h', String(H)], { stdio: 'ignore' })
  return out
}
function trace(row) { appendFileSync(join(runDir, 'trace.jsonl'), JSON.stringify(row) + '\n') }

const criteria = (intent.criteria || []).filter(Boolean)
// --next '{"sigma":0.07,"ambient":0.03}'：按诊断直接给一个候选，跑一帧就报结果。
// 为什么要有：A 臂上一轮绕开了 quick.mjs，因为"固定顺序坐标扫描不能按诊断挑轴"。
const nextJson = arg('next', '')
if (nextJson) {
  const it = intent.criteria || []
  const cand = JSON.parse(nextJson)
  const name = 'n' + String(Date.now() % 100000)
  const file = capture(cand, name)
  const { metrics, err } = measure(file, criteria)
  trace({ n: 1, params: cand, metrics, err, note: 'quick --next' })
  writeFileSync(join(runDir, 'quick', 'best.json'), JSON.stringify({ best: { err, params: cand, file }, shots: 1, mode: 'next' }, null, 2), 'utf8')
  console.log('err=' + err + ' ' + JSON.stringify(metrics) + ' → ' + file)
  process.exit(err === 0 ? 0 : 1)
}
const grid = JSON.parse(arg('params', '{}'))
let state = {}
for (const [k, vs] of Object.entries(grid)) state[k] = vs[0]
let n = 0, best = null
const t0 = Date.now()
console.log('判据 ' + criteria.length + ' 条 · 预算 ' + maxShots + ' 帧 · 起始 ' + JSON.stringify(state))
while (n < maxShots) {
  const name = 'q' + String(n + 1).padStart(2, '0')
  const file = capture(state, name)
  n += 1
  const { metrics, err } = measure(file, criteria)
  trace({ n, params: state, metrics, err, note: 'quick' })
  const flag = err === 0 ? 'TARGET' : ''
  console.log('#' + n + ' err=' + err + ' ' + JSON.stringify(metrics) + ' ' + flag)
  if (!best || err < best.err) best = { err, params: { ...state }, file }
  if (err === 0) break
  if (n >= maxShots) break
  // 坐标扫描：在误差最大的那根参数上换下一档（没有剩余档位就换下一根）
  let advanced = false
  for (const [k, vs] of Object.entries(grid)) {
    const i = vs.indexOf(state[k])
    if (i >= 0 && i + 1 < vs.length) { state[k] = vs[i + 1]; advanced = true; break }
  }
  if (!advanced) break
}
// --sheet：把这一轮所有候选拼成一张联系表（用来"看过程"，不只是看终点）
if (process.argv.includes('--sheet')) {
  const FF = process.env.WEBCAPTURE_FFMPEG || 'C:/Users/htsd/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe'
  const sheet = join(runDir, 'quick', 'sheet.png')
  // Windows 上 ffmpeg 的 glob 输入不可用（"Function not implemented"），改用编号序列 + start_number
  const r = spawnSync(FF, ['-y', '-framerate', '1', '-start_number', '1', '-i', join(shotsDir, 'q%02d.png'),
    '-vf', 'scale=200:-1,tile=5x4:padding=4:margin=4', '-frames:v', '1', sheet], { encoding: 'utf8' })
  if (existsSync(sheet)) console.log('[quick] 联系表 ' + sheet)
  else console.log('[quick] 联系表失败：' + String(r.stderr || '').slice(-200))
}
// --flipbook：生成一个可点的"回看搜索过程"页面（帧 + err + 判据），用来给人看 selfloop 在干什么
if (process.argv.includes('--flipbook')) {
  const rows = existsSync(join(runDir, 'trace.jsonl'))
    ? readFileSync(join(runDir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    : []
  const shotsRel = []
  for (const r of rows) {
    const name = 'q' + String(r.n).padStart(2, '0') + '.png'
    shotsRel.push({ n: r.n, err: r.err, params: r.params, metrics: r.metrics, src: 'shots/' + name, has: existsSync(join(shotsDir, name)) })
  }
  const html = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>selfloop 搜索回放</title>'
    + '<style>body{margin:0;background:#0b0e13;color:#c9d6e4;font:13px/1.5 ui-monospace,Consolas,monospace}'
    + '#wrap{display:flex;gap:16px;padding:16px}img{width:420px;border:1px solid #223;border-radius:6px;background:#000}'
    + '.side{flex:1}.k{color:#7f97ad}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #1b2432;padding:3px 6px;text-align:left;font-size:12px}'
    + '.ok{color:#5ad469}.bad{color:#e5645f}button{background:#1a2534;color:#c9d6e4;border:1px solid #2b3a4d;border-radius:4px;padding:4px 10px;margin-right:6px;cursor:pointer}</style></head><body>'
    + '<div id="wrap"><div><img id="f" src=""><div style="margin-top:8px"><button onclick="step(-1)">◀</button><button onclick="step(1)">▶</button>'
    + '<button onclick="play()">▶▶ 播放</button> <span id="pos"></span></div></div><div class="side"><div id="info"></div>'
    + '<table id="t"><thead><tr><th>#</th><th>err</th><th>dark</th><th>bright</th><th>corr</th><th>top</th><th>cy</th></tr></thead><tbody></tbody></table></div></div>'
    + '<script>const rows=' + JSON.stringify(shotsRel) + ';let i=0,timer=null;'
    + 'function render(){const r=rows[i];if(!r)return;document.getElementById("f").src=r.src;'
    + 'document.getElementById("pos").textContent=(i+1)+" / "+rows.length+"   err="+r.err;'
    + 'const m=r.metrics||{};document.getElementById("info").innerHTML="<div class=k>参数</div><div>"+JSON.stringify(r.params)+"</div>"'
    + '+"<div class=k style=\"margin-top:8px\">判据</div><div>dark "+((m.cloudDarkFrac??0).toFixed(3))+" (带 .155~.295)</div>"'
    + '+"<div>bright "+((m.cloudBrightFrac??0).toFixed(3))+" (带 .013~.071)</div><div>corr "+((m.rowProfile??0).toFixed(3))+" (>=0.83)</div>"'
    + '+"<div>top "+((m.topCoverage??0).toFixed(3))+" (带 .669~.744)</div><div>cy "+((m.centroidY??0).toFixed(3))+" (带 .453~.502)</div>";'
    + 'document.querySelectorAll("#t tbody tr").forEach((tr,j)=>tr.style.background=j===i?"#16202e":"");}'
    + 'function step(d){i=Math.max(0,Math.min(rows.length-1,i+d));render()}'
    + 'function play(){if(timer){clearInterval(timer);timer=null;return}timer=setInterval(()=>{if(i>=rows.length-1){clearInterval(timer);timer=null;return}step(1)},420)}'
    + 'const tb=document.querySelector("#t tbody");rows.forEach((r,j)=>{const m=r.metrics||{};const tr=document.createElement("tr");'
    + 'tr.innerHTML="<td>"+r.n+"</td><td class=\""+(r.err===0?"ok":(r.err>0.5?"bad":""))+"\">"+r.err.toFixed(3)+"</td><td>"'
    + '+((m.cloudDarkFrac??0).toFixed(3))+"</td><td>"+((m.cloudBrightFrac??0).toFixed(3))+"</td><td>"+((m.rowProfile??0).toFixed(3))+"</td><td>"'
    + '+((m.topCoverage??0).toFixed(3))+"</td><td>"+((m.centroidY??0).toFixed(3))+"</td>";tr.onclick=()=>{i=j;render()};tb.appendChild(tr)});render();</script></body></html>'
  writeFileSync(join(runDir, 'quick', 'flipbook.html'), html, 'utf8')
  console.log('[quick] 回放页 ' + join(runDir, 'quick', 'flipbook.html'))
}
const secs = Math.round((Date.now() - t0) / 1000)
writeFileSync(join(runDir, 'quick', 'best.json'), JSON.stringify({ best, shots: n, secs, elapsed: secs }, null, 2), 'utf8')
const verify = { runs: true, visible: true, shots: ['quick/shots/' + 'q' + String(best.n || 1).padStart(2, '0') + '.png'], measured: best ? Object.assign({}, ...[]) : {} }
writeFileSync(join(runDir, 'verify.json'), JSON.stringify({ stage: '2.3-verify-r1', runs: true, visible: true, shots: [], measured: best && best.params ? { params: best.params, err: best.err, metrics: measure(best.file, criteria).metrics } : {} }, null, 2), 'utf8')
console.log('\n最佳 err=' + best.err + ' 参数 ' + JSON.stringify(best.params) + ' · 共 ' + n + ' 帧 / ' + secs + 's')
if (best.err !== 0) process.exitCode = 1
