// 调研节点（research）自测：不碰浏览器、不开端口。
//
// 这一版要钉住的东西只有一件：**"调研"到底有没有改变这次搜索**。
// 所以每条用例都在问同一个问题："引擎凭什么说它变了？" —— 答案必须是**引擎自己比出来的 changed**
// （对比应用 research 之前/之后的判据与起点），而不是文件里自报的字段。
//
// 覆盖（任务书要求的 7 条 + 指纹 1 条 + 弄坏能红 2 条）：
//   ① 完整 research（1 图 + 1 doc + 1 criteria + 1 start）→ done；report.md 有调研段；changed 恰好 2 项；
//      并且权重与起点**真的落到了这次搜索上**（不是只记了个账）
//   ② findings[].kind=image 指向不存在的文件 → 中文硬错（图不在 = 没有参照物），不产出 best.json
//   ③ extracted[].apply=criteria 但 id 不在 adapter 指标里 → 硬错（绝不静默忽略）
//   ④ extracted[].apply=start 但 name 不在参数白名单里 → 硬错
//   ⑤ 产物给了但 changed 为空（weight/start 都设成原值）→ 节点 degraded，reason 含"装饰性调研"
//   ⑥ 没有 research.json → 节点 skipped + 终端 warn 一行，跑通（不拒跑），report 里也写 skipped
//   ⑦ queries: [] 且没写 note → 硬错（没搜还不写为什么）
//   ⑧ research 的内容进 run 指纹：同内容跨目录同 hash；换一条 query 就换 hash
//   ⑨ 弄坏能红 ×2：把"引擎自己算 changed"换成"信文件自报" → ⑤ 塌；把 degraded 记成 done → ⑤ 塌
//
// 变异开关（只给测试用，见 harness/research.mjs 的 RESEARCH_MUTANT）：
//   SELFLOOP_RESEARCH_MUTANT=trustSelfReportedChanged|degradedAsDone node test/research.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'harness', 'cmdloop.mjs')
const ECHO_ADAPTER = join(ROOT, 'examples', 'command-echo.json')
const RESEARCH_SUMMARY = 'research.summary.json'

const tmp = (tag) => mkdtempSync(join(tmpdir(), `selfloop-research-${tag}-`))
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const nodeDir = (out) => join(out, 'nodes')
const readReport = (out) => readFileSync(join(out, 'report.md'), 'utf8')
const researchNode = (out) => readJson(join(nodeDir(out), '02-research.json'))

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// 一份 1×1 的真 PNG：findings[].kind=image 要求 ref **真实存在**
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wAp0AAfAAAAAElFTkSuQmCC',
  'base64',
)

// 写一份调研产物到 <out>/research.json（echo 示例的指标是 loss / size，白名单是 alpha/beta/ghost）
function writeResearch(out, over = {}) {
  mkdirSync(out, { recursive: true })
  mkdirSync(join(out, 'refs'), { recursive: true })
  writeFileSync(join(out, 'refs', 'ref-a.png'), PNG_1X1)
  const doc = {
    queries: ['二次元火焰特效 参考', '崩坏星穹铁道 火焰 配色'],
    findings: [
      { kind: 'image', ref: 'refs/ref-a.png', why: '同类高评分火焰，边缘有描边' },
      { kind: 'doc', ref: 'https://example.com/article', why: '配色链：白芯→黄→橙→暗红' },
    ],
    extracted: [
      { apply: 'criteria', id: 'size', weight: 0.25, confidence: 0.7, source: 'ref-a.png 的色相圆均值' },
      { apply: 'start', name: 'alpha', value: 2.28, confidence: 0.5, source: '参考图里光束更粗' },
    ],
    note: '配色链：白芯→黄→橙→暗红',
    ...over,
  }
  const file = join(out, 'research.json')
  writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')
  return { file, doc }
}

// ---------------------------------------------------------------- ① 完整 research
test('① 完整 research（1 图 + 1 doc + 1 criteria + 1 start）→ done；report 有调研段；changed 恰好 2 项', () => {
  const out = tmp('done')
  writeResearch(out)
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '12', '--no-intent'])
  assert.equal(r.status, 0, `完整调研该跑通，实际 exit=${r.status}\n${r.out.slice(-1500)}`)

  // 节点：02 号、done、producer=agent（文件是 agent 填的）
  const node = researchNode(out)
  assert.equal(node.node, 'research')
  assert.equal(node.seq, 2, 'research 排在 intent（01）之后、target 之前 → 02')
  assert.equal(node.status, 'done', '真改了判据/起点的调研是 done')
  assert.equal(node.producer, 'agent', '调研产物是 agent 填的，不是引擎自己编的')
  assert.ok(node.artifacts.includes(RESEARCH_SUMMARY), 'artifacts 里要放调研摘要')
  assert.ok(existsSync(join(out, RESEARCH_SUMMARY)), '摘要要真的落盘（不是只在台帐里提一句）')

  // changed 恰好 2 项（weight + start），且是**引擎算出来的**
  const summary = readJson(join(out, RESEARCH_SUMMARY))
  assert.equal(summary.status, 'done')
  assert.equal(summary.changed.length, 2, `changed 要恰好 2 项，实测 ${JSON.stringify(summary.changed.map((c) => c.text))}`)
  const texts = summary.changed.map((c) => c.text)
  assert.ok(texts.some((t) => t.includes('criteria.size.weight') && t.includes('0.5') && t.includes('0.25')), `要逐项写清 criteria 的改动：${texts.join(' / ')}`)
  assert.ok(texts.some((t) => t.includes('start.alpha') && t.includes('2.28')), `要逐项写清 start 的改动：${texts.join(' / ')}`)
  assert.equal(summary.affectsDistance, true, 'research 改了判据/起点 → 它确实影响距离（与 intent 的四样不同）')
  assert.ok(summary.overrideOrder.includes('research'), '摘要里要写明覆盖顺序')

  // 报告：调研段（在台帐汇总行下面）+ changed 清单
  const md = readReport(out)
  assert.ok(md.indexOf('本次运行：') < md.indexOf('调研（research · done）'), '调研段要在"本次运行"汇总行下面')
  assert.match(md, /\*\*调研（research · done）\*\*/)
  assert.match(md, /2 条 query/)
  assert.match(md, /image 1 \/ doc 1/, '要写出 findings 的 image/doc 条数')
  assert.match(md, /真正改了 2 项/)
  assert.match(md, /criteria\.size\.weight 0\.5 → 0\.25/)
  assert.match(md, /start\.alpha 2 → 2\.28/)

  // **真的落到了搜索上**（只记账不改判据 = 没做事）
  const best = readJson(join(out, 'best.json'))
  const w = Object.fromEntries(best.metricsCfg.metrics.map((x) => [x.id, x.weight]))
  assert.equal(w.size, 0.25, `research 的 weight 要真落到判据上，实测 size=${w.size}`)
  assert.equal(best.startParams.alpha, 2.28, 'research 的 start 要真落到起点参数上')
  // 台帐 target 节点要能看出起点被谁改过（否则"起点怎么是这个数"就断链）
  const target = readJson(join(nodeDir(out), '03-target.json'))
  assert.ok(
    target.decision.basis.some((s) => s.includes('research 覆盖起点 alpha')),
    `target 台帐要写清起点被 research 改过：${target.decision.basis.join(' / ')}`,
  )
})

// ---------------------------------------------------------------- ② 图不在
test('② findings[].kind=image 指向不存在的文件 → 中文硬错（图不在 = 没有参照物）', () => {
  const out = tmp('noimg')
  writeResearch(out, {
    findings: [{ kind: 'image', ref: 'refs/not-there.png', why: '同类高评分火焰' }],
  })
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '8', '--no-intent'])
  assert.equal(r.status, 1, `参考图不存在必须拒跑，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /\[调研\]/, '错误要自报家门（哪个节点拦的）')
  assert.match(r.out, /参考图不存在/, '要直接说清是哪一种问题')
  assert.match(r.out, /not-there\.png/, '要点名那个 ref')
  assert.match(r.out, /解析成：/, '要把解析出来的绝对路径写出来（告诉用户它去哪找的）')
  assert.ok(!existsSync(join(out, 'best.json')), '硬错时不许交出"看起来跑完了"的证据包')
  const node = researchNode(out)
  assert.equal(node.status, 'failed', '拦下来的这一步在台帐里是 failed（不是"没这回事"）')
})

// ---------------------------------------------------------------- ③ criteria id 不在 adapter
test('③ extracted[].apply=criteria 但 id 不在 adapter 指标里 → 硬错（绝不静默忽略）', () => {
  const out = tmp('badid')
  writeResearch(out, {
    extracted: [{ apply: 'criteria', id: 'hue', weight: 0.25, source: 'ref-a.png 的色相圆均值' }],
  })
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '8', '--no-intent'])
  assert.equal(r.status, 1, `写错 id 必须拒跑（静默忽略 = 对着没人用的判据跑完一轮），实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /不在 adapter 指标里/)
  assert.match(r.out, /hue/, '要点名写错的那个 id')
  assert.match(r.out, /loss/, '要把 adapter 里真实的指标列出来（照着改）')
  assert.ok(!existsSync(join(out, 'best.json')))
})

// ---------------------------------------------------------------- ④ start name 不在白名单
test('④ extracted[].apply=start 但 name 不在参数白名单里 → 硬错', () => {
  const out = tmp('badstart')
  writeResearch(out, {
    extracted: [{ apply: 'start', name: 'radius', value: 0.28, source: '参考图里光束更粗' }],
  })
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '8', '--no-intent'])
  assert.equal(r.status, 1, `起点改到白名单外必须拒跑（等于这次调研什么都没影响），实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /不在参数白名单里/)
  assert.match(r.out, /radius/, '要点名写错的那个参数')
  assert.match(r.out, /alpha/, '要把白名单列出来（照着改）')
  assert.ok(!existsSync(join(out, 'best.json')))
})

// ---------------------------------------------------------------- ⑤ 装饰性调研
test('⑤ 产物给了但 changed 为空（weight/start 都是原值）→ 节点 degraded，reason 含"装饰性调研"', () => {
  const out = tmp('deco')
  // weight 写成 adapter 原值 0.5；start 写成起点原值 2 —— 两次应用都等于没动
  // 再故意塞一个自报的 changed（2 项）：引擎**不许**信它，否则这条用例就是绿的
  writeResearch(out, {
    extracted: [
      { apply: 'criteria', id: 'size', weight: 0.5, source: '原值（装饰性）' },
      { apply: 'start', name: 'alpha', value: 2, source: '原值（装饰性）' },
    ],
    changed: ['criteria.size.weight 0.5 → 0.25', 'start.alpha 2 → 2.28'],
  })
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '8', '--no-intent'])
  assert.equal(r.status, 0, `装饰性调研不拒跑（跑了就记 degraded），实际 exit=${r.status}\n${r.out.slice(-1200)}`)
  const node = researchNode(out)
  assert.equal(node.status, 'degraded', '给产物但没改动任何判据/起点 = degraded（不是 done）')
  assert.match(node.reason, /装饰性调研/, `reason 要写明"装饰性调研"：${node.reason}`)
  assert.match(node.reason, /没改变任何判据或起点/)
  assert.ok(node.decision.basis.some((s) => s.includes('自报的 changed 已忽略')), '台帐要留一句：文件里自报的 changed 被忽略')
  const summary = readJson(join(out, RESEARCH_SUMMARY))
  assert.equal(summary.changed.length, 0, '引擎自己算出来的 changed 是 0 项')
  assert.equal(summary.affectsDistance, false)
  const md = readReport(out)
  assert.match(md, /\*\*调研（research · degraded）\*\*/)
  assert.match(md, /装饰性调研/)
  assert.match(md, /真正改了 0 项/)
})

// ---------------------------------------------------------------- ⑥ skipped
test('⑥ 没有 research.json → 节点 skipped + 终端 warn 一行，跑通（不拒跑）', () => {
  const out = tmp('skip')
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '8', '--no-intent'])
  assert.equal(r.status, 0, `没给调研产物不该拒跑，实际 exit=${r.status}\n${r.out.slice(-800)}`)
  assert.match(r.out, /\[research\]\[warn\]/, '终端要有一行 warn（跳过要有名字，但别拦人）')
  assert.match(r.out, /没提供调研产物/, 'warn 要写清"没给产物"，不是"调研通过"')
  const node = researchNode(out)
  assert.equal(node.status, 'skipped')
  assert.equal(node.reason, '没提供调研产物（--research <file>）')
  assert.ok(!node.artifacts.length, '跳过就没有摘要产物')
  const md = readReport(out)
  assert.match(md, /\*\*调研（research · skipped）\*\*/)
  assert.match(md, /没提供调研产物/)
  // 汇总行的 skipped 计数要含这一条（与 intent 的 --no-intent 两条）
  const m = /本次运行：(\d+) done \/ (\d+) skipped \/ (\d+) degraded/.exec(md)
  assert.ok(m, 'report.md 要有汇总行')
  assert.equal(Number(m[2]), 2, `skipped 该是 intent + research 两条，实测 ${m[0]}`)
})

// ---------------------------------------------------------------- ⑦ queries 空且没 note
test('⑦ queries: [] 且没写 note → 硬错（没搜还不写为什么）', () => {
  const out = tmp('nonote')
  writeResearch(out, { queries: [], findings: [], extracted: [], note: '' })
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '8', '--no-intent'])
  assert.equal(r.status, 1, `queries 空且没 note 必须拒跑，实际 exit=${r.status}\n${r.out}`)
  assert.match(r.out, /没写 note/, '要说清缺的是 note')
  assert.match(r.out, /为什么没搜/, '要解释"为什么这条要拦"')
  assert.ok(!existsSync(join(out, 'best.json')))
  // 反过来：queries 空但写了 note → 允许（这是"离线/没资料可用"的合法姿势），但要记 degraded（没改动）
  const out2 = tmp('nonote-ok')
  writeResearch(out2, {
    queries: [],
    findings: [],
    extracted: [{ apply: 'criteria', id: 'size', weight: 0.5 }],
    note: '离线环境，没有可查的参考；这一轮只是复验同一个点',
  })
  const r2 = runCli(['--adapter', ECHO_ADAPTER, '--out', out2, '--budget', '8', '--no-intent'])
  assert.equal(r2.status, 0, `写了 note 就该放行，实际 exit=${r2.status}\n${r2.out.slice(-600)}`)
  assert.equal(researchNode(out2).status, 'degraded', '没搜也没改动 → degraded（有产物但没起效）')
})

// ---------------------------------------------------------------- ⑧ 指纹
test('⑧ research 的内容进 run 指纹：同内容跨目录同 hash；换一条 query 就换 hash', () => {
  const a = tmp('fp-a')
  writeResearch(a)
  const ra = runCli(['--adapter', ECHO_ADAPTER, '--out', a, '--budget', '10', '--no-intent'])
  assert.equal(ra.status, 0, ra.out.slice(-800))
  const b = tmp('fp-b')
  writeResearch(b) // 同内容、不同目录
  const rb = runCli(['--adapter', ECHO_ADAPTER, '--out', b, '--budget', '10', '--no-intent'])
  assert.equal(rb.status, 0, rb.out.slice(-800))
  const ha = readJson(join(a, 'best.json')).hash
  const hb = readJson(join(b, 'best.json')).hash
  assert.match(ha, /^[0-9a-f]{64}$/)
  assert.equal(ha, hb, `同内容同参数换目录重跑，hash 必须一致（文件路径不进指纹）`)

  // 内容换了（多一条 query）→ 判据/起点没变，但指纹必须变：否则两次不同调研会被同一个 hash 糊成同一次
  const c = tmp('fp-c')
  writeResearch(c, { queries: ['二次元火焰特效 参考', '崩坏星穹铁道 火焰 配色', '火焰 描边 做法'] })
  const rc = runCli(['--adapter', ECHO_ADAPTER, '--out', c, '--budget', '10', '--no-intent'])
  assert.equal(rc.status, 0, rc.out.slice(-800))
  const hc = readJson(join(c, 'best.json')).hash
  assert.notEqual(hc, ha, 'research 内容变了，hash 必须跟着变（否则两次不同调研的 run 会撞 hash）')
  assert.equal(readJson(join(c, 'best.json')).research.queries.length, 3, 'best.json 里要能机器读到调研内容')
})

// ---------------------------------------------------------------- ⑨ 弄坏能红 ×2
// 不是"再测一遍功能"，而是证明 ⑤ 的断言真的接在实现上：把实现弄坏，那条必须塌。
test('⑨-1 弄坏能红：直接信文件自报的 changed（SELFLOOP_RESEARCH_MUTANT=trustSelfReportedChanged）→ ⑤ 必塌', () => {
  const out = tmp('mut-trust')
  writeResearch(out, {
    extracted: [
      { apply: 'criteria', id: 'size', weight: 0.5 },
      { apply: 'start', name: 'alpha', value: 2 },
    ],
    // 自报 2 项改动，实际 0 项 —— ⑤ 的文件就是靠这个抓"信自报"
    changed: ['criteria.size.weight 0.5 → 0.25', 'start.alpha 2 → 2.28'],
  })
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '8', '--no-intent'], { SELFLOOP_RESEARCH_MUTANT: 'trustSelfReportedChanged' })
  assert.equal(r.status, 0, r.out.slice(-800))
  const node = researchNode(out)
  // ⑤ 断言的是 degraded；信自报之后它变成 done（这正是"装饰性调研被洗白"的危险）
  assert.equal(node.status, 'done', '变异体下自报的 changed 顶替了引擎的计算 → 节点成了 done')
  assert.notEqual(node.status, 'degraded', '⑤ 的 assert.equal(node.status,"degraded") 在这份实现上不可能成立')
  assert.ok(!/装饰性调研/.test(node.reason || ''), '变异体下 reason 里没有"装饰性调研"')
})

test('⑨-2 弄坏能红：degraded 记成 done（SELFLOOP_RESEARCH_MUTANT=degradedAsDone）→ ⑤ 必塌', () => {
  const out = tmp('mut-done')
  writeResearch(out, {
    extracted: [{ apply: 'criteria', id: 'size', weight: 0.5 }],
  })
  const r = runCli(['--adapter', ECHO_ADAPTER, '--out', out, '--budget', '8', '--no-intent'], { SELFLOOP_RESEARCH_MUTANT: 'degradedAsDone' })
  assert.equal(r.status, 0, r.out.slice(-800))
  const node = researchNode(out)
  assert.equal(node.status, 'done', '变异体把 degraded 洗成 done')
  assert.equal(node.reason, '', 'done 的 reason 是空串')
  assert.ok(!/装饰性调研/.test(JSON.stringify(node)), '⑤ 断言的"装饰性调研"字样在变异体下不存在')
})
