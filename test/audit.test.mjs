// 复算历史结论（audit，0.8.0）自测：纯文件、不跑闭环、不碰浏览器/端口。
//
// 覆盖（«» 里对应用户要求的测试编号）：
//   «1» 更严的 intent：当时 best（更近但违规）今天不合格 → exit 1 + 给出新的最优（被判违规之外那个）
//   «2» 更松的 intent：best 仍合格 → exit 0（--strict 时"有更优点"也算 1）
//   «3» 空 / 缺 outputs/ → exit 2 + 中文说明
//   «4» --json 可 parse 且字段齐（total / nowInvalid / bestOk / suggestedBest / reasons）
//   «5» 截图链路 run（schema=t3-iter/2、无 outputs/）→ exit 2 + "暂不支持截图链路"
//   «6» --dir 批量：两个 run（一个好一个坏）→ 逐 run 两行 + 总表两行 + exit 1
//   «7» 全不可判定 → exit 2 且说清"证据包坏了"（不是 1）
//   «8» 截断输出（capped:true）→ 该点 undecidable、不计入不合格；同一份证据去掉标记就会判成不合格
//   «9» 弄坏能红：「把不可判定判成不合格」→ «7» 的 exit 2 断言必塌
//   «10» 弄坏能红：「不认 capped 标记」→ «8» 的"判不了"断言必塌
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

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// 一份"当时的证据包"：4 个评估点 + outputs/ 原文。dist / guard / loss 全是手写的，最小但合法。
const POINTS = [
  { seq: 1, note: 'start', alpha: 1, dist: 0.5, guard: 1 },
  { seq: 2, note: 'search', alpha: 2, dist: 0.1, guard: 0 },
  { seq: 3, note: 'search', alpha: 3, dist: 0.3, guard: 1 },
  { seq: 4, note: 'search', alpha: 4, dist: 0.05, guard: 0 },
]
// 全合格的一组：--dir 的"好 run"用它（TIGHT 下 best 仍合格 → exit 0）
const GOOD_POINTS = [
  { seq: 1, note: 'start', alpha: 1, dist: 0.5, guard: 1 },
  { seq: 2, note: 'search', alpha: 2, dist: 0.1, guard: 1 },
  { seq: 3, note: 'search', alpha: 3, dist: 0.3, guard: 1 },
  { seq: 4, note: 'search', alpha: 4, dist: 0.2, guard: 1 },
]
// 一个"本该不合格"的点 + 它的输出被截断：判不了 ≠ 不合格
const CAPPED_ONE_POINTS = [
  { seq: 1, note: 'start', alpha: 1, dist: 0.5, guard: 1 },
  { seq: 2, note: 'search', alpha: 2, dist: 0.1, guard: 1 },
  { seq: 3, note: 'search', alpha: 3, dist: 0.3, guard: 0 },
  { seq: 4, note: 'search', alpha: 4, dist: 0.2, guard: 1 },
]

// 在指定目录造一份 run（--dir 批量要用固定布局：<root>/<run名>/）
function makeRunAt(runDir, points = POINTS, opts = {}) {
  mkdirSync(join(runDir, 'outputs'), { recursive: true })
  const curve = points.map((p) => ({
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
  // 当时的 best 默认是 seq=2（当时没有门禁，它更近所以赢了）—— 复算要能认出"当时那个点"
  const bestPoint = points.find((p) => p.seq === (opts.bestSeq || 2)) || points[0]
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
    bestParams: { alpha: bestPoint.alpha },
    bestDist: bestPoint.dist,
    dropAbs: 0.4,
    dropPct: 80,
    stop: { reason: 'stagnant', detail: '连续 2 轮没有改进' },
    evaluations: { used: points.length },
    curve,
    precheck: { rows: [] },
    rounds: [],
    meta: { outDir: runDir, command: 'node harness/cmdloop.mjs --adapter x --out y', outputCapBytes: 4096 },
  }
  writeFileSync(join(runDir, 'best.json'), JSON.stringify(best, null, 2), 'utf8')
  writeFileSync(
    join(runDir, 'curve.csv'),
    ['round,eval_seq,id,note,alpha,dist,pen,inv,m:loss,output']
      .concat(curve.map((c) => `${c.round},${c.seq},${c.id},${c.note},${c.params.alpha},${c.dist},0,1,${1 - c.dist},${c.output}`))
      .join('\n') + '\n',
    'utf8',
  )
  const cappedSeqs = opts.allCapped ? points.map((p) => p.seq) : opts.cappedSeqs || []
  for (const p of points) {
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
    if (cappedSeqs.includes(p.seq)) {
      // 真实证据包里 capped 是由 capOutputDoc 打的（stdout 超 4KB 被截）。
      // 这里手写同一个标记，是为了把"带标记"和"不带标记"的同一份证据放在一起比 —— 差别只能是它。
      doc.capped = true
      doc.truncated = true
    }
    writeFileSync(join(runDir, 'outputs', 'e' + String(p.seq).padStart(3, '0') + '.json'), JSON.stringify(doc, null, 2), 'utf8')
  }
  if (opts.noOutputs) {
    // 删掉 outputs/（模拟"旧 run 的输出被清掉了"）
    const rm = spawnSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(join(runDir, 'outputs'))},{recursive:true,force:true})`], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(rm.status, 0, rm.stderr)
  }
  return runDir
}

function makeRun(tag, opts = {}) {
  const dir = tmp(tag)
  const runDir = join(dir, 'run')
  makeRunAt(runDir, opts.points || POINTS, opts)
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

// ---------------------------------------------------------------- «6» --dir 批量
test('⑥ --dir 批量：一个好 run + 一个坏 run（+ 一个不是 run 的目录）→ 逐 run 两行、总表、exit 1', () => {
  const dir = tmp('batch')
  const root = join(dir, 'runs')
  makeRunAt(join(root, 'run-good'), GOOD_POINTS)
  makeRunAt(join(root, 'run-bad'), POINTS)
  mkdirSync(join(root, 'not-a-run'), { recursive: true }) // 放错了的目录：整批不许因为这一条就断
  const intent = writeIntent(dir, TIGHT)
  const r = runCli(['--dir', root, '--intent', intent])
  assert.equal(r.status, 1, `一个不合格就 exit 1，实际 exit=${r.status}\n${r.out}`)
  // 逐 run 一行（名字 / 点数 / 不合格 / best）
  assert.match(r.out, /run-good：4 个点 \/ 不合格 0 \/ 不可判定 0 \/ best 合格 \/ exit 0/, r.out)
  assert.match(r.out, /run-bad：4 个点 \/ 不合格 2 \/ 不可判定 0 \/ best 不合格 \/ exit 1/, r.out)
  assert.match(r.out, /not-a-run：.*best 跑不起来 \/ exit 2/, '不是 run 的目录要单列"跑不起来"，不许让整批断掉')
  // 总表：表头 + 每个 run 一行
  assert.match(r.out, /── 总表 ──/)
  assert.match(r.out, /\[audit\] run\s+点数\s+不合格\s+不可判定\s+best\s+exit/, '总表要有列头（名字/点数/不合格/不可判定/best/exit）')
  const tableRows = r.out.split('\n').filter((l) => /^\[audit\] (run-good|run-bad|not-a-run)\s+/.test(l))
  assert.equal(tableRows.length, 3, `总表要有 3 行（每个 run 一行）：\n${r.out}`)
  assert.match(r.out, /合计 3 个 run：合格 1 \/ 不合格 1 \/ 证据坏了 1 \/ best 判不了 0/)
  assert.match(r.out, /证据包坏了.*not-a-run/, '坏的证据包要点名')
  // 机器读的那一份
  const j = runCli(['--dir', root, '--intent', intent, '--json'])
  assert.equal(j.status, 1)
  const doc = JSON.parse(j.stdout)
  assert.equal(doc.mode, 'dir')
  assert.equal(doc.runs.length, 3)
  assert.deepEqual(doc.totals, { runs: 3, ok: 1, failed: 1, broken: 1, undecidableBest: 0 })
  assert.equal(doc.runs.find((x) => x.name === 'run-bad').nowInvalid, 2)
  assert.equal(doc.exitCode, 1)
})

// ---------------------------------------------------------------- «7» 全不可判定 → exit 2
test('⑦ 某个 run 的所有点都不可判定 → exit 2，且说清"证据包坏了"（不是 1）', () => {
  const { dir, runDir } = makeRun('all-undecidable', { allCapped: true })
  const intent = writeIntent(dir, TIGHT)
  const r = runCli([runDir, '--intent', intent])
  assert.equal(r.status, 2, `全部判不了必须 exit 2（不是 1：判不了不是不合格），实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /现在不合格：0 \/ 4/, '判不了的不能进不合格数')
  assert.match(r.out, /另有 4 个不可判定/)
  assert.match(r.out, /全部不可判定/)
  assert.match(r.out, /证据包坏了/)
  const j = runCli([runDir, '--intent', intent, '--json'])
  assert.equal(j.status, 2)
  const doc = JSON.parse(j.stdout)
  assert.equal(doc.undecidable, 4)
  assert.equal(doc.nowInvalid, 0, '--json 里也不许把判不了的算成不合格')
  assert.equal(doc.allUndecidable, true)
  assert.equal(doc.bestStatus, 'undecidable')
  assert.equal(doc.exitCode, 2)
  assert.equal(doc.reasons.length, 0)
  assert.equal(doc.undecidableReasons.length, 4)
})

// ---------------------------------------------------------------- «8» capped → undecidable、不算不合格
test('⑧ 截断输出（capped:true）→ 该点 undecidable 且不计入不合格；去掉这个标记同一份证据就会判成不合格', async () => {
  // 先钉住"标记是 cmdlib 打的"：超 4KB 的原始输出必须带 capped:true（不然 audit 那边等于没接上）
  const { capOutputDoc, OUTPUT_CAP_BYTES } = await import('../harness/cmdlib.mjs')
  const big = capOutputDoc({ stdout: 'x'.repeat(OUTPUT_CAP_BYTES * 2), stderr: '' })
  assert.equal(big.truncated, true)
  assert.match(big.text, /"capped": true/, '截断过的输出必须打 capped:true（audit 靠它判"没法复算"）')
  const small = capOutputDoc({ stdout: 'x', stderr: '' })
  assert.equal(small.truncated, false)
  assert.doesNotMatch(small.text, /"capped"/, '没截断的不许乱打标记')

  // 同一份证据的两份拷贝：区别只有一个点上有 capped:true
  const dir = tmp('capped')
  const plain = makeRunAt(join(dir, 'plain'), CAPPED_ONE_POINTS)
  const cut = makeRunAt(join(dir, 'cut'), CAPPED_ONE_POINTS, { cappedSeqs: [3] })
  const intent = writeIntent(dir, TIGHT)
  // 参照：没有 capped 时，seq=3 那个点（guard=0）今天判不合格（best 仍合格，所以整体 exit 0）
  const base = runCli([plain, '--intent', intent])
  assert.equal(base.status, 0, base.out)
  assert.match(base.out, /现在不合格：1 \/ 4/)
  assert.match(base.out, /- seq=3/)
  const baseDoc = JSON.parse(runCli([plain, '--intent', intent, '--json']).stdout)
  assert.equal(baseDoc.nowInvalid, 1)
  assert.equal(baseDoc.undecidable, 0)
  assert.equal(baseDoc.points.find((p) => p.seq === 3).status, 'fail')
  // 打上 capped 之后：同一点变成"判不了"，**不进不合格数**（差别只来自那个标记）
  const r = runCli([cut, '--intent', intent])
  assert.match(r.out, /现在不合格：0 \/ 4（另有 1 个不可判定/, r.out)
  assert.match(r.out, /~ seq=3 .*原始输出被截断/, `要说明是哪份证据被截断：\n${r.out}`)
  assert.doesNotMatch(r.out, /- seq=3 /, '截断的点不许出现在"不合格"清单里')
  const doc = JSON.parse(runCli([cut, '--intent', intent, '--json']).stdout)
  assert.equal(doc.undecidable, 1)
  assert.equal(doc.nowInvalid, 0)
  assert.equal(doc.bestStatus, 'ok')
  assert.equal(doc.reasons.length, 0)
  assert.match(doc.undecidableReasons[0], /原始输出被截断.*字段型不变量无法复算/)
  assert.equal(doc.points.find((p) => p.seq === 3).status, 'undecidable')
})

// ---------------------------------------------------------------- «9»«10» 弄坏能红 ×2
// 这两条不是"再测一遍功能"，而是**验证 ⑦⑧ 的断言真有牙**：用变异体把实现弄坏，断言必须塌。
test('⑨ 弄坏能红：把"不可判定"判成"不合格"（SELFLOOP_AUDIT_MUTANT=undecidableAsInvalid）→ ⑦ 的 exit 2 断言必塌', () => {
  const { dir, runDir } = makeRun('all-undecidable-mut', { allCapped: true })
  const intent = writeIntent(dir, TIGHT)
  const r = runCli([runDir, '--intent', intent], { SELFLOOP_AUDIT_MUTANT: 'undecidableAsInvalid' })
  // ⑦ 断言的是 exit 2 + "现在不合格：0 / 4"；变异体把判不了的算成不合格之后，这两条都不可能成立
  assert.equal(r.status, 1, `变异体下会把判不了的算成不合格 → exit 1，实际 exit=${r.status}\n${r.out}`)
  assert.notEqual(r.status, 2, '⑦ 的 assert.equal(r.status, 2) 在这份实现上不可能成立')
  assert.match(r.out, /现在不合格：4 \/ 4/)
  assert.doesNotMatch(r.out, /全部不可判定/, '变异体下不会有"全部不可判定"这个结论')
})

test('⑩ 弄坏能红：不认 capped 标记（SELFLOOP_AUDIT_MUTANT=ignoreCapped）→ ⑧ 的"判不了"断言必塌', () => {
  const dir = tmp('capped-mut')
  const cut = makeRunAt(join(dir, 'cut'), CAPPED_ONE_POINTS, { cappedSeqs: [3] })
  const intent = writeIntent(dir, TIGHT)
  const r = runCli([cut, '--intent', intent, '--json'], { SELFLOOP_AUDIT_MUTANT: 'ignoreCapped' })
  const doc = JSON.parse(r.stdout)
  // ⑧ 断言的是 undecidable===1 / nowInvalid===0；不认标记之后 seq=3 会被照常判成不合格
  assert.equal(doc.undecidable, 0, '⑧ 的 assert.equal(doc.undecidable, 1) 在这份实现上不可能成立')
  assert.equal(doc.nowInvalid, 1, '拿半份原文照复算：那个点会被判成不合格')
  assert.equal(doc.points.find((p) => p.seq === 3).status, 'fail')
  assert.doesNotMatch(r.out, /原始输出被截断/, '不认标记就不会给出"被截断"的解释')
})

