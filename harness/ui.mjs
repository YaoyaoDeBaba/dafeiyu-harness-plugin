// Selfloop · 可视化查看器（本地网页，零依赖）
//
// 用法：
//   node harness/ui.mjs <run目录> [--port 7788] [--host 127.0.0.1] [--open]
//
// 它只做两件事：
//   1) 把一次 run 的产物聚合成一个 JSON（GET /api/state）——曲线、节点台帐、帧、报告、实时事件；
//   2) 把 ui/ 目录（前端）与 <run>/shots 等静态文件发出去。
// 跑的过程中页面自己按 mtime 轮询，跑完就是一份可回看的证据包。
//
// 设计边界（刻意）：
//   - 不写任何文件、不改 run 目录；只读。
//   - 没有 skills/ 依赖、没有打包步骤；前端是原生 HTML/JS。
//   - 文件缺失一律降级为空（老 run 没有 nodes/ 或 live.jsonl 也能看），不抛错。
import http from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const UI_DIR = path.join(HERE, '..', 'ui')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const rel = (p, root) => {
  if (typeof p !== 'string' || p === '') return ''
  const r = path.relative(root, p)
  return r.startsWith('..') || path.isAbsolute(r) ? '' : r.split(path.sep).join('/')
}
const safeRead = async (p, enc = 'utf8') => { try { return await readFile(p, enc) } catch { return null } }
const safeJson = async (p) => { const t = await safeRead(p); if (t == null) return null; try { return JSON.parse(t) } catch { return null } }


/** 把 CSV 里出现过的图片路径归一成 run 相对路径；run 之外的一律丢空（不漏本机路径） */
export function normRunPath(p, root) {
  if (typeof p !== 'string' || p === '') return ''
  const cleaned = p.replace(/\\/g, '/')
  const abs = path.isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned) ? path.resolve(cleaned) : ''
  if (abs !== '') {
    const r = path.relative(root, abs)
    return r.startsWith('..') || path.isAbsolute(r) ? '' : r.split(path.sep).join('/')
  }
  return cleaned.startsWith('..') ? '' : cleaned
}

/** 只做形状判断的 CSV 解析：首行表头，其余按逗号切；数字能转就转，转不了保留字符串 */
export function parseCsv(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return { header: [], rows: [] }
  const header = lines[0].split(',').map((s) => s.trim())
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',')
    const row = {}
    header.forEach((h, i) => {
      const raw = (cells[i] ?? '').trim()
      const num = raw === '' ? NaN : Number(raw)
      row[h] = Number.isFinite(num) ? num : raw
    })
    return row
  })
  return { header, rows }
}

/** 把一次 run 目录聚合成前端要的一份状态（缺什么给空，不抛错） */
export async function buildState(runDir) {
  const root = path.resolve(runDir)
  const best = await safeJson(path.join(root, 'best.json'))
  const curveText = await safeRead(path.join(root, 'curve.csv'))
  const curve = curveText == null ? { header: [], rows: [] } : parseCsv(curveText)
  const report = await safeRead(path.join(root, 'report.md'))
  const intent = await safeJson(path.join(root, 'intent.json'))
  const research = await safeJson(path.join(root, 'research.json'))
  const liveText = await safeRead(path.join(root, 'live.jsonl'))

  let shots = []
  try {
    shots = (await readdir(path.join(root, 'shots')))
      .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
      .map((f) => 'shots/' + f)
  } catch { /* 老 run 可能没有 shots/ */ }

  let nodes = []
  try {
    const files = (await readdir(path.join(root, 'nodes'))).filter((f) => f.endsWith('.json')).sort()
    for (const f of files) {
      const j = await safeJson(path.join(root, 'nodes', f))
      if (j && typeof j === 'object') nodes.push({ file: f, ...j })
    }
  } catch { /* 0.5.0 之前的 run 没有台帐 */ }

  const live = []
  if (liveText) {
    for (const line of liveText.split('\n')) {
      const t = line.trim()
      if (t === '') continue
      try { live.push(JSON.parse(t)) } catch { /* 半行（正在写）忽略 */ }
    }
  }

  const summary = best == null ? null : {
    effect: best.effect ?? '', block: best.block ?? '', strategy: best.strategy ?? '',
    seed: best.seed ?? null, t: best.t ?? null, stepN: best.stepN ?? null, stepMs: best.stepMs ?? null,
    w: best.w ?? null, h: best.h ?? null, tier: best.tier ?? '',
    metricIds: best.metricIds ?? [],
    startDist: best.startDist ?? null, bestDist: best.bestDist ?? null,
    dropPct: best.dropPct ?? null, dropAbs: best.dropAbs ?? null,
    budget: best.budget ?? null,
    used: best.stop?.used ?? best.evaluations?.used ?? null,
    stopReason: best.stop?.reason ?? '', stopDetail: best.stop?.detail ?? '',
    whitelist: best.whitelist ?? [], alive: best.alive ?? [], dead: best.dead ?? [],
    startParams: best.startParams ?? {}, bestParams: best.bestParams ?? {},
    hash: best.hash ?? '', evaluations: best.evaluations ?? null,
  }

  // 更新信号：跑的过程中 best.json 往往最后才写，真正会动的是 curve.csv / shots / nodes / live.jsonl
  let mtime = 0
  for (const f of ['best.json', 'curve.csv', 'report.md', 'live.jsonl', 'shots', 'nodes']) {
    try { const st2 = await stat(path.join(root, f)); if (st2.mtimeMs > mtime) mtime = st2.mtimeMs } catch { /* 缺就跳过 */ }
  }
  const progress = { curveRows: curve.rows.length, shots: shots.length, nodes: nodes.length, live: live.length }

  for (const row of curve.rows) {
    if (typeof row.png === 'string') row.png = normRunPath(row.png, root)
  }

  return {
    ok: true,
    run: { dir: root, name: path.basename(root), mtime },
    progress,
    summary,
    targetPng: best ? rel(best.targetPng, root) : (shots.includes('shots/target.png') ? 'shots/target.png' : ''),
    bestPng: best ? rel(best.bestPng, root) : (shots.includes('shots/best.png') ? 'shots/best.png' : ''),
    curve: curve.rows,
    curveHeader: curve.header,
    shots: shots.filter((s) => !/(^|\/)target\.png$/.test(s) && !/(^|\/)best\.png$/.test(s)),
    nodes,
    intent,
    research,
    report: report ?? '',
    live: live.slice(-300),
  }
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  res.end(body)
}

async function serveFile(res, file, rootForGuard) {
  const abs = path.resolve(file)
  const relToRoot = path.relative(rootForGuard, abs)
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return send(res, 403, '403')
  let st
  try { st = await stat(abs) } catch { return send(res, 404, '404 ' + path.basename(abs)) }
  if (!st.isFile()) return send(res, 404, '404')
  res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  createReadStream(abs).pipe(res)
}

export function createServer(runDir) {
  const root = path.resolve(runDir)
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const p = decodeURIComponent(url.pathname)
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '405')
      if (p === '/api/state') {
        const st = await buildState(root)
        return send(res, 200, JSON.stringify(st))
      }
      if (p === '/' || p === '/index.html') return serveFile(res, path.join(UI_DIR, 'index.html'), UI_DIR)
      if (p.startsWith('/ui/')) return serveFile(res, path.join(UI_DIR, p.slice(4)), UI_DIR)
      if (p.startsWith('/run/')) return serveFile(res, path.join(root, p.slice(5)), root)
      return send(res, 404, '404 ' + p)
    } catch (e) {
      return send(res, 500, '500 ' + (e?.message ?? e))
    }
  })
}

export async function startUi({ runDir, port = 7788, host = '127.0.0.1' } = {}) {
  const server = createServer(runDir)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const addr = server.address()
  const url = `http://${host}:${addr.port}/`
  return { server, port: addr.port, url }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const runDir = args.find((a) => !a.startsWith('--'))
  const flag = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def }
  const port = Number(flag('port', '7788'))
  const host = flag('host', '127.0.0.1')
  if (!runDir) {
    console.error('用法：node harness/ui.mjs <run目录> [--port 7788] [--host 127.0.0.1]')
    process.exit(2)
  }
  const { url } = await startUi({ runDir, port, host })
  console.log(`Selfloop 查看器：${url}`)
  console.log(`run 目录：${path.resolve(runDir)}`)
  if (args.includes('--open')) {
    const { spawn } = await import('node:child_process')
    try { spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref() } catch { /* 打不开就算了 */ }
  }
}
