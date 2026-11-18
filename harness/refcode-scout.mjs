#!/usr/bin/env node
// refcode-scout —— 按主题队列找标杆仓库、增量入库，产出日报。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = process.env.REFCODE_ROOT || path.join(os.homedir(), '.dsh', 'refcode')
const QUEUE = path.join(ROOT, 'topics.json')
const REPORT_DIR = path.join(ROOT, 'reports')
const TOOL = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'refcode.mjs')

const DEFAULT_TOPICS = [
  { topic: 'volumetric-cloud', query: 'volumetric clouds shader', minStars: 30, why: '体积云', match: ['volumetric', 'cloud'] },
  { topic: 'lightning', query: 'lightning shader procedural', minStars: 20, why: '程序化闪电', match: ['lightning', 'bolt', 'thunder'] },
  { topic: 'tornado', query: 'tornado vfx simulation', minStars: 10, why: '龙卷风', match: ['tornado', 'cyclone', 'vortex'] },
  { topic: 'raymarch-sdf', query: 'raymarching sdf shader', minStars: 100, why: 'raymarch/SDF 通用', match: ['raymarch', 'sdf', 'shader'] },
  { topic: 'volumetric-fx', query: 'volumetric fog light shafts shader', minStars: 30, why: '体积光/雾', match: ['volumetric', 'fog', 'shaft'] }
]

function sh(cmd) { return execFileSync('pwsh', ['-NoProfile', '-Command', cmd], { stdio: 'pipe' }).toString() }
function ghSearch(q) {
  const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(q + ' stars:>10') + '&sort=stars&order=desc&per_page=8'
  const raw = sh("(Invoke-WebRequest -Uri '" + url + "' -UseBasicParsing -TimeoutSec 90).Content")
  return JSON.parse(raw).items || []
}
function loadCatalog() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8')) } catch { return { items: [] } } }

fs.mkdirSync(REPORT_DIR, { recursive: true })
const topics = fs.existsSync(QUEUE) ? JSON.parse(fs.readFileSync(QUEUE, 'utf8')) : DEFAULT_TOPICS
if (!fs.existsSync(QUEUE)) fs.writeFileSync(QUEUE, JSON.stringify(DEFAULT_TOPICS, null, 2))
const cat = loadCatalog()
const known = new Set(cat.items.map((x) => x.repo))
const lines = ['# refcode 巡检日报 ' + new Date().toISOString(), '']
let added = 0
for (const t of topics) {
  lines.push('## ' + t.topic + '（' + t.why + '）')
  let items = []
  try { items = ghSearch(t.query) } catch (e) { lines.push('- 搜索失败：' + e.message.slice(0, 120)); continue }
  // 相关性过滤：描述或名字必须含主题关键词，否则只收 star 很高的
  const keys = (t.match || [t.topic.split('-')[0]]).map((k) => k.toLowerCase())
  const rel = (it) => {
    const s = ((it.description || '') + ' ' + it.full_name).toLowerCase()
    return keys.some((k) => s.includes(k))
  }
  const cand = items
    .filter((it) => it.stargazers_count >= (t.minStars || 10) && !known.has(it.full_name))
    .filter((it) => rel(it) || it.stargazers_count >= 300)
    .slice(0, 2)
  if (!cand.length) { lines.push('- 无新候选（库内已有 ' + items.filter((it) => known.has(it.full_name)).length + ' 个）'); continue }
  for (const it of cand) {
    try {
      execFileSync('node', [TOOL, 'add', it.full_name, '--topic', t.topic, '--why', (it.description || '').slice(0, 80)], { stdio: 'pipe' })
      known.add(it.full_name)
      added++
      lines.push('- NEW ' + it.full_name + ' ★' + it.stargazers_count + ' — ' + (it.description || '').slice(0, 70))
    } catch (e) { lines.push('- 失败 ' + it.full_name + '：' + e.message.slice(0, 100)) }
  }
}
lines.push('', '本次新增：' + added + ' 个；库内共：' + (cat.items.length + added) + ' 个')
const rep = path.join(REPORT_DIR, 'scout-' + new Date().toISOString().slice(0, 10) + '.md')
fs.writeFileSync(rep, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
console.log('\n日报：' + rep)