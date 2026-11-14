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
