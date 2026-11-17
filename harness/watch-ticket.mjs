// harness/watch-ticket.mjs —— 自唤醒（A1 · ㉒）：Agent 停手了，得有人喊一声。
//
// 问题：pipeline 出票（<run>/tickets/<node>.json）之后就只等 Agent 交活。
// Agent 一停手（断线 / 卡在思考 / 以为自己交完了），流程**永久卡住**——2026-11-17 夜断了 4 次，2 次是这个原因。
//
// 做法：常驻 watcher 盯「当前节点的票」。票在、但**超过 N 秒（默认 90s）没有任何进展**时，
// 写 <run>/need-agent.json（客户端横幅 + 主 Agent 侧轮询都读它），然后退出 0。
// 什么算「有进展」：tickets/ 之外任何文件的 mtime 变了（stages/、rounds/、forms/、active.json…）。
// 票对应的节点交活了（信号 done）→ 当前节点就换人了，旧票不再算卡住。
//
// 用法（主 Agent 可以后台跑）：
//   node harness/watch-ticket.mjs --run <run目录> [--idle 90] [--interval 15] [--timeout 3600] [--once] [--now <epochMs|ISO>] [--json]
//
// 退出码：0 = 检测到停滞并已写 need-agent.json ／ 3 = 还不用叫醒（--once 或到点）／ 2 = 参数不对
// --now 是给测试用的假时钟（给了它就只跑一次，不真等）。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentNode } from './pipeline.mjs'

/** 默认 90s 无进展就喊人。 */
export const DEFAULT_IDLE_MS = 90 * 1000

// 这些不算「主 Agent 在动」：
//   tickets/           票本身就是静止起点
//   need-agent.json    自己写的提醒，不能拿它续命
//   user-interrupt.jsonl / active-agents.json  人写的 / 名册，不代表节点有进展
const SKIP_DIRS = new Set(['tickets', 'node_modules', '.git'])
const SKIP_FILES = new Set(['need-agent.json', 'user-interrupt.jsonl', 'active-agents.json'])

function newestFileMtime(dir, depth) {
  let best = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || depth >= 4) continue
      const m = newestFileMtime(p, depth + 1)
      if (m > best) best = m
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue
      try {
        const m = statSync(p).mtimeMs
        if (m > best) best = m
      } catch { /* 文件刚被删，跳过 */ }
    }
  }
  return best
}

function parseNow(v) {
  if (v === undefined || v === null || v === '') return Date.now()
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) return n
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : Date.now()
}

/**
 * 当前节点有没有「出票不交活」。
 * @returns {{ needed:boolean, reason:string, node:string|null, kind?:string, title?:string,
 *             ticketPath:string|null, ticketAt:number|null, waitedMs:number, thresholdMs:number,
 *             at:number, hint?:string }}
 */
export function ticketState(runDir, opts = {}) {
  const now = Number.isFinite(Number(opts.now)) && Number(opts.now) > 0 ? Number(opts.now) : Date.now()
  const thresholdMs = Number.isFinite(Number(opts.thresholdMs)) && Number(opts.thresholdMs) > 0 ? Number(opts.thresholdMs) : DEFAULT_IDLE_MS
  const base = { needed: false, reason: 'idle', node: null, ticketPath: null, ticketAt: null, waitedMs: 0, thresholdMs, at: now }

  let cur
  try {
    cur = currentNode(runDir)
  } catch {
    return { ...base, reason: 'no-current-node' }
  }
  const node = cur && cur.node
  if (!node) return { ...base, reason: 'no-current-node' }

  const ticketPath = join(runDir, 'tickets', String(node.id) + '.json')
  if (!existsSync(ticketPath)) return { ...base, reason: 'no-ticket', node: node.id, kind: node.kind, title: node.title, ticketPath }

  let ticketAt
  try {
    ticketAt = statSync(ticketPath).mtimeMs
  } catch {
    return { ...base, reason: 'no-ticket', node: node.id, kind: node.kind, title: node.title, ticketPath }
  }
  const progressAt = Math.max(ticketAt, newestFileMtime(runDir, 0))
  const waitedMs = Math.max(0, now - progressAt)
  const needed = waitedMs > thresholdMs
  const secs = Math.round(waitedMs / 1000)
  const hint = needed
    ? '节点 ' + node.id + '（' + node.title + '）出票后 ' + secs + ' 秒没有任何进展：主 Agent 可能已经停手。看一眼票 ' + ticketPath + '，接着做，或者把当前节点交活。'
    : '节点 ' + node.id + ' 出票 ' + secs + ' 秒（未到 ' + Math.round(thresholdMs / 1000) + ' 秒阈值）'
  return {
    needed,
    reason: needed ? 'stalled' : 'waiting',
    node: node.id,
    kind: node.kind,
    title: node.title,
    ticketPath,
    ticketAt,
    progressAt,
    waitedMs,
    thresholdMs,
    at: now,
    hint,
  }
}

/** 写 <run>/need-agent.json（内容就是票 + 等了多久 + 一句人话提示）。 */
export function writeNeedAgent(runDir, state) {
  const body = {
    needAgent: true,
    node: state.node,
    ticketAt: state.ticketAt ? new Date(state.ticketAt).toISOString() : null,
    waitedMs: state.waitedMs,
    thresholdMs: state.thresholdMs,
    hint: state.hint,
    at: new Date(state.at || Date.now()).toISOString(),
  }
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'need-agent.json'), JSON.stringify(body, null, 2), 'utf8')
  return body
}

/**
 * /state.status.needAgent：读 need-agent.json，但**交活后旧标记要失效**。
 * 失效条件：那个节点的信号已经 done，或当前节点已经不是它。
 */
export function needAgentOf(runDir) {
  let j
  try {
    j = JSON.parse(readFileSync(join(runDir, 'need-agent.json'), 'utf8'))
  } catch {
    return false
  }
  if (!j || typeof j !== 'object') return false
  const node = String(j.node || '')
  if (!node) return true
  try {
    const sig = JSON.parse(readFileSync(join(runDir, 'stages', node + '.json'), 'utf8'))
    if (sig && sig.status === 'done') return false
  } catch { /* 没有信号文件：仍是待办 */ }
  try {
    const cur = currentNode(runDir)
    if (cur && cur.node && cur.node.id !== node) return false
  } catch { /* 读不出来就当它还算数 */ }
  return true
}

const USAGE = `用法：node harness/watch-ticket.mjs --run <run目录> [--idle 90] [--interval 15] [--timeout 3600] [--once] [--now <epochMs|ISO>] [--json]

  --run <dir>     盯这个 run（必填）
  --idle <秒>     出票后多少秒没进展就喊人（默认 90）
  --interval <秒> 多久查一次（默认 15）
  --timeout <秒>  最多盯多久（默认 3600）
  --once          只看一次就退出（主 Agent 侧轮询用）
  --now <t>       假时钟（测试用；给了就只跑一次）
  --json          只打 JSON
退出：0 检测到停滞（已写 need-agent.json）／ 3 还不用叫醒 ／ 2 参数不对`

function parseArgv(argv) {
  const a = { run: '', idle: 90, interval: 15, timeout: 3600, once: false, now: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (k === '--once') a.once = true
    else if (k === '--json') a.json = true
    else if (k === '--help' || k === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (['--run', '--idle', '--interval', '--timeout', '--now'].includes(k)) {
      const v = argv[i + 1]
      i += 1
      if (v === undefined) throw new Error(k + ' 缺值')
      if (k === '--run') a.run = v
      else if (k === '--now') a.now = v
      else if (k === '--idle') a.idle = Number(v)
      else if (k === '--interval') a.interval = Number(v)
      else a.timeout = Number(v)
    } else throw new Error('不认识的参数：' + k)
  }
  if (!a.run) throw new Error('缺 --run <run目录>')
  for (const key of ['idle', 'interval', 'timeout']) {
    if (!Number.isFinite(a[key]) || a[key] <= 0) throw new Error('--' + key + ' 要一个正数')
  }
  return a
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let a
  try {
    a = parseArgv(process.argv.slice(2))
  } catch (e) {
    console.error(String((e && e.message) || e))
    console.error(USAGE)
    process.exit(2)
    return
  }
  const runDir = resolve(a.run)
  if (!existsSync(runDir)) {
    console.error('run 目录不存在：' + runDir)
    process.exit(2)
    return
  }
  const idleMs = Math.round(a.idle * 1000)
  const onceOnly = a.once || a.now !== null
  const fixedNow = a.now === null ? null : parseNow(a.now)
  const deadline = Date.now() + Math.round(a.timeout * 1000)

  for (;;) {
    const st = ticketState(runDir, { now: fixedNow === null ? Date.now() : fixedNow, thresholdMs: idleMs })
    if (st.needed) {
      const body = writeNeedAgent(runDir, st)
      if (a.json) console.log(JSON.stringify(body, null, 2))
      else {
        console.log('需要主 Agent：' + st.node + ' 出票 ' + Math.round(st.waitedMs / 1000) + ' 秒没进展')
        console.log('  ' + st.hint)
        console.log('  已写 ' + join(runDir, 'need-agent.json'))
      }
      process.exit(0)
      return
    }
    if (onceOnly) {
      if (a.json) console.log(JSON.stringify(st, null, 2))
      else console.log('还不用叫醒：' + (st.hint || st.reason))
      process.exit(3)
      return
    }
    if (Date.now() > deadline) {
      if (a.json) console.log(JSON.stringify({ ...st, reason: 'timeout' }, null, 2))
      else console.log('盯到时间上限，没发现停滞：' + (st.hint || st.reason))
      process.exit(3)
      return
    }
    await sleep(Math.round(a.interval * 1000))
  }
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
