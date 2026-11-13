// 插件自测：不起宿主、不装 profile、不开端口、不跑产线。
// 纯 node:test + 假 ctx + 一个 JSON-Schema 子集校验器（用来验 output.schema 和返回值对得上）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const mod = await import('../lib/index.js')
const { name, inject, apply, selfloopProbeTool, selfloopListAdaptersTool, DEFAULT_ADAPTER, DEFAULT_DOMAIN } = mod
const { HARNESS_REQUIRED, parseAdapter, listAdapters, groupByDomain } = await import('../core/adapter.js')
const { resolveRequest, contentType, createStaticHandler, MIME } = await import('../static/server.mjs')

const ADAPTER_DIR = join(ROOT, 'domains', 'vfx-render', 'adapters')
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))

// 假 ctx：tools.register 收集工具；skills.register 收集技能（模拟宿主挂了 skills 服务）
function mockCtx({ withSkills = false } = {}) {
  const tools = []
  const skills = []
  const ctx = { tools: { register: (tool) => (tools.push(tool), () => {}) } }
  if (withSkills) ctx.skills = { register: (skill) => (skills.push(skill), () => {}) }
  return { ctx, tools, skills }
}

// ---- 极简 JSON Schema 子集校验器：type / properties / required / additionalProperties / items / enum
function validate(schema, value, at = '$') {
  const errs = []
  const type = schema.type
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value
  const typeOk =
    type === undefined ||
    type === actual ||
    (type === 'number' && actual === 'integer')
  if (!typeOk) {
    errs.push(`${at}: 期望 ${type}，实际 ${actual}`)
    return errs
  }
  if (type === 'object') {
    const props = schema.properties ?? {}
    for (const k of schema.required ?? []) {
      if (!(k in value)) errs.push(`${at}.${k}: required 但缺失`)
    }
    for (const [k, v] of Object.entries(value)) {
      if (!(k in props)) {
        if (schema.additionalProperties === false) errs.push(`${at}.${k}: 多余键（additionalProperties=false）`)
        continue
      }
      errs.push(...validate(props[k], v, `${at}.${k}`))
    }
  }
  if (type === 'array' && schema.items) {
    value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)))
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} 不在 enum 里`)
  return errs
}

// schema 自身的形状：每个 object 都要明文 additionalProperties；
// requireAll=true 时（输出 schema）每个 property 都必须进 required —— 返回值要稳定给全。
function walkSchema(node, at, requireAll = false) {
  assert.equal(typeof node.type, 'string', `${at}.type`)
  if (node.type === 'object') {
    assert.equal(typeof node.additionalProperties, 'boolean', `${at}.additionalProperties 要写明`)
    for (const k of node.required ?? []) assert.ok(node.properties?.[k], `${at}.required ${k} 未声明`)
    if (requireAll) {
      for (const k of Object.keys(node.properties ?? {})) {
        assert.ok((node.required ?? []).includes(k), `${at}.properties.${k} 没进 required（返回值必须稳定给全）`)
      }
    }
    for (const [k, p] of Object.entries(node.properties ?? {})) walkSchema(p, `${at}.${k}`, requireAll)
  }
  if (node.type === 'array' && node.items) walkSchema(node.items, `${at}[]`, requireAll)
}

test('插件名与 inject 声明（正名后叫 selfloop）', () => {
  assert.equal(name, 'selfloop')
  assert.deepEqual(inject, ['tools'])
})

test('apply 注册恰好 2 个工具，名字合法且带 execute/render', () => {
  const { ctx, tools } = mockCtx()
  apply(ctx)
  assert.equal(tools.length, 2)
  assert.deepEqual(tools.map((t) => t.name).sort(), ['selfloop_list_adapters', 'selfloop_probe'])
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/)
    assert.equal(typeof t.execute, 'function')
    assert.equal(typeof t.output?.render, 'function')
    assert.equal(typeof t.description, 'string')
    assert.ok(t.description.length > 20)
    assert.ok(!/vfx/i.test(t.name), '工具名不该再带题材');
    assert.ok(!/^vfx/i.test(t.description), '工具描述该是领域无关的')
  }
})

test('两个工具的 schema 每个 object 都显式 additionalProperties:boolean，且 properties 全在 required 里', () => {
  for (const t of [selfloopProbeTool, selfloopListAdaptersTool]) {
    walkSchema(t.parameters, `${t.name}.parameters`, false)
    walkSchema(t.output.schema, `${t.name}.output`, true)
    assert.equal(t.parameters.additionalProperties, false)
    assert.equal(t.output.schema.additionalProperties, false)
  }
  assert.deepEqual(selfloopProbeTool.parameters.properties.adapter.type, 'string')
  assert.deepEqual(Object.keys(selfloopListAdaptersTool.parameters.properties), [])
})

// ---------------------------------------------------------------- harness / adapters / 三层
test('harness 齐全：8 件跑一轮必需件 + 默认 adapter + 适配层字段说明', () => {
  const dir = join(ROOT, 'harness')
  assert.equal(HARNESS_REQUIRED.length, 8, '跑一轮的必需件清单')
  for (const f of HARNESS_REQUIRED) {
    const p = join(dir, f)
    assert.ok(existsSync(p), `harness 缺 ${f}`)
    assert.ok(statSync(p).size > 200, `${f} 太小，像占位`)
  }
  for (const f of ['adapter.json', '适配层-说明.md']) {
    assert.ok(statSync(join(dir, f)).size > 1000, `${f} 缺失或过小`)
  }
  // iter.ps1 的边界契约：dot-source capture.ps1、按 PSScriptRoot 找脚本
  const iter = readFileSync(join(dir, 'iter.ps1'), 'utf8')
  assert.match(iter, /Import-Adapter/)
  assert.match(iter, /capture\.ps1/)
  assert.match(iter, /\$PSScriptRoot/)
})

test('三层目录齐备：lib 入口 / core 引擎 / domains 领域 / harness 执行器 / skills 技能', () => {
  for (const p of [
    'lib/index.js',
    'core/index.js',
    'core/adapter.js',
    'core/README.md',
    'domains/vfx-render/adapters/fire-ray.json',
    'domains/vfx-render/README.md',
    'harness/iter.ps1',
    'skills/selfloop/SKILL.md',
    'skills/selfloop/references/domains-vfx.md',
  ]) {
    assert.ok(existsSync(join(ROOT, p)), `三层缺 ${p}`)
  }
  // 引用方向单向：入口走 core，不直接 import core/adapter.js 的内部结构
  const lib = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
  assert.match(lib, /from '\.\.\/core\/index\.js'/, 'lib 应该从 core/index.js 取引擎能力')
  assert.ok(!/from '\.\.\/core\/adapter\.js'/.test(lib), 'lib 不该绕过 core 的入口直接拆内件')
  assert.ok(!/from '\.\.\/harness/.test(lib), 'lib 不该 import 执行器源码（执行器是黑盒资产）')
  // core 不回头引用 lib（三层单向）
  for (const f of ['core/index.js', 'core/adapter.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(!/from '\.\.\/lib\//.test(src), `${f} 不该回头引用 lib/`)
  }
})

test('包内 3 份适配器都能被解析，带 domain 标注，且脚本路径都落在包内', () => {
  const names = readdirSync(ADAPTER_DIR).filter((n) => n.endsWith('.json')).sort()
  assert.deepEqual(names, ['chain-lightning.json', 'demo-url-time.json', 'fire-ray.json'])
  for (const f of names) {
    const a = parseAdapter(join(ADAPTER_DIR, f), join(ROOT, 'harness'))
    assert.match(a.block, /^effects\.[A-Za-z0-9_]+\.[A-Za-z0-9_.]+$/, `${f} 的 block`)
    assert.ok(a.metricsCount >= 3, `${f} 指标太少`)
    assert.ok(a.topic.length > 8, `${f} 缺 topic（适用题材）`)
    assert.equal(a.domain, 'vfx-render', `${f} 应该标 domain`)
    assert.equal(a.configFormat === 'flat-params' ? 'apply_params.js' : 'apply.js', a.tools.apply.split(/[\\/]/).pop())
    // 包内路径必须指得到（这是"装完就能跑"的前提）
    assert.ok(existsSync(a.tools.metricsJs), `${f} 的 metricsJs 指不到：${a.tools.metricsJs}`)
    assert.ok(existsSync(a.tools.capture), `${f} 的 capture 指不到`)
    assert.ok(existsSync(a.tools.apply), `${f} 的 apply 指不到`)
    assert.ok(a.server.staticScript.endsWith(join('static', 'server.mjs')), `${f} 应该用包内静态服`)
    assert.ok(existsSync(a.server.staticScript), `${f} 的静态服指不到`)
    for (const it of a.metrics) {
      assert.ok(it.id && it.extract, `${f} 的指标缺 id/extract`)
      assert.equal(typeof it.weight, 'number')
    }
  }
  // adapter 搬家到 domains/ 之后，harness 不能被“按 adapters 的上级”猜歪
  const listed = listAdapters(ADAPTER_DIR, join(ROOT, 'harness'))
  assert.deepEqual(listed.map((a) => a.name).sort(), ['fanren-lab-chain-lightning', 'fanren-lab-fire-ray', 'trial-demo-url-time'])
  // 不传 harnessDir 时也要能向上找到 harness/（旧调用方式）
  assert.deepEqual(
    listAdapters(ADAPTER_DIR).map((a) => a.runnable),
    listAdapters(ADAPTER_DIR, join(ROOT, 'harness')).map((a) => a.runnable),
  )
})

test('selfloop_probe 默认读包内 fire-ray.json，返回结构合 schema，指标口径齐全，并显示 domain', async () => {
  const v = await selfloopProbeTool.execute({})
  assert.deepEqual(validate(selfloopProbeTool.output.schema, v), [])
  assert.equal(v.adapterResolved, DEFAULT_ADAPTER)
  assert.equal(DEFAULT_ADAPTER, join(ADAPTER_DIR, 'fire-ray.json'))
  assert.equal(v.domain, DEFAULT_DOMAIN)
  assert.equal(v.adapterName, 'fanren-lab-fire-ray')
  assert.equal(v.schemaVersion, 'closed-loop-adapter/3')
  assert.equal(v.block, 'effects.FireRay.fireBeamG1M1')
  assert.equal(v.configFormat, 'vfx-block')
  assert.equal(v.freeze.protocol, 'noloop-step')
  assert.equal(v.freeze.clock, 'virtual')
  assert.equal(v.freeze.targetTimeMs, 320)
  assert.equal(v.metricsCount, 3)
  assert.deepEqual(v.metrics.map((m) => m.id), ['cov', 'lapVar', 'tone'])
  assert.deepEqual(v.metrics.map((m) => m.extract), ['cov', 'lapVar', 'warmFrac'])
  assert.equal(v.metrics[0].norm, 'range[0,0.3]')
  assert.equal(v.penalties[0].id, 'coreGone')
  assert.match(v.distanceRule, /Σ\(nd_i × w_i\)/)
  assert.deepEqual(v.harness.missing, [], '包内 harness 不该缺件')
  assert.equal(v.harness.required, 8)
  assert.ok(v.tools.metricsJs.endsWith('metrics2.js'))
  // 包内零本机绝对路径：clientRoot 是 %VFX_LOOP_CLIENT% 模板 ⇒ 没设变量时应当"指不到配置"并说清原因
  assert.equal(v.clientRoot, '')
  const envWarn = v.warnings.filter((w) => /环境变量没设置/.test(w))
  assert.equal(envWarn.length, 1, '应当恰好一条"环境变量没设置"警告：' + v.warnings.join(' | '))
  assert.equal(v.configFileExists, false)
})

test('domain 是可选字段：旧 adapter 没有 domain 时照常解析、照常跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-legacy-'))
  const src = readJson('domains/vfx-render/adapters/fire-ray.json')
  delete src.domain
  const legacy = join(dir, 'legacy.json')
  writeFileSync(legacy, JSON.stringify(src))
  const v = await selfloopProbeTool.execute({ adapter: legacy })
  assert.deepEqual(validate(selfloopProbeTool.output.schema, v), [])
  assert.equal(v.domain, '', '缺字段时 domain 要回空串而不是抛错')
  assert.equal(v.adapterName, 'fanren-lab-fire-ray')
  assert.deepEqual(v.harness.missing, [])
  // 清单里照样能列出来，归到"未标注"那组
  const listed = listAdapters(dir, join(ROOT, 'harness'))
  assert.equal(listed.length, 1)
  assert.equal(listed[0].domain, '')
  assert.equal(listed[0].name, 'fanren-lab-fire-ray')
  assert.deepEqual(groupByDomain(listed).map((g) => g.domain), [''])
})

test('selfloop_probe：设了 %VFX_LOOP_CLIENT% 之后 clientRoot / 配置文件就解析成"能跑"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-client-'))
  mkdirSync(join(dir, 'resource', 'lab', 'vfx'), { recursive: true })
  writeFileSync(join(dir, 'resource', 'lab', 'vfx', 'vfx.json'), '{}')
  const prev = process.env.VFX_LOOP_CLIENT
  process.env.VFX_LOOP_CLIENT = dir
  try {
    const v = await selfloopProbeTool.execute({})
    assert.deepEqual(validate(selfloopProbeTool.output.schema, v), [])
    assert.equal(v.clientRoot, dir)
    assert.equal(v.configFileExists, true)
    assert.deepEqual(v.warnings.filter((w) => /环境变量没设置|配置文件不在/.test(w)), [])
    // 浏览器候选也是模板展开的：本机装了 Edge/Chrome 才会命中，没装就只该有一条"没命中"的警告
    assert.ok(Array.isArray(v.warnings))
    assert.ok(v.browser.exeCandidates >= 3, 'adapter 声明了 4 个候选（模板按 4 条计）')
  } finally {
    if (prev === undefined) delete process.env.VFX_LOOP_CLIENT
    else process.env.VFX_LOOP_CLIENT = prev
  }
})

test('selfloop_probe 对能解析但跑不起来的情况只记账不抛错（clientRoot 指空）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-probe-'))
  const src = readJson('domains/vfx-render/adapters/fire-ray.json')
  src.clientRoot = join(dir, 'nope')
  src.browser.exeCandidates = [join(dir, 'no-browser.exe')]
  const file = join(dir, 'a.json')
  writeFileSync(file, JSON.stringify(src))
  const v = await selfloopProbeTool.execute({ adapter: file })
  assert.deepEqual(validate(selfloopProbeTool.output.schema, v), [])
  assert.equal(v.configFileExists, false)
  assert.ok(v.warnings.length >= 2, v.warnings.join(' | '))
  assert.ok(v.warnings.some((w) => /配置文件不在/.test(w)))
  assert.ok(v.warnings.some((w) => /浏览器/.test(w)))
})

test('selfloop_probe 硬错与 iter.ps1 同口径：坏路径/坏 JSON/缺字段/相对路径/未知参数/空串', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-probe-bad-'))
  await assert.rejects(selfloopProbeTool.execute({ adapter: join(dir, 'nope.json') }), /读不到/)
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{ not json')
  await assert.rejects(selfloopProbeTool.execute({ adapter: bad }), /不是合法 JSON/)

  const good = readJson('domains/vfx-render/adapters/fire-ray.json')
  const write = (name, obj) => {
    const p = join(dir, name)
    writeFileSync(p, JSON.stringify(obj))
    return p
  }
  const noBlock = write('no-block.json', { ...good, config: { path: 'x' } })
  await assert.rejects(selfloopProbeTool.execute({ adapter: noBlock }), /缺字段：config\.block/)
  const noFreeze = write('no-freeze.json', { ...good, freeze: undefined })
  await assert.rejects(selfloopProbeTool.execute({ adapter: noFreeze }), /缺字段：freeze/)
  const badProto = write('bad-proto.json', { ...good, freeze: { ...good.freeze, protocol: 'noloop' } })
  await assert.rejects(selfloopProbeTool.execute({ adapter: badProto }), /freeze\.protocol=noloop 未实现/)
  const badStep = write('bad-step.json', { ...good, freeze: { ...good.freeze, stepMs: 0 } })
  await assert.rejects(selfloopProbeTool.execute({ adapter: badStep }), /freeze\.stepMs/)
  const badFormat = write('bad-format.json', { ...good, config: { ...good.config, format: 'yaml' } })
  await assert.rejects(selfloopProbeTool.execute({ adapter: badFormat }), /config\.format=yaml/)
  const badClock = write('bad-clock.json', { ...good, freeze: { ...good.freeze, clock: 'virtual-x' } })
  await assert.rejects(selfloopProbeTool.execute({ adapter: badClock }), /freeze\.clock=virtual-x/)

  await assert.rejects(selfloopProbeTool.execute({ adapter: 'domains/vfx-render/adapters/fire-ray.json' }), /绝对路径/)
  await assert.rejects(selfloopProbeTool.execute({ path: '/x' }), /未知参数 path/)
  await assert.rejects(selfloopProbeTool.execute({ adapter: '' }), /不能是空字符串/)
})

test('selfloop_list_adapters 返回结构合 schema，按 domain 分组，3 份题材都不重复', async () => {
  const v = await selfloopListAdaptersTool.execute()
  assert.deepEqual(validate(selfloopListAdaptersTool.output.schema, v), [])
  assert.equal(v.ok, true)
  assert.equal(v.count, 3)
  assert.equal(v.dir, ADAPTER_DIR)
  assert.deepEqual(v.domains, ['vfx-render'])
  assert.equal(v.groups.length, 1)
  assert.equal(v.groups[0].domain, 'vfx-render')
  assert.equal(v.groups[0].count, 3)
  assert.equal(v.groups[0].files.length, 3)
  assert.deepEqual(v.adapters.map((a) => a.domain), ['vfx-render', 'vfx-render', 'vfx-render'])
  const topics = v.adapters.map((a) => a.topic)
  assert.equal(new Set(topics).size, 3)
  assert.deepEqual(v.adapters.map((a) => a.freezeProtocol).sort(), ['noloop-step', 'noloop-step', 'url-time'])
  for (const a of v.adapters) {
    assert.equal(typeof a.runnable, 'boolean')
    if (!a.runnable) assert.ok(a.reason.length > 0, `${a.file} runnable=false 必须给原因`)
  }
  // 与 parseAdapter 同源
  assert.deepEqual(
    listAdapters(ADAPTER_DIR, join(ROOT, 'harness')).map((a) => a.name),
    v.adapters.map((a) => a.name),
  )
})

test('domain 分组：有标注的在前、未标注的垫底，且都在 groups 里', () => {
  const fake = [
    { file: 'b.json', name: 'b', domain: '', topic: '', freezeProtocol: '', tier: '', metricsCount: 0, runnable: false, reason: 'x' },
    { file: 'a.json', name: 'a', domain: 'vfx-render', topic: '', freezeProtocol: '', tier: '', metricsCount: 0, runnable: false, reason: 'x' },
    { file: 'c.json', name: 'c', domain: 'audio-mix', topic: '', freezeProtocol: '', tier: '', metricsCount: 0, runnable: false, reason: 'x' },
  ]
  const groups = groupByDomain(fake)
  assert.deepEqual(groups.map((g) => g.domain), ['audio-mix', 'vfx-render', ''])
  assert.deepEqual(groups.map((g) => g.count), [1, 1, 1])
  assert.deepEqual(groups[2].files, ['b.json'])
})

test('两个工具的 render 都是 [{type:text,text}]，text 里能看到关键口径与领域', async () => {
  const p = await selfloopProbeTool.execute({})
  const pr = selfloopProbeTool.output.render({}, p)
  assert.ok(Array.isArray(pr) && pr.length === 1)
  assert.equal(pr[0].type, 'text')
  assert.match(pr[0].text, /fireBeamG1M1/)
  assert.match(pr[0].text, /领域：vfx-render/)
  assert.match(pr[0].text, /指标 3 项/)
  assert.match(pr[0].text, /range\[0,0\.3\]/)
  assert.ok(pr[0].text.includes(p.note))

  const l = await selfloopListAdaptersTool.execute()
  const lr = selfloopListAdaptersTool.output.render({}, l)
  assert.equal(lr[0].type, 'text')
  assert.match(lr[0].text, /3 份/)
  assert.match(lr[0].text, /\[vfx-render\] 3 份/)
  assert.match(lr[0].text, /火焰射线|闪电链/)
})

// ---------------------------------------------------------------- 静态服（不起端口）
test('自带静态服：路径解析拒绝穿越，斜杠当 index.html，MIME 表与项目根那份一致', () => {
  const root = join(ROOT, 'static')
  assert.deepEqual(resolveRequest(root, '/'), { file: join(root, 'index.html') })
  assert.equal(resolveRequest(root, '/a b.html?x=1').file, join(root, 'a b.html'))
  for (const bad of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/x', '/../..']) {
    assert.ok(resolveRequest(root, bad).denied, `${bad} 应该被拒`)
  }
  assert.equal(contentType('x.html'), 'text/html; charset=utf-8')
  assert.equal(contentType('x.mjs'), 'application/javascript; charset=utf-8')
  assert.equal(contentType('x.unknown'), 'application/octet-stream')
  for (const k of ['.html', '.js', '.json', '.png', '.jpg', '.webp', '.svg', '.css', '.map']) {
    assert.ok(MIME[k], `MIME 缺 ${k}（_tmp_static.js 里有）`)
  }
  // 处理器是惰性构造，createStaticHandler 不监听端口
  assert.equal(typeof createStaticHandler(root), 'function')
})

test('静态服处理器能真的回一份文件（假 req/res，不开端口）', async () => {
  const root = join(ROOT, 'skills')
  const handle = createStaticHandler(root)
  const res = {
    status: 0,
    headers: {},
    writeHead(code, headers) {
      this.status = code
      this.headers = headers ?? {}
    },
    end() {},
  }
  await handle({ method: 'HEAD', url: '/selfloop/SKILL.md' }, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /text\/markdown|octet-stream/)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*')
  assert.ok(Number(res.headers['Content-Length']) > 1000)

  const miss = { status: 0, headers: {}, writeHead(c, h) { this.status = c; this.headers = h ?? {} }, end() {} }
  await handle({ method: 'GET', url: '/nope.md' }, miss)
  assert.equal(miss.status, 404)

  const denied = { status: 0, headers: {}, writeHead(c, h) { this.status = c; this.headers = h ?? {} }, end() {} }
  await handle({ method: 'GET', url: '/../package.json' }, denied)
  assert.equal(denied.status, 403)

  const wrongMethod = { status: 0, headers: {}, writeHead(c, h) { this.status = c; this.headers = h ?? {} }, end() {} }
  await handle({ method: 'POST', url: '/' }, wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

// ---------------------------------------------------------------- 技能
test('包内 skill 5 个文件齐全（含领域拆分），frontmatter 与注册结果一致', () => {
  const dir = join(ROOT, 'skills', 'selfloop')
  for (const f of [
    'SKILL.md',
    'references/metrics.md',
    'references/pitfalls.md',
    'references/workflow.md',
    'references/domains-vfx.md',
  ]) {
    assert.ok(statSync(join(dir, f)).size > 1000, `skill 缺 ${f}`)
  }
  const src = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  assert.ok(fm, 'SKILL.md 要有 frontmatter')
  assert.match(fm[1], /^name:[ \t]*selfloop$/m)
  assert.match(fm[1], /^description:[ \t]*\S+/m)
  // 描述是领域无关的：先说通用闭环，vfx 只作为例子出现在后面
  const desc = /^description:[ \t]*(.*)$/m.exec(fm[1])[1]
  assert.match(desc, /任意可测目标/, '描述要先讲通用闭环')
  assert.ok(desc.indexOf('任意可测目标') < desc.indexOf('渲染'), 'vfx 只能作为例子出现，不能打头')
  assert.ok(!desc.startsWith('用「改参数 → 冻帧出图'), '不该再以 vfx 打头')
  // 通用骨架三句必须在（引擎与题材的分界）
  const body = src.slice(fm[0].length)
  for (const need of [
    '任意能给出可比较数值的探针',
    '可配置的判据与距离',
    '可配置的参数空间',
    '先扫活性，再选轴',
  ]) {
    assert.ok(body.includes(need), `SKILL.md 缺通用骨架：${need}`)
  }
  // 五条硬规则保留
  for (const h of ['① 没做参数活性扫描', '② 对比必须锁', '③ 判据只认数字', '④ 闸门新增断言', '⑤ 对抗样本']) {
    assert.ok(body.includes(h), `SKILL.md 缺硬规则 ${h}`)
  }
  // 领域细节搬走了：SKILL.md 不再替 vfx 讲现场，只指路
  assert.match(body, /references\/domains-vfx\.md/)
  assert.ok(!/warmFrac/.test(body), 'vfx 的指标细节不该留在通用 SKILL.md 里')
  const domainsVfx = readFileSync(join(dir, 'references', 'domains-vfx.md'), 'utf8')
  assert.match(domainsVfx, /warmFrac/, 'vfx 专属内容要在 domains-vfx.md 里')
  assert.match(domainsVfx, /%VFX_LOOP_CLIENT%/, 'vfx 的现场模板也在领域文档里')
})

test('宿主有 skills 服务时 apply 把技能注册进去（名字/正文/resourceBase 都对）', () => {
  const { ctx, tools, skills } = mockCtx({ withSkills: true })
  apply(ctx)
  assert.equal(tools.length, 2)
  assert.equal(skills.length, 1)
  const s = skills[0]
  assert.equal(s.name, 'selfloop')
  assert.ok(s.description.length > 30)
  assert.equal(s.source, 'runtime')
  assert.ok(!s.content.startsWith('---'), '正文不该带 frontmatter')
  assert.match(s.content, /通用闭环引擎/)
  assert.equal(s.resourceBase.kind, 'directory')
  assert.ok(existsSync(join(s.resourceBase.path, 'references', 'workflow.md')))
  assert.ok(existsSync(join(s.resourceBase.path, 'references', 'domains-vfx.md')))
})

test('宿主没有 skills 服务 / 没有 inject 时 apply 不抛错（工具照常注册）', () => {
  const { ctx, tools } = mockCtx()
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(tools.length, 2)
})

test('Cordis 式 ctx.inject：按可选依赖挂技能，deps 只声明 skills', () => {
  const tools = []
  const skills = []
  const seen = []
  const ctx = {
    tools: { register: (t) => (tools.push(t), () => {}) },
    skills: { register: (s) => (skills.push(s), () => {}) },
    inject: (deps, cb) => {
      seen.push(deps)
      cb(ctx)
    },
  }
  apply(ctx)
  assert.deepEqual(seen, [['skills']])
  assert.equal(tools.length, 2)
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'selfloop')
})

// ---------------------------------------------------------------- 清单与 locale
test('locale 双语 key 完全一致，title 是「权臣」/ Selfloop，描述写的是新工具名', () => {
  const zh = readJson(join('locale', 'zh.json'))
  const en = readJson(join('locale', 'en.json'))
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  assert.deepEqual(Object.keys(en.meta).sort(), Object.keys(zh.meta).sort())
  assert.equal(zh.meta.title, '权臣')
  assert.equal(en.meta.title, 'Selfloop — self-closing loop engine')
  for (const [lang, loc] of [['zh', zh], ['en', en]]) {
    assert.ok(loc.meta.title.trim().length > 0, lang)
    assert.ok(loc.meta.description.trim().length > 60, `${lang} description 太短，像没改模板`)
    assert.match(loc.meta.description, /selfloop_probe/, `${lang} 描述要提新工具名`)
    assert.ok(!/vfx_probe/.test(loc.meta.description), `${lang} 还留着旧工具名`)
  }
})

test('清单：files 白名单覆盖三层、分发协议行、engines.dsh 只有下界、版本 0.3.0', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'dsh-selfloop')
  assert.equal(pkg.version, '0.3.0')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  for (const k of ['.', './core', './cordis.patch.yml', './package.json', './locale/*.json']) {
    assert.ok(pkg.exports[k], `exports 缺 ${k}`)
  }
  for (const need of ['lib', 'core', 'domains', 'harness', 'static', 'skills', 'locale/*.json', 'cordis.patch.yml', 'icon.png', 'README.md']) {
    assert.ok(pkg.files.includes(need), `files 缺 ${need}`)
  }
  assert.ok(!pkg.files.includes('adapters'), 'adapters 已搬进 domains/，根目录不该再列')
  const positives = pkg.files.filter((f) => !f.startsWith('!'))
  assert.equal(positives.length, 10, 'files 正名单不该有多余项')
  // 评审 §4.2：日志文件不许随包分发 —— 显式排除一条，别指望"忘了把文件挪进来"
  assert.ok(pkg.files.includes('!**/*.log'), 'files 要显式排除 *.log')
  // 白名单里的每一项都真有东西（带 * 的按"目录里至少命中一个"判）
  for (const entry of positives) {
    if (entry.includes('*')) {
      const dir = join(ROOT, entry.split('/')[0])
      const ext = entry.split('*')[1] ?? ''
      assert.ok(
        readdirSync(dir).some((f) => f.endsWith(ext)),
        `files 项 ${entry} 一个都没命中`,
      )
      continue
    }
    const p = join(ROOT, entry)
    assert.ok(existsSync(p), `files 项不存在：${entry}`)
    if (!entry.includes('.')) assert.ok(statSync(p).isDirectory(), `${entry} 应该是目录`)
  }
  assert.equal(pkg.icon, './icon.png')
  const iconBytes = statSync(join(ROOT, 'icon.png')).size
  assert.ok(iconBytes > 0 && iconBytes <= 256 * 1024, `icon ${iconBytes} B 不合规`)
  assert.ok(statSync(join(ROOT, 'cordis.patch.yml')).size > 0)
  // cordis.patch.yml 的 id/name 跟着改成 selfloop
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: selfloop/)
  assert.match(patch, /name: 'dsh-selfloop'/)
  // engines.dsh 只写下界（>=），不设上界
  assert.match(pkg.engines.dsh, /^>=/, 'engines.dsh 只该有下界')
  assert.ok(!/[<^~]/.test(pkg.engines.dsh), 'engines.dsh 不该有上界')
  // playwright 是运行时依赖（P3 定的引擎）
  assert.match(pkg.dependencies.playwright, /^\^?1\./)
  // 包里不该混进测试与 node_modules
  assert.ok(!pkg.files.some((f) => /test|node_modules|tgz/.test(f)))
  assert.ok(!pkg.files.some((f) => /\.log$/i.test(f) && !f.startsWith('!')), 'files 正名单里不该有日志')
})

// ---------------------------------------------------------------- 便携性（评审 §5）
test('包内没有本机绝对路径（盘符形式，node_modules 除外）', () => {
  // 判据自己别被自己的样例命中：盘符正则用字符串拼，源码里不出现"字母:反斜杠"
  const sep = String.fromCharCode(92)
  const driveRe = new RegExp('(?<![A-Za-z0-9])[A-Za-z]:' + sep + sep)
  const skip = /^(node_modules|\.git)$/
  const binary = /\.(png|jpe?g|webp|gif|ico|tgz|zip)$/i
  const hits = []
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.test(e.name)) continue
      const relPath = rel ? join(rel, e.name) : e.name
      if (e.isDirectory()) {
        walk(join(dir, e.name), relPath)
        continue
      }
      if (binary.test(e.name)) continue
      const txt = readFileSync(join(dir, e.name), 'utf8')
      for (const line of txt.split(/\r?\n/)) {
        if (driveRe.test(line)) hits.push(`${relPath}: ${line.trim().slice(0, 120)}`)
      }
    }
  }
  walk(ROOT, '')
  assert.deepEqual(hits, [], '包内出现了本机绝对路径（换台机器就装不上/跑不了）：\n' + hits.join('\n'))
})

test('三个入口都有 Windows 平台守卫（非 Windows 立刻中文拒绝，不跑到一半才炸）', () => {
  const iter = readFileSync(join(ROOT, 'harness', 'iter.ps1'), 'utf8')
  const capPs = readFileSync(join(ROOT, 'harness', 'capture.ps1'), 'utf8')
  const capMjs = readFileSync(join(ROOT, 'harness', 'capture.mjs'), 'utf8')
  const msg = '本适配器需要 Windows（harness 基于 PowerShell + Edge）；当前平台 '
  for (const [name, src] of [['iter.ps1', iter], ['capture.ps1', capPs]]) {
    assert.ok(src.includes(msg), `${name} 缺平台拒绝对话（要一字不差地给人看）`)
    assert.match(src, /\$IsWindows/, `${name} 判据要用 $IsWindows`)
    assert.match(src, /\$PSVersionTable\.PSEdition/, `${name} 要处理 Windows PowerShell 5.1（没有 $IsWindows）`)
  }
  assert.match(iter, /\[Environment\]::Exit\(2\)/, 'iter.ps1 是入口脚本：一行错误 + 非零退出（exit 2 在 & 调用下会变 1，实测）')
  assert.match(capPs, /throw \(/, 'capture.ps1 被 dot-source：只能用 throw，exit 会连带关掉调用方')
  assert.ok(capMjs.includes(msg), 'capture.mjs 缺平台拒绝对话')
  assert.match(capMjs, /process\.platform !== 'win32'/, 'capture.mjs 判据要用 process.platform')
  // 守卫必须在"干活"之前：start 的第一件事就是判平台
  const startBody = capMjs.slice(capMjs.indexOf('const handlers = {'))
  assert.ok(
    startBody.indexOf("process.platform !== 'win32'") < startBody.indexOf('sweepOrphans()'),
    'start 里平台判断要排在清孤儿/起浏览器之前',
  )
})

test('孤儿守卫三条都在（评审 §4.1）：看门狗 / 关闭时杀整棵树 / 启动时清孤儿', () => {
  const cap = readFileSync(join(ROOT, 'harness', 'capture.mjs'), 'utf8')
  assert.match(cap, /function startWatchdog/, '缺父进程死亡看门狗')
  assert.match(cap, /WATCHDOG_INTERVAL_SEC = 10/, '看门狗间隔必须是 10s')
  assert.match(cap, /detached: false/, 'Windows 上 detached:true 会让看门狗立刻退出（实测坑）')
  assert.match(cap, /function sweepOrphans/, '缺启动时清孤儿')
  assert.match(cap, /ParentProcessId/, '清孤儿的判据必须是"父进程已不存在"')
  assert.match(cap, /taskkill/, '关闭时必须按进程树杀（taskkill /T /F）')
  assert.match(cap, /chromiumMissingMessage/, 'Chromium 没装要在返回里说人话（§4.2）')
  // iter.ps1：-Root 默认空，运行时推导；profile 不许落在包目录
  const iter = readFileSync(join(ROOT, 'harness', 'iter.ps1'), 'utf8')
  assert.match(iter, /\[string\]\$Root = '',/)
  assert.match(iter, /\[string\]\$ProfileRoot = '',/)
  assert.match(iter, /\$ProfileRoot = Resolve-AbsPath/)
  assert.ok(!/\$profile = Join-Path \$ToolDir/.test(iter), 'profile 不该落在包目录里（装成 node_modules 后可能只读）')
  assert.match(iter, /Expand-PathTpl/, '路径模板（%环境变量%）要有统一的展开口径')
})
