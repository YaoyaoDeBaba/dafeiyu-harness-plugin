// build-client.mjs —— 把 lib/client.js 包进 __ModuleLoader__ 外壳，产出 dist/client.cjs
//
// 为什么手写而不用打包器：客户端是**裸脚本**（不依赖任何 npm 包，react 走运行期 require），
// 没有需要内联的相对模块，一个外壳就够了。外壳写错的表现是「整页 web boot 失败」，
// 所以产出后**逐字节校验**三条：开头、id、结尾。
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const SRC = join(ROOT, 'lib', 'client.js')
const OUT = join(ROOT, 'dist', 'client.cjs')
const BUNDLE_ID = 'dsh-selfloop'

const body = readFileSync(SRC, 'utf8')
const shell =
  'window.__ModuleLoader__.load({\n' +
  '  id: ' + JSON.stringify(BUNDLE_ID) + ',\n' +
  '  factory: (require) => {\n' +
  '    var module = { exports: {} };\n' +
  '    var exports = module.exports;\n'
const footer = '\n    return module.exports;\n  },\n});\n'

mkdirSync(join(ROOT, 'dist'), { recursive: true })
writeFileSync(OUT, shell + body + footer, 'utf8')

const text = readFileSync(OUT, 'utf8')
const checks = [
  [text.startsWith('window.__ModuleLoader__.load({'), '外壳开头不是 __ModuleLoader__.load'],
  [text.includes('id: "' + BUNDLE_ID + '"'), '外壳里的 id 不是 ' + BUNDLE_ID],
  [text.trimEnd().endsWith('});'), '外壳结尾没闭合'],
  [text.includes("require('react')"), '客户端没在运行期要 react'],
  [text.includes("inject('conversation.composer.dock'"), '没有挂 composer.dock'],
  [text.includes("inject('conversation.session.header.actions'"), '没有挂 header.actions'],
]
// 语法判据：外壳内那一段必须能被 JS 引擎解析（2026-11-17 实测漏过一次：
// CSS 数组少了个 ']'，字符串检查全过、装上去整页 boot 失败）
try {
  // eslint-disable-next-line no-new-func
  new Function('require', body)
} catch (e) {
  checks.push([false, '客户端代码有语法错误：' + e.message])
}

let bad = 0
for (const [ok, message] of checks) {
  if (!ok) {
    console.error('[build-client] ' + message)
    bad += 1
  }
}
if (bad) process.exit(1)
console.log('dist/client.cjs ' + statSync(OUT).size + ' B，外壳与槽位挂载点校验通过')
