// harness/snapshot.mjs —— 交活即快照三件套（A5 · ㊱）
//
// 为什么有它：2026-11-17 夜丢了用户认可的那版云——代码能找回，参数与场景序列化值全丢，
// cloudCoverage 实机 0.88 没人知道是什么时候被改的。
// 所以「交活即快照」：每轮执行结果旁边必须留一份能重建现场的三件套。
//
// 三件套（默认落在 <run>/rounds/r<N>/snapshot/；带 --tag 则 snapshot-<tag>/）：
//   code/              本轮改过的源文件（原样复制，别只写路径）
//   scene-params.json  执行员用 MCP 导出的组件字段 + 材质值（参数名 → 实机值）
//   params.md          本轮每个参数的 旧值 → 新值 → 为什么
//
// 谁用：
//   - pipeline.mjs：done --stage 2.2-exec-rN / 2.3-verify-rN 时调 missingPieces()，
//     缺件写进 verify.caveat（不硬拦，留痕）。
//   - 人/主 Agent：随时手动快照 ——
//     node harness/snapshot.mjs --run <run> --tag <名字> [--file <源文件>...] [--scene <导出.json>] [--params <参数说明.md>]
//
// 退出码：0 = 三件齐全；3 = 缺件（打印缺哪件）；2 = 参数不对。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PIECES = ['code/', 'scene-params.json', 'params.md']

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 快照目录名里的 tag 只留安全字符（会进路径）。 */
export function safeTag(tag) {
  return String(tag || '').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 40)
}

/** 这个 run 当前最大轮次（rounds/r<N> 里最大的 N）；没有就 1。 */
export function roundOfRun(runDir) {
  const base = join(runDir, 'rounds')
  if (!existsSync(base)) return 1
  let max = 0
  for (const f of readdirSync(base)) {
    const m = f.match(/^r(\d+)$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max || 1
}

/** 三件套落在哪：rounds/r<N>/snapshot/（带 tag 就 snapshot-<tag>/）。 */
export function snapshotDir(runDir, round, tag) {
  const base = join(runDir, 'rounds', 'r' + Number(round || 1))
  const name = safeTag(tag)
  return join(base, name ? 'snapshot-' + name : 'snapshot')
}

/** 缺哪几件（空数组 = 齐了）。pipeline 只拿它写 caveat，不硬拦。 */
export function missingPieces(runDir, round, tag) {
  const snap = snapshotDir(runDir, round, tag)
  const out = []
  const codeDir = join(snap, 'code')
  let codeOk = false
  try {
    codeOk = existsSync(codeDir) && statSync(codeDir).isDirectory() && readdirSync(codeDir).length > 0
  } catch {
    codeOk = false
  }
  if (!codeOk) out.push('code/')
  if (!existsSync(join(snap, 'scene-params.json'))) out.push('scene-params.json')
  if (!existsSync(join(snap, 'params.md'))) out.push('params.md')
  return out
}

/** 第 N 轮的台账（rounds/NN.json）——里面常写着这轮改了哪些文件、参数怎么变的。 */
function roundArtifact(runDir, round) {
  const name = String(Number(round || 1)).padStart(2, '0') + '.json'
  return readJson(join(runDir, 'rounds', name))
}

/** 从台账里翻出「可能存在的源文件路径」（changes[] / files[] 里长得像路径的）。 */
function filesFromArtifact(runDir, round) {
  const a = roundArtifact(runDir, round) || {}
  const raw = []
  for (const k of ['files', 'changed', 'changes', 'edits']) {
    if (Array.isArray(a[k])) raw.push(...a[k])
  }
  const out = []
  for (const v of raw) {
    const p = typeof v === 'string' ? v : v && (v.file || v.path || v.path)
    if (typeof p !== 'string' || !p.trim()) continue
    const abs = isAbsolute(p) ? p : join(runDir, p)
    if (existsSync(abs) && statSync(abs).isFile()) out.push(abs)
  }
  return out
}

/** 参数表 → params.md（旧值 → 新值 → 为什么）。认 [{name,from,to,why}] 或 {name:{from,to,why}}。 */
export function paramsMarkdown(params, round) {
  const rows = []
  if (Array.isArray(params)) {
    for (const p of params) {
      if (!p || typeof p !== 'object') continue
      rows.push([String(p.name ?? p.key ?? ''), String(p.from ?? p.old ?? ''), String(p.to ?? p.new ?? ''), String(p.why ?? p.reason ?? '')])
    }
  } else if (params && typeof params === 'object') {
    for (const [name, v] of Object.entries(params)) {
      if (v && typeof v === 'object') rows.push([name, String(v.from ?? v.old ?? ''), String(v.to ?? v.new ?? ''), String(v.why ?? v.reason ?? '')])
      else rows.push([name, '', String(v), ''])
    }
  }
  const lines = ['# 第 ' + round + ' 轮参数变更（旧值 → 新值 → 为什么）', '']
  if (!rows.length) {
    lines.push('（台账里没有参数记录：执行员要把每个改过的参数写进来）')
    return lines.join('\n') + '\n'
  }
  lines.push('| 参数 | 旧值 | 新值 | 为什么 |', '|---|---|---|---|')
  for (const r of rows) lines.push('| ' + r.join(' | ') + ' |')
  return lines.join('\n') + '\n'
}

/**
 * 写一份快照。
 * opts: { tag, round, files[], scene(object), sceneFile, params(string), paramsFile, auto(默认 true) }
 * 返回 { dir, round, tag, code:[文件名], scene:bool, params:bool, missing:[] }
 */
export function writeSnapshot(runDir, opts = {}) {
  const round = Number(opts.round || 0) || roundOfRun(runDir)
  const dir = snapshotDir(runDir, round, opts.tag)
  const codeDir = join(dir, 'code')
  mkdirSync(codeDir, { recursive: true })

  // ① code/：显式给的优先，再补台账里能解析出真实文件的
  const wanted = []
  for (const f of Array.isArray(opts.files) ? opts.files : []) {
    const s = String(f || '').trim()
    if (!s) continue
    const abs = isAbsolute(s) ? s : join(runDir, s)
    if (existsSync(abs) && statSync(abs).isFile()) wanted.push(abs)
  }
  if (opts.auto !== false) wanted.push(...filesFromArtifact(runDir, round))
  const copied = []
  const used = new Set()
  for (const abs of wanted) {
    let name = basename(abs)
    if (used.has(name)) name = copied.length + '-' + name
    used.add(name)
    copyFileSync(abs, join(codeDir, name))
    copied.push(name)
  }
  // 没解析出真实源文件就让 code/ 空着：missingPieces 会如实报"缺 code/"
  // （占位文件会让"三件齐全"的判据形同虚设 —— 这里宁可报缺，也不放假东西）

  // ② scene-params.json：对象直接写、给文件就复制、否则看 run 根下有没有现成的
  let scene = false
  const sceneOut = join(dir, 'scene-params.json')
  if (opts.scene && typeof opts.scene === 'object') {
    writeFileSync(sceneOut, JSON.stringify(opts.scene, null, 2), 'utf8')
    scene = true
  } else if (opts.sceneFile && existsSync(opts.sceneFile)) {
    copyFileSync(opts.sceneFile, sceneOut)
    scene = true
  } else if (existsSync(join(runDir, 'scene-params.json'))) {
    copyFileSync(join(runDir, 'scene-params.json'), sceneOut)
    scene = true
  }

  // ③ params.md：给的优先，其次台账里的参数，其次 run 根下现成的
  let params = false
  const paramsOut = join(dir, 'params.md')
  if (typeof opts.params === 'string' && opts.params.trim()) {
    writeFileSync(paramsOut, opts.params.trimEnd() + '\n', 'utf8')
    params = true
  } else if (opts.paramsFile && existsSync(opts.paramsFile)) {
    copyFileSync(opts.paramsFile, paramsOut)
    params = true
  } else {
    const art = roundArtifact(runDir, round)
    if (art && art.params && (Array.isArray(art.params) ? art.params.length : Object.keys(art.params).length)) {
      writeFileSync(paramsOut, paramsMarkdown(art.params, round), 'utf8')
      params = true
    } else if (existsSync(join(runDir, 'params.md'))) {
      copyFileSync(join(runDir, 'params.md'), paramsOut)
      params = true
    }
  }

  return { dir, round, tag: safeTag(opts.tag) || '', code: copied, scene, params, missing: missingPieces(runDir, round, opts.tag) }
}

const USAGE = `用法：node harness/snapshot.mjs --run <run目录> [--tag <名字>] [--round N] [--file <源文件>...] [--scene <导出.json>] [--params <参数说明.md>] [--json]

  --run <dir>      这一轮的 run 目录（必填）
  --tag <名字>     快照目录后缀：rounds/r<N>/snapshot-<名字>；不给就写 snapshot/
  --round N        指定轮次（默认取 rounds/r<N> 里最大的）
  --file <path>    本轮改过的源文件（可给多次）
  --scene <json>   MCP 导出的组件字段 / 材质值
  --params <md>    本轮参数的 旧值→新值→为什么
  --json           只打 JSON
退出：0 三件齐全 / 3 缺件 / 2 参数不对`

function parseArgv(argv) {
  const a = { run: '', tag: '', round: 0, files: [], sceneFile: '', paramsFile: '', json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (k === '--json') a.json = true
    else if (k === '--run' || k === '--tag' || k === '--round' || k === '--file' || k === '--scene' || k === '--params') {
      const v = argv[i + 1]
      i += 1
      if (v === undefined || v.startsWith('--')) throw new Error(k + ' 缺值')
      if (k === '--run') a.run = v
      else if (k === '--tag') a.tag = v
      else if (k === '--round') a.round = Number(v)
      else if (k === '--file') a.files.push(v)
      else if (k === '--scene') a.sceneFile = v
      else a.paramsFile = v
    } else if (k === '--help' || k === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else throw new Error('不认识的参数：' + k)
  }
  if (!a.run) throw new Error('缺 --run <run目录>')
  return a
}

function main() {
  let a
  try {
    a = parseArgv(process.argv.slice(2))
  } catch (e) {
    console.error(String(e && e.message ? e.message : e))
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
  const r = writeSnapshot(runDir, { tag: a.tag, round: a.round, files: a.files, sceneFile: a.sceneFile, paramsFile: a.paramsFile })
  if (a.json) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    console.log('快照：' + r.dir)
    console.log('  code/：' + (r.code.length ? r.code.join('、') : '（空 —— 用 --file 指定本轮改过的源文件）'))
    console.log('  scene-params.json：' + (r.scene ? '有' : '缺'))
    console.log('  params.md：' + (r.params ? '有' : '缺'))
    if (r.missing.length) console.log('缺件：' + r.missing.join('、') + '（pipeline 会写进 verify.caveat）')
    else console.log('三件齐全')
  }
  process.exit(r.missing.length ? 3 : 0)
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
