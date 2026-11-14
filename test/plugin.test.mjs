// 插件自测：不起宿主、不装 profile、不开端口、不跑闭环。
// 纯 node:test + 假 ctx + 一个 JSON-Schema 子集校验器（用来验 output.schema 和返回值对得上）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const mod = await import('../lib/index.js')
const { name, apply, selfloopProbeTool, selfloopListAdaptersTool, DEFAULT_ADAPTER, DEFAULT_DOMAIN } = mod
const { HARNESS_REQUIRED, HARNESS_ROLES, parseAdapter, listAdapters, groupByDomain } = await import('../core/adapter.js')
const { resolveRequest, contentType, createStaticHandler, MIME } = await import('../static/server.mjs')

const ADAPTER_DIR = join(ROOT, 'domains', 'vfx-render', 'adapters')
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))

// 假 ctx：cordis 的 inject(deps, cb) 在服务就绪时回调；这里同步回调模拟"服务已在"
function mockCtx({ withSkills = false } = {}) {
  const tools = []
  const skills = []
  const ctx = {
    tools: { register: (tool) => (tools.push(tool), () => {}) },
    inject: (_deps, cb) => cb(ctx),
  }
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

test('插件名，且**不导出插件级 inject**（宿主会把 pending 挂死）', () => {
  assert.equal(name, 'selfloop')
  // 0.3.1 的实测：export const inject = { required: [], optional: ['tools'] }
  // → 本宿主 fiberPhase 永远 pending，apply 一次都没跑，工具与技能全消失。
  // 所以这条断言不是风格偏好，是装机事故的护栏：插件级 inject 必须不存在。
  assert.ok(!('inject' in mod), '不许导出插件级 inject：本宿主会 pending 到永不激活（见 README 安装验收）')
})

test('宿主没有 tools 服务（inject 回调等不到）：apply 不抛、工具不注册', () => {
  const tools = []
  const ctx = {
    // 真宿主里 ctx.inject 在服务 ACTIVE 时才回调；服务永远没有 → 回调不跑，这是"软"
    inject: (_deps, _cb) => {},
    get: () => undefined,
    logger: { warn: () => {} },
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(tools.length, 0)
})

test('服务就绪时走 ctx.inject 回调注册两个工具（不在 apply 里同步读服务）', () => {
  const tools = []
  const ctx = {
    // 服务没就绪时 inject 的回调还没被叫过，ctx.get 也按设计返回 undefined
    get: () => undefined,
    inject: (deps, cb) => {
      if (deps.includes('tools')) cb({ tools: { register: (t) => (tools.push(t), () => {}) } })
    },
  }
  apply(ctx)
  assert.equal(tools.length, 2, '就绪后回调必须把两个工具挂上')
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
test('harness 齐全：9 件跑一轮必需件 + 默认 adapter + 适配层字段说明', () => {
  const dir = join(ROOT, 'harness')
  assert.equal(HARNESS_REQUIRED.length, 9, '跑一轮的必需件清单')
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
  assert.deepEqual(listed.map((a) => a.name).sort(), ['example-chain-lightning', 'example-fire-ray', 'example-flat-params'])
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
  assert.equal(v.adapterName, 'example-fire-ray')
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
  assert.equal(v.harness.required, 9, '必需件清单含 writeguard.js（9 件）')
  assert.ok(v.tools.metricsJs.endsWith('metrics2.js'))
  // 包内零本机绝对路径：clientRoot 是 %VFX_LOOP_CLIENT% 模板 ⇒ 没设变量时应当"指不到配置"并说清原因。
  // 模板变量有两条（clientRoot + guard.protectPaths 的 %VFX_LOOP_BODY_CLIENT%），所以这里**不数条数**：
  // 只钉"该报的那条报了"——数条数的写法在加 protectPaths 时就会红（加一个模板变量 = 一条新 warning）。
  assert.equal(v.clientRoot, '')
  assert.ok(
    v.warnings.some((w) => /环境变量没设置/.test(w) && w.includes('%VFX_LOOP_CLIENT%')),
    'clientRoot 的模板变量没设要说出来：' + v.warnings.join(' | '),
  )
  assert.ok(
    v.warnings.some((w) => /环境变量没设置/.test(w) && w.includes('VFX_LOOP_BODY_CLIENT')),
    'guard.protectPaths 的模板变量没设也要说出来：' + v.warnings.join(' | '),
  )
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
  assert.equal(v.adapterName, 'example-fire-ray')
  assert.deepEqual(v.harness.missing, [])
  // 清单里照样能列出来，归到"未标注"那组
  const listed = listAdapters(dir, join(ROOT, 'harness'))
  assert.equal(listed.length, 1)
  assert.equal(listed[0].domain, '')
  assert.equal(listed[0].name, 'example-fire-ray')
  assert.deepEqual(groupByDomain(listed).map((g) => g.domain), [''])
})

test('selfloop_probe：设了 %VFX_LOOP_CLIENT% 之后 clientRoot / 配置文件就解析成"能跑"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-client-'))
  mkdirSync(join(dir, 'resource', 'lab', 'vfx'), { recursive: true })
  writeFileSync(join(dir, 'resource', 'lab', 'vfx', 'vfx.json'), '{}')
  const prev = process.env.VFX_LOOP_CLIENT
  // fire-ray 现在有两处模板变量：clientRoot（%VFX_LOOP_CLIENT%）与 guard.protectPaths（%VFX_LOOP_BODY_CLIENT%）。
  // 这条测的是"变量都设好 → 一条环境变量警告都不该有"，所以两个都设。
  const prevBody = process.env.VFX_LOOP_BODY_CLIENT
  process.env.VFX_LOOP_CLIENT = dir
  process.env.VFX_LOOP_BODY_CLIENT = join(dir, 'body')
  try {
    const v = await selfloopProbeTool.execute({})
    assert.deepEqual(validate(selfloopProbeTool.output.schema, v), [])
    assert.equal(v.clientRoot, dir)
    assert.equal(v.configFileExists, true)
    assert.deepEqual(v.warnings.filter((w) => /环境变量没设置|配置文件不在/.test(w)), [])
    // 保护路径也是模板展开的（bodyClient 空 → 只剩声明的那一条）
    assert.deepEqual(v.guard.protectPaths, [join(dir, 'body')])
    assert.equal(v.guard.enforced, true)
    // 浏览器候选也是模板展开的：本机装了 Edge/Chrome 才会命中，没装就只该有一条"没命中"的警告
    assert.ok(Array.isArray(v.warnings))
    assert.ok(v.browser.exeCandidates >= 3, 'adapter 声明了 4 个候选（模板按 4 条计）')
  } finally {
    if (prev === undefined) delete process.env.VFX_LOOP_CLIENT
    else process.env.VFX_LOOP_CLIENT = prev
    if (prevBody === undefined) delete process.env.VFX_LOOP_BODY_CLIENT
    else process.env.VFX_LOOP_BODY_CLIENT = prevBody
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

test('既没有 ctx.inject 也没有 ctx.get：apply 只 warn，不抛（失联也要响）', () => {
  const warns = []
  const ctx = { logger: { warn: (m) => warns.push(m) } }
  assert.doesNotThrow(() => apply(ctx))
  assert.ok(warns.some((m) => /tools/.test(m)), '缺 tools 必须留一条 warn')
})

test('老宿主没有 ctx.inject 时：走 ctx.get 同步探测，绝不碰 ctx.tools 属性', () => {
  const tools = []
  const ctx = {
    get: (n, opt) => {
      assert.equal(opt, true, 'ctx.get 第二个参数必须是 true（可选）')
      return n === 'tools' ? { register: (t) => (tools.push(t), () => {}) } : undefined
    },
    // 0.3.2 就是这么挂的：未声明 inject 时直接读 ctx.tools 会被 cordis Proxy 抛
    get tools() {
      throw new Error('cannot get property "tools" without inject')
    },
  }
  assert.doesNotThrow(() => apply(ctx), '绝不能为了兜底去直接读 ctx.tools')
  assert.equal(tools.length, 2)
})

test('Cordis 式 ctx.inject：tools 与 skills 各订阅一次，回调里拿作用域服务', () => {
  const tools = []
  const skills = []
  const seen = []
  const ctx = {
    get: () => undefined,
    inject: (deps, cb) => {
      seen.push(deps)
      cb({
        tools: { register: (t) => (tools.push(t), () => {}) },
        skills: { register: (s) => (skills.push(s), () => {}) },
      })
    },
  }
  apply(ctx)
  assert.deepEqual(seen, [['tools'], ['skills']])
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

test('清单：files 白名单覆盖三层、分发协议行、engines.dsh 只有下界、版本 0.7.0', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'dsh-selfloop')
  assert.equal(pkg.version, '0.7.0')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  for (const k of ['.', './core', './cordis.patch.yml', './package.json', './locale/*.json']) {
    assert.ok(pkg.exports[k], `exports 缺 ${k}`)
  }
  for (const need of ['lib', 'core', 'domains', 'harness', 'static', 'examples', 'skills', 'locale/*.json', 'cordis.patch.yml', 'icon.png', 'README.md']) {
    assert.ok(pkg.files.includes(need), `files 缺 ${need}`)
  }
  assert.ok(!pkg.files.includes('adapters'), 'adapters 已搬进 domains/，根目录不该再列')
  const positives = pkg.files.filter((f) => !f.startsWith('!'))
  assert.equal(positives.length, 12, 'files 正名单恰好 12 项，不该有多余项')
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

test('T21 files 正名单里的每一项都真的进得了包（npm pack --dry-run 对账）', (t) => {
  // 上面那条只证明"本地有这个东西"，证明不了"打出来的 tgz 里有它"——
  // 0.3.4 就是栽在这：CHANGELOG 写了却不在白名单里，装机后根本看不到。
  const pkg = readJson('package.json')
  const positives = pkg.files.filter((f) => !f.startsWith('!'))
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: true })
  if (r.error || r.status !== 0) {
    t.skip(`这台机器跑不了 npm pack（${r.error?.message ?? `exit ${r.status}`}）—— 发版前手动跑一次 npm pack --dry-run 对账`)
    return
  }
  let packed
  try {
    packed = JSON.parse(r.stdout)[0].files.map((f) => f.path.replace(/\\/g, '/'))
  } catch (e) {
    assert.fail(`npm pack --json 的输出解析不了：${e.message}`)
  }
  for (const entry of positives) {
    const hit = entry.includes('*')
      ? packed.some((p) => p.startsWith(entry.split('*')[0]))
      : packed.some((p) => p === entry || p.startsWith(`${entry}/`))
    assert.ok(hit, `files 里有 ${entry}，但 npm pack 的产物里没有它 —— 白名单写了发不出去，等于没写`)
  }
})

// ---------------------------------------------------------------- 便携性（评审 §5）
test('包内没有本机绝对路径（盘符形式，node_modules 除外）', () => {
  // 判据自己别被自己的样例命中：盘符正则用字符串拼，源码里不出现"字母:反斜杠"
  const sep = String.fromCharCode(92)
  const driveRe = new RegExp('(?<![A-Za-z0-9])[A-Za-z]:' + sep + sep)
  // 运行时产物目录一律跳过：证据包本来就该落在 run 目录（默认就叫 runs/，且 .gitignore 里已排除），
  // 里面记本机绝对路径是**要求**（报告要能说清基线参数文件在哪）。不跳的话，谁在仓库里跑过一轮闭环，
  // 这条"包内没有本机绝对路径"就会假红 —— 它该管的是随包分发的源码/配置，不是 run 产物。
  const skip = /^(node_modules|\.git|runs|prof_.*)$/
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

// ---------------------------------------------------------------- 解耦批次一：默认值中性化 + adapter 字段解析
// 对应方案 11-解耦方案.md §4 的 T10 / T11 / T13~T17 / T19。
// 每条都要"弄坏能红"：删掉被测的那行，本条（或点名的那条）必须红。
const ITER_SRC = readFileSync(join(ROOT, 'harness', 'iter.ps1'), 'utf8')

test('T10 iter.ps1 没有内置白名单：$Params 默认空串，白名单没来源就 throw（唯一 BREAKING）', () => {
  // 弄坏能红：把 param 块改回 [string]$Params = 'widthPx,distM' 或把 else 的 throw 改回静默赋值
  assert.ok(
    !/\[string\]\$Params\s*=\s*'widthPx,distM'/.test(ITER_SRC),
    '[string]$Params 不许再有内置默认白名单 widthPx,distM',
  )
  assert.match(ITER_SRC, /\[string\]\$Params = '',/, '$Params 的默认值必须是空串')
  assert.match(ITER_SRC, /throw '白名单没有来源：/, '命令行没 -Params 且 adapter 没 params 节时必须 throw，不许静默兜底')
  assert.match(ITER_SRC, /-Params a,b/, '报错文案要写清修法（-Params a,b 或给 adapter 加 params 节）')
  assert.ok(
    !/内置默认 widthPx,distM，等价 P2\.5 之前的行为/.test(ITER_SRC),
    '旧的"内置默认 + 打日志就开跑"必须删干净',
  )
})

test('T11 iter.ps1 不认字段模板（template:true 拒跑）+ Import-Adapter 补非空校验/block 空串', () => {
  // 弄坏能红：删掉 template 拒跑那段 → 本条红
  assert.match(ITER_SRC, /\$[aA]\['template'\]/, 'Import-Adapter 要检查 template 键')
  assert.match(ITER_SRC, /template:true/, '拒跑文案要点明 template:true')
  assert.match(ITER_SRC, /你用的是包内字段模板/, '拒跑要用人话说明"这是模板不是 adapter"')
  assert.match(ITER_SRC, /domains\/vfx-render\/adapters\/fire-ray\.json/, '拒跑要指路一份真 adapter')
  // 与 core 同口径的非空校验（D4：一侧只看键在不在、一侧查空串，就是第三次口径分叉）
  assert.match(ITER_SRC, /IsNullOrWhiteSpace/, 'Import-Adapter 要查空串（name/clientRoot/config.path/config.block/page.file）')
  assert.match(ITER_SRC, /adapter 缺字段：config\.block（空串）/, 'config.block 空串要在 §0 就报错，别让正则报"格式不对"')
})

test('T13 parseAdapter 认 guard.protectPaths：绝对路径 + bodyClient 自动并入（并集、不重复）', () => {
  // 弄坏能红：不并入 bodyClient → 第二条断言的 length 变 1
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-guard-'))
  const src = readJson('domains/vfx-render/adapters/fire-ray.json')
  src.clientRoot = dir
  src.guard = { protectPaths: ['protect-body'], bodyClient: 'protect-body/client' }
  const file = join(dir, 'a.json')
  writeFileSync(file, JSON.stringify(src))
  const a = parseAdapter(file, join(ROOT, 'harness'))
  assert.equal(a.guard.enforced, true, '声明了 protectPaths 就必须 enforced=true')
  assert.equal(a.guard.bodyClient, join(dir, 'protect-body', 'client'))
  assert.equal(a.guard.protectPaths.length, 2, 'protectPaths(1) ∪ bodyClient(1)')
  for (const p of a.guard.protectPaths) assert.ok(isAbsolute(p), `protectPaths 必须展开成绝对路径：${p}`)
  assert.ok(a.guard.protectPaths.includes(join(dir, 'protect-body')), '相对路径按 adapter 目录展开')
  assert.ok(a.guard.protectPaths.includes(a.guard.bodyClient), 'bodyClient 非空时必须进 protectPaths')
  assert.deepEqual(a.warnings.filter((w) => /没声明 guard\.protectPaths/.test(w)), [])

  // 已经写在 protectPaths 里的 bodyClient 不许重复加
  src.guard = { protectPaths: ['protect-body', 'protect-body/client'], bodyClient: 'protect-body/client' }
  const file2 = join(dir, 'b.json')
  writeFileSync(file2, JSON.stringify(src))
  assert.equal(parseAdapter(file2, join(ROOT, 'harness')).guard.protectPaths.length, 2, '并集要去重')
})

test('T14 parseAdapter 守卫缺失只记账：enforced=false + 恰好一条 guard.protectPaths 警告，不抛', () => {
  // 弄坏能红：改成硬错 → assert.throws 之外的这行拿不到结果（直接红）
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-noguard-'))
  const src = readJson('domains/vfx-render/adapters/fire-ray.json')
  src.clientRoot = dir
  delete src.guard
  const file = join(dir, 'a.json')
  writeFileSync(file, JSON.stringify(src))
  const a = parseAdapter(file, join(ROOT, 'harness'))
  assert.equal(a.guard.enforced, false)
  assert.deepEqual(a.guard.protectPaths, [])
  assert.equal(a.guard.bodyClient, '')
  const hits = a.warnings.filter((w) => w.includes('guard.protectPaths'))
  assert.equal(hits.length, 1, `守卫缺失应当恰好一条 warning，实际：${a.warnings.join(' | ')}`)
})

test('T15 clientRoot 空串硬错 vs %环境变量% 没设只 warn（两条不能混）', () => {
  // 弄坏能红：把空串也做成 warn → 第一条 throws 红；把模板没设做成硬错 → 末段绿断言红
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-clientroot-'))
  const good = readJson('domains/vfx-render/adapters/fire-ray.json')
  const empty = join(dir, 'empty.json')
  writeFileSync(empty, JSON.stringify({ ...good, clientRoot: '' }))
  assert.throws(() => parseAdapter(empty, join(ROOT, 'harness')), /clientRoot（空串/, '空串是缺字段，必须硬错')

  const tpl = join(dir, 'tpl.json')
  writeFileSync(tpl, JSON.stringify({ ...good, clientRoot: '%NOPE_X_%' }))
  const a = parseAdapter(tpl, join(ROOT, 'harness'))
  assert.equal(a.clientRoot, '', '模板没展开时 clientRoot 回空串')
  assert.ok(
    a.warnings.some((w) => /环境变量没设置/.test(w) && /NOPE_X_/.test(w)),
    '模板变量没设只记账：' + a.warnings.join(' | '),
  )
})

test('T16 target.mode=params 但 params 为空：一条 warning，不抛', () => {
  // 弄坏能红：删掉 target.params 解析与 warning → 本条红
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-tp-'))
  const src = readJson('domains/vfx-render/adapters/fire-ray.json')
  src.clientRoot = dir
  src.target = { mode: 'params' }
  const file = join(dir, 'a.json')
  writeFileSync(file, JSON.stringify(src))
  const a = parseAdapter(file, join(ROOT, 'harness'))
  assert.equal(a.target.mode, 'params')
  assert.deepEqual(a.target.params, {})
  assert.equal(a.warnings.filter((w) => /target\.params 为空/.test(w)).length, 1)
  // 正常那份要能把目标参数透出来
  const ok = parseAdapter(join(ADAPTER_DIR, 'fire-ray.json'), join(ROOT, 'harness'))
  assert.deepEqual(ok.target.params, { widthPx: 30, distM: 8 })
})

test('T16b probe 的 clientRoot 参数能盖掉环境变量（宿主继承不到 %VFX_LOOP_CLIENT%）', () => {
  // 弄坏能红：把 opts.clientRoot 去掉 → 两条都红（第二条会多出"环境变量没设置"告警）
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-cr-'))
  mkdirSync(join(dir, 'resource', 'lab', 'vfx'), { recursive: true })
  writeFileSync(join(dir, 'resource', 'lab', 'vfx', 'vfx.json'), JSON.stringify({ effects: { FireRay: { blk: {} } } }))
  const file = join(ADAPTER_DIR, 'fire-ray.json')

  const a = parseAdapter(file, join(ROOT, 'harness'), { clientRoot: dir })
  assert.equal(a.clientRoot, dir)
  assert.equal(a.configFileExists, true, '覆盖之后要真的指到配置文件')
  assert.ok(a.warnings.some((w) => /显式覆盖/.test(w)), '覆盖这件事要留一句账')
  assert.ok(!a.warnings.some((w) => /clientRoot 里的环境变量/.test(w)), 'clientRoot 覆盖了就不该再报它那条环境变量')
  // 注意：fire-ray 的 guard.protectPaths 里还有 %VFX_LOOP_BODY_CLIENT%，那条该继续报（别误伤）

  // 相对路径不接受：没有可靠基准
  assert.throws(() => parseAdapter(file, join(ROOT, 'harness'), { clientRoot: 'client' }), /绝对路径/)
  // 不存在的路径也不接受：宁可不给，别给一个假现场
  assert.throws(() => parseAdapter(file, join(ROOT, 'harness'), { clientRoot: join(dir, 'nope') }), /不存在/)
})


test('T17 probe 输出 schema 说得出 template / guard / target / params（新键全进 required）', async () => {
  // 弄坏能红：只加 property 不加 required → walkSchema(requireAll) 那条（以及下面逐键点名）红
  const schema = selfloopProbeTool.output.schema
  for (const k of ['template', 'guard', 'target', 'params']) {
    assert.ok(schema.properties[k], `PROBE_OUT.properties 缺 ${k}`)
    assert.ok(schema.required.includes(k), `${k} 没进 required（返回值必须稳定给全）`)
  }
  for (const k of ['readyExpr', 'readbackExpr']) {
    assert.ok(schema.properties.page.required.includes(k), `page.${k} 没进 required`)
  }
  const v = await selfloopProbeTool.execute({})
  assert.deepEqual(validate(schema, v), [])
  assert.equal(v.template, false, 'fire-ray 不是模板')
  assert.equal(typeof v.guard.enforced, 'boolean')
  assert.ok(Array.isArray(v.guard.protectPaths))
  assert.equal(typeof v.guard.bodyClient, 'string')
  assert.equal(typeof v.target.mode, 'string')
  assert.ok(Array.isArray(v.params.list))
  assert.ok(v.page.readbackExpr.includes('VfxConfig'), '要能看见这轮用什么回读')
  // template:true 的 adapter 能被解析出标记（iter.ps1 据此拒跑）
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-tpl-'))
  const src = readJson('domains/vfx-render/adapters/fire-ray.json')
  src.clientRoot = dir
  src.template = true
  const file = join(dir, 'tpl.json')
  writeFileSync(file, JSON.stringify(src))
  assert.equal(parseAdapter(file, join(ROOT, 'harness')).template, true)
})

test('T19 三份示例 adapter 的"最少命令行可跑性"：target / params / readbackExpr / format↔apply 一致', () => {
  // 弄坏能红：删掉 chain 的 params 节 → 第一条红
  for (const f of ['chain-lightning.json', 'demo-url-time.json', 'fire-ray.json']) {
    const raw = readJson(join('domains', 'vfx-render', 'adapters', f))
    assert.ok(raw.target && typeof raw.target.mode === 'string' && raw.target.mode, `${f} 缺 target 节（最少命令行会报"目标帧没有来源"）`)
    assert.ok(raw.params && Array.isArray(raw.params.list), `${f} 缺 params 节（拆掉内置默认后同样硬错）`)
    assert.ok(raw.params.list.length > 0, `${f} 的 params.list 不能空`)
    assert.equal(typeof raw.page.readbackExpr, 'string', `${f} 缺 page.readbackExpr（会静默变成 selfCheck:false）`)
    assert.ok(raw.page.readbackExpr.length > 8, `${f} 的 readbackExpr 太短`)
    const a = parseAdapter(join(ADAPTER_DIR, f), join(ROOT, 'harness'))
    const want = a.configFormat === 'flat-params' ? 'apply_params.js' : 'apply.js'
    assert.equal(a.tools.apply.split(/[\\/]/).pop(), want, `${f} 的 tools.apply 与 config.format 不一致`)
    assert.equal(a.warnings.filter((w) => /target\.params 为空/.test(w)).length, 0, `${f} target.params 不能空`)
  }
})

test('C4 examples/minimal.json 是解耦后的字段模板（零项目默认值、零私有宿主 API、包里不带 host）', () => {
  const file = join(ROOT, 'examples', 'minimal.json')
  assert.ok(existsSync(file), 'examples/minimal.json 必须随包（files 里有 examples）')
  const m = readJson(join('examples', 'minimal.json'))
  assert.equal(m.schema, 'closed-loop-adapter/3')
  assert.ok(m.target && m.params && m.page.readbackExpr && m.guard, '模板要示范 target/params/readbackExpr/guard 四节')
  assert.deepEqual(m.guard.protectPaths, [])
  assert.ok(!/VfxConfig|__t3_stale|mergeProbe/.test(JSON.stringify(m)), '不许再出现示例宿主的私有宿主 API')
  assert.ok(!/可直接跑/.test(m.retarget.note), '没验过的事不许承诺"可直接跑"')
  const a = parseAdapter(file, join(ROOT, 'harness'))
  assert.equal(a.template, false, '这份是字段模板示例，不是 template:true 的包内模板')
  assert.equal(a.configFormat, 'flat-params')
  assert.equal(a.tools.apply.split(/[\\/]/).pop(), 'apply_params.js')
})

// ---------------------------------------------------------------- 解耦批次二：写护栏（方案 §3-B / §4 的 T1~T9、T12、T18、T20）
// T1~T4 是 writeguard 的纯函数单测（platform 可注入 → 不在 Windows 上也能钉住大小写/段边界）；
// T5~T9 是**唯一**起子进程的几条：直接调 applier，秒级、无端口、无浏览器。
const wgImport = await import('../harness/writeguard.js')
const WG = wgImport.default ?? wgImport
const APPLY_JS = join(ROOT, 'harness', 'apply.js')
const APPLY_PARAMS_JS = join(ROOT, 'harness', 'apply_params.js')

function runNode(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), error: r.error }
}

// 一份 vfx-block 形态的基线（effects.<Effect>.<Block>）；minBytes 给了就靠 note 补到那个大小
function makeVfxBlock(dir, minBytes = 0) {
  const blk = { widthPx: 10, distM: 5, note: 'pad' }
  const doc = { effects: { FireRay: { blk } } }
  let txt = JSON.stringify(doc, null, 2)
  while (minBytes && Buffer.byteLength(txt, 'utf8') < minBytes) {
    blk.note += 'x'.repeat(16)
    txt = JSON.stringify(doc, null, 2)
  }
  const p = join(dir, 'vfx.json')
  writeFileSync(p, txt)
  return p
}

test('T1 writeguard.normPath 归一：尾分隔符 / 斜杠 / win32 大小写', () => {
  // 弄坏能红：删掉 toLowerCase() → 大小写那行红；删掉去尾分隔符 → 第一行红
  const n = (p, plat) => WG.normPath(p, plat)
  assert.equal(n('sub\\dir\\', 'win32'), n('sub\\dir', 'win32'), '尾分隔符必须归一掉')
  assert.equal(n('sub/dir', 'win32'), n('sub\\dir', 'win32'), 'win32 下 / 与反斜杠等价')
  assert.equal(n('SUB\\DIR', 'win32'), n('sub\\dir', 'win32'), 'win32 忽略大小写')
  assert.notEqual(n('A/b', 'posix'), n('a/b', 'posix'), '非 win32 区分大小写')
})

test('T2 writeguard.isUnder 按路径段边界（…\\a\\b 不匹配 …\\a\\bc）', () => {
  // 弄坏能红：把 startsWith 改成裸前缀（去掉 + sep）→ 第一条红
  assert.equal(WG.isUnder('a/bc/x', 'a/b', 'win32'), false, 'bodycopy 不是 body 的子目录')
  assert.equal(WG.isUnder('a/b/x', 'a/b', 'win32'), true, '真子目录要命中')
  assert.equal(WG.isUnder('a/b/', 'a/b', 'win32'), true, '等值（含尾分隔符）要命中')
  assert.equal(WG.isUnder('A/b/x', 'a/b', 'win32'), true, 'win32 忽略大小写')
  assert.equal(WG.isUnder('A/b/x', 'a/b', 'posix'), false, 'posix 区分大小写')
})

test('T2b writeguard.isUnder 能识破 junction（镜像目录指向本体）', (t) => {
  // 这是"写回本体"最真实的翻车方式：路径字面上不在本体的子树里，realpath 之后在。
  // 弄坏能红：删掉 normPath 里的 realpathSync → 第一条 false ≠ true。
  if (process.platform !== 'win32') {
    t.skip('junction 只有 Windows 有，这里不假装跨平台')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'sl-junction-'))
  try {
    const body = join(root, 'body')
    mkdirSync(join(body, 'cfg'), { recursive: true })
    spawnSync('cmd', ['/c', 'mklink', '/J', join(root, 'mirror'), body])
    if (!existsSync(join(root, 'mirror', 'cfg'))) {
      t.skip('这台机器建不了 junction（权限或文件系统不支持）')
      return
    }
    assert.equal(WG.isUnder(join(root, 'mirror', 'cfg', 'vfx.json'), body), true, 'junction 指过来的路径也算本体')
    assert.equal(WG.isUnder(join(root, 'bodycopy', 'x.json'), body), false, '兄弟目录仍不许误伤')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T3 writeguard.hitProtect 回命中的那条原串，未命中回 null，空元素不炸', () => {
  // 弄坏能红：改成返回 boolean → 第一条的类型/文案断言红
  const o = { platform: 'win32' }
  assert.equal(WG.hitProtect('a/b/x', ['zzz', 'a/b'], o), 'a/b', '要回**声明里的原串**，用得上拒写文案')
  assert.equal(WG.hitProtect('a/bx/x', ['a/b'], o), null)
  assert.equal(WG.hitProtect('a/b/x', [], o), null)
  assert.equal(WG.hitProtect('a/b/x', [null, '', undefined], o), null, '空元素跳过，不许炸')
})

test('T4 writeguard.splitProtectFlags 摘 --protect（可重复）且 rest 里不留它', () => {
  // 弄坏能红：只取第一个 --protect → protect 少一项；不把值从 rest 里摘掉 → rest 多一项
  const r = WG.splitProtectFlags(['--del', 'a,b', '--protect', 'X', '--protect', 'Y'])
  assert.deepEqual(r.protect, ['X', 'Y'])
  assert.deepEqual(r.rest, ['--del', 'a,b'], '--protect 的值不许留在 rest 里（否则 --del 会扫到它）')
  assert.deepEqual(WG.splitProtectFlags(['--protect']).protect, [], '末尾裸挂 --protect 不许把空吃成值')
})

test('T5 apply.js 端到端拒写：out 落在 --protect 下 → 退出码 3 / stdout 空 / stderr 说清怎么改', () => {
  // 弄坏能红：删掉 apply.js 的 hitProtect 检查 → 退出码变 0，这条红
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-wg-apply-'))
  const base = makeVfxBlock(dir)
  const prot = join(dir, 'body')
  mkdirSync(prot, { recursive: true })
  const out = join(prot, 'vfx.json')
  const r = runNode([APPLY_JS, base, out, 'FireRay', 'blk', '{"widthPx":57}', '--protect', prot])
  assert.equal(r.code, 3, '拒写必须退出码 3（实际 ' + r.code + '）：' + r.stderr)
  assert.equal(r.stdout, '', '拒写时不许有 OK 输出')
  assert.match(r.stderr, /拒写/)
  assert.ok(r.stderr.includes(prot), 'stderr 要点名命中的那条保护路径：' + r.stderr)
  assert.match(r.stderr, /protectPaths|clientRoot|-Mirror/, '要告诉用户改哪里，不能只说"拒写"')
  assert.equal(existsSync(out), false, '拒写之后不许留下文件')
})

test('T6 apply.js 不误伤兄弟目录：保护 body，写 bodycopy 必须能过（裸前缀匹配会红）', () => {
  // 弄坏能红：把 isUnder 的段边界改成裸前缀 → 这条退出码变 3
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-wg-sibling-'))
  const base = makeVfxBlock(dir)
  const prot = join(dir, 'body')
  mkdirSync(prot, { recursive: true })
  const outDir = join(dir, 'bodycopy', 'runs')
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, 'vfx.json')
  const r = runNode([APPLY_JS, base, out, 'FireRay', 'blk', '{"widthPx":57}', '--protect', prot])
  assert.equal(r.code, 0, 'bodycopy 是合法输出目录：' + r.stderr)
  assert.ok(existsSync(out), '兄弟目录必须真的写出来')
  assert.match(readFileSync(out, 'utf8'), /"widthPx": 57/)
})

test('T7 apply_params.js 接的是同一份护栏：拒写/放行与 apply.js 一致', () => {
  // 弄坏能红：只给 apply.js 加 --protect、忘了 apply_params.js → 第一条退出码变 0
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-wg-flat-'))
  const baseP = join(dir, 'params.json')
  writeFileSync(baseP, JSON.stringify({ name: 'demo', params: { size: 40, soft: 0.2 } }))
  const prot = join(dir, 'body')
  mkdirSync(prot, { recursive: true })
  const blocked = runNode([APPLY_PARAMS_JS, baseP, join(prot, 'params.json'), '{"size":12}', '--protect', prot])
  assert.equal(blocked.code, 3, 'flat-params 也要拒写：' + blocked.stderr)
  assert.match(blocked.stderr, /拒写/)
  assert.ok(blocked.stderr.includes(prot))
  const outDir = join(dir, 'bodycopy')
  mkdirSync(outDir, { recursive: true })
  const okOut = join(outDir, 'params.json')
  const ok = runNode([APPLY_PARAMS_JS, baseP, okOut, '{"size":12}', '--protect', prot])
  assert.equal(ok.code, 0, ok.stderr)
  assert.deepEqual(JSON.parse(readFileSync(okOut, 'utf8')).params, { size: 12, soft: 0.2 })
})

test('T8 不带 --protect 仍可写（向后兼容）；out==base 的判等走 normPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-wg-compat-'))
  const base = makeVfxBlock(dir)
  const sub = join(dir, 'sub')
  mkdirSync(sub, { recursive: true })
  const out = join(sub, 'vfx.json')
  assert.equal(runNode([APPLY_JS, base, out, 'FireRay', 'blk', '{"widthPx":11}']).code, 0, '老的直接调用方式不许断')
  // Windows 上同一个文件换个大小写写法必须判成"等于 base"（旧的 path.resolve 严格比较会放过它）
  const same = process.platform === 'win32' ? base.toUpperCase() : base
  const r = runNode([APPLY_JS, base, same, 'FireRay', 'blk', '{"widthPx":11}'])
  assert.equal(r.code, 3, 'out 与 base 是同一个文件时必须拒写：' + r.stderr)
  assert.match(r.stderr, /不能等于 base/)
})

test('T9 小配置不会被"写坏"判死：~300B 的 vfx-block 基线写出来必须过（阈值 20000 会红）', () => {
  // 弄坏能红：把 sz < 0.5*基线 改回 sz < 20000 → 退出码变 6
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-wg-small-'))
  const base = makeVfxBlock(dir, 300)
  const sz = statSync(base).size
  assert.ok(sz >= 300 && sz < 20000, '这条要的是"小而正常"的基线，实际 ' + sz + 'B')
  const sub = join(dir, 'sub')
  mkdirSync(sub, { recursive: true })
  const r = runNode([APPLY_JS, base, join(sub, 'vfx.json'), 'FireRay', 'blk', '{"distM":7.5}'])
  assert.equal(r.code, 0, '小配置不该被判成写坏：' + r.stderr)
  assert.match(r.stdout, /^OK/)
})

test('T12 iter.ps1 两头接护栏：--protect 走数组 splat / Test-PathUnder / [guard][warn] / meta 记 protectPaths', () => {
  // 弄坏能红：只改 applier 不改 ps1（删掉 @(--protect) 那行）→ 本条红。这是最容易被漏的一半。
  assert.match(ITER_SRC, /@\('--protect', \$pp\)/, 'protectPaths 必须逐条变成 --protect 参数')
  assert.match(ITER_SRC, /& node @nodeArgs/, '调 applier 必须走数组 splat（手工拼引号会在带空格路径上拆错）')
  assert.match(ITER_SRC, /function Test-PathUnder/, '要有与 writeguard.isUnder 同语义的路径判定')
  assert.match(ITER_SRC, /\[guard\]\[warn\]/, '没声明 protectPaths 时只 warn 一行（不硬错）')
  assert.match(ITER_SRC, /镜像配置文件落在保护路径里/, '执行点①：镜像落在保护区要在花预算之前 throw')
  assert.match(ITER_SRC, /别改保护路径/, '报错要写清修法（改 -Mirror / adapter.clientRoot）')
  assert.match(ITER_SRC, /protectPaths = @\(\$protectPaths\)/, '证据包 meta 要记保护路径')
  assert.match(ITER_SRC, /guardEnforced = \(\$protectPaths\.Count -gt 0\)/, '证据包要记这轮到底强制没强制')
})

test('T18 harness 清单 9 件：writeguard.js 在必需件里、有角色说明、文件不是占位', () => {
  // 弄坏能红：从 HARNESS_REQUIRED 删掉 writeguard.js → length 变 8
  assert.equal(HARNESS_REQUIRED.length, 9)
  assert.ok(HARNESS_REQUIRED.includes('writeguard.js'), 'apply*.js require 它，缺了就是 MODULE_NOT_FOUND')
  assert.ok(HARNESS_ROLES['writeguard.js']?.length > 10, 'HARNESS_ROLES 要说明它是干什么的')
  assert.ok(statSync(join(ROOT, 'harness', 'writeguard.js')).size > 200, 'writeguard.js 太小，像占位')
})

test('T20 三份示例 adapter 的 guard 自洽：不写死盘符；fire-ray 示范同模板；demo 显式空数组', () => {
  // 弄坏能红：往任一示例的 protectPaths 里写死一个盘符路径 → 盘符那条红（包里那条便携性测试也会红）
  const driveRe = new RegExp('^[A-Za-z]:')
  const files = ['chain-lightning.json', 'demo-url-time.json', 'fire-ray.json']
  for (const f of files) {
    const raw = readJson(join('domains', 'vfx-render', 'adapters', f))
    const pp = raw.guard?.protectPaths
    if (pp === undefined) continue
    assert.ok(Array.isArray(pp), f + '.guard.protectPaths 必须是数组')
    for (const p of pp) {
      assert.equal(typeof p, 'string', f + ' 的 protectPaths 元素必须是字符串')
      assert.ok(p.length > 0, f + ' 的 protectPaths 不许有空串')
      assert.ok(!driveRe.test(p), f + ' 的 protectPaths 不许写死盘符：' + p)
    }
  }
  assert.deepEqual(
    readJson(join('domains', 'vfx-render', 'adapters', 'fire-ray.json')).guard.protectPaths,
    ['%VFX_LOOP_BODY_CLIENT%'],
    'fire-ray 要与 bodyClient 同一个模板（示范"两个都写不冲突"）',
  )
  assert.deepEqual(
    readJson(join('domains', 'vfx-render', 'adapters', 'demo-url-time.json')).guard.protectPaths,
    [],
    'demo 要显式声明"没有本体"',
  )
  // 展开后：要么空、要么绝对路径；enforced 必须与"真的声明出几条"一致
  for (const f of files) {
    const a = parseAdapter(join(ADAPTER_DIR, f), join(ROOT, 'harness'))
    for (const p of a.guard.protectPaths) assert.ok(isAbsolute(p), f + ' 的 protectPaths 展开后必须是绝对路径：' + p)
    assert.equal(a.guard.enforced, a.guard.protectPaths.length > 0)
  }
})

test('模板例外：template:true 的字段模板不硬错，返回 template:true + 一条"字段模板"warning', async () => {
  // 弄坏能红：把 isTemplate 那几处 guard 去掉 → parseAdapter 抛"缺字段：clientRoot（空串）"，本条红
  const tplFile = join(ROOT, 'harness', 'adapter.json')
  const a = parseAdapter(tplFile, join(ROOT, 'harness'))
  assert.equal(a.template, true)
  const hits = a.warnings.filter((w) => /字段模板/.test(w))
  assert.equal(hits.length, 1, '模板只记一条人话警告：' + a.warnings.join(' | '))
  assert.match(hits[0], /不能直接跑/)
  assert.match(hits[0], /clientRoot/, '要把还空着的必填项点名')
  // probe 是唯一的对外体检口：读包内模板时也该看到这句话，而不是"缺字段 clientRoot（空串）"
  const v = await selfloopProbeTool.execute({ adapter: tplFile })
  assert.deepEqual(validate(selfloopProbeTool.output.schema, v), [], '模板也要能过输出 schema')
  assert.equal(v.template, true)
  assert.ok(v.warnings.some((w) => /字段模板/.test(w)), v.warnings.join(' | '))
  // 模板例外不许把批次一的裁决松掉：没有 template 标记的空串仍然硬错
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-tplexc-'))
  const good = readJson('domains/vfx-render/adapters/fire-ray.json')
  const bad = join(dir, 'no-tpl.json')
  writeFileSync(bad, JSON.stringify({ ...good, clientRoot: '' }))
  assert.throws(() => parseAdapter(bad, join(ROOT, 'harness')), /clientRoot（空串/)
})

// ---------------------------------------------------------------- 第三方 3D 台改造后的示例（0.3.8）
// 与 C4（字段模板）同一类：示例随包，但这份代表的是「第三方台**改造后**的形态」，不是开箱即用。
// 守的是两件事：① 中性化没退化（%ENV% + 相对路径、零盘符）；② 真正值钱的三条实测判据没被抄坏。
const DRIVE_SEP = String.fromCharCode(92)
const driveLike = (letter) => letter + ':' + DRIVE_SEP // 拼出来：源码里不出现"字母:反斜杠"

function checkThirdParty3d(file) {
  const text = readFileSync(file, 'utf8')
  const raw = JSON.parse(text)
  // ① 中性化：不许有任何盘符（包里那条便携性测试也会红，这里先点死）
  const driveRe = new RegExp('(?<![A-Za-z0-9])[A-Za-z]:' + DRIVE_SEP + DRIVE_SEP)
  assert.ok(!driveRe.test(text), '示例里出现了盘符绝对路径（换台机器就跑不了）：' + (driveRe.exec(text)?.[0] ?? ''))
  assert.equal(raw.clientRoot, '%VFX_LOOP_3D_CLIENT%', 'clientRoot 必须靠环境变量，像 minimal.json 那样')
  for (const p of [raw.config.path, raw.page.file, raw.server.staticScript]) {
    assert.ok(p && !isAbsolute(p) && !/^[A-Za-z]:/.test(p), '其余路径全部相对：' + p)
  }
  // ② 关键选择：url-time + strict + 扁平回读
  assert.equal(raw.freeze.protocol, 'url-time', '这个宿主没有 step/playFx，只能 url-time')
  assert.equal(raw.freeze.clock, 'n/a', 'url-time 没有推进过程，clock 必须是 n/a')
  assert.equal(raw.freeze.verify, 'strict', '冻帧自检要 strict（同 URL 连拍两张逐字节比）')
  assert.match(raw.freeze.urlTemplate, /\{sec\}/, 'urlTemplate 必须含 {sec}')
  assert.equal(raw.config.format, 'flat-params')
  assert.match(raw.page.readyExpr, /__ready/, 'readyExpr 要有"首帧"标记')
  assert.match(raw.page.readyExpr, /__cfgLoaded/, 'readyExpr 还要有"配置真落地"标记（少了会抢拍）')
  assert.match(raw.page.readbackExpr, /params\(\)/, 'readbackExpr 要指向扁平回读接口')
  // ③ 三条判据的实测阈值：200 档 + 松一档的 warmFrac，不许被抄回默认值
  assert.deepEqual(raw.metrics.map((m) => m.extract), ['cov', 'bbox', 'warmFrac'], '三条提取器要原样保留')
  const [cov, bbox, warm] = raw.metrics
  assert.equal(cov.opts.luma, 200, 'cov 的 luma 必须实测到 200（40 时恒等 0.98）')
  assert.equal(bbox.opts.luma, 200, 'bbox 的 luma 必须实测到 200（150 时宽度恒 640）')
  assert.equal(bbox.opts.field, 'w', 'bbox 取宽度（对 length/radius 敏感）')
  assert.equal(warm.opts.luma, 100)
  assert.ok(warm.opts.rMin < 140, 'warmFrac 的 rMin 要比提取器默认 140 松（白芯 r/g≈1.05 会被漏掉）')
  for (const m of raw.metrics) {
    assert.ok(m.norm?.mode === 'range' && m.norm.range.length === 2, m.id + ' 要有归一区间')
    assert.ok(m.weight > 0, m.id + ' 权重要 > 0')
  }
  // ④ 两条惩罚都指向真实存在的 metric id（缺了 iter.ps1 会报错，这里提前钉住）
  const ids = raw.metrics.map((m) => m.id)
  assert.deepEqual(raw.score.penalties.map((p) => p.id), ['noEmber', 'flatFrame'])
  for (const p of raw.score.penalties) {
    for (const id of ids) {
      if (p.when.includes(id)) assert.ok(ids.includes(id))
    }
  }
  assert.match(raw.score.penalties[0].when, /cov/, 'noEmber 要挂在 cov 上')
  assert.match(raw.score.penalties[1].when, /bboxW/, 'flatFrame 要挂在 bboxW 上')
  // ⑤ 话要说清：这是改造后的形态，宿主侧还有活要干
  assert.match(raw.packageNote || '', /不是开箱即用/)
  assert.match(raw.packageNote || '', /host-adaptation\.md/, '要指到宿主改造清单')
  // ⑥ 引擎口径：能解析、走 apply_params、协议一致
  const a = parseAdapter(file, join(ROOT, 'harness'))
  assert.equal(a.template, false)
  assert.equal(a.configFormat, 'flat-params')
  assert.equal(a.freeze.protocol, 'url-time')
  assert.equal(a.tools.apply.split(/[\\/]/).pop(), 'apply_params.js')
  assert.ok(a.params.list.length >= 3, '白名单至少三根轴')
  return { raw, a }
}

test('T22 examples/third-party-3d.json：中性化没退化、url-time + 扁平参数、三条实测判据、零盘符', () => {
  const file = join(ROOT, 'examples', 'third-party-3d.json')
  assert.ok(existsSync(file), 'examples/third-party-3d.json 必须随包（files 里有 examples）')
  const { a } = checkThirdParty3d(file)
  // 弄坏能红：三个变异体必须各自被 checkThirdParty3d 拒掉
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-t22-'))
  const good = JSON.parse(readFileSync(file, 'utf8'))
  const cases = [
    ['把冻帧协议改成 noloop-step（宿主没有 step/playFx）', (o) => { o.freeze.protocol = 'noloop-step'; delete o.freeze.stepMs }],
    ['把第一条 extract 换成 p160（判据被抄坏）', (o) => { o.metrics[0].extract = 'p160' }],
    ['往 page.file 里塞一个盘符', (o) => { o.page.file = driveLike('D') + 'work' + DRIVE_SEP + 'fxbench' }],
    ['把 cov 的 luma 抄回提取器默认 40', (o) => { o.metrics[0].opts.luma = 40 }],
  ]
  try {
    for (const [why, mutate] of cases) {
      const o = structuredClone(good)
      mutate(o)
      const p = join(dir, 'mutant.json')
      writeFileSync(p, JSON.stringify(o, null, 2))
      assert.throws(() => checkThirdParty3d(p), `弄坏没红：${why}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // probe 也得能读它（对外体检口，别只让 parseAdapter 认）
  assert.equal(a.freeze.protocol, 'url-time')
})
