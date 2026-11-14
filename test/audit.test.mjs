// 复算历史结论（audit，0.8.0）自测：纯文件、不跑闭环、不碰浏览器/端口。
//
// 覆盖（«» 里对应用户要求的测试编号）：
//   «1» 更严的 intent：当时 best（更近但违规）今天不合格 → exit 1 + 给出新的最优（被判违规之外那个）
//   «2» 更松的 intent：best 仍合格 → exit 0（--strict 时"有更优点"也算 1）
//   «3» 空 / 缺 outputs/ → exit 2 + 中文说明
//   «4» --json 可 parse 且字段齐（total / nowInvalid / bestOk / suggestedBest / reasons）
//   «5» 截图链路 run（schema=t3-iter/2、无 outputs/）→ exit 2 + "暂不支持截图链路"
//
// 合成 run 的现场（不需要真跑搜索 —— 复算读的就是证据包，造一份合法的证据包最省事）：
//   e001 alpha=1 d=0.5 guard=1   ← 合格
//   e002 alpha=2 d=0.1 guard=0   ← 更近但违规：**当时的 best**（当时没有这条门禁）
//   e003 alpha=3 d=0.3 guard=1   ← 合格，且是"现在合格"里最靠前的
//   e004 alpha=4 d=0.05 guard=0  ← 当时被门禁挡掉的更优点（更松的 intent 下会合格）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'harness', 'audit.mjs')

const tmp = (tag) => mkdtempSync(join(tmpdir(), `selfloop-audit-${tag}-`))

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// 一份"当时的证据包"：4 个评估点 + outputs/ 原文。dist / guard / loss 全是手写的，最小但合法。
const POINTS = [
  { seq: 1, note: 'start', alpha: 1, dist: 0.5, guard: 1 },
  { seq: 2, note: 'search', alpha: 2, dist: 0.1, guard: 0 },
  { seq: 3, note: 'search', alpha: 3, dist: 0.3, guard: 1 },
  { seq: 4, note: 'search', alpha: 4, dist: 0.05, guard: 0 },
]

function makeRun(tag, opts = {}) {
  const dir = tmp(tag)
  const runDir = join(dir, 'run')
  mkdirSync(join(runDir, 'outputs'), { recursive: true })
  const curve = POINTS.map((p) => ({
    round: p.note === 'start' ? 0 : 1,
    seq: p.seq,
    id: p.note,
    note: p.note,
    params: { alpha: p.alpha },
    dist: p.dist,
    output: join('outputs', 'e' + String(p.seq).padStart(3, '0') + '.json'),
    // 当时没有门禁（或门禁更窄）：这些字段只是账，复算不看它
    inv: true,
    invFail: [],
  }))
  const best = {
    schema: 'cmd-iter/1',
    hash: 'synthetic',
    metricIds: ['loss'],
    metricsCfg: { metrics: [{ id: 'loss', field: 'loss', norm: { mode: 'abs', scale: 1 }, weight: 1 }], score: { type: 'l1', penalties: [] } },
    target: { kind: 'params', spec: { alpha: 0 }, seq: null, effective: { loss: 0 } },
    observe: { type: 'command', cmd: 'node ./probe.mjs', cwd: '.', parse: 'json', timeoutMs: 30000 },
    seed: 12345,
    stepRatio: 0.1,
    budget: 20,
    maxRounds: 20,
    maxStagnant: 2,
    strategy: 'coordinate',
    whitelist: ['alpha'],
    dead: [],
    alive: ['alpha'],
    startParams: { alpha: 1 },
    bestParams: { alpha: 2 },
    bestDist: 0.1,
    dropAbs: 0.4,
    dropPct: 80,
    stop: { reason: 'stagnant', detail: '连续 2 轮没有改进' },
    evaluations: { used: 4 },
    curve,
    precheck: { rows: [] },
    rounds: [],
    meta: { outDir: runDir, command: 'node harness/cmdloop.mjs --adapter x --out y' },
  }
  writeFileSync(join(runDir, 'best.json'), JSON.stringify(best, null, 2), 'utf8')
  writeFileSync(
    join(runDir, 'curve.csv'),
    ['round,eval_seq,id,note,alpha,dist,pen,inv,m:loss,output']
      .concat(curve.map((c) => `${c.round},${c.seq},${c.id},${c.note},${c.params.alpha},${c.dist},0,1,${1 - c.dist},${c.output}`))
      .join('\n') + '\n',
    'utf8',
  )
  for (const p of POINTS) {
    const doc = {
      seq: p.seq,
      id: p.note,
      round: 1,
      note: p.note,
      cmd: 'node ./probe.mjs',
      params: { alpha: p.alpha },
      metrics: { loss: 1 - p.dist },
      dist: p.dist,
      invariants: { ok: true, failed: [] },
      // 原始 stdout：复算按 observe.parse=json 重新解析出字段表（guard 就在这儿，不在 metrics 里）
      stdout: JSON.stringify({ loss: Number((1 - p.dist).toFixed(6)), guard: p.guard, alpha: p.alpha }) + '\n',
      stderr: '',
    }
    writeFileSync(join(runDir, 'outputs', 'e' + String(p.seq).padStart(3, '0') + '.json'), JSON.stringify(doc, null, 2), 'utf8')
  }
  if (opts.noOutputs) {
    // 删掉 outputs/（模拟"旧 run 的输出被清掉了"）
    const rm = spawnSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(join(runDir, 'outputs'))},{recursive:true,force:true})`], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(rm.status, 0, rm.stderr)
  }
  return { dir, runDir }
}

function writeIntent(dir, invariants, tag = 'strict') {
  const doc = {
    version: 2,
    restate: '把 loss 压到目标，同时不许选出废解',
    anchors: [{ kind: 'text', ref: '具体参照物', why: '量级参照' }],
    criteria: [],
    notWanted: ['不要含糊通过'],
    freeVsFixed: { fixed: ['目标'], free: ['步长'] },
    howWeVerify: { human: true, metrics: true },
    uncertain: [],
    confirm: [],
    confirmed: true,
    invariants,
  }
  const file = join(dir, `intent-${tag}.json`)
  writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')
  return file
}

const TIGHT = [{ id: 'no_dead_band', check: { field: 'guard', op: '==', value: 1 }, why: 'guard=0 的解虽然更近，但不可用' }]
const LOOSE = [{ id: 'guard_any', check: { field: 'guard', op: '>=', value: 0 }, why: '这次只要求 guard 是个数（更松）' }]

// ---------------------------------------------------------------- «1» 更严 → exit 1 + 新最优
test('① 更严的 intent：当时的 best 今天不合格 → exit 1，并给出新的最优（违规点之外那个）', () => {
  const { dir, runDir } = makeRun('tight')
  const intent = writeIntent(dir, TIGHT)
  const r = runCli([runDir, '--intent', intent])
  assert.equal(r.status, 1, `best 今天不合格必须 exit 1，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /现在不合格：2 \/ 4/, '应有两个点今天不合格（e002 和 e004）')
  assert.match(r.out, /✗ 按今天的标准不合格/, '要明确写出当时的 best 今天不合格')
  assert.match(r.out, /no_dead_band/, '要指出违反的是哪条不变量')
  // 新的最优：合格点里距离最小的是 e003（d=0.3）；e001 d=0.5 更差
  assert.match(r.out, /新的最优.*seq=3 d=0\.3000/, `新的最优应是 seq=3：\n${r.out}`)
  assert.match(r.out, /alpha=3/, '要给出新最优的参数')
  // e002（原 best）与 e004 都是违规点，绝不能出现在"新的最优"里
  const suggestedLine = /新的最优[^\n]*/.exec(r.out)[0]
  assert.doesNotMatch(suggestedLine, /seq=2|seq=4/, `新最优不能是被判违规的点：${suggestedLine}`)
})

// ---------------------------------------------------------------- «2» 更松 → exit 0（strict 有更优点 = 1）
test('② 更松的 intent：best 仍合格 → exit 0；--strict 时"有更优点"也算 1', () => {
  const { dir, runDir } = makeRun('loose')
  const intent = writeIntent(dir, LOOSE)
  const r = runCli([runDir, '--intent', intent])
  assert.equal(r.status, 0, `best 仍合格应 exit 0，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /现在不合格：0 \/ 4/)
  assert.match(r.out, /✓ 按今天的标准仍合格/)
  // 更松的门禁下 e004（d=0.05）合格了，比当时的 best（d=0.1）更优 —— 默认不算错，--strict 算
  const s = runCli([runDir, '--intent', intent, '--strict'])
  assert.equal(s.status, 1, `--strict 下"有更优点"必须 exit 1，实际 exit=${s.status}\n${s.out}`)
  assert.match(s.out, /更优的合格点：seq=4/)
  assert.match(s.out, /--strict 下这算不合格/)
})

// ---------------------------------------------------------------- «3» 缺 outputs → exit 2 + 中文
test('③ 缺 outputs/ → exit 2 且中文说明（不拿旧结论证明旧结论）', () => {
  const { dir, runDir } = makeRun('nooutputs', { noOutputs: true })
  const intent = writeIntent(dir, TIGHT)
  const r = runCli([runDir, '--intent', intent])
  assert.equal(r.status, 2, `缺 outputs/ 必须 exit 2，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /没有 outputs\//)
  assert.match(r.out, /原始 stdout/, '要说清为什么需要 outputs/')
  // 空 run 目录（连 best.json 都没有）也是 2，且给中文
  const empty = tmp('emptyrun')
  const e2 = runCli([empty, '--intent', intent])
  assert.equal(e2.status, 2, `空 run 目录必须 exit 2，实际 exit=${e2.status}\n${e2.out}`)
  assert.match(e2.out, /找不到 .*best\.json/)
  assert.match(e2.out, /[\u4e00-\u9fa5]/, '错误必须是中文')
})

// ---------------------------------------------------------------- «4» --json 可 parse、字段齐
test('④ --json 输出可 parse，且 total / nowInvalid / bestOk / suggestedBest / reasons 都在', () => {
  const { dir, runDir } = makeRun('json')
  const intent = writeIntent(dir, TIGHT)
  const r = runCli([runDir, '--intent', intent, '--json'])
  assert.equal(r.status, 1, r.out)
  const doc = JSON.parse(r.stdout)
  assert.equal(doc.total, 4)
  assert.equal(doc.nowInvalid, 2)
  assert.equal(doc.bestOk, false)
  assert.ok(doc.suggestedBest && typeof doc.suggestedBest === 'object', 'suggestedBest 要在')
  assert.equal(doc.suggestedBest.seq, 3)
  assert.equal(doc.suggestedBest.params.alpha, 3)
  assert.ok(Array.isArray(doc.reasons) && doc.reasons.length === 2, `reasons 要列出每个不合格点：${JSON.stringify(doc.reasons)}`)
  assert.ok(doc.reasons.every((s) => /no_dead_band/.test(s)), 'reasons 要点名违反的不变量')
  assert.equal(doc.exitCode, 1)
  assert.equal(doc.chain, 'command')
})

// ---------------------------------------------------------------- «5» 截图链路 → exit 2 暂不支持
test('⑤ 截图链路的 run（无 outputs/、schema 不是 cmd-iter/1）→ exit 2 且提示"暂不支持截图链路"', () => {
  const dir = tmp('shot')
  const runDir = join(dir, 'run')
  mkdirSync(runDir, { recursive: true })
  // finalize.js 写的就是这个形状：有 best.json / curve.csv，但没有 outputs/ 与字段表
  writeFileSync(
    join(runDir, 'best.json'),
    JSON.stringify({ schema: 't3-iter/2', hash: 'x', bestParams: { alpha: 1 }, bestDist: 0.1, evals: [] }, null, 2),
    'utf8',
  )
  writeFileSync(join(runDir, 'curve.csv'), 'round,eval_seq,dist\n0,1,0.1\n', 'utf8')
  const intent = writeIntent(dir, TIGHT)
  const r = runCli([runDir, '--intent', intent])
  assert.equal(r.status, 2, `截图链路必须 exit 2，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /暂不支持截图链路/)
  assert.match(r.out, /命令链路/, '要指向唯一支持的那条链路')
})
