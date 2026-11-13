// 命令观测（0.4.0 / 0.4.1）自测：不碰浏览器、不开端口、不依赖仓库外的现场。
//
// 覆盖：
//   ① 一轮能收敛（drop > 50%）+ 证据包齐全（curve.csv / best.json / report.md / outputs/）
//   ② 故意无效的参数被活性扫描判死（且不占搜索预算）
//   ③ 命令超时 → 中文硬错（不许静默当 0）
//   ④ 非零退出 → 中文硬错
//   ⑤ 输出解析不出来 → 中文硬错
//   ⑥ 指标缺失 → 中文硬错
//   ⑦ 同 seed 两次（换 out 目录）best.json 的 hash 一致
//   ⑧ 适配层/工具层：core 说得清 observe，probe 输出过 schema（新键全进 required）
//   ⑨ 弄坏能红 ×2：flatZero（距离恒 0）→ 收敛断言必红；noTimeout（超时当正常）→ 超时断言必红
//   ⑩ 另外两种取数方式（parse=number / line:k=v）
//   ⑪ 观测稳定性闸（0.4.1）：稳定命令过闸 + 证据包有 stability 表；不稳定命令硬错（点名指标与 spread）；
//      repeat=1 显式关闭并 warn；非法配置中文硬错；预算不够时硬错（不偷偷少跑几次）
//   ⑫ 弄坏能红 ×2（0.4.1）：stableAlways（判定恒真）→ ⑪ 的不稳定断言必红；
//      noStability（整段删掉）→ ⑪ 的 stability 字段断言必红
//   ⑬ 真实非图形目标（包体积预算）：压缩示例跑一轮 drop > 30%，且每一轮都无损解压
//   ⑭ 同 seed 两次 hash 一致（压缩示例，独立一条 —— 它证明的是"语料与搜索都可复现"）
//   ⑮ 弄坏能红（0.4.2）：把目标改成一个"起点参数就命中"的值 → ⑬ 的降幅断言必红（起点距离为 0，降幅 null）
//
// 变异开关（只给测试用，见 harness/cmdlib.mjs 的 MUTANT）：
//   CMDLOOP_MUTANT=flatZero|noTimeout|stableAlways|noStability node test/command.test.mjs
// 不设时行为完全正常。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'harness', 'cmdloop.mjs')
const EXAMPLE_ADAPTER = join(ROOT, 'examples', 'command-echo.json')
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))

function tmp(tag) {
  return mkdtempSync(join(tmpdir(), `selfloop-cmd-${tag}-`))
}

// 跑一次 cmdloop.mjs（子进程 = 真执行器，不是 in-process 复刻）
function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: r.stdout + r.stderr }
}

// 一个临时"现场"：基线参数文件 + 一条命令 + 一份 adapter（与 examples/command-echo.json 同形状）
// stability 不传 = adapter 里不写 observe.stability（**默认值仍要生效**，这正是要测的一条）
function makeSite(tag, { cmd, timeoutMs = 5000, parse = 'json', metrics, target, params = ['a'], stability }) {
  const dir = tmp(tag)
  writeFileSync(join(dir, 'base.json'), JSON.stringify({ params: { a: 1 } }), 'utf8')
  if (cmd.script) writeFileSync(join(dir, cmd.name), cmd.script, 'utf8')
  const observe = {
    type: 'command',
    cmd: cmd.line ?? `node ./${cmd.name}`,
    timeoutMs,
    parse,
    metrics:
      metrics ?? [
        { id: 'loss', field: 'loss', norm: { mode: 'abs', scale: 1 }, weight: 1 },
        { id: 'size', field: 'size', norm: { mode: 'abs', scale: 10 }, weight: 0.5 },
      ],
  }
  if (stability !== undefined) observe.stability = stability
  const adapter = {
    schema: 'closed-loop-adapter/3',
    domain: 'command',
    name: `test-${tag}`,
    config: { path: 'base.json', format: 'flat-params' },
    observe,
    target: target ?? { mode: 'metrics', metrics: { loss: 0, size: 10 } },
    params: { mode: 'list', list: params },
    score: { type: 'l1', penalties: [] },
    guard: { protectPaths: [] },
  }
  const file = join(dir, 'adapter.json')
  writeFileSync(file, JSON.stringify(adapter, null, 2), 'utf8')
  return { dir, file, adapter }
}

// 一轮示例只跑一次，① 和 ② 共用（省 4 秒，也让两条断言看的是同一份证据）
let run1
function oneRun() {
  if (!run1) {
    const out = tmp('r1')
    const r = runCli(['--adapter', EXAMPLE_ADAPTER, '--out', out, '--budget', '40', '--seed', '12345'])
    run1 = { r, out, best: existsSync(join(out, 'best.json')) ? readJson2(join(out, 'best.json')) : null }
  }
  return run1
}
function readJson2(abs) {
  return JSON.parse(readFileSync(abs, 'utf8'))
}

// ---------------------------------------------------------------- ① 收敛 + 证据包
test('① 命令观测一轮能收敛：drop > 50%，证据包齐全（curve/best/report/outputs）', () => {
  const { r, out, best } = oneRun()
  assert.equal(r.status, 0, `cmdloop 该跑通，实际 exit=${r.status}\n${r.out.slice(-2000)}`)
  assert.ok(best, 'best.json 必须存在')
  assert.equal(best.schema, 'cmd-iter/1')
  assert.ok(best.dropPct > 50, `降幅应 > 50%，实测 ${best.dropPct}%（start=${best.startDist} best=${best.bestDist}）`)
  assert.ok(best.bestDist < best.startDist, '最佳距离必须真的更小')
  // 证据包四件 + 两个目录
  for (const f of ['curve.csv', 'best.json', 'report.md']) assert.ok(existsSync(join(out, f)), `缺 ${f}`)
  for (const d of ['outputs', 'params']) assert.ok(existsSync(join(out, d)), `缺目录 ${d}`)
  const outputs = readdirSync(join(out, 'outputs')).filter((n) => n.endsWith('.json'))
  assert.equal(outputs.length, best.evaluations.used, '每次评估都要留一份原始命令输出')
  for (const n of outputs) {
    const size = statSync(join(out, 'outputs', n)).size
    assert.ok(size > 0 && size <= 4096, `${n} 体积 ${size}B 超出 4KB 上限（或空文件）`)
    const doc = readJson2(join(out, 'outputs', n))
    assert.equal(typeof doc.stdout, 'string', `${n} 缺原始 stdout`)
    assert.ok(doc.metrics && Object.keys(doc.metrics).length >= 2, `${n} 缺指标`)
  }
  // curve.csv：表头 + 每个评估点一行
  const lines = readFileSync(join(out, 'curve.csv'), 'utf8').trim().split(/\r?\n/)
  assert.equal(lines.length, best.evaluations.used + 1, 'curve.csv 行数 = 评估数 + 表头')
  assert.match(lines[0], /^round,eval_seq,id,note,a?/) // 参数列在白名单里，这里只钉开头
  assert.match(lines[0], /m:loss/)
  assert.match(lines[0], /nd:loss/)
  // report.md 要能自己说清"观测来源是命令"
  const md = readFileSync(join(out, 'report.md'), 'utf8')
  assert.match(md, /run hash/)
  assert.match(md, /command/)
  assert.match(md, /参数活性预检/)
  // 目标/起点/预检/搜索都记了账
  assert.equal(best.evaluations.target, 1, 'target.mode=params 要跑一次目标命令')
  assert.equal(best.evaluations.start, 1)
  assert.ok(best.evaluations.precheck >= 1)
  assert.ok(best.evaluations.search >= 1)
})

// ---------------------------------------------------------------- ② 无效参数判死
test('② 故意无效的参数（ghost）被活性扫描判死，且不进搜索轴', () => {
  const { best } = oneRun()
  const rows = best.precheck.rows
  const byName = Object.fromEntries(rows.map((r) => [r.param, r]))
  assert.ok(byName.ghost, '预检里必须有 ghost')
  assert.equal(byName.ghost.verdict, 'dead', `ghost 改了命令输出但距离不动，应判 dead（实测 Δd=${byName.ghost.dDelta}）`)
  assert.equal(byName.ghost.dDelta, 0)
  assert.equal(byName.ghost.outputSame, false, 'ghost 让 stdout 变了（诊断字段），所以"输出同"应为 false —— 判死靠的是距离不是字节')
  assert.equal(byName.alpha.verdict, 'alive')
  assert.equal(byName.beta.verdict, 'alive')
  assert.deepEqual(best.dead, ['ghost'])
  assert.deepEqual(best.alive, ['alpha', 'beta'])
  // 搜索候选里不该出现 ghost±
  const notes = best.rounds.flatMap((r) => r.cands.map((c) => c.note))
  assert.ok(notes.length > 0, '至少有一轮候选')
  assert.ok(!notes.some((n) => n.startsWith('ghost')), `ghost 不该出现在候选里：${notes.join(',')}`)
})

// ---------------------------------------------------------------- ③ 超时硬错
test('③ 命令超时 → 中文硬错，不许静默当 0', () => {
  const site = makeSite('timeout', {
    cmd: { name: 'slow.mjs', script: 'await new Promise((r) => setTimeout(r, 5000))\nconsole.log(JSON.stringify({ loss: 1, size: 10 }))\n' },
    timeoutMs: 400,
  })
  const out = tmp('timeout-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '4'])
  assert.equal(r.status, 1, `超时必须非零退出，实际 ${r.status}\n${r.out}`)
  assert.match(r.out, /超时/, '错误必须是中文且点明超时')
  assert.match(r.out, /timeoutMs|400ms/, '要说清超时阈值')
  assert.ok(!existsSync(join(out, 'best.json')), '硬错时不许产出"看起来跑完了"的证据包')
})

// ---------------------------------------------------------------- ④ 非零退出硬错
test('④ 命令非零退出 → 中文硬错', () => {
  const site = makeSite('exit', {
    cmd: { name: 'boom.mjs', script: 'console.error("我崩了"); process.exit(7)\n' },
  })
  const r = runCli(['--adapter', site.file, '--out', tmp('exit-out'), '--budget', '4'])
  assert.equal(r.status, 1, `非零退出必须让 cmdloop 也非零\n${r.out}`)
  assert.match(r.out, /非零退出/)
  assert.match(r.out, /exit=7/, '要把子进程的退出码说出来')
})

// ---------------------------------------------------------------- ⑤ 解析失败硬错
test('⑤ 输出解析不出来 → 中文硬错（不是"指标算不了就跳过"）', () => {
  const site = makeSite('badjson', {
    cmd: { name: 'junk.mjs', script: 'console.log("这不是 JSON")\n' },
  })
  const r = runCli(['--adapter', site.file, '--out', tmp('badjson-out'), '--budget', '4'])
  assert.equal(r.status, 1)
  assert.match(r.out, /不是合法 JSON/)
  // parse=number 但 stdout 不是数，也要硬错
  const site2 = makeSite('badnum', {
    cmd: { name: 'junk2.mjs', script: 'console.log("nope")\n' },
    parse: 'number',
    metrics: [{ id: 'loss', field: 'loss', norm: { mode: 'abs', scale: 1 }, weight: 1 }],
    target: { mode: 'metrics', metrics: { loss: 0 } },
  })
  const r2 = runCli(['--adapter', site2.file, '--out', tmp('badnum-out'), '--budget', '4'])
  assert.equal(r2.status, 1)
  assert.match(r2.out, /stdout 不是数/)
})

// ---------------------------------------------------------------- ⑥ 指标缺失硬错
test('⑥ 指标缺失 → 中文硬错（绝不把缺的指标当 0）', () => {
  const site = makeSite('missing', {
    cmd: { name: 'partial.mjs', script: 'console.log(JSON.stringify({ loss: 0.5 }))\n' },
  })
  const r = runCli(['--adapter', site.file, '--out', tmp('missing-out'), '--budget', '4'])
  assert.equal(r.status, 1)
  assert.match(r.out, /指标缺失/)
  assert.match(r.out, /size/, '要说清缺的是哪条指标（size）')
})

// ---------------------------------------------------------------- ⑦ 同 seed 同 hash
test('⑦ 同 seed 跑两次（换 out 目录）best.json 的 hash 必须一致', () => {
  const o1 = tmp('seed-a')
  const o2 = tmp('seed-b')
  const r1 = runCli(['--adapter', EXAMPLE_ADAPTER, '--out', o1, '--budget', '14', '--seed', '2024'])
  const r2 = runCli(['--adapter', EXAMPLE_ADAPTER, '--out', o2, '--budget', '14', '--seed', '2024'])
  assert.equal(r1.status, 0, r1.out)
  assert.equal(r2.status, 0, r2.out)
  const b1 = readJson2(join(o1, 'best.json'))
  const b2 = readJson2(join(o2, 'best.json'))
  assert.match(b1.hash, /^[0-9a-f]{64}$/)
  assert.equal(b1.hash, b2.hash, '同 seed 同参数换目录重跑，hash 必须一致（时间/路径不许进指纹）')
  // 轨迹本身也要逐点一致（hash 一致只是必要条件）
  assert.deepEqual(
    b1.curve.map((c) => [c.seq, c.params, c.dist]),
    b2.curve.map((c) => [c.seq, c.params, c.dist]),
    '同 seed 的评估序列必须逐点一致',
  )
  assert.equal(b1.meta.outDir === b2.meta.outDir, false, '两次本来就该落在不同目录 —— 否则这条测不出"路径不进指纹"')
})

// ---------------------------------------------------------------- ⑧ 适配层 + 工具层
test('⑧ core 解析 observe、probe 说得清命令观测（输出过 schema，每个 property 都进 required）', async () => {
  const { parseAdapter } = await import('../core/adapter.js')
  const { selfloopProbeTool } = await import('../lib/index.js')
  const a = parseAdapter(EXAMPLE_ADAPTER, join(ROOT, 'harness'))
  assert.equal(a.observe.type, 'command')
  assert.equal(a.observe.cmdRaw, 'node ./command-demo/probe.mjs')
  assert.equal(a.observe.parse, 'json')
  assert.equal(a.observe.timeoutMs, 30000)
  assert.equal(a.observe.metricsCount, 2)
  assert.deepEqual(a.observe.metrics.map((m) => [m.id, m.field]), [['loss', 'loss'], ['size', 'size']])
  assert.equal(a.configFormat, 'flat-params')
  assert.equal(a.block, '', '命令观测没有参数块概念')
  assert.ok(a.configFileExists, '基线参数文件要指得到')
  assert.deepEqual(a.warnings, [], `命令 adapter 不该背一堆截图链路的警告：${a.warnings.join(' | ')}`)

  const v = await selfloopProbeTool.execute({ adapter: EXAMPLE_ADAPTER })
  const schema = selfloopProbeTool.output.schema
  assert.deepEqual(validate(schema, v), [])
  assert.equal(v.observe.type, 'command')
  assert.equal(v.observe.metrics.length, 2)
  assert.ok(schema.required.includes('observe'), 'observe 必须进 PROBE_OUT.required')
  // 仓库纪律：schema 里每个 property 都要在 required 里（返回值必须稳定给全）
  for (const k of Object.keys(schema.properties.observe.properties)) {
    assert.ok(schema.properties.observe.required.includes(k), `observe.${k} 没进 required`)
  }
  assert.ok(schema.properties.target.required.includes('metrics'), 'target.metrics 没进 required')
  const text = selfloopProbeTool.output.render({}, v)[0].text
  assert.match(text, /观测：命令/)
  assert.match(text, /node \.\/command-demo\/probe\.mjs/)
  assert.ok(!/视口：/.test(text), '命令观测不该打印视口/端口这些浏览器字段')

  // 反向兼容：没有 observe 节的老 adapter 必须还是老样子（截图链路），几个字段回空而不是抛错
  const legacy = parseAdapter(join(ROOT, 'domains', 'vfx-render', 'adapters', 'fire-ray.json'), join(ROOT, 'harness'))
  assert.equal(legacy.observe.type, '', '老 adapter 的 observe.type 是空串 = 截图链路')
  assert.equal(legacy.observe.cmdRaw, '')
  assert.equal(legacy.observe.metricsCount, 0)
  assert.deepEqual(legacy.observe.metrics, [])
  assert.deepEqual(legacy.target.metrics, {})
  assert.equal(legacy.metricsCount, 3, '老 adapter 的指标还是从 adapter.metrics 来')
})

// ---------------------------------------------------------------- ⑨ 弄坏能红 ×2
// 这两条不是"再测一遍功能"，而是**验证 ①③ 的断言真有牙**：
// 用变异体把实现弄坏，断言必须塌（这里断言的是"塌了"这件事，所以测试本身是绿的）。
test('⑨-1 弄坏能红：距离恒 0（CMDLOOP_MUTANT=flatZero）→ ① 的收敛断言必须不成立', () => {
  const out = tmp('flat')
  const r = runCli(['--adapter', EXAMPLE_ADAPTER, '--out', out, '--budget', '12'], { CMDLOOP_MUTANT: 'flatZero' })
  assert.equal(r.status, 0, r.out)
  const best = readJson2(join(out, 'best.json'))
  // 实现坏了之后，① 里那句 `dropPct > 50` 一定过不了 —— 它还成立就说明那句断言没接在实现上
  assert.equal(best.stop.reason, 'all-dead', '距离恒 0 时所有参数都该是 dead')
  assert.equal(best.startDist, 0, '距离恒 0：起点就是 0')
  assert.equal(best.bestDist, 0)
  assert.equal(best.dropPct, null, '起点为 0 时降幅无从计算（null，不是编一个 0%）')
  assert.ok(!(best.dropPct > 50), '收敛断言在恒 0 距离下必须为假')
  assert.equal(best.meta.mutant, 'flatZero', '证据包要记下"这轮是变异体跑的"')
})

test('⑨-2 弄坏能红：超时当正常（CMDLOOP_MUTANT=noTimeout）→ ③ 的硬错断言必须塌', () => {
  const site = makeSite('timeout-mut', {
    cmd: { name: 'slow.mjs', script: 'await new Promise((r) => setTimeout(r, 5000))\nconsole.log(JSON.stringify({ loss: 1, size: 10 }))\n' },
    timeoutMs: 300,
  })
  const out = tmp('timeout-mut-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '5'], { CMDLOOP_MUTANT: 'noTimeout' })
  // ③ 断言"超时必须非零退出 + 报超时"；变异体把超时降级成静默的 0 之后，这条断言就该红
  assert.equal(r.status, 0, `变异体应跑完（这正是静默当 0 的危险），实际 exit=${r.status}\n${r.out}`)
  assert.ok(!/超时/.test(r.out), '变异体下不该出现"超时"硬错')
  const doc = readJson2(join(out, 'outputs', 'e001.json'))
  assert.deepEqual(doc.metrics, { loss: 0, size: 0 }, '这就是"静默当 0"：超时的命令被当成指标全是 0')
})

// ---------------------------------------------------------------- ⑩ 另外两种取数方式
test('⑩ parse=number 与 line:k=v 也能跑通（三种取数方式都有人测）', () => {
  // number：整个 stdout 就是一个数 → 只能有 1 条指标
  const st = makeSite('num-ok', {
    cmd: { name: 'n.mjs', script: 'console.log(0.25)\n' },
    parse: 'number',
    metrics: [{ id: 'err', field: 'err', norm: { mode: 'abs', scale: 1 }, weight: 1 }],
    target: { mode: 'metrics', metrics: { err: 0 } },
  })
  const o1 = tmp('num-ok-out')
  // 预算 4 = 起点 1 + 稳定性闸 2（0.4.1 起默认 repeat=3，起点那一次算第 1 次采样）+ 预检 1。
  // 这条测的是"取数方式"，不是预算边界（预算不够的表现由 ⑪-5 单独钉）。
  const r1 = runCli(['--adapter', st.file, '--out', o1, '--budget', '4'])
  assert.equal(r1.status, 0, r1.out)
  const b1 = readJson2(join(o1, 'best.json'))
  assert.equal(b1.curve[0].dist, 0.25, 'number 模式：距离就是 0.25')
  assert.deepEqual(b1.curve[0].params, { a: 1 })

  // line:k=v：逐行 key=数值
  const kv = makeSite('kv-ok', {
    cmd: { name: 'kv.mjs', script: 'console.log("noise 这不是 k=v")\nconsole.log("loss=1.5")\nconsole.log("size = 33")\n' },
    parse: 'line:k=v',
    target: { mode: 'metrics', metrics: { loss: 0, size: 10 } },
  })
  const o2 = tmp('kv-ok-out')
  const r2 = runCli(['--adapter', kv.file, '--out', o2, '--budget', '4'])
  assert.equal(r2.status, 0, r2.out)
  const b2 = readJson2(join(o2, 'best.json'))
  assert.equal(b2.curve[0].m_loss, 1.5, 'line:k=v 要能取到 loss')
  assert.equal(b2.curve[0].m_size, 33, 'line:k=v 要能取到 size（容忍 key 两侧空格）')
  // 距离 = (1.5×1 + (33-10)/10×0.5)/1.5
  assert.equal(b2.curve[0].dist, 1.766667)

  // number 模式配 2 条指标：没有"哪条指标拿这个数"的答案 → 硬错
  const bad = makeSite('num-two', {
    cmd: { name: 'n2.mjs', script: 'console.log(1)\n' },
    parse: 'number',
    target: { mode: 'metrics', metrics: { loss: 0, size: 10 } },
  })
  const r3 = runCli(['--adapter', bad.file, '--out', tmp('num-two-out'), '--budget', '1'])
  assert.equal(r3.status, 1)
  assert.match(r3.out, /只能配 1 条指标/)
})

// 稳定性闸用的两条 demo 命令（都写成 .mjs 落进临时目录，由 cmdloop 当普通命令跑）
// 稳定：同一个参数跑几次，输出逐字节相同。
const STABLE_SCRIPT =
  [
    'import { readFileSync } from "node:fs"',
    'const d = JSON.parse(readFileSync(process.env.SELFLOOP_PARAMS, "utf8"))',
    'const a = Number(d.params.a)',
    'console.log(JSON.stringify({ loss: Number(Math.abs(a - 1).toFixed(6)), size: 10 + a }))',
  ].join('\n') + '\n'
// 不稳定：连续调用依次给 ×1.00 / ×1.05 / ×0.95（**确定性**抖动，不用 Math.random —— 用例要每次一样）。
// 用计数器文件实现"第几次调用"，所以同一组参数两次采样的值必然不同，spread = 0.1 > 0.02。
const JITTER_SCRIPT =
  [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs"',
    'import { dirname, join } from "node:path"',
    'import { fileURLToPath } from "node:url"',
    'const f = join(dirname(fileURLToPath(import.meta.url)), "jitter.n")',
    'const n = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0',
    'writeFileSync(f, String(n + 1))',
    'const k = [1, 1.05, 0.95][n % 3]',
    'console.log(JSON.stringify({ loss: Number((1 * k).toFixed(6)), size: 10 }))',
  ].join('\n') + '\n'

// ---------------------------------------------------------------- ⑪ 观测稳定性闸（0.4.1）
// 截图链路的等价物是 freeze.verify=strict（同 URL 连拍两张逐字节比）。命令链路原来什么都没有：
// 命令一旦有随机性，搜索就会学会在噪声里挑"看起来更好"的点，最后交付一个假的最优。
test('⑪-1 稳定命令 + 不写 stability → 默认参数生效、过闸、证据包里有 stability 表', () => {
  const site = makeSite('stab-ok', { cmd: { name: 'steady.mjs', script: STABLE_SCRIPT } })
  const out = tmp('stab-ok-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '12'])
  assert.equal(r.status, 0, `稳定命令该跑通，实际 exit=${r.status}\n${r.out.slice(-2000)}`)
  // 前提：adapter 里一个字都没写 stability —— 默认值必须自己生效
  assert.equal(site.adapter.observe.stability, undefined, '这条用例的前提是 adapter 没写 stability')
  const best = readJson2(join(out, 'best.json'))
  assert.deepEqual([best.stability.repeat, best.stability.maxSpread], [3, 0.02], '默认 repeat=3 / maxSpread=0.02 不写也要生效')
  assert.equal(best.stability.ok, true)
  assert.equal(best.stability.checked, true)
  assert.equal(best.stability.spreads.loss, 0, '稳定命令：loss 的 spread 必须是 0')
  assert.equal(best.stability.values.loss.length, 3, 'repeat=3 → 要留 3 条原始值')
  // 成本：起点那一次算第 1 次采样，额外花 repeat-1 = 2 次，并且**记进预算**（真的评估过 → 有 outputs）
  assert.equal(best.evaluations.stability, 2, `稳定性检查该花 2 次，实测 ${best.evaluations.stability}`)
  assert.equal(best.evaluations.used, best.curve.length, 'curve 行数 = 评估次数（稳定性那几次也在里面）')
  for (const n of ['e001.json', 'e002.json', 'e003.json']) assert.ok(existsSync(join(out, 'outputs', n)), `缺 outputs/${n}（稳定性检查的原始输出要留）`)
  const md = readFileSync(join(out, 'report.md'), 'utf8')
  assert.match(md, /观测稳定性闸/, 'report.md 要有那一节')
  assert.match(md, /spread/, 'report.md 的表头要写清 spread 口径')
  assert.match(md, /repeat=3/)
  assert.match(md, /记进预算/, '要写清这几次花掉的是预算')
})

test('⑪-2 不稳定命令（±5% 抖动）→ 中文硬错，点名指标、spread、阈值与原始值', () => {
  const site = makeSite('stab-jitter', { cmd: { name: 'jitter.mjs', script: JITTER_SCRIPT } })
  const out = tmp('stab-jitter-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '10'])
  assert.equal(r.status, 1, `观测不稳必须硬错，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /观测不稳定/)
  assert.match(r.out, /`loss`|loss/, '要点名是哪条指标')
  assert.match(r.out, /0\.100000/, `要报出 spread（实测 0.1），原文：${r.out}`)
  assert.match(r.out, /maxSpread=0\.02/, '要报出阈值')
  assert.match(r.out, /1、1\.05、0\.95/, '要报出 repeat 次的原始值')
  assert.ok(!existsSync(join(out, 'best.json')), '硬错时不许交出"看起来跑完了"的证据包')
})

test('⑪-3 repeat=1 → 显式关掉检查，但必须 warn（不静默）', () => {
  const site = makeSite('stab-off', { cmd: { name: 'steady.mjs', script: STABLE_SCRIPT }, stability: { repeat: 1 } })
  const out = tmp('stab-off-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '8'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /不验证观测稳定性/, 'repeat=1 必须打一条中文 warn')
  const best = readJson2(join(out, 'best.json'))
  assert.equal(best.stability.repeat, 1)
  assert.equal(best.stability.checked, false, 'repeat=1 = 没验过')
  assert.equal(best.evaluations.stability, 0, 'repeat=1 不该额外花评估')
  assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /未验证/, 'report 里要写"未验证"，不能假装通过')
})

test('⑪-4 非法配置（repeat:0 / maxSpread:0 / maxSpread:1.5）→ 各个中文硬错', () => {
  const cases = [
    [{ repeat: 0 }, /stability\.repeat 必须是 ≥1 的整数/],
    [{ maxSpread: 0 }, /stability\.maxSpread 必须是 \(0, 1\] 的数/],
    [{ maxSpread: 1.5 }, /stability\.maxSpread 必须是 \(0, 1\] 的数/],
  ]
  for (const [stability, re] of cases) {
    const site = makeSite('stab-bad', { cmd: { name: 'steady.mjs', script: STABLE_SCRIPT }, stability })
    const r = runCli(['--adapter', site.file, '--out', tmp('stab-bad-out'), '--budget', '6'])
    assert.equal(r.status, 1, `非法配置 ${JSON.stringify(stability)} 必须非零退出\n${r.out}`)
    assert.match(r.out, re, `非法配置 ${JSON.stringify(stability)} 的中文错不对：${r.out.slice(0, 400)}`)
    assert.match(r.out, /收到 /, '错误里要把收到的值原样回显（不然没法排查）')
  }
})

test('⑪-5 预算不够跑闸 → 硬错（绝不偷偷少跑几次）', () => {
  const site = makeSite('stab-budget', { cmd: { name: 'steady.mjs', script: STABLE_SCRIPT } })
  const out = tmp('stab-budget-out')
  // repeat=3 要 起点 1 + 2，预算 2 不够
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '2'])
  assert.equal(r.status, 1, `预算不够必须硬错，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /预算太小/)
  assert.match(r.out, /repeat=3/, '要说清要跑几次')
  assert.match(r.out, /repeat=1/, '要给一条出路（显式关掉）')
  assert.ok(!existsSync(join(out, 'best.json')), '硬错时不许产出证据包')
})

// ---------------------------------------------------------------- ⑫ 弄坏能红 ×2（0.4.1）
test('⑫-1 弄坏能红：判定恒真（CMDLOOP_MUTANT=stableAlways）→ ⑪-2 的硬错断言必须塌', () => {
  const site = makeSite('stab-mut-a', { cmd: { name: 'jitter.mjs', script: JITTER_SCRIPT } })
  const out = tmp('stab-mut-a-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '10'], { CMDLOOP_MUTANT: 'stableAlways' })
  // ⑪-2 断言"不稳 → exit 1"；判定恒真之后它必然 exit 0 —— 这就是"那条断言真的接在实现上"的证据
  assert.equal(r.status, 0, `变异体该跑完（这正是判定形同虚设的危险），实际 exit=${r.status}\n${r.out}`)
  assert.notEqual(r.status, 1, '⑪-2 的 assert.equal(r.status, 1) 在这份实现上不可能成立')
  assert.ok(!/观测不稳定/.test(r.out), '变异体下不该出现"观测不稳定"硬错')
  const best = readJson2(join(out, 'best.json'))
  assert.equal(best.stability.ok, true, '判定恒真：spread 再大也说 ok')
  assert.ok(best.stability.spreads.loss > 0.02, `spread 实测 ${best.stability.spreads.loss}，本来超阈值该被拦`)
})

test('⑫-2 弄坏能红：整段删掉（CMDLOOP_MUTANT=noStability）→ ⑪-1 的 stability 字段断言必须塌', () => {
  const site = makeSite('stab-mut-b', { cmd: { name: 'steady.mjs', script: STABLE_SCRIPT } })
  const out = tmp('stab-mut-b-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '12'], { CMDLOOP_MUTANT: 'noStability' })
  assert.equal(r.status, 0, r.out)
  const best = readJson2(join(out, 'best.json'))
  // ⑪-1 断言 best.stability.repeat === 3 / ok === true；字段没了之后它必然红（这里断言"没了"这件事）
  assert.ok(!('stability' in best), '整段删掉后 best.json 不该有 stability')
  assert.equal(best.evaluations.stability, 0)
  assert.ok(!/^## 观测稳定性闸/m.test(readFileSync(join(out, 'report.md'), 'utf8')), '报告里也不该有那一节')
  // 但它照样"看起来跑完了"—— 这正是没这个闸的时候证据包的样子：谁也看不出观测没验过
  assert.equal(typeof best.dropPct, 'number')
})

// ---------------------------------------------------------------- ⑬⑭⑮ 真实非图形目标：包体积预算（0.4.2）
// 这条测的不是"新功能"，而是**这套引擎在一个完全非图形的真实目标上到底能不能用**：
// 语料当场生成、zlib 真压真解、ratio 是实测的字节比。数字都是这份示例自己的实测值。
const COMPRESS_ADAPTER = join(ROOT, 'examples', 'command-compress.json')

// 跑一轮压缩要 2.5 秒上下；⑬ 与 ⑮ 共用同一次 run（⑭ 必须独立跑第二次才能比 hash）
let cmpRun
function compressRun() {
  if (!cmpRun) {
    const out = tmp('compress')
    const r = runCli(['--adapter', COMPRESS_ADAPTER, '--out', out, '--budget', '60', '--seed', '12345'])
    cmpRun = { r, out, best: existsSync(join(out, 'best.json')) ? readJson2(join(out, 'best.json')) : null }
  }
  return cmpRun
}

test('⑬ 包体积预算示例跑一轮：ratio 0.3902 → 0.3721（drop 89.4% > 30%），每一轮都必须无损解压', () => {
  const { r, out, best } = compressRun()
  assert.equal(r.status, 0, `压缩示例该跑通，实际 exit=${r.status}\n${r.out.slice(-2000)}`)
  assert.ok(best, 'best.json 必须存在')
  // 门槛按实测定：实测 89.4%，这里只钉 30%（不虚高；真坏了掉到 0 附近也会红）
  assert.ok(best.dropPct > 30, `降幅应 > 30%，实测 ${best.dropPct}%（start=${best.startDist} best=${best.bestDist}）`)
  // 观测量本身要对得上"包体积"这件事：起点 ratio ≈ 0.3902，最佳 ratio ≈ 0.3721
  const startRow = best.curve.find((c) => c.note === 'start')
  assert.ok(Math.abs(startRow.m_ratio - 0.390232) < 0.001, `起点 ratio 实测 ${startRow.m_ratio}，应约 0.3902`)
  assert.ok(Math.abs(best.bestDist) < 0.005, `最佳距离实测 ${best.bestDist}（= |ratio 0.3721 − 目标 0.37|），应 < 0.005`)
  // 无损：每一轮都解压比对通过，且 penalty 一次都没被触发
  for (const c of best.curve) {
    assert.equal(c.m_roundtrip, 1, `第 ${c.seq} 次评估解压比对失败（roundtrip=0）—— 方案作废`)
    assert.equal(c.pen, 0, `第 ${c.seq} 次评估被 penalty 罚了 ${c.pen}`)
  }
  // 证据包该有的都在（与 ① 同口径）
  for (const f of ['curve.csv', 'best.json', 'report.md']) assert.ok(existsSync(join(out, f)), `缺 ${f}`)
  assert.ok(best.stability.ok, '确定性的压缩命令必须过稳定性闸')
  assert.ok(best.meta.msPerEval > 0 && best.meta.msPerEval < 2000, `单次评估 ${best.meta.msPerEval}ms，不像是在跑一次真压缩`)
})

test('⑭ 同 seed 跑两次（压缩示例）best.json 的 hash 必须一致', () => {
  const a = compressRun()
  const out2 = tmp('compress-b')
  const r2 = runCli(['--adapter', COMPRESS_ADAPTER, '--out', out2, '--budget', '60', '--seed', '12345'])
  assert.equal(r2.status, 0, r2.out)
  const b2 = readJson2(join(out2, 'best.json'))
  assert.match(a.best.hash, /^[0-9a-f]{64}$/)
  assert.equal(a.best.hash, b2.hash, '同 seed 同参数换目录重跑，hash 必须一致（语料与搜索都得可复现）')
  assert.deepEqual(
    a.best.curve.map((c) => [c.seq, c.params, c.dist]),
    b2.curve.map((c) => [c.seq, c.params, c.dist]),
    '同 seed 的评估序列必须逐点一致',
  )
})

test('⑮ 弄坏能红：目标改成"起点参数就命中"的值 → ⑬ 的降幅断言必红（降幅算不出来 = null）', () => {
  // 把示例整份抄进临时目录，再把目标 ratio 改成**起点参数跑出来的那个 ratio**
  // （也就是"默认参数直接命中"—— 任务里点名的那个反例）。
  const site = tmp('compress-mut')
  cpSync(join(ROOT, 'examples', 'command-compress'), join(site, 'command-compress'), { recursive: true })
  const mut = JSON.parse(JSON.stringify(readJson2(COMPRESS_ADAPTER)))
  mut.name = 'compress-mut-hit-by-start'
  mut.config.path = 'command-compress/base-params.json'
  mut.observe.cmd = 'node ./command-compress/probe.mjs'
  // 起点参数跑一次，拿到"默认就命中"的那个值（不抄常数，免得示例改了口径这条还假装成立）
  const pf = join(site, 'start-params.json')
  const baseParams = readJson2(join(ROOT, 'examples', 'command-compress', 'base-params.json')).params
  writeFileSync(pf, JSON.stringify({ params: baseParams }), 'utf8')
  const probe = spawnSync(process.execPath, [join(site, 'command-compress', 'probe.mjs'), pf], { encoding: 'utf8' })
  assert.equal(probe.status, 0, `探针要能跑：${probe.stderr}`)
  mut.target.metrics.ratio = JSON.parse(probe.stdout).ratio
  const file = join(site, 'adapter.json')
  writeFileSync(file, JSON.stringify(mut, null, 2), 'utf8')

  const out = tmp('compress-mut-out')
  const r = runCli(['--adapter', file, '--out', out, '--budget', '14', '--seed', '12345'])
  assert.equal(r.status, 0, r.out)
  const best = readJson2(join(out, 'best.json'))
  // 起点就命中 → 起点距离 0 → 降幅算不出来（null，不编一个 0%），⑬ 那句 assert.ok(dropPct > 30) 必红
  assert.equal(best.startDist, 0, '目标 = 起点参数跑出来的值，起点距离必须是 0')
  assert.equal(best.dropPct, null, '起点距离为 0 时降幅无从计算（null）')
  assert.ok(!(best.dropPct > 30), '这条落在这份实现上不可能成立 —— ⑬ 的降幅断言真的接着实现')
})

// ---------------------------------------------------------------- 极小 JSON-Schema 子集校验器（与 plugin.test.mjs 同口径）
function validate(schema, value, at = '$') {
  const errs = []
  const type = schema.type
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value
  const typeOk = type === undefined || type === actual || (type === 'number' && actual === 'integer')
  if (!typeOk) return [`${at}: 期望 ${type}，实际 ${actual}`]
  if (type === 'object') {
    const props = schema.properties ?? {}
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${at}.${k}: required 但缺失`)
    for (const [k, v] of Object.entries(value)) {
      if (!(k in props)) {
        if (schema.additionalProperties === false) errs.push(`${at}.${k}: 多余键（additionalProperties=false）`)
        continue
      }
      errs.push(...validate(props[k], v, `${at}.${k}`))
    }
  }
  if (type === 'array' && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)))
  return errs
}
