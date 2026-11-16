// skill 分层自测（0.13.1）：references 按"读者在什么时刻需要它"切篇，防回潮。
//
// 覆盖：
//   ① 单篇 references > 12,000 字符 → 红（评审口径：超过就该拆）
//   ② 每篇开头 20 行内必须有「什么时候读」（read 可能只给开头，开头就得有用）
//   ③ SKILL.md 的索引表与 references 目录必须一一对得上（点了名的不许缺，存在的必须被点名）
//   ④ 旧的大文件不许回来（intent-and-ledger.md / command-observe.md）
//   ⑤ 包内文档与执行器源码不许再引用旧文件名（CHANGELOG 是历史，豁免）
//   ⑥ 弄坏能红：超限检查喂 12,001 字符必红、喂 12,000 字符不红
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILL = join(ROOT, 'skills', 'selfloop')
const REFS = join(SKILL, 'references')
const REF_LIMIT = 12000
const STALE_NAMES = ['intent-and-ledger.md', 'command-observe.md']

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const refFiles = () => readdirSync(REFS).filter((f) => f.endsWith('.md')).sort()

/** 纯函数：找出超过上限的条目（弄坏能红靠它单测） */
function findOversized(entries, limit = REF_LIMIT) {
  return entries.filter((e) => e.chars > limit).map((e) => `${e.name} ${e.chars} 字符 > ${limit}`)
}

test('① references 单篇不超过 12,000 字符', () => {
  const entries = refFiles().map((f) => ({ name: f, chars: read(join(REFS, f)).length }))
  const bad = findOversized(entries)
  assert.deepEqual(bad, [], '这些篇超限了，按「读者在什么时刻需要它」再拆：\n' + bad.join('\n'))
})

test('② 每篇开头 20 行内必须写清「什么时候读」', () => {
  const bad = []
  for (const f of refFiles()) {
    const head = read(join(REFS, f)).split('\n').slice(0, 20).join('\n')
    if (!head.includes('什么时候读')) bad.push(f)
  }
  assert.deepEqual(bad, [], '开头 20 行没写「什么时候读」：' + bad.join(', '))
})

test('③ SKILL.md 索引与 references 目录一一对应', () => {
  const skill = read(join(SKILL, 'SKILL.md'))
  const indexed = [...skill.matchAll(/references\/([A-Za-z0-9.\-_]+\.md)/g)].map((m) => m[1])
  const unique = [...new Set(indexed)].sort()
  const files = refFiles()
  const missingFiles = unique.filter((f) => !existsSync(join(REFS, f)))
  const notIndexed = files.filter((f) => !unique.includes(f))
  assert.deepEqual(missingFiles, [], '索引里点了名但文件不存在：' + missingFiles.join(', '))
  assert.deepEqual(notIndexed, [], '目录里有但这篇没进索引（等于没人读得到）：' + notIndexed.join(', '))
})

test('④ 旧的两个大文件不许回来', () => {
  const back = STALE_NAMES.filter((f) => existsSync(join(REFS, f)))
  assert.deepEqual(back, [], '这些文件已拆掉，别又长回来：' + back.join(', '))
})

test('⑤ 包内不许再引用旧文件名（CHANGELOG 豁免）', () => {
  const scan = [join(SKILL, 'SKILL.md'), join(ROOT, 'README.md'), join(ROOT, 'harness', '适配层-说明.md')]
  const hits = []
  for (const p of scan) {
    if (!existsSync(p)) continue
    const body = read(p)
    for (const name of STALE_NAMES) {
      if (body.includes('references/' + name)) hits.push(`${p.replace(ROOT, '')} → ${name}`)
    }
  }
  assert.deepEqual(hits, [], '旧指针没改干净：\n' + hits.join('\n'))
})

test('⑥ 弄坏能红：超限检查对 12,001 红、对 12,000 不红', () => {
  assert.deepEqual(findOversized([{ name: 'a.md', chars: 12000 }]), [], '正好 12,000 不该报')
  const red = findOversized([{ name: 'b.md', chars: 12001 }])
  assert.equal(red.length, 1, '12,001 必须报出来')
  assert.match(red[0], /b\.md/)
})
