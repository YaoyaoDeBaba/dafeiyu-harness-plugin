// client-bundle.test.mjs —— 浏览器半边的构建判据（2026-11-17）
//
// 判据都是「错了就整页 web boot 失败」的形状，所以钉在测试里而不是靠肉眼：
//   ① 外壳开头/结尾/id 三件套
//   ② 客户端里内联的路由常量必须与宿主侧 ROUTES 逐字相同（两边漂移 = 永远 404）
//   ③ 必须挂到那两个槽位、必须运行期要 react（静态 import 会整页失败）
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROUTES } from '../lib/routes.js'

const ROOT = join(import.meta.dirname, '..')

function build() {
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-client.mjs')], { stdio: 'pipe' })
  return readFileSync(join(ROOT, 'dist', 'client.cjs'), 'utf8')
}

test('client.cjs 外壳三件套（开头 / id / 结尾）', () => {
  const text = build()
  assert.ok(text.startsWith('window.__ModuleLoader__.load({'), '外壳开头不对')
  assert.ok(text.includes('id: "dsh-selfloop"'), '外壳 id 不是包名')
  assert.ok(text.trimEnd().endsWith('});'), '外壳结尾没闭合')
})

test('客户端内联路由与宿主侧 ROUTES 逐字一致（漂移 = 永远 404）', () => {
  const text = build()
  for (const key of Object.keys(ROUTES)) {
    assert.ok(text.includes("'" + ROUTES[key] + "'"), '客户端缺路由 ' + ROUTES[key])
  }
})

test('挂载点与 react 取用方式', () => {
  const text = build()
  assert.ok(text.includes("inject('conversation.composer.dock'"), '没挂 composer.dock')
  assert.ok(text.includes("inject('conversation.session.header.actions'"), '没挂 header.actions')
  assert.ok(text.includes("require('react')"), '没在运行期要 react')
  assert.ok(!/^import .*react/m.test(text), '不许静态 import react（会让整页 boot 失败）')
})

test('导出的 name 与 inject 契约', () => {
  const text = build()
  assert.ok(text.includes("exports.name = PLUGIN_ID"), '缺 exports.name')
  assert.ok(text.includes("PLUGIN_ID = 'dsh-selfloop'"), 'name 不是包名')
  assert.ok(text.includes("exports.inject = ['slots']"), '没用声明 slots')
})

test('package.json 的 dsh.client 声明齐全', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.exports['./client'], '缺 exports["./client"]')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.ok(pkg.files.includes('dist'), 'files 没带 dist，装进 profile 会缺客户端')
})
