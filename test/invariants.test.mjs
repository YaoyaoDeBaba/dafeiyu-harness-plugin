// 硬不变量（invariants，0.7.0）自测：不碰浏览器、不开端口、不依赖仓库外的现场。
//
// 覆盖（«» 里对应用户要求的测试编号）：
//   ① «1» 目标违规 → 硬错（错误信息点名 id）
//   ② «1» 起点违规 → 硬错（错误信息点名 id）
//   ③ «2» 候选级门禁：死区里的候选被拒 → 跑通 + report 拒绝次数 > 0 + best.json invariants.rejected >= 1
//         且**被拒候选没有成为 best**（best 停在死区外），台帐 search 节点 basis 写着"门禁拒绝 N 个候选"
//   ④ «3» 没写 invariants → 跑通 + 默认 warn；--no-invariants-warn 关掉
//   ⑤ «4» 文法错（op="~="）→ 硬错，错误信息列出支持的 op
//   ⑥ «5» field 在观测里取不到 → 硬错（不许静默判过）
//   ⑦ «6» 弄坏能红 A：门禁恒通过（SELFLOOP_INVARIANTS_MUTANT=alwaysPass）→ ③ 的断言必红
//   ⑧ «6» 弄坏能红 B：目标/起点硬错不查（SELFLOOP_INVARIANTS_MUTANT=noTargetGate）→ ① 必红
//   ⑨ 文法边界：duplicate id / 空 all / 缺 why / 截图链路写 invariants（fail-closed）
//   ⑩ 空数组 invariants = 不拦（等价于没写，会 warn）
//
// 0.8.0 新增（门禁自身的三条"病"）：
//   ⑪ «6» 假门：永远为真的不变量 + 评估 ≥10 次 → 终端与报告都写「未拦任何候选」；--no-fake-gate-warn 只关终端
//   ⑫ «7» 写死了：连续 3 轮新候选全被门禁拒绝 → stop=invariant-blocked（点名 id、与"参数全 dead"区分、早停）
//   ⑬ «8» 贴阈值：目标过了但贴着阈值 → 终端与报告各写一次「阈值很近」
//
// 变异开关（只给测试用，见 harness/invariants.mjs 的 INVARIANTS_MUTANT）：
//   SELFLOOP_INVARIANTS_MUTANT=alwaysPass|noTargetGate node test/invariants.test.mjs
// 不设时行为完全正常。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'harness', 'cmdloop.mjs')
const INTENT_CLI = join(ROOT, 'harness', 'intent.mjs')
const ECHO = join(ROOT, 'examples', 'command-echo.json')

const tmp = (tag) => mkdtempSync(join(tmpdir(), `selfloop-inv-${tag}-`))
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// 1x1 PNG：v2 intent 的 anchors 硬要求（kind=image 的 ref 必须真实存在）
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// 一份填好的 v2 intent（锚/反例/自由度/验收方式齐全），invariants 按用例给
function writeIntent(out, invariants, over = {}) {
  mkdirSync(out, { recursive: true })
  mkdirSync(join(out, 'refs'), { recursive: true })
  writeFileSync(join(out, 'refs', 'ref-a.png'), PNG_1X1)
  const doc = {
    version: 2,
    restate: '把指标压到目标，同时不许选出废解',
    anchors: [
      { kind: 'image', ref: 'refs/ref-a.png', why: '同类高评分的参照图' },
      { kind: 'text', ref: '具体参照物（不是抽象口号）', why: '量级参照' },
    ],
    criteria: [],
    notWanted: ['不要含糊通过', '不要越界'],
    freeVsFixed: { fixed: ['目标'], free: ['步长'] },
    howWeVerify: { human: true, metrics: true, note: '指标过闸 + 人眼一次' },
    uncertain: [],
    confirm: [],
    confirmed: true,
    confirmedBy: 'user',
    confirmedAt: '2026-11-14T22:00:00+08:00',
    invariants,
    ...over,
  }
  const file = join(out, 'intent.json')
  writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')
  return file
}

// 一个"死区"现场：alpha 单调靠近目标 4，但 alpha ∈ [2, 3.5) 时 guard=0（废解）。
// 起点 alpha=1 / 目标 alpha=4 都 guard=1 —— 正常跑必须被门禁挡住，改坏门禁就会穿过去。
function makeGuardSite(tag) {
  const dir = tmp(tag)
  writeFileSync(join(dir, 'base.json'), JSON.stringify({ params: { alpha: 1 } }), 'utf8')
  writeFileSync(
    join(dir, 'probe.mjs'),
    [
      "import { readFileSync } from 'node:fs'",
      'const doc = JSON.parse(readFileSync(process.env.SELFLOOP_PARAMS, "utf8"))',
      'const p = doc.params && typeof doc.params === "object" ? doc.params : doc',
      'const alpha = Number(p.alpha)',
      'const guard = alpha >= 2 && alpha < 3.5 ? 0 : 1',
      'const loss = Number(Math.abs(alpha - 4).toFixed(6))',
      'process.stdout.write(JSON.stringify({ loss, guard, alpha }) + "\\n")',
    ].join('\n') + '\n',
    'utf8',
  )
  const adapter = {
    schema: 'closed-loop-adapter/3',
    domain: 'command',
    name: `test-invariants-${tag}`,
    config: { path: 'base.json', format: 'flat-params' },
    observe: {
      type: 'command',
      cmd: 'node ./probe.mjs',
      timeoutMs: 30000,
      parse: 'json',
      metrics: [{ id: 'loss', field: 'loss', norm: { mode: 'abs', scale: 4 }, weight: 1 }],
    },
    target: { mode: 'params', params: { alpha: 4 } },
    params: { mode: 'list', list: ['alpha'] },
    score: { type: 'l1', penalties: [] },
    guard: { protectPaths: [] },
  }
  const file = join(dir, 'adapter.json')
  writeFileSync(file, JSON.stringify(adapter, null, 2), 'utf8')
  return { dir, file }
}

const DEAD_BAND = {
  id: 'no_dead_band',
  check: { any: [{ field: 'guard', op: '==', value: 1 }] },
  why: 'guard=0 的解虽然更近，但不可用（解压回不去那类）',
}

// 「写死了」现场（0.8.0）：guard 只在起点（alpha=1）与预检点（alpha=1.1）为 1，
// 其余参数空间全不合格。预检能扫到活轴（alpha+1 步 = 1.1 过门）→ **不是**"参数全 dead"，
// 而是随机搜索的每个新候选都被门禁拒绝 —— 归因必须落在 invariant-blocked 上。
function makeBlockedSite(tag) {
  const dir = tmp(tag)
  writeFileSync(join(dir, 'base.json'), JSON.stringify({ params: { alpha: 1 } }), 'utf8')
  writeFileSync(
    join(dir, 'probe.mjs'),
    [
      "import { readFileSync } from 'node:fs'",
      'const doc = JSON.parse(readFileSync(process.env.SELFLOOP_PARAMS, "utf8"))',
      'const p = doc.params && typeof doc.params === "object" ? doc.params : doc',
      'const alpha = Number(p.alpha)',
      'const guard = alpha === 1 || alpha === 1.1 || alpha === 1.25 ? 1 : 0',
      'const loss = Number(Math.abs(alpha - 2).toFixed(6))',
      'process.stdout.write(JSON.stringify({ loss, guard, alpha }) + "\\n")',
    ].join('\n') + '\n',
    'utf8',
  )
  const adapter = {
    schema: 'closed-loop-adapter/3',
    domain: 'command',
    name: `test-blocked-${tag}`,
    config: { path: 'base.json', format: 'flat-params' },
    observe: {
      type: 'command',
      cmd: 'node ./probe.mjs',
      timeoutMs: 30000,
      parse: 'json',
      metrics: [{ id: 'loss', field: 'loss', norm: { mode: 'abs', scale: 4 }, weight: 1 }],
    },
    target: { mode: 'params', params: { alpha: 1.25 } },
    params: { mode: 'list', list: ['alpha'] },
    score: { type: 'l1', penalties: [] },
    guard: { protectPaths: [] },
  }
  const file = join(dir, 'adapter.json')
  writeFileSync(file, JSON.stringify(adapter, null, 2), 'utf8')
  return { dir, file }
}

// 「目标贴阈值」现场（0.8.0）：目标直接给数值 loss=0.4487，不变量 loss<=0.45 —— 过了，但只差 0.29%。
// 起点 loss=0（合规），所以这不是目标/起点硬错，而是"这次合格、下一版微调就翻脸"。
function makeNearSite(tag) {
  const dir = tmp(tag)
  writeFileSync(join(dir, 'base.json'), JSON.stringify({ params: { alpha: 1, beta: 1 } }), 'utf8')
  writeFileSync(
    join(dir, 'probe.mjs'),
    [
      "import { readFileSync } from 'node:fs'",
      'const doc = JSON.parse(readFileSync(process.env.SELFLOOP_PARAMS, "utf8"))',
      'const p = doc.params && typeof doc.params === "object" ? doc.params : doc',
      'const alpha = Number(p.alpha)',
      'const beta = Number(p.beta)',
      'const loss = Number((Math.abs(alpha - 1) + 0.5 * Math.abs(beta - 1)).toFixed(6))',
      'const size = Number((20 + 5 * alpha + 3 * beta).toFixed(6))',
      'process.stdout.write(JSON.stringify({ loss, size, alpha, beta }) + "\\n")',
    ].join('\n') + '\n',
    'utf8',
  )
  const adapter = {
    schema: 'closed-loop-adapter/3',
    domain: 'command',
    name: `test-near-${tag}`,
    config: { path: 'base.json', format: 'flat-params' },
    observe: {
      type: 'command',
      cmd: 'node ./probe.mjs',
      timeoutMs: 30000,
      parse: 'json',
      metrics: [
        { id: 'loss', field: 'loss', norm: { mode: 'abs', scale: 1 }, weight: 1 },
        { id: 'size', field: 'size', norm: { mode: 'abs', scale: 24 }, weight: 0.5 },
      ],
    },
    target: { mode: 'metrics', metrics: { loss: 0.4487, size: 28 } },
    params: { mode: 'list', list: ['alpha', 'beta'] },
    score: { type: 'l1', penalties: [] },
    guard: { protectPaths: [] },
  }
  const file = join(dir, 'adapter.json')
  writeFileSync(file, JSON.stringify(adapter, null, 2), 'utf8')
  return { dir, file }
}

// 一次"门禁该拦住东西"的 run：③⑦ 共用（省一次 1 秒的跑，也保证两条断言看的是同一份证据）
let gatedRun
function gatedRunOnce() {
  if (!gatedRun) {
    const site = makeGuardSite('band')
    const out = tmp('band-run')
    const intent = writeIntent(out, [DEAD_BAND])
    const r = runCli(['--adapter', site.file, '--out', out, '--budget', '40', '--intent', intent])
    gatedRun = { r, out, site, best: readJson(join(out, 'best.json')), report: readFileSync(join(out, 'report.md'), 'utf8') }
  }
  return gatedRun
}

// ---------------------------------------------------------------- ① / ⑧ 目标与起点也要过
test('① 目标违反硬不变量 → 硬错，错误信息点名 id（不是静默判过）', () => {
  const out = tmp('tgt')
  // size >= 30：target.params 跑出来的 size=28 违规（起点 size=36 合规）→ 硬错必须落在"目标"上
  const intent = writeIntent(out, [{ id: 'size_floor', check: { field: 'size', op: '>=', value: 30 }, why: '目标体积不得低于 30' }])
  const r = runCli(['--adapter', ECHO, '--out', join(out, 'run'), '--budget', '8', '--intent', intent])
  assert.equal(r.status, 1, `目标违规必须硬错，实际 exit=${r.status}\n${r.out.slice(-1500)}`)
  assert.match(r.out, /硬不变量/)
  assert.match(r.out, /id="size_floor"/, '错误信息必须点名是哪条不变量')
  assert.match(r.out, /目标/)
  assert.match(r.out, /自相矛盾/)
})

test('② 起点违反硬不变量 → 硬错，错误信息点名 id（目标本身合规）', () => {
  const out = tmp('start')
  // size <= 30：目标 size=28 合规，起点 size=36 违规
  const intent = writeIntent(out, [{ id: 'start_fail', check: { field: 'size', op: '<=', value: 30 }, why: '起点体积超标' }])
  const r = runCli(['--adapter', ECHO, '--out', join(out, 'run'), '--budget', '8', '--intent', intent])
  assert.equal(r.status, 1, `起点违规必须硬错，实际 exit=${r.status}\n${r.out.slice(-1500)}`)
  assert.match(r.out, /id="start_fail"/)
  assert.match(r.out, /起点/)
})

// ---------------------------------------------------------------- ③ 候选级门禁
test('③ 候选违反硬不变量 → 判废（不进距离、不做 best），并且证据包里看得见', () => {
  const { r, out, best, report } = gatedRunOnce()
  assert.equal(r.status, 0, `门禁拒绝候选不该让整轮失败，实际 exit=${r.status}\n${r.out.slice(-1500)}`)
  // best.json 记账
  assert.equal(best.invariants.declared, true)
  assert.ok(best.invariants.rejected >= 1, `invariants.rejected 应 >= 1，实际 ${best.invariants.rejected}`)
  assert.equal(best.invariants.items.length, 1)
  assert.equal(best.invariants.items[0].id, 'no_dead_band')
  assert.ok(best.invariants.items[0].rejected >= 1, '那条 invariant 自己的拒绝次数也要 >= 1')
  assert.equal(best.invariants.items[0].lastReject.values.guard, 0, '最近一次拒绝要留下原始观测片段（guard=0）')
  // 被拒候选没成为 best：best 停在死区外（alpha < 2）
  assert.ok(best.bestParams.alpha < 2, `违例候选不该成为 best，实际 best.alpha=${best.bestParams.alpha}`)
  // report.md 一节「硬不变量」+ 拒绝次数
  assert.match(report, /## 硬不变量/)
  const rejectedLine = /门禁拒绝 (\d+) 个候选/.exec(report)
  assert.ok(rejectedLine, 'report.md 必须写出门禁拒绝次数')
  assert.ok(Number(rejectedLine[1]) > 0, `report 里的拒绝次数应 > 0，实际 ${rejectedLine && rejectedLine[1]}`)
  assert.match(report, /"guard":\s*0/, 'report 要保留最近一次拒绝的原始观测片段')
  // 台帐 search 节点 basis（research 插到 02 之后，search 从 05 变 06）
  const node = readJson(join(out, 'nodes', '06-search.json'))
  assert.ok(node.decision.basis.some((s) => /门禁拒绝 \d+ 个候选/.test(s)), 'search 节点的 basis 要写"门禁拒绝 N 个候选"')
  // 图省事的写法（dist 更小但违例）不能靠缓存绕过：curve 里被拒点标了 inv=0
  const rejectedPts = best.curve.filter((c) => c.inv === false && c.invFail.includes('no_dead_band'))
  assert.ok(rejectedPts.length >= 1, 'curve 里要能看出哪个评估点被拒')
  assert.ok(
    rejectedPts.some((c) => c.dist < best.bestDist),
    `被拒候选里有距离比 best 更小的（这才是"拿底线换分数"）：rejected d=${JSON.stringify(rejectedPts.map((c) => c.dist))} best d=${best.bestDist}`,
  )
  const csv = readFileSync(join(out, 'curve.csv'), 'utf8').trim().split(/\r?\n/)
  const invIdx = csv[0].split(',').indexOf('inv')
  assert.ok(invIdx >= 0, 'curve.csv 要有 inv 列')
  assert.ok(
    csv.slice(1).some((line) => line.split(',')[invIdx] === '0'),
    'curve.csv 的 inv 列要标出被拒的点（0 = 门禁拒绝）',
  )
})

// ---------------------------------------------------------------- ④ 默认 warn / 关 warn
test('④ 没写 invariants → 跑通 + 默认 warn；--no-invariants-warn 能关', () => {
  const out = tmp('warn')
  const r = runCli(['--adapter', ECHO, '--out', out, '--budget', '10', '--no-intent'])
  assert.equal(r.status, 0, r.out.slice(-1500))
  assert.match(r.out, /没写硬不变量：搜索会拿底线换分数/)
  const best = readJson(join(out, 'best.json'))
  assert.equal(best.invariants.declared, false)
  assert.equal(best.invariants.rejected, 0)
  const report = readFileSync(join(out, 'report.md'), 'utf8')
  assert.match(report, /没写硬不变量：搜索会拿底线换分数/)

  const out2 = tmp('warn-off')
  const r2 = runCli(['--adapter', ECHO, '--out', out2, '--budget', '10', '--no-intent', '--no-invariants-warn'])
  assert.equal(r2.status, 0, r2.out.slice(-1500))
  assert.doesNotMatch(r2.out, /没写硬不变量：搜索会拿底线换分数/, '--no-invariants-warn 要给一条安静的路')
  assert.match(readFileSync(join(out2, 'report.md'), 'utf8'), /没写硬不变量/, '报告里仍然要如实记"门禁没装"（warn 开关不改事实）')
})

// ---------------------------------------------------------------- ⑤ 文法错
test('⑤ 文法不认识（op="~="）→ 硬错，错误信息列出支持的 op', () => {
  const out = tmp('grammar')
  const intent = writeIntent(out, [{ id: 'bad_op', check: { field: 'loss', op: '~=', value: 1 }, why: '文法测试' }])
  const r = runCli(['--adapter', ECHO, '--out', join(out, 'run'), '--budget', '6', '--intent', intent])
  assert.equal(r.status, 1, `文法错必须硬错，实际 exit=${r.status}\n${r.out.slice(-1200)}`)
  assert.match(r.out, /~=/)
  assert.match(r.out, /只认 == != < <= > >=/, '错误信息必须列出支持的 op')
  assert.match(r.out, /intent\.invariants\[0\]\.check\.op/)
})

// ---------------------------------------------------------------- ⑥ 字段取不到
test('⑥ field 在观测里取不到 → 硬错（不许静默判过）', () => {
  const out = tmp('missing')
  const intent = writeIntent(out, [{ id: 'missing_field', check: { field: 'nope', op: '<', value: 1 }, why: '字段不存在' }])
  const r = runCli(['--adapter', ECHO, '--out', join(out, 'run'), '--budget', '6', '--intent', intent])
  assert.equal(r.status, 1, `取不到字段必须硬错，实际 exit=${r.status}\n${r.out.slice(-1200)}`)
  assert.match(r.out, /字段 `nope` 在观测里取不到/)
  assert.match(r.out, /不许静默判过/)
  assert.match(r.out, /id="missing_field"/, '硬错要能点回是哪条不变量写的')
})

// ---------------------------------------------------------------- ⑦ 弄坏能红 A
test('⑦ 弄坏能红：门禁恒通过（SELFLOOP_INVARIANTS_MUTANT=alwaysPass）→ ③ 的断言必红', () => {
  const site = makeGuardSite('band-mutant')
  const out = tmp('band-mutant-run')
  const intent = writeIntent(out, [DEAD_BAND])
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '40', '--intent', intent], { SELFLOOP_INVARIANTS_MUTANT: 'alwaysPass' })
  assert.equal(r.status, 0, r.out.slice(-1500))
  const best = readJson(join(out, 'best.json'))
  // ③ 的第一条断言：rejected >= 1 —— 恒通过时变 0
  assert.equal(best.invariants.rejected, 0, '恒通过时 rejected 必须是 0，否则 ③ 的 rejected 断言没有牙')
  // ③ 的第二条断言：best 不进死区 —— 恒通过时违例点不但被评，还当上了某轮 best
  const bySeq = new Map(best.curve.map((c) => [c.seq, c]))
  const winnerAlphas = best.rounds
    .filter((x) => x.winner !== null && x.winner !== undefined)
    .map((x) => bySeq.get(x.winner))
    .filter((c) => c)
    .map((c) => c.params.alpha)
  assert.ok(
    winnerAlphas.some((a) => a >= 2 && a < 3.5),
    `恒通过后违例候选没有成为 best（rounds: ${JSON.stringify(winnerAlphas)}）—— 那 ③ 的"best 不进死区"断言就没有牙`,
  )
})

// ---------------------------------------------------------------- ⑧ 弄坏能红 B
test('⑧ 弄坏能红：目标/起点硬错不查（SELFLOOP_INVARIANTS_MUTANT=noTargetGate）→ ① 必红', () => {
  const out = tmp('tgt-mutant')
  const intent = writeIntent(out, [{ id: 'size_floor', check: { field: 'size', op: '>=', value: 30 }, why: '目标体积不得低于 30' }])
  const r = runCli(['--adapter', ECHO, '--out', join(out, 'run'), '--budget', '10', '--intent', intent], { SELFLOOP_INVARIANTS_MUTANT: 'noTargetGate' })
  assert.equal(r.status, 0, `noTargetGate 变异体下必须能跑（证明 ① 的 exit=1 不是"怎么都退出 1"）\n${r.out.slice(-1500)}`)
  assert.doesNotMatch(r.out, /自相矛盾/)
})

// ---------------------------------------------------------------- ⑨ 文法边界 + 截图链路 fail-closed
test('⑨ 文法边界：重复 id / 空组合 / 缺 why 都硬错；截图链路写 invariants 也硬错（不假装装了门禁）', () => {
  const runGate = (intentFile, chain = 'cmd') =>
    spawnSync(process.execPath, [INTENT_CLI, 'gate', '--out', tmp('gate'), '--adapter', ECHO, '--chain', chain, '--intent', intentFile], {
      cwd: ROOT,
      encoding: 'utf8',
    })
  const cases = [
    ['重复 id', [DEAD_BAND, DEAD_BAND], /id="no_dead_band" 和前面重复/],
    ['空组合', [{ id: 'empty_all', check: { all: [] }, why: '空组合' }], /空数组/],
    ['缺 why', [{ id: 'no_why', check: { field: 'loss', op: '==', value: 0 } }], /why 不能是空的/],
  ]
  for (const [label, invariants, re] of cases) {
    const out = tmp('gate-' + label)
    const intent = writeIntent(out, invariants)
    const r = runGate(intent)
    assert.equal(r.status, 1, `${label} 必须硬错：\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr + r.stdout, re, `${label} 的错误信息不对：\n${r.stdout}${r.stderr}`)
  }
  // 截图链路：暂不支持门禁 → 写了就拒跑（fail-closed），绝不静默忽略
  const out = tmp('shot')
  const intent = writeIntent(out, [DEAD_BAND])
  const r = runGate(intent, 'screenshot')
  assert.equal(r.status, 1, `截图链路写了 invariants 必须硬错：\n${r.stdout}${r.stderr}`)
  assert.match(r.stderr + r.stdout, /截图链路不支持硬不变量/)
  assert.match(r.stderr + r.stdout, /no_dead_band/)
})

// ---------------------------------------------------------------- ⑪ 假门告警（0.8.0）
// 关键设计：**同一轮里既有会拒绝的，也有永远为真的**。
// 如果"rejected==0"这条检查被删掉，永远为真的那条还没事，但**会拒绝的那条也会被当成假门**报出来 ——
// ⑪ 断言 "假门只能有一条、且是 loss_nonneg" 就会红（只放一条恒真的不变量，删了检查也不会红）。
test('⑪ 假门告警（«6»）：永远为真的不变量 + 评估 ≥10 次 → 终端与报告都写「未拦任何候选」', () => {
  const site = makeGuardSite('fakegate')
  const out = tmp('fakegate-run')
  const intent = writeIntent(out, [
    DEAD_BAND, // 会拒绝：门在干活，**不该**被报成假门
    { id: 'loss_nonneg', check: { field: 'loss', op: '>=', value: 0 }, why: 'loss 不该为负（本条永远为真，专门用来验假门告警）' },
  ])
  const r = runCli(['--adapter', site.file, '--out', join(out, 'run'), '--budget', '40', '--intent', intent])
  assert.equal(r.status, 0, r.out.slice(-2000))
  // 终端：只点名永远不会拒绝的那条
  assert.match(r.out, /未拦任何候选/, '终端要有假门告警')
  assert.match(r.out, /硬不变量 loss_nonneg 本次一次都没拦住候选/, '要点名是哪条不变量')
  assert.match(r.out, /假门比没门更危险/, '要写清"为什么假门更危险"')
  assert.match(r.out, /评估 \d+ 次，报告里标/, '告警里要带评估次数')
  assert.doesNotMatch(r.out, /硬不变量 no_dead_band 本次一次都没拦住候选/, '真拦过候选的那条不能被报成假门')
  // best.json（机器读的那一份）
  const best = readJson(join(out, 'run', 'best.json'))
  assert.ok(best.invariants.rejected >= 1, '这一轮必须真有候选被拒（否则"假门"这个词就没对照物）')
  assert.ok(Array.isArray(best.invariants.fakeGate) && best.invariants.fakeGate.length === 1, `假门只能有一条（loss_nonneg）：${JSON.stringify(best.invariants.fakeGate)}`)
  assert.equal(best.invariants.fakeGate[0].id, 'loss_nonneg')
  assert.ok(best.invariants.fakeGate[0].attempts >= 10, '评估次数要 >= 10（这是告警的门槛）')
  // 报告
  const report = readFileSync(join(out, 'run', 'report.md'), 'utf8')
  assert.match(report, /未拦任何候选/, '报告「硬不变量」那一节要标出来')
  assert.match(report, /假门告警/)
  // --no-fake-gate-warn 只关终端，报告照写（开关不改事实）
  const out2 = tmp('fakegate-quiet')
  const intent2 = writeIntent(out2, [
    DEAD_BAND,
    { id: 'loss_nonneg', check: { field: 'loss', op: '>=', value: 0 }, why: 'loss 不该为负' },
  ])
  const r2 = runCli(['--adapter', site.file, '--out', join(out2, 'run'), '--budget', '40', '--intent', intent2, '--no-fake-gate-warn'])
  assert.equal(r2.status, 0, r2.out.slice(-1200))
  assert.doesNotMatch(r2.out, /未拦任何候选/, '--no-fake-gate-warn 之后终端要安静')
  assert.match(readFileSync(join(out2, 'run', 'report.md'), 'utf8'), /未拦任何候选/, '报告里仍然要如实记（warn 开关不改事实）')
})

// ---------------------------------------------------------------- ⑦ 写死了 → invariant-blocked
test('⑫ 写死了（«7»）：连续 3 轮新候选全被门禁拒绝 → stop=invariant-blocked（不是 stagnant、也不是参数死了）', () => {
  const site = makeBlockedSite('blocked')
  const out = tmp('blocked-run')
  const intent = writeIntent(out, [
    { id: 'only_start_ok', check: { field: 'guard', op: '==', value: 1 }, why: '只有起点附近合格：用来验"门禁挡死搜索"的归因' },
  ])
  // 随机策略 + 放大的 max-stagnant/max-rounds：要让"门禁挡路 3 轮"先于这两条停条件触发
  const r = runCli([
    '--adapter', site.file, '--out', join(out, 'run'),
    '--budget', '30', '--strategy', 'random', '--max-stagnant', '8', '--max-rounds', '8',
    '--intent', intent,
  ])
  assert.equal(r.status, 0, r.out.slice(-2000))
  const run = join(out, 'run')
  const best = readJson(join(run, 'best.json'))
  assert.equal(best.stop.reason, 'invariant-blocked', `必须是专门的终止原因，实际 ${best.stop.reason}：${best.stop.detail}`)
  assert.match(best.stop.detail, /门禁挡住了搜索，不是参数死了/, '要注明是门禁挡的')
  assert.match(best.stop.detail, /only_start_ok/, '要点名被频繁拒绝的不变量 id')
  assert.match(best.stop.detail, /参数全 dead/, '要与"参数全 dead"明确区分')
  // 早停：门禁挡了 3 轮就停，没跑到 --max-rounds 8
  assert.ok(best.rounds.length <= 3, `应在第 3 轮早停，实际跑了 ${best.rounds.length} 轮`)
  // 报告里也是同一句（不是只在终端一闪而过）
  const report = readFileSync(join(run, 'report.md'), 'utf8')
  assert.match(report, /门禁挡住了搜索，不是参数死了/)
  assert.match(report, /only_start_ok/)
  assert.match(r.out, /invariant-blocked/)
})

// ---------------------------------------------------------------- ⑧ 贴阈值提醒（0.8.0）
test('⑬ 贴阈值提醒（«8»）：目标过了但离阈值 <1% → 终端与报告各出现一次「阈值很近」', () => {
  const site = makeNearSite('near')
  const out = tmp('near-run')
  const intent = writeIntent(out, [{ id: 'loss_ceiling', check: { field: 'loss', op: '<=', value: 0.45 }, why: 'loss 超过 0.45 就不能用' }])
  const r = runCli(['--adapter', site.file, '--out', join(out, 'run'), '--budget', '12', '--intent', intent])
  assert.equal(r.status, 0, r.out.slice(-1500))
  const termHits = (r.out.match(/阈值很近/g) || []).length
  assert.equal(termHits, 1, `终端要恰好提示一次（实际 ${termHits} 次）：\n${r.out.slice(-1200)}`)
  assert.match(r.out, /loss_ceiling/)
  assert.match(r.out, /观测 0\.4487 \/ 阈值 0.45/, '要带观测值与阈值')
  const report = readFileSync(join(out, 'run', 'report.md'), 'utf8')
  const repHits = (report.match(/阈值很近/g) || []).length
  assert.equal(repHits, 1, `报告里也要恰好一次（实际 ${repHits} 次）`)
  const best = readJson(join(out, 'run', 'best.json'))
  assert.equal(best.invariants.nearThreshold.length, 1)
  assert.equal(best.invariants.nearThreshold[0].id, 'loss_ceiling')
  assert.equal(best.invariants.nearThreshold[0].observed, 0.4487)
  assert.equal(best.invariants.nearThreshold[0].threshold, 0.45)
})

// ---------------------------------------------------------------- ⑩ 空数组 = 不拦
test('⑩ invariants: [] → 不拦（等价于没写），warn 照打', () => {
  const out = tmp('empty')
  const intent = writeIntent(out, [])
  const r = runCli(['--adapter', ECHO, '--out', join(out, 'run'), '--budget', '10', '--intent', intent])
  assert.equal(r.status, 0, r.out.slice(-1500))
  assert.match(r.out, /没写硬不变量：搜索会拿底线换分数/)
  const best = readJson(join(out, 'run', 'best.json'))
  assert.equal(best.invariants.declared, false)
  assert.equal(best.invariants.rejected, 0)
})


