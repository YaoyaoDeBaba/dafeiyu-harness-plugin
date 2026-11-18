// driver.mjs · 程序驱动节点流转 + 流转信号灯（2026-11-18，用户第 3 条）
//
// 规则（用户原话）：
//   节点之间流转**靠程序驱动，不靠 agent 自觉**；
//   信号灯透明：① 程序有没有收到上游交付？ ② 程序有没有唤醒下游？
//   程序**不管交付内容**，只判断「是否可以流转的信号」。
//
// 做法：
//   - 与 pipeline 同源拿节点表与 checks（不另写一套判据，避免两套口径）
//   - 每个 run 算三件事：上游是否齐全 / 当前节点产物是否齐全 / 是否可以流转
//   - 可以流转：--auto 就直接替 agent 调 pipeline done；否则写 wake 事件（"该谁动了"）
//   - 每轮写 <run>/signals.json（UI 读它画信号灯）+ 追加 <run>/wake.jsonl
//
// 用法：
//   node harness/driver.mjs --runs <runs根,...> [--auto] [--once] [--interval 5000]
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PIPE = join(HERE, 'pipeline.mjs')
const { allNodes, currentNode, checks } = await import(pathToFileURL(PIPE).href)

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const flag = (k) => process.argv.includes('--' + k)
const ROOTS = arg('runs', '').split(',').map((x) => x.trim()).filter(Boolean)
const AUTO = flag('auto')
const ONCE = flag('once')
const INTERVAL = Number(arg('interval', '5000'))
if (!ROOTS.length) { console.error('用法: node harness/driver.mjs --runs <runs根,...> [--auto] [--once]'); process.exit(2) }

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

function findRuns(root) {
  const out = []
  try {
    for (const name of readdirSync(root)) {
      const d = join(root, name)
      try { if (!statSync(d).isDirectory()) continue } catch { continue }
      if (existsSync(join(d, 'requirement.md')) || existsSync(join(d, 'budget.json'))) out.push(d)
    }
  } catch { /* 根不存在 */ }
  return out
}

function signalsOf(dir) {
  const out = {}
  try {
    for (const f of readdirSync(join(dir, 'stages'))) {
      if (!f.endsWith('.json')) continue
      const j = readJson(join(dir, 'stages', f))
      if (j && j.stage) out[j.stage] = j
    }
  } catch { /* 没 stages */ }
  return out
}

function evaluate(dir) {
  const cur = currentNode(dir)
  const nodes = allNodes(dir).nodes || []
  const sig = signalsOf(dir)
  if (!cur.node) return { run: dir, stage: null, done: true, upstream: true, artifact: true, canAdvance: false }
  const idx = nodes.findIndex((n) => n.id === cur.node.id)
  const upstreamMissing = nodes.slice(0, Math.max(0, idx)).filter((n) => !(sig[n.id] && sig[n.id].status === 'done')).map((n) => n.id)
  const fn = checks && checks[cur.node.check]
  let problems = []
  try { problems = typeof fn === 'function' ? (fn(dir) || []) : [] } catch (e) { problems = ['check 抛错: ' + (e && e.message)] }
  const artifact = problems.length === 0
  return {
    run: dir,
    runName: dir.split(/[\\/]/).pop(),
    stage: cur.node.id,
    title: cur.node.title,
    kind: cur.node.kind,
    upstream: upstreamMissing.length === 0,
    upstreamMissing,
    artifact,
    artifactProblems: problems.slice(0, 4),
    canAdvance: upstreamMissing.length === 0 && artifact,
    at: new Date().toISOString(),
  }
}

function writeSignals(dir, ev) { try { writeFileSync(join(dir, 'signals.json'), JSON.stringify(ev, null, 2), 'utf8') } catch { /* 只读 */ } }
function wake(dir, ev, reason) { try { appendFileSync(join(dir, 'wake.jsonl'), JSON.stringify(Object.assign({}, ev, { wake: reason })) + '\n', 'utf8') } catch { /* ignore */ } }

function advance(dir, stage) {
  const r = spawnSync(process.execPath, [PIPE, 'done', '--run', dir, '--stage', stage], { encoding: 'utf8' })
  return { ok: r.status === 0, out: String(r.stdout || '').slice(0, 300) }
}

function tick() {
  for (const root of ROOTS) {
    for (const dir of findRuns(resolve(root))) {
      let ev = evaluate(dir)
      if (ev.done) { writeSignals(dir, ev); continue }
      if (AUTO && ev.canAdvance) {
        const res = advance(dir, ev.stage)
        ev = Object.assign(ev, { autoAdvanced: res.ok, advanceError: res.ok ? null : res.out })
        if (!res.ok) wake(dir, ev, 'done 被拒（表单/产物问题）')
      } else {
        wake(dir, ev, ev.upstream ? '当前节点产物未齐：等执行员交活' : '上游未交付：等 ' + ev.upstreamMissing.join('、'))
      }
      writeSignals(dir, ev)
      console.log('[' + ev.stage + '] ' + (ev.canAdvance ? '可流转' : (ev.upstream ? '等当前交付' : '等上游')) +
        (ev.autoAdvanced === true ? ' → 程序已推进' : ''))
    }
  }
}

tick()
if (!ONCE) setInterval(tick, INTERVAL)
