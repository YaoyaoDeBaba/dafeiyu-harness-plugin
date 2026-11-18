// 配方库（R4，2026-11-18）：把「听到名字就知道怎么画」变成可检索的参数表。
//
// 用法：
//   node harness/recipe.mjs list                 # 列出库里所有主题的配方
//   node harness/recipe.mjs search 体积云        # 按关键词搜（主题名 / 症状 / 参数名）
//   node harness/recipe.mjs show volumetric-cloud
//
// 配方文件位置：<库根>/<topic>/recipes.md（库根默认 ~/.dsh/refcode）
// 格式约定（手写/人审，别自动生成后直接信）：## 配方名 → 骨架 / 参数区间 / 判别量 / 反例
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const arg = (i, d) => process.argv[i] || d
const libArg = process.argv.find((a) => a.startsWith('--lib='))
const LIB = libArg ? libArg.slice(6) : join(homedir(), '.dsh', 'refcode')

function recipes() {
  if (!existsSync(LIB)) return []
  const out = []
  for (const t of readdirSync(LIB, { withFileTypes: true })) {
    if (!t.isDirectory()) continue
    const f = join(LIB, t.name, 'recipes.md')
    if (existsSync(f)) out.push({ topic: t.name, file: f, text: readFileSync(f, 'utf8') })
  }
  return out
}

const cmd = arg(2, 'list')
const all = recipes()
if (cmd === 'list') {
  if (!all.length) { console.log('库里还没有配方文件（<库根>/<topic>/recipes.md）'); process.exit(0) }
  for (const r of all) {
    const names = (r.text.match(/^## (.+)$/gm) || []).map((x) => x.replace(/^## /, ''))
    console.log(r.topic + '  (' + names.length + ' 条): ' + names.join(' | '))
  }
} else if (cmd === 'search') {
  const kw = arg(3, '')
  if (!kw) { console.error('用法: node harness/recipe.mjs search <关键词>'); process.exit(2) }
  const hits = all.filter((r) => r.topic.includes(kw) || r.text.includes(kw))
  if (!hits.length) { console.log('没找到：' + kw); process.exit(0) }
  for (const r of hits) console.log('=== ' + r.topic + ' (' + r.file + ') ===\n' + r.text)
} else if (cmd === 'show') {
  const t = arg(3, '')
  const hit = all.find((r) => r.topic === t)
  if (!hit) { console.error('没有主题：' + t); process.exit(2) }
  console.log(hit.text)
} else {
  console.error('用法: node harness/recipe.mjs list|search <kw>|show <topic> [--lib=<库根>]')
  process.exit(2)
}
