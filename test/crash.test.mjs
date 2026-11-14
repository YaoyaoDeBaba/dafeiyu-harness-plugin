// 退化配置回归（目标参数 == 起点参数）：这一版之前它会**崩**，不是硬错。
//
// 崩的路径（钉住，别再走回去）：
//   ① adapter.target.mode=params，target.params 与 params.list 的起点值完全一样；
//   ② 目标那次评估跑的时候**还没有目标行**（trow 未定义），evaluate() 按约定把 dist 记成 null
//      —— 那本来是"目标自己跟自己没有距离"，只对目标那一刻成立；
//   ③ 但这条记录被写进了**缓存**（缓存键是「点」= 参数，不是「阶段」）；
//   ④ 起点读同一个点 → 命中缓存 → 拿到的 rec.dist 是 null；
//   ⑤ `[start] d=${startDist.toFixed(4)}` → Cannot read properties of null (reading 'toFixed')，进程直接掀翻。
//
// 修法不是给那一行加兜底：命中缓存时**观测照用、距离按当前真正的目标行重算**
// （与普通评估同一套判据），并把 outputs/ 那份原始输出的 dist 一起补上。
// 这条用例钉的就是这件事，顺带钉住退化配置必须被标成 degraded（能跑完 ≠ 调到了目标）。
//
// 复现（同一份现场，不用改仓库）：
//   node harness/cmdloop.mjs --adapter <site>/adapter.json --out <site>/run --budget 8 --no-intent
//   （target.mode=params、target.params={a:1}，起点 a=1 —— 本用例的 makeSite() 就是这个形状）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'harness', 'cmdloop.mjs')

const tmp = (tag) => mkdtempSync(join(tmpdir(), `selfloop-crash-${tag}-`))
const readJson = (abs) => JSON.parse(readFileSync(abs, 'utf8'))

function runCli(args, env = {}) {
  const withGate = args.some((a) => a === '--no-intent' || a === '--intent') ? args : [...args, '--no-intent']
  const r = spawnSync(process.execPath, [CLI, ...withGate], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// 最小现场：一条确定性命令 + 一份基线 {a:1} + 目标参数 {a:1}（与起点完全相同）
function makeSite(tag) {
  const dir = tmp(tag)
  writeFileSync(join(dir, 'base.json'), JSON.stringify({ params: { a: 1 } }), 'utf8')
  writeFileSync(
    join(dir, 'probe.mjs'),
    [
      'import { readFileSync } from "node:fs"',
      'const d = JSON.parse(readFileSync(process.env.SELFLOOP_PARAMS, "utf8"))',
      'const a = Number(d.params.a)',
      'console.log(JSON.stringify({ loss: Number(Math.abs(a - 1).toFixed(6)), size: 10 + a }))',
    ].join('\n') + '\n',
    'utf8',
  )
  const adapter = {
    schema: 'closed-loop-adapter/3',
    domain: 'command',
    name: `test-${tag}`,
    config: { path: 'base.json', format: 'flat-params' },
    observe: {
      type: 'command',
      cmd: 'node ./probe.mjs',
      timeoutMs: 5000,
      parse: 'json',
      metrics: [{ id: 'loss', field: 'loss', norm: { mode: 'abs', scale: 1 }, weight: 1 }],
    },
    // 目标就是起点参数本身 —— 退化配置
    target: { mode: 'params', params: { a: 1 } },
    params: { mode: 'list', list: ['a'] },
    score: { type: 'l1', penalties: [] },
  }
  const file = join(dir, 'adapter.json')
  writeFileSync(file, JSON.stringify(adapter, null, 2), 'utf8')
  return { dir, file }
}

test('目标参数 == 起点参数：不崩、[start] 正着打印、start 距离不是 null、同 seed 两次 hash 一致', () => {
  const site = makeSite('target-equals-start')
  const out1 = tmp('eq-a')
  const r1 = runCli(['--adapter', site.file, '--out', out1, '--budget', '8', '--seed', '12345'])
  // ① 不崩：这条以前是 TypeError（不是中文硬错），进程直接掀翻
  assert.doesNotMatch(r1.out, /Cannot read properties of null/, `不许再崩在这里：\n${r1.out}`)
  assert.equal(r1.status, 0, `退化配置是合法配置，要跑完，实际 exit=${r1.status}\n${r1.out}`)
  // ② [start] 那行正常打印（就是崩在 toFixed 的那一行）
  assert.match(r1.out, /\[start\] d=0\.0000/, `[start] 要正常打印距离：\n${r1.out}`)
  assert.match(r1.out, /\[target\] 参数目标 \{"a":1\}/, '目标那次评估照旧要跑')
  // ③ 起点距离在证据包里是数（不是 null）
  const b1 = readJson(join(out1, 'best.json'))
  assert.notEqual(b1.startDist, null, 'best.json 的 startDist 不许是 null')
  assert.equal(typeof b1.startDist, 'number')
  assert.equal(b1.startDist, 0, '起点就是目标 → 起点距离必然是 0')
  assert.equal(b1.bestDist, 0)
  assert.equal(b1.dropPct, null, '起点距离 0 时降幅算不出来（null，不编一个 0%）')
  // 观测被复用，但距离补算过：目标那个点的 outputs/ 里也不能留着 null
  const e001 = readJson(join(out1, 'outputs', 'e001.json'))
  assert.equal(e001.dist, 0, '被复用的那条观测，距离也要按目标行算出来（不是留下"目标取值"的 null）')
  assert.equal(b1.curve[0].dist, 0, 'curve 里同一个点的距离同样是数')
  // ④ 退化配置必须留痕：能跑完 ≠ 调到了目标
  assert.ok(Array.isArray(b1.degraded) && b1.degraded.length === 1, `best.json 要标 degraded：${JSON.stringify(b1.degraded)}`)
  assert.equal(b1.degraded[0].code, 'target-equals-start')
  assert.match(b1.degraded[0].why, /起点即目标/)
  assert.match(r1.out, /\[degraded\]\[warn\] 起点即目标/, '终端也要说一句（不然 drop=n/a 会被读成"已达标"）')
  assert.match(readFileSync(join(out1, 'report.md'), 'utf8'), /退化配置 \| `degraded` `target-equals-start`/, 'report.md 里要有这一行')
  // research 节点插到 02 之后，target 从 02 变 03
  const nodeDoc = readJson(join(out1, 'nodes', '03-target.json'))
  assert.equal(nodeDoc.status, 'degraded', '台帐里 target 节点记 degraded（不是 done）')
  assert.match(nodeDoc.reason, /搜索没有起点差异可用/)
  // ⑤ 同 seed 两次 → hash 一致（距离补算不能把指纹弄成非确定性的）
  const out2 = tmp('eq-b')
  const r2 = runCli(['--adapter', site.file, '--out', out2, '--budget', '8', '--seed', '12345'])
  assert.equal(r2.status, 0, r2.out)
  const b2 = readJson(join(out2, 'best.json'))
  assert.match(b1.hash, /^[0-9a-f]{64}$/)
  assert.equal(b1.hash, b2.hash, '同 seed 同参数换目录重跑，hash 必须一致')
  assert.deepEqual(
    b1.curve.map((c) => [c.seq, c.params, c.dist]),
    b2.curve.map((c) => [c.seq, c.params, c.dist]),
    '同 seed 的评估序列必须逐点一致',
  )
  assert.ok(existsSync(join(out2, 'outputs', 'e001.json')))
})
