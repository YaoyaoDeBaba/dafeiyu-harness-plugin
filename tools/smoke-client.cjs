// smoke-client.cjs —— 在假宿主里真跑一遍 dist/client.cjs（2026-11-17）
//
// 为什么需要它：构建脚本的三条「外壳」判据只看字符串，2026-11-17 实测漏过一次
// （CSS 数组少了个 ']'：字符串检查全过，装上去整页 web boot 失败）。
// 这个脚本把 window / document / __ModuleLoader__ 铺好，真 require 一遍，
// 断言：外壳 id 对、exports.name/inject 对、apply 能挂上两个槽位。
globalThis.window = globalThis
const seen = []
const registered = []
const fakeEl = () => ({
  dataset: {}, style: {}, className: '', innerHTML: '',
  appendChild() {}, addEventListener() {}, setAttribute() {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
})
globalThis.document = { getElementById: () => null, createElement: fakeEl, head: { appendChild() {} }, body: { appendChild() {} } }
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
const reactStub = { createElement: (type, props) => ({ type, props }) }

let failures = 0
const check = (ok, message) => {
  if (!ok) {
    failures += 1
    console.error('FAIL ' + message)
  }
}

globalThis.__ModuleLoader__ = {
  load({ id, factory }) {
    check(id === 'dsh-selfloop', '外壳 id 不是 dsh-selfloop（实际 ' + id + '）')
    const exports = factory((name) => (name === 'react' ? reactStub : {}))
    check(exports && exports.name === 'dsh-selfloop', 'exports.name 不对')
    check(Array.isArray(exports.inject) && exports.inject.includes('slots'), 'exports.inject 没声明 slots')
    const slots = {
      inject(name, cb) { seen.push(name); return cb() },
      register(def) { registered.push(def.name + '#' + def.id); return () => {} },
    }
    exports.apply({ slots, get: () => undefined })
  },
}

require('../dist/client.cjs')
check(seen.includes('conversation.composer.dock'), '没往 composer.dock 注册')
check(seen.includes('conversation.session.header.actions'), '没往 header.actions 注册')
check(registered.length === 3, '槽位注册数量应为 3（胶囊/标题栏/发起按钮），实际 ' + registered.length)
check(registered.some((r) => r.endsWith('-chip')), '缺胶囊槽位 id')
check(registered.some((r) => r.endsWith('-header')), '缺标题栏槽位 id')
check(registered.some((r) => r.endsWith('-new')), '缺发起按钮槽位 id')
if (failures) {
  process.exit(1)
}
console.log('smoke-client 通过：' + registered.join(' , '))
