// 领域资产（0.6.0）自测：吸收进 domains/ 的需求方法论与 GLSL 配方，必须可溯源、可辨认、且不污染骨架。
//
// 覆盖：
//   ① references/ 每份 .md 非空，且带统一元信息（来源 / 许可 / 适用宿主 / 吸收说明）
//   ② recipes/glsl/*.glsl 每份保留六行头里的三类关键行（来源 / 许可 / 适用管线）
//   ③ 核心不被污染：core/*.js 与 lib/*.js 的源码里不出现领域词表
//   ④ 包内零盘符（只扫 domains/，与 plugin.test.mjs 的全包扫描互补）
//   ⑤ runtime-libs.md 明写「代码未吸收」（证明没有偷偷搬来源不明的实现）
//   ⑥ 资产清单防丢：references 7 份、recipes/glsl 8 份，文件名对得上
//
// 词表说明（③）：这里钉的是「领域词不该长进骨架代码」，不是「不许知道这些词」。
// 领域词只允许出现在 domains/、示例、测试夹具里；core/ 要讲清概念时用「题材词」这类抽象说法。
// 现有 core/ 里的 `vfx-block` 是 adapter 配置格式名（历史契约），不在本词表内 —— 它是配置格式，
// 不是渲染概念；真要连它一起收，需要先改契约，属于另一次改动。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOMAIN = join(ROOT, 'domains', 'vfx-render')
const REFS = join(DOMAIN, 'references')
const GLSL = join(DOMAIN, 'recipes', 'glsl')

function listFiles(dir, filter) {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile() && filter(name))
    .sort()
}

const mdFiles = listFiles(REFS, (n) => n.endsWith('.md'))
const glslFiles = listFiles(GLSL, (n) => n.endsWith('.glsl'))

test('① references 里的 .md 都非空，且带来源/许可/适用宿主/吸收说明', () => {
  assert.ok(mdFiles.length > 0, 'references/ 下一份 .md 都没有')
  for (const name of mdFiles) {
    const text = readFileSync(join(REFS, name), 'utf8')
    assert.ok(text.trim().length > 0, `${name} 是空文件`)
    for (const label of ['来源：', '许可：', '适用宿主：', '吸收说明：']) {
      assert.ok(text.includes(label), `${name} 缺统一元信息「${label}」—— 吸收物必须可溯源`)
    }
  }
})

test('② 每份 GLSL 配方保留来源、许可、适用管线三类头行', () => {
  assert.equal(glslFiles.length, 8, `recipes/glsl 应恰好 8 份，实际 ${glslFiles.length}`)
  for (const name of glslFiles) {
    const text = readFileSync(join(GLSL, name), 'utf8')
    for (const line of ['// 来源：', '// 许可：', '// 适用管线：']) {
      assert.ok(text.includes(line), `${name} 缺「${line}」—— 配方头不能丢`)
    }
    assert.ok(text.includes('// 适用宿主：'), `${name} 缺「// 适用宿主：」—— 脱敏后要用通用说法说明宿主`)
  }
})

test('③ 核心不被污染：core/ 与 lib/ 源码不含领域词表', () => {
  // 中文词直接子串匹配；英文词用词边界，避免误伤（如 uniform 出现在 "uniformly" 里就不算）。
  const banned = [/勾线/, /色阶/, /卡渲/, /着色器/, /\b(shader|uniform|fragment|ssao|fbm)\b/i]
  const hits = []
  for (const dir of ['core', 'lib']) {
    const abs = join(ROOT, dir)
    for (const name of listFiles(abs, (n) => n.endsWith('.js'))) {
      readFileSync(join(abs, name), 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          for (const re of banned) {
            if (re.test(line)) hits.push(`${dir}/${name}:${i + 1}: ${line.trim().slice(0, 120)}`)
          }
        })
    }
  }
  assert.deepEqual(hits, [], '领域词长进了骨架代码（应放进 domains/ 或走 domainExt）：\n' + hits.join('\n'))
})

test('④ domains/ 内零盘符（可移植性）', () => {
  // 判据自己别被自己命中：反斜杠用字符拼。
  // 源码里要写成 `(?:\\|/)` 才能同时匹配反斜杠与正斜杠（字符类 [\/] 只等于 /）。
  const sep = String.fromCharCode(92)
  const driveRe = new RegExp('(?<![A-Za-z0-9])[A-Za-z]:(?:' + sep + sep + '|/)')
  const hits = []
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(join(dir, e.name), relPath)
        continue
      }
      const text = readFileSync(join(dir, e.name), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (driveRe.test(line)) hits.push(`${relPath}: ${line.trim().slice(0, 120)}`)
      }
    }
  }
  walk(DOMAIN, 'domains/vfx-render')
  assert.deepEqual(hits, [], '领域资产里出现了本机盘符（换台机器就失效）：\n' + hits.join('\n'))
})

test('⑤ runtime-libs.md 明写「代码未吸收」', () => {
  const text = readFileSync(join(REFS, 'runtime-libs.md'), 'utf8')
  assert.ok(
    text.includes('代码未吸收：来源/许可未确认'),
    '粒子/带子只吸收方法论，必须明写「代码未吸收：来源/许可未确认」—— 否则等于默认把来源不明的实现搬进包',
  )
})

test('⑥ 资产清单防丢：references 7 份、recipes 8 份，名字对得上', () => {
  assert.deepEqual(mdFiles, [
    'construction-contracts.md',
    'demand-translator.md',
    'glsl-guardrails.md',
    'no-bloom.md',
    'pitfalls.md',
    'runtime-libs.md',
    'tooling.md',
  ])
  assert.deepEqual(glslFiles, [
    'dissolve.glsl',
    'dither.glsl',
    'fake-bloom.glsl',
    'fbm.glsl',
    'hash-nosin.glsl',
    'hash-pcg.glsl',
    'outline.glsl',
    'toon-shade.glsl',
  ])
})

// ⑧⑨（0.6.0 只到 ⑥；编号沿用交办清单，⑦ 空号未用）以下两条是 2026-11-15 修订版吸收时新加的——它们钉的是
// 「这次修订最值钱的两块内容别在下次改动里悄悄退化回去」：
//   ⑧ §3.5 的「主观词 → 客观指标」对照表还在不在（删几行 = 翻译能力被掏空）
//   ⑨ GLSL 护栏是不是还被当成旧版「八条硬雷」+ 有没有三条实现铁律

test('⑧ demand-translator.md 有「主观词 → 客观指标」映射表（≥10 组），且带「怎么量」口径', () => {
  const text = readFileSync(join(REFS, 'demand-translator.md'), 'utf8')
  for (const label of ['用户话术', '客观指标', '怎么量']) {
    assert.ok(text.includes(label), `映射表缺表头「${label}」—— 没有「怎么量」的指标等于没法验收`)
  }
  // 只数 §3.5 那一节的表行：从 "## 3.5" 到下一个二级标题之间。
  const start = text.indexOf('## 3.5')
  assert.notEqual(start, -1, '找不到 §3.5「主观词 → 客观指标」—— 这是本领域最值钱的一张表')
  const nextH2 = text.indexOf('\n## ', start + 5)
  const block = text.slice(start, nextH2 === -1 ? undefined : nextH2)
  const rows = block.split(/\r?\n/).filter((line) => {
    const t = line.trim()
    if (!t.startsWith('|')) return false
    if (/^\|[\s:|-]+\|$/.test(t)) return false // 分隔行
    if (t.includes('用户话术')) return false // 表头行
    return (t.match(/\|/g) || []).length >= 3 // 至少 2 列内容
  })
  assert.ok(
    rows.length >= 10,
    `§3.5 映射表只有 ${rows.length} 行数据（要求 ≥10）—— 删行就是掏空这个领域的翻译能力`,
  )
})

test('⑨ glsl-guardrails.md 是「十一条硬契约 + 三条实现铁律」，不是旧的八条', () => {
  const text = readFileSync(join(REFS, 'glsl-guardrails.md'), 'utf8')
  assert.ok(text.includes('十一条'), 'glsl-guardrails.md 缺「十一条」—— 2026-11-15 修订版已把八条升到十一条，退回去就是丢三条真机契约')
  assert.ok(text.includes('三条实现铁律'), 'glsl-guardrails.md 缺「三条实现铁律」—— 这三条是「编译能过但画面错」的唯一防线')
  // 三条铁律各自的关键词：漏一条就红。
  assert.ok(text.includes('useProgram'), '缺铁律 1 的关键词 useProgram（draw() 必须绑定 program，否则 uniform 静默丢弃）')
  assert.ok(text.includes('varying'), '缺铁律 2 的关键词 varying（极径绝不做 varying，否则整张 quad 是常数）')
  assert.ok(text.includes('精确为 0'), '缺铁律 3 的关键词「精确为 0」（quad 四边界必须精确为 0，不能是「很小」）')
  // 「退回旧版」的判据落在**标题**上，不在正文提及：正文里出现「八条硬雷 → 十一条」这种溯源是好事，
  // 但一级标题退回成「八条」就等于资产退化。
  const badHeadings = text
    .split(/\r?\n/)
    .filter((line) => /^#{1,3}\s/.test(line) && /八条|八雷/.test(line))
  assert.deepEqual(
    badHeadings,
    [],
    'glsl-guardrails.md 的标题还写着「八条」—— 旧版已被十一条取代（正文里溯源可以提，标题不行）',
  )
})
