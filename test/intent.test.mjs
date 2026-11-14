// 需求转译闸（intent 硬闸）+ 节点台帐（0.5.0）自测：不碰浏览器、不开端口。
//
// 覆盖（任务书 D 节的七条 + 两条附带）：
//   ① 无 intent          → 硬错 + 写出 <out>/intent.template.json（有 confirm 字段）
//   ② confirmed:false    → 硬错，错误文本里含 confirm[] 的每一条（原样列出）
//   ③ confirmed:true 且 id 合法 → 跑通；report.md 有"本次运行："汇总行；nodes/01-intent.json 是 done；
//                          并且 criteria 的权重/目标值**真的落到判据上**（不是只记了个账）
//   ④ criteria 里有不存在的 id → 硬错（绝不静默忽略）+ 不产出 best.json
//   ⑤ --no-intent        → 跑通；nodes/01-intent.json 是 skipped 且 reason 含 --no-intent
//   ⑥ 台帐一致性         → nodes/ 每个文件能 parse、node/seq/status 齐全、status 合法、seq 连续；
//                          report.md 汇总行的 done/skipped 计数与 nodes/ 实际条数相等
//   ⑦ 弄坏能红 ×2        → alwaysPass（闸恒放行）让 ① 塌；dropSkipRecord（不记 skipping）让 ⑤ 塌
//   ⑧ 截图链路的闸       → intent.mjs gate --chain screenshot：权重覆盖进派生 adapter、target 只记账（degraded）
//   ⑨ 截图链路台帐补全   → 合成 _run.json 跑 finalize.js：intent(01) 之后补 target/stability/precheck/search/finalize，
//                          汇总行计数与文件条数相等、stability 是 skipped
//
// 变异开关（只给测试用，见 harness/intent.mjs 的 INTENT_MUTANT）：
//   SELFLOOP_INTENT_MUTANT=alwaysPass|dropSkipRecord node test/intent.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'harness', 'cmdloop.mjs')
const INTENT_CLI = join(ROOT, 'harness', 'intent.mjs')
const FINALIZE = join(ROOT, 'harness', 'finalize.js')
const ECHO_ADAPTER = join(ROOT, 'examples', 'command-echo.json')
const FIRE_RAY = join(ROOT, 'domains', 'vfx-render', 'adapters', 'fire-ray.json')

const tmp = (tag) => mkdtempSync(join(tmpdir(), `selfloop-intent-${tag}-`))
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const nodeDir = (out) => join(out, 'nodes')

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// 一份"填好了的" intent。criteria 用 echo 示例的两条指标（loss / size）。
function writeIntent(out, over = {}) {
  const doc = {
    understood: '把 size 从 12 压回 10，loss 别反弹',
    criteria: [
      { id: 'size', weight: 2, target: 10, why: '体积是你说的重点' },
      { id: 'loss', weight: 1, why: '次要点，别归零' },
    ],
    uncertain: ["'更硬'是指边缘锐利还是对比度更高？"],
    confirm: ['粗细优先还是亮度优先？'],
    confirmed: true,
    confirmedBy: 'user',
    confirmedAt: '2026-11-14T10:46:00+08:00',
    ...over,
  }
  mkdirSync(out, { recursive: true })
  const file = join(out, 'intent.json')
  writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')
  return { file, doc }
}

// 一次跑通的 run：③ 与 ⑥ 共用（省一次 1 秒的跑）
let okRun
function okRunOnce() {
  if (!okRun) {
    const out = tmp('ok')
    writeIntent(out)
    const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '12'])
    okRun = { r, out, best: existsSync(join(out, 'best.json')) ? readJson(join(out, 'best.json')) : null }
  }
  return okRun
}

const REPORT_LINE = /本次运行：(\d+) done \/ (\d+) skipped \/ (\d+) degraded/

// ---------------------------------------------------------------- ① 无 intent
test('① 没有 intent 文件 → 中文硬错 + 写出 intent.template.json（含 confirm 字段）', () => {
  const out = tmp('none')
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '6'])
  assert.equal(r.status, 1, `没有需求转译必须拒跑，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /需求转译闸/, '错误要自报家门（哪道闸拦的）')
  assert.match(r.out, /没有需求转译文件/, '要直接说缺的是什么')
  assert.match(r.out, /intent\.template\.json/, '要告诉用户模板写到哪')
  assert.match(r.out, /confirmed/, '要告诉用户"填完怎么确认"')
  assert.match(r.out, /--no-intent/, '要告诉用户"显式跳过"的开关是什么')
  const tplFile = join(out, 'intent.template.json')
  assert.ok(existsSync(tplFile), '模板必须真的落盘（不是只在错误里提一句）')
  const tpl = readJson(tplFile)
  assert.ok(Array.isArray(tpl.confirm), '模板要有 confirm 字段（待确认问题）')
  assert.ok(Array.isArray(tpl.criteria) && Array.isArray(tpl.uncertain), '模板要有 criteria / uncertain')
  assert.equal(tpl.confirmed, false, '模板默认未确认')
  assert.ok(!existsSync(join(out, 'best.json')), '闸拦下来时不许交出"看起来跑完了"的证据包')
  // 台帐也要留痕：哪一步被拦的
  const node = readJson(join(nodeDir(out), '01-intent.json'))
  assert.equal(node.node, 'intent')
  assert.equal(node.status, 'failed', '闸没过的这一步在台帐里是 failed，不是"没这回事"')
})

// ---------------------------------------------------------------- ② 未确认
test('② confirmed:false → 硬错，错误文本里原样列出 confirm[] 的每一条', () => {
  const out = tmp('unconfirmed')
  const q1 = "'更硬'是指边缘锐利还是对比度更高？"
  const q2 = '粗细优先还是亮度优先？'
  writeIntent(out, { confirmed: false, confirm: [q1, q2] })
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '6'])
  assert.equal(r.status, 1, `未确认必须拒跑，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /需求转译还没被确认/, '要说清是"没确认"而不是"没填"')
  assert.ok(r.out.includes(q1) && r.out.includes(q2), `要原样列出 confirm[]（要能看到用户该回答什么）：\n${r.out}`)
  assert.ok(!existsSync(join(out, 'best.json')), '未确认时不许开跑')
})

// ---------------------------------------------------------------- ③ 通过 + 覆盖真的生效
test('③ confirmed:true 且 id 合法 → 跑通；report 有汇总行；01-intent 是 done；判据真被覆盖', () => {
  const { r, out, best } = okRunOnce()
  assert.equal(r.status, 0, `确认过的需求转译必须能跑，实际 exit=${r.status}\n${r.out.slice(-2000)}`)
  assert.ok(best, 'best.json 必须存在')
  const md = readFileSync(join(out, 'report.md'), 'utf8')
  const m = REPORT_LINE.exec(md)
  assert.ok(m, `report.md 顶部要有"本次运行：N done / N skipped / N degraded"汇总行:\n${md.slice(0, 400)}`)
  const node = readJson(join(nodeDir(out), '01-intent.json'))
  assert.equal(node.node, 'intent', '第一个节点必须是 intent')
  assert.equal(node.seq, 1)
  assert.equal(node.status, 'done', '确认过的转译是 done')
  assert.equal(node.producer, 'agent', 'intent 是 agent 填的，不是引擎自己编的')
  assert.ok(node.decision.basis.some((s) => s.includes('confirmed=true')), '依据里要留"谁在哪一刻确认的"')
  // 覆盖必须落到判据上（只记账不改判据 = 没做事）
  const w = Object.fromEntries(best.metricsCfg.metrics.map((x) => [x.id, x.weight]))
  assert.equal(w.size, 2, `criteria 的 weight 要真落到判据上，实测 size=${w.size}`)
  assert.equal(w.loss, 1)
  assert.equal(best.target.effective.size, 10, 'criteria 的 target 要真覆盖目标值')
  // 落盘派生件：图上看得出"这次用的是改过的判据"
  assert.equal(best.target.intentOverrides.length, 1)
  assert.equal(best.target.intentOverrides[0].id, 'size')
})

// ---------------------------------------------------------------- ④ 未知 id
test('④ criteria 里给了 adapter 不存在的 id → 硬错（绝不静默忽略）', () => {
  const out = tmp('badid')
  writeIntent(out, { criteria: [{ id: 'covv', weight: 1, why: 'typo' }] })
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '6'])
  assert.equal(r.status, 1, `写错 id 必须拒跑（静默忽略 = 对着没人用的判据跑完一轮），实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /不认识的指标 id/)
  assert.match(r.out, /covv/, '要点名写错的那个 id')
  assert.match(r.out, /loss/, '要把 adapter 里真实的指标列出来（照着改）')
  assert.ok(!existsSync(join(out, 'best.json')), '不许产出证据包')
})

// ---------------------------------------------------------------- ⑤ 显式跳过
test('⑤ --no-intent → 跑通；01-intent 是 skipped 且 reason 含 --no-intent', () => {
  const out = tmp('skip')
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '10', '--no-intent'])
  assert.equal(r.status, 0, `--no-intent 是显式放行，该跑通，实际 exit=${r.status}\n${r.out.slice(-1500)}`)
  const node = readJson(join(nodeDir(out), '01-intent.json'))
  assert.equal(node.status, 'skipped', '--no-intent 在台帐里是 skipped，不是 done')
  assert.match(node.reason, /--no-intent/, '跳过必须写明原因（跳过要有名字）')
  assert.ok(node.decision.basis.some((s) => s.includes('--no-intent')), '台帐的依据里也要写清是哪一步被跳过')
  const m = REPORT_LINE.exec(readFileSync(join(out, 'report.md'), 'utf8'))
  assert.ok(m, 'report.md 要有汇总行')
  assert.equal(Number(m[2]), 1, `汇总行的 skipped 要含这条 —— 实测 ${m[0]}`)
})

// ---------------------------------------------------------------- ⑥ 台帐一致性
test('⑥ 台帐一致性：nodes/ 每个文件字段齐全、seq 连续；汇总行计数 == 实际条数', () => {
  const { out } = okRunOnce()
  const files = readdirSync(nodeDir(out)).filter((n) => n.endsWith('.json')).sort()
  assert.ok(files.length >= 6, `初版该覆盖 intent/target/stability/precheck/search/finalize，实际 ${files.length} 条：${files.join(',')}`)
  const ALLOWED = new Set(['done', 'skipped', 'degraded', 'failed'])
  const seen = []
  for (const f of files) {
    const n = readJson(join(nodeDir(out), f)) // 解析不了就是硬红
    for (const k of ['node', 'seq', 'status']) assert.ok(k in n, `${f} 缺字段 ${k}`)
    assert.ok(ALLOWED.has(n.status), `${f} 的 status=${n.status} 不在枚举里`)
    assert.equal(typeof n.node, 'string')
    assert.equal(typeof n.seq, 'number')
    assert.ok(Array.isArray(n.inputs) && Array.isArray(n.artifacts), `${f} 的 inputs/artifacts 要是数组`)
    assert.ok(n.decision && typeof n.decision.why === 'string' && Array.isArray(n.decision.basis), `${f} 的 decision{why,basis} 不完整`)
    assert.equal(typeof n.cost, 'object', `${f} 缺 cost`)
    assert.match(f, /^\d{2}-[a-z][a-z0-9_-]*\.json$/, `${f} 命名要 NN-<node>.json`)
    assert.equal(f.slice(0, 2), String(n.seq).padStart(2, '0'), `${f} 文件名前两位要等于 seq`)
    if (n.status !== 'done') assert.ok(n.reason, `${f} 是 ${n.status}，必须写 reason`)
    seen.push(n.seq)
  }
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'seq 要按文件名顺序递增')
  assert.deepEqual(seen, seen.map((_, i) => i + 1), `seq 要从 1 连续编号，实测 ${seen.join(',')}`)
  // 汇总行必须和目录里实际条数一致（不是另外算一个数）
  const md = readFileSync(join(out, 'report.md'), 'utf8')
  const m = REPORT_LINE.exec(md)
  assert.ok(m, 'report.md 要有汇总行')
  const nodes = readdirSync(nodeDir(out)).filter((n) => n.endsWith('.json')).map((n) => readJson(join(nodeDir(out), n)))
  const count = (s) => nodes.filter((n) => n.status === s).length
  assert.equal(Number(m[1]), count('done'), `汇总行 done=${m[1]} 与 nodes/ 里 done=${count('done')} 不等`)
  assert.equal(Number(m[2]), count('skipped'), `汇总行 skipped=${m[2]} 与 nodes/ 里 skipped=${count('skipped')} 不等`)
  assert.equal(Number(m[3]), count('degraded'), `汇总行 degraded=${m[3]} 与 nodes/ 里 degraded=${count('degraded')} 不等`)
})

// ---------------------------------------------------------------- ⑦ 弄坏能红 ×2
// 不是"再测一遍功能"，而是证明 ①/⑤ 的断言真的接在实现上：把实现弄坏，那两条必须塌。
test('⑦-1 弄坏能红：闸恒放行（SELFLOOP_INTENT_MUTANT=alwaysPass）→ ① 的硬错断言必塌', () => {
  const out = tmp('mut-pass')
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '10'], { SELFLOOP_INTENT_MUTANT: 'alwaysPass' })
  // ① 断言 exit 1 + 有模板；闸恒放行之后它必然 exit 0
  assert.equal(r.status, 0, `变异体该跑完（这正是"闸形同虚设"的危险），实际 exit=${r.status}\n${r.out.slice(-800)}`)
  assert.notEqual(r.status, 1, '① 的 assert.equal(r.status, 1) 在这份实现上不可能成立')
  assert.ok(!/需求转译闸/.test(r.out), '变异体下不该出现闸的硬错')
  // 但它照样"看起来跑完了"—— 这就是没有这道闸的时候证据包的样子：谁也看不出判据没人确认过
  assert.ok(existsSync(join(out, 'best.json')))
  const node = readJson(join(nodeDir(out), '01-intent.json'))
  assert.equal(node.status, 'degraded', '恒放行时至少要在台帐里承认这一步没做（degraded）')
})

test('⑦-2 弄坏能红：不记跳过（SELFLOOP_INTENT_MUTANT=dropSkipRecord）→ ⑤ 的台帐断言必塌', () => {
  const out = tmp('mut-drop')
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '10', '--no-intent'], { SELFLOOP_INTENT_MUTANT: 'dropSkipRecord' })
  assert.equal(r.status, 0, r.out.slice(-800))
  // ⑤ 断言"01-intent 是 skipped 且 reason 含 --no-intent"；记录被删掉之后这条必然红
  assert.ok(!existsSync(join(nodeDir(out), '01-intent.json')), '记录被删掉后不该有 01-intent.json')
  const files = readdirSync(nodeDir(out)).filter((n) => n.endsWith('.json'))
  assert.equal(files[0], '01-target.json', '跳过没留痕 → 台帐从 target 开始，"哪些被绕过"就查不到了')
})

// ---------------------------------------------------------------- ⑧ 截图链路的闸
test('⑧ 截图链路（intent.mjs gate --chain screenshot）：权重进派生 adapter；target 只记账（degraded）', () => {
  const out = tmp('shot')
  writeIntent(out, {
    understood: '火柱要更粗更硬',
    criteria: [
      { id: 'cov', weight: 0.6, target: 0.02, why: '你说的更粗' },
      { id: 'lapVar', weight: 0.2, why: '细节次要' },
    ],
  })
  const r = spawnSync(process.execPath, [INTENT_CLI, 'gate', '--out', out, '--adapter', FIRE_RAY, '--chain', 'screenshot'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `截图链路的闸该过，实际 exit=${r.status}\n${r.stdout}\n${r.stderr}`)
  const receipt = JSON.parse(r.stdout.trim().split(/\r?\n/).pop())
  assert.equal(receipt.status, 'degraded', 'criteria[].target 在截图链路不生效 → 记 degraded，不假装 done')
  assert.ok(receipt.effectiveAdapter, '有权重覆盖时必须产出派生 adapter')
  const eff = readJson(receipt.effectiveAdapter)
  const w = Object.fromEntries(eff.metrics.map((m) => [m.id, m.weight]))
  assert.equal(w.cov, 0.6, 'cov 的权重要被覆盖')
  assert.equal(w.lapVar, 0.2)
  assert.equal(w.tone, 0.3, '没提到的指标保持原权重')
  assert.equal(eff.metrics.length, 3, '指标条数不许变（只改权重）')
  const node = readJson(join(nodeDir(out), '01-intent.json'))
  assert.equal(node.status, 'degraded')
  assert.match(node.reason, /target 在截图链路不生效/)
  // 未知 id 同样硬错（截图链路没有另一套宽容规则）
  const out2 = tmp('shot-bad')
  writeIntent(out2, { criteria: [{ id: 'nope', weight: 1 }] })
  const r2 = spawnSync(process.execPath, [INTENT_CLI, 'gate', '--out', out2, '--adapter', FIRE_RAY, '--chain', 'screenshot'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(r2.status, 1)
  assert.match(r2.stderr, /不认识的指标 id/)
})

// ---------------------------------------------------------------- ⑨ 截图链路的台帐补全
test('⑨ finalize.js 补齐截图链路台帐：intent 之后 target/stability/precheck/search/finalize，汇总行对得上', () => {
  const out = tmp('shotfinal')
  // 先过闸（写 01-intent），再喂一份合成的 _run.json 让 finalize 补其余节点
  const gate = spawnSync(process.execPath, [INTENT_CLI, 'gate', '--out', out, '--adapter', FIRE_RAY, '--chain', 'screenshot', '--no-intent'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(gate.status, 0, gate.stderr)
  mkdirSync(join(out, 'logs'), { recursive: true })
  const h = (c) => c.repeat(64)
  const run = {
    meta: {
      command: 'pwsh -File harness/iter.ps1 -Adapter "x.json" -Out "' + out + '" -NoIntent',
      url: 'http://127.0.0.1:1/x', mirror: 'M', mirrorJson: 'M/vfx.json',
      effect: 'FireRay', block: 'fireBeamG1M1', seed: 7, t: 320, stepN: 16, stepMs: 20, w: 480, h: 270, tier: 'low',
      strategy: 'coordinate', stepRatio: 0.1, budget: 20, maxRounds: 8, maxStagnant: 2, thumbEvery: 2,
      whitelist: ['widthPx', 'distM'], baseSha256: h('a'), mirrorShaBefore: h('b'), mirrorShaAfter: h('a'),
      bodyShaBefore: h('c'), bodyShaAfter: h('c'), startedAt: '2026-11-14 10:00:00', elapsedSec: 9.5, msPerEval: 210,
      hiW: 1600, hiH: 900, hiTier: 'high', metricsJs: 'metrics2.js', toolDir: 'harness',
      metricIds: ['cov', 'lapVar', 'tone'], metricsJson: '[{"id":"cov","weight":0.35}]', scoreJson: '{"type":"l1"}',
      adapter: 'demo', adapterPath: 'x.json', adapterSchema: 'closed-loop-adapter/3', adapterIntentOrig: '',
      captureJs: 'capture.mjs', pageFile: 'index.html', freezeProtocol: 'noloop-step', clockMode: 'virtual', clockStepMs: 16,
      staticPort: 8171, cdpPort: 9222, profPrefix: 'prof_', profileRoot: 'P', root: 'R',
      targetSrc: 'adapter', targetModeNote: 'png -> t.png', paramsSrc: 'adapter', paramsRaw: 'list', activity: null,
      applyFormat: 'vfx-block', applyJs: 'apply.js', urlTemplate: 'index.html', urlSec: null,
      freezeVerify: 'strict', freezeVerified: true, selfCheck: true, configPath: 'vfx.json', pageQuery: '',
      protectPaths: ['P'], guardEnforced: true, guardBodyClient: '',
    },
    target: { kind: 'png', mode: 'png', srcFrom: 'adapter', spec: null, src: 't.png', png: 'shots/target.png', sha256: h('d'), metrics: { cov: 0.11, lapVar: 1200, tone: 0.2 } },
    startParams: { widthPx: 32, distM: 3.6 },
    startDist: 0.42,
    best: { params: { widthPx: 28, distM: 4 }, dist: 0.11, seq: 9, png: 'shots/best.png' },
    dead: ['zzz'], alive: ['widthPx', 'distM'],
    precheck: {
      rows: [
        { param: 'widthPx', start: 32, perturbed: 35.2, dist: 0.39, dDelta: 0.03, outputSame: false, verdict: 'alive', seq: 3 },
        { param: 'distM', start: 3.6, perturbed: 3.96, dist: 0.4, dDelta: 0.02, outputSame: false, verdict: 'alive', seq: 4 },
        { param: 'zzz', start: 1, perturbed: 1.1, dist: 0.42, dDelta: 0, outputSame: true, verdict: 'dead', seq: 5 },
      ],
    },
    rounds: [
      { round: 1, cands: [{ note: 'none', seq: 6 }, { note: 'widthPx-', seq: 7 }], winner: 7 },
      { round: 2, cands: [{ note: 'none', seq: 8 }], winner: 9 },
    ],
    evals: [
      { round: 0, seq: 1, id: 'e001', note: 'start', params: { widthPx: 32, distM: 3.6 }, png: 'p1.png', dist: 0.42, dprof: 0.1, dlap: 0.2, dwarm: 0.1, pen: 0, lapVar: 1200, warmFrac: 0.2, mean: 90, covCore: 0.2, mvals: { cov: 0.11, lapVar: 1200, tone: 0.2 }, parts: { cov: 0.1, lapVar: 0.2, tone: 0.1 } },
      { round: 1, seq: 7, id: 'r1_s7', note: 'widthPx-', params: { widthPx: 28.8, distM: 3.6 }, png: 'p7.png', dist: 0.2, dprof: 0.05, dlap: 0.1, dwarm: 0.05, pen: 0, lapVar: 1300, warmFrac: 0.25, mean: 95, covCore: 0.25, mvals: { cov: 0.12, lapVar: 1300, tone: 0.25 }, parts: { cov: 0.05, lapVar: 0.1, tone: 0.05 } },
      { round: 2, seq: 9, id: 'r2_s9', note: 'distM+', params: { widthPx: 28.8, distM: 3.96 }, png: 'p9.png', dist: 0.11, dprof: 0.02, dlap: 0.05, dwarm: 0.04, pen: 0, lapVar: 1400, warmFrac: 0.28, mean: 99, covCore: 0.3, mvals: { cov: 0.13, lapVar: 1400, tone: 0.28 }, parts: { cov: 0.02, lapVar: 0.05, tone: 0.04 } },
    ],
    usage: { used: 9, target: 1, start: 1, precheck: 3, search: 4, cache: 0, hi: 0 },
    stop: { reason: 'stagnant', detail: '连续 2 轮没有改进', used: 9, budget: 20 },
    thumbs: ['shots/thumbs/t1.png'],
    hiPng: '',
  }
  const runFile = join(out, 'logs', '_run.json')
  writeFileSync(runFile, JSON.stringify(run, null, 2), 'utf8')
  const fin = spawnSync(process.execPath, [FINALIZE, runFile, out], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(fin.status, 0, `finalize 该跑通：${fin.stdout}\n${fin.stderr}`)
  const names = readdirSync(nodeDir(out)).filter((n) => n.endsWith('.json')).sort()
  assert.deepEqual(
    names,
    ['01-intent.json', '02-target.json', '03-stability.json', '04-precheck.json', '05-search.json', '06-finalize.json'],
    '截图链路也要有完整台帐（intent 由闸写，其余由 finalize 补）',
  )
  const stab = readJson(join(nodeDir(out), '03-stability.json'))
  assert.equal(stab.status, 'skipped', '截图链路没有稳定性闸 → skipped（跳过要有记录）')
  assert.match(stab.reason, /没有观测稳定性闸/)
  const md = readFileSync(join(out, 'report.md'), 'utf8')
  const m = REPORT_LINE.exec(md)
  assert.ok(m, '截图链路的 report.md 也要有汇总行')
  const nodes = names.map((n) => readJson(join(nodeDir(out), n)))
  assert.equal(Number(m[1]), nodes.filter((n) => n.status === 'done').length)
  assert.equal(Number(m[2]), nodes.filter((n) => n.status === 'skipped').length, '跳过计数要等于文件条数')
  const best = readJson(join(out, 'best.json'))
  assert.equal(best.nodes.counts.total, 6, 'best.json 里也要能机器读到台帐索引')
  assert.equal(best.nodes.counts.skipped, 2, '跳过的是 intent（-NoIntent）与 stability（截图链路没这道闸）')
  assert.deepEqual(
    best.nodes.items.map((n) => n.node),
    ['intent', 'target', 'stability', 'precheck', 'search', 'finalize'],
  )
})

// ---------------------------------------------------------------- 附：两个入口都接上了闸
test('⑩ 两个入口都接了闸：iter.ps1 有 -Intent/-NoIntent，且在活性预检之前调用 intent.mjs', () => {
  const src = readFileSync(join(ROOT, 'harness', 'iter.ps1'), 'utf8')
  assert.match(src, /\[string\]\$Intent = '',/, 'iter.ps1 要有 -Intent 参数')
  assert.match(src, /\[switch\]\$NoIntent/, 'iter.ps1 要有 -NoIntent 开关')
  assert.match(src, /'intent\.mjs'\).*'gate'/s, 'iter.ps1 要调 intent.mjs 的 gate（闸只有一份实现）')
  const iGate = src.indexOf("'intent.mjs'")
  const iPrecheck = src.indexOf("'[precheck] 每个参数改一档")
  assert.ok(iGate > 0 && iPrecheck > iGate, `闸必须排在活性预检之前（gate@${iGate}，precheck@${iPrecheck}）`)
  assert.ok(src.indexOf("'intent.mjs'") < src.indexOf('function Invoke-Render'), '闸要排在第一次渲染之前')
  // 语法也能过一遍（PS 解析器不执行）
  const ps = spawnSync('pwsh', ['-NoProfile', '-Command', `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${join(ROOT, 'harness', 'iter.ps1').replace(/'/g, "''")}',[ref]$t,[ref]$e); if($e -and $e.Count){$e|%{$_.Message};exit 1}else{exit 0}`], { encoding: 'utf8' })
  if (ps.error) return // 没有 pwsh 的机器上跳过（不影响闸本身的判据）
  assert.equal(ps.status, 0, `iter.ps1 语法必须能过 PowerShell 解析器：${ps.stdout}${ps.stderr}`)
})
