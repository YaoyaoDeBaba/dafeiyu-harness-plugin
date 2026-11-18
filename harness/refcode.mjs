#!/usr/bin/env node
// refcode —— 标杆源码资产库：把前沿开源实现拉回本地、建索引、可检索。
// 用法：
//   node refcode.mjs add <owner/repo> --topic <主题> --why "为什么值得看"
//   node refcode.mjs import <本地目录> --repo <owner/repo> --topic <主题> --why "..."
//   node refcode.mjs list | search "<关键词>" | rm <owner/repo>
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = process.env.REFCODE_ROOT || path.join(os.homedir(), '.dsh', 'refcode')
const CATALOG = path.join(ROOT, 'catalog.json')
const CODE_EXT = new Set(['.ts','.js','.mjs','.cjs','.glsl','.frag','.vert','.wgsl','.hlsl','.shader','.cs','.py','.rs','.cpp','.h','.hpp','.cu'])
const KEY_TERMS = ['raymarch','sdf','smin','volumetric','density','extinction','scattering','phase','powder','curl','worley','perlin','fbm','temporal','reproject','lighting','occlusion','bloom','atmosphere','ocean','fft','lightning','tornado']

function ensureRoot() { fs.mkdirSync(ROOT, { recursive: true }) }
function readCatalog() { try { return JSON.parse(fs.readFileSync(CATALOG, 'utf8')) } catch { return { version: 1, items: [] } } }
function writeCatalog(c) { ensureRoot(); fs.writeFileSync(CATALOG, JSON.stringify(c, null, 2), 'utf8') }
function slug(s) { return s.replace(/[^a-zA-Z0-9._-]+/g, '_') }
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out); else out.push(p)
  }
  return out
}
function arg(name, dflt) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }

function resolveBranch(repo) {
  const fallback = ['main', 'master']
  try {
    const apiUrl = 'https://api.github.com/repos/' + repo
    const raw = execFileSync('pwsh', ['-NoProfile', '-Command', "(Invoke-WebRequest -Uri '" + apiUrl + "' -UseBasicParsing -TimeoutSec 60).Content"], { stdio: 'pipe' }).toString()
    const j = JSON.parse(raw)
    if (j && j.default_branch) return j.default_branch
  } catch {}
  return fallback[0]
}
function downloadZip(repo, destZip) {
  const branch = resolveBranch(repo)
  const url = 'https://codeload.github.com/' + repo + '/zip/refs/heads/' + branch
  execFileSync('pwsh', ['-NoProfile', '-Command', "Invoke-WebRequest -Uri '" + url + "' -OutFile '" + destZip + "' -UseBasicParsing -TimeoutSec 180"], { stdio: 'pipe' })
  return destZip
}
function extractZip(zip, destDir) {
  execFileSync('pwsh', ['-NoProfile', '-Command', "Expand-Archive -Path '" + zip + "' -DestinationPath '" + destDir + "' -Force"], { stdio: 'pipe' })
  const subs = fs.readdirSync(destDir).filter((d) => fs.statSync(path.join(destDir, d)).isDirectory())
  return subs.length === 1 ? path.join(destDir, subs[0]) : destDir
}

function indexRepo(repoDir, meta) {
  const files = walk(repoDir)
  const code = files.filter((f) => CODE_EXT.has(path.extname(f).toLowerCase()))
  const rows = code.map((f) => ({ rel: path.relative(repoDir, f).replace(/\\/g, '/'), size: fs.statSync(f).size }))
  const hits = {}
  for (const term of KEY_TERMS) {
    let n = 0
    for (const r of rows) { try { const t = fs.readFileSync(path.join(repoDir, r.rel), 'utf8').toLowerCase(); if (t.includes(term)) n++ } catch {} }
    if (n > 0) hits[term] = n
  }
  const out = []
  out.push('# ' + meta.repo)
  out.push('')
  out.push('- 主题：' + meta.topic)
  out.push('- 为什么看：' + (meta.why || '—'))
  out.push('- 落地：' + repoDir)
  out.push('- 代码文件：' + code.length + ' / 全部文件：' + files.length)
  out.push('- 抓取时间：' + new Date().toISOString())
  out.push('')
  out.push('## 关键词分布')
  out.push('```')
  for (const [k, v] of Object.entries(hits).sort((a, b) => b[1] - a[1])) out.push(k.padEnd(14) + v + ' 个文件')
  out.push('```')
  out.push('')
  out.push('## 文件清单')
  out.push('```')
  for (const r of rows.sort((a, b) => a.rel.localeCompare(b.rel))) out.push(r.rel.padEnd(52) + (Math.round(r.size / 102.4) / 10 + 'KB').padStart(8))
  out.push('```')
  fs.writeFileSync(path.join(repoDir, 'INDEX.md'), out.join('\n'), 'utf8')
  return { files: files.length, code: code.length, hits }
}

const cmd = process.argv[2]
if (cmd === 'add' || cmd === 'import') {
  const target = process.argv[3]
  if (!target) { console.error('缺参数'); process.exit(1) }
  const topic = arg('--topic', 'misc')
  const why = arg('--why', '')
  const cat = readCatalog()
  const topicDir = path.join(ROOT, slug(topic))
  fs.mkdirSync(topicDir, { recursive: true })
  let repoDir, repoName
  if (cmd === 'add') {
    repoName = target
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refcode-'))
    const zip = path.join(tmp, 'repo.zip')
    console.log('[1/3] 下载 ' + target);
    downloadZip(target, zip);
    console.log('[2/3] 解压');
    const ex = extractZip(zip, tmp)
    repoDir = path.join(topicDir, slug(target.replace('/', '__')))
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.cpSync(ex, repoDir, { recursive: true })
    fs.rmSync(tmp, { recursive: true, force: true })
  } else {
    repoName = arg('--repo', path.basename(target))
    repoDir = path.join(topicDir, slug(repoName.replace('/', '__')))
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.cpSync(target, repoDir, { recursive: true })
  }
  console.log('[3/3] 建索引');
  const stat = indexRepo(repoDir, { repo: repoName, topic, why })
  cat.items = cat.items.filter((x) => x.repo !== repoName)
  cat.items.push({ repo: repoName, topic, why, dir: repoDir, files: stat.files, code: stat.code, hits: stat.hits, addedAt: new Date().toISOString() })
  writeCatalog(cat)
  console.log('OK ' + repoName + ' → ' + path.join(repoDir, 'INDEX.md'))
} else if (cmd === 'list') {
  const cat = readCatalog()
  console.log('资产库：' + ROOT + '（' + cat.items.length + ' 个仓库）')
  for (const it of cat.items) console.log('- [' + it.topic + '] ' + it.repo + '  ' + it.code + '/' + it.files + '  ' + (it.why || '').slice(0, 60))
} else if (cmd === 'search') {
  const kw = (process.argv[3] || '').toLowerCase()
  const topic = arg('--topic')
  const cat = readCatalog()
  for (const it of cat.items) {
    if (topic && it.topic !== topic) continue
    for (const f of walk(it.dir)) {
      if (!CODE_EXT.has(path.extname(f).toLowerCase())) continue
      let t; try { t = fs.readFileSync(f, 'utf8') } catch { continue }
      const idx = t.toLowerCase().indexOf(kw)
      if (idx >= 0) console.log(it.repo + ' :: ' + path.relative(it.dir, f).replace(/\\/g, '/') + ':' + t.slice(0, idx).split('\n').length)
    }
  }
} else if (cmd === 'rm') {
  const repo = process.argv[3]
  const cat = readCatalog()
  const it = cat.items.find((x) => x.repo === repo)
  if (!it) { console.error('没有 ' + repo); process.exit(1) }
  fs.rmSync(it.dir, { recursive: true, force: true })
  cat.items = cat.items.filter((x) => x.repo !== repo)
  writeCatalog(cat)
  console.log('removed ' + repo)
} else {
  console.log('用法：add <owner/repo> --topic <t> --why "..." | import <dir> --repo <r> ... | list | search "<kw>" | rm <repo>')
  console.log('资产库根：' + ROOT)
}