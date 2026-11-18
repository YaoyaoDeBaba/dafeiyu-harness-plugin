// 实验室快照（2026-11-18）：把「一版实验代码 + 参数 + 帧」整份存下来，可回滚、可复现。
//
// 为什么单列：selfloop 的快照规矩挂在 2.2-exec（交活即快照三件套）上，只有走 pipeline 才触发；
// 而探索期（改 _exp/<lab> 里的页面）根本不在 pipeline 里 —— 昨晚 mimo 余额耗尽、成果没存，
// 今天又差点重演。这个工具把快照从"流程节点"降到"任何一次实验都能用"。
//
// 用法：
//   node harness/lab-snapshot.mjs --lab <实验目录> --tag v1 [--frame <png>] [--params <probe.json>] [--run <run目录>]
// 产出：
//   <lab>/_versions/<tag>-<时间>/  ← 源码整份拷贝（跳过 node_modules/_versions/.git）
//        MANIFEST.json            ← 每个文件的 sha256 + 大小 + 时间
//        params.json              ← 当时的参数（给了 --params 就拷，给了 --frame 就记下它）
//   <lab>/_versions/INDEX.md       ← 追加一行：tag / 时间 / 文件数 / 帧 / 怎么恢复
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const labDir = arg('lab', '')
const tag = arg('tag', '')
if (!labDir || !tag) { console.error('用法: node harness/lab-snapshot.mjs --lab <实验目录> --tag <名字> [--frame <png>] [--params <json>]'); process.exit(2) }
const labAbs = resolve(labDir)
if (!existsSync(labAbs)) { console.error('实验目录不存在：' + labAbs); process.exit(2) }
const SKIP = new Set(['node_modules', '_versions', '.git', '.DS_Store'])
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = join(labAbs, '_versions', tag + '-' + ts)
mkdirSync(outDir, { recursive: true })

const files = []
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else files.push(p)
  }
}
walk(labAbs)

const manifest = { tag, at: new Date().toISOString(), lab: labAbs, files: [], frame: arg('frame', ''), params: arg('params', '') }
for (const f of files) {
  const rel = relative(labAbs, f).split('\\').join('/')
  if (rel.startsWith('_versions/')) continue
  const buf = readFileSync(f)
  const dest = join(outDir, rel)
  mkdirSync(join(dest, '..'), { recursive: true })
  copyFileSync(f, dest)
  manifest.files.push({ path: rel, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) })
}
if (manifest.params && existsSync(manifest.params)) copyFileSync(manifest.params, join(outDir, 'params.json'))
if (manifest.frame && existsSync(manifest.frame)) copyFileSync(manifest.frame, join(outDir, 'frame.png'))
writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8')

const idx = join(labAbs, '_versions', 'INDEX.md')
const line = '| ' + tag + ' | ' + ts + ' | ' + manifest.files.length + ' 文件 | ' + (manifest.frame ? 'frame.png' : '-') + ' | 把本目录里的文件覆盖回实验根即可 |' + '\n'
if (!existsSync(idx)) writeFileSync(idx, '# 版本索引\n\n| tag | 时间 | 文件数 | 帧 | 恢复 |\n|---|---|---|---|---|\n' + line, 'utf8')
else writeFileSync(idx, readFileSync(idx, 'utf8') + line, 'utf8')

console.log('[lab-snapshot] ' + outDir + '  (' + manifest.files.length + ' 个文件)')
