// 实时视图（0.5.2）自测：watch.mjs 只读磁盘、不连引擎，所以这里全部用「手写真 run 目录」+ 一次真链路。
//
// 覆盖：
//   ① 一屏能看全：第 N 轮 / best / 最近评估点 d= / 产物绝对路径 / 节点计数
//   ② skipped 节点带原因（原因片段出现在输出里）
//   ③ finalize 已存在 → 正常模式立刻退（不等 --timeout）
//   ④ 没有 live.jsonl（截图链路）→ 一行说明、不崩
//   ⑤ --json 可 JSON.parse，含 round/budget/evaluated/best/nodes[]
//   ⑥ 真链路：cmdloop --budget 8 跑完，live.jsonl ≥6 行、逐行可 parse、seq 递增（且行数 = 评估次数）
//
// 变异开关（只为证明断言有牙；改的是 cmdloop.mjs 的落点，不是测试）：
//   把 appendLive() 的 appendFileSync 改成"攒到最后再写"或干脆不写 → ⑥ 红。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WATCH = join(ROOT, 'harness', 'watch.mjs')
const CMDLOOP = join(ROOT, 'harness', 'cmdloop.mjs')
const EXAMPLE_ADAPTER = join(ROOT, 'examples', 'command-echo.json')

function tmp(tag) {
  return mkdtempSync(join(tmpdir(), `selfloop-watch-${tag}-`))
}

function runWatch(args, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [WATCH, ...args], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? ''), elapsedMs: Date.now() - t0 }
}

// 一条台帐记录（字段与 harness/ledger.js 一致；watch 只读 node/status/ms/reason/seq）
function nodeRec(node, seq, status, ms, reason = '') {
  return { node, seq, status, producer: 'engine', ms, inputs: [], decision: { why: reason, basis: [] }, artifacts: [], cost: {}, reason }
}

// 造一个"跑到一半/刚跑完"的 run 目录。live=false 时模拟截图链路（没有实时评估流）。
function makeRun(tag, { live = true, finalize = true, skippedReason = '' } = {}) {
  const dir = tmp(tag)
  mkdirSync(join(dir, 'nodes'), { recursive: true })
  mkdirSync(join(dir, 'shots'), { recursive: true })
  writeFileSync(join(dir, 'shots', 'best.png'), 'png', 'utf8')
  writeFileSync(join(dir, 'report.md'), '# report\n', 'utf8')

  const nodes = [
    nodeRec('intent', 1, 'done', 12),
    nodeRec('target', 2, 'done', 165),
    nodeRec('stability', 3, 'done', 133),
    nodeRec('precheck', 4, skippedReason ? 'skipped' : 'done', 190, skippedReason),
    nodeRec('search', 5, 'done', 322),
  ]
  if (finalize) nodes.push(nodeRec('finalize', 6, 'done', 0))
  for (const n of nodes) writeFileSync(join(dir, 'nodes', String(n.seq).padStart(2, '0') + '-' + n.node + '.json'), JSON.stringify(n, null, 2), 'utf8')

  if (live) {
    const rows = [
      { seq: 1, round: 0, t: '2026-11-14T20:30:10.100+08:00', d: null, best: null, params: { alpha: 1, beta: 1 }, evalMs: 70, note: 'target', budget: 60 },
      { seq: 2, round: 0, t: '2026-11-14T20:30:10.200+08:00', d: 0.2127, best: 0.2127, params: { alpha: 0.96, beta: 1.46 }, evalMs: 85, note: 'start', budget: 60 },
      { seq: 3, round: 2, t: '2026-11-14T20:30:11.400+08:00', d: 0.0804, best: 0.0804, params: { alpha: 0.96, beta: 1.46 }, evalMs: 83, note: 'search', budget: 60 },
    ]
    writeFileSync(join(dir, 'live.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  }
  return dir
}

// ---------------------------------------------------------------- ① 一屏能看全
test('① 一屏画全：轮次 / best / 最近评估点 / 产物绝对路径 / 节点计数', () => {
  const dir = makeRun('full')
  const r = runWatch([dir, '--once'])
  assert.equal(r.status, 0, `watch --once 该正常退出\n${r.out.slice(-1500)}`)
  assert.match(r.out, /第 2 轮/, '状态行要有当前轮次')
  assert.match(r.out, /best 0\.0804/, '状态行要有当前最优距离')
  assert.match(r.out, /#3 d=0\.0804/, '要有最近评估点（带 d=）')
  assert.ok(r.out.includes(join(dir, 'shots', 'best.png')), '产物要写绝对路径')
  assert.match(r.out, /6 done/, '节点计数要对（6 个节点全 done）')
})

// ---------------------------------------------------------------- ② skipped 带原因
test('② skipped 节点带原因（原因片段要出现在输出里）', () => {
  const dir = makeRun('skip', { skippedReason: '显式 --no-intent 跳过需求转译（台帐：跳过有名字）' })
  const r = runWatch([dir, '--once'])
  assert.equal(r.status, 0, r.out.slice(-1500))
  assert.match(r.out, /–\s+precheck\s+skipped/, 'skipped 节点要有符号 + 名字 + 状态')
  assert.ok(r.out.includes('显式 --no-intent'), '原因片段要能被看到')
  assert.match(r.out, /5 done \/ 1 skipped \/ 0 degraded/, '节点计数要含 skipped')
})

// ---------------------------------------------------------------- ③ finalize 存在 → 立刻退
test('③ finalize 已存在：正常模式画完最后一屏立刻退出（不等 --timeout）', () => {
  const dir = makeRun('done')
  const r = runWatch([dir, '--interval', '100', '--timeout', '5'], { timeoutMs: 4000 })
  assert.equal(r.status, 0, `该以 0 退出（被 kill 会是 null/1）\n${r.out.slice(-1500)}`)
  assert.ok(r.elapsedMs < 3000, `finalize 已在，应该秒退；实测 ${r.elapsedMs}ms（--timeout 5s）`)
  assert.match(r.out, /6 done/, '最后一屏也要画出来')
})

// ---------------------------------------------------------------- ④ 没有 live.jsonl 也要能跑
test('④ 没有 live.jsonl（截图链路）：输出一行说明，不崩', () => {
  const dir = makeRun('nolive', { live: false })
  const r = runWatch([dir, '--once'])
  assert.equal(r.status, 0, `没有 live.jsonl 不该崩\n${r.out.slice(-1500)}`)
  assert.ok(r.out.includes('没有实时评估流'), '要说清"这条链路只写节点台帐"')
  assert.match(r.out, /6 done/, '节点段照常画')
})

// ---------------------------------------------------------------- ⑤ --json
test('⑤ --json 输出可解析，含 round/budget/evaluated/best/nodes[]', () => {
  const dir = makeRun('json')
  const r = runWatch([dir, '--json'])
  assert.equal(r.status, 0, r.out.slice(-1500))
  let data
  assert.doesNotThrow(() => {
    data = JSON.parse(r.stdout)
  }, `--json 的输出必须是合法 JSON\n${r.stdout.slice(0, 800)}`)
  for (const k of ['round', 'budget', 'evaluated', 'best', 'nodes']) assert.ok(k in data, `缺字段 ${k}`)
  assert.equal(data.round, 2)
  assert.equal(data.budget, 60)
  assert.equal(data.evaluated, 3)
  assert.ok(Array.isArray(data.nodes) && data.nodes.length === 6, 'nodes[] 要有 6 条')
  assert.ok(data.nodes.every((n) => typeof n.node === 'string' && typeof n.status === 'string'), 'nodes[] 每项要有 node/status')
  assert.ok(data.finished === true)
})

// ---------------------------------------------------------------- ⑥ 真链路写 live.jsonl
// 光看"跑完以后文件里有几行"是抓不到"攒到最后才写"的（跑完后两种做法长得一样）。
// 所以在子进程跑的时候**边跑边数行数**：中途就见过 ≥3 行、且 seq 递增，才算"边跑边写"。
function runWithPolling(outDir, budget) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CMDLOOP, '--adapter', EXAMPLE_ADAPTER, '--out', outDir, '--budget', String(budget), '--no-intent'], {
      cwd: ROOT,
      env: { ...process.env },
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      out += String(d)
    })
    let maxLive = 0
    const file = join(outDir, 'live.jsonl')
    const timer = setInterval(() => {
      try {
        const n = readFileSync(file, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length
        if (n > maxLive) maxLive = n
      } catch {
        // 目录/文件还没建出来：下一次 tick 再数
      }
    }, 20)
    child.on('close', (code) => {
      clearInterval(timer)
      resolveRun({ code, out, maxLive })
    })
  })
}

test('⑥ 真跑一次：live.jsonl ≥6 行、逐行可 parse、seq 递增（边跑边写，不是攒到最后）', async () => {
  const out = tmp('eal')
  const r = await runWithPolling(out, 8)
  assert.equal(r.code, 0, `cmdloop 该跑通\n${r.out.slice(-2000)}`)
  const liveFile = join(out, 'live.jsonl')
  assert.ok(existsSync(liveFile), '必须写出 <out>/live.jsonl')
  const rows = readFileSync(liveFile, 'utf8')
    .split(/\r?\n/)
    .filter((s) => s.trim())
    .map((s) => JSON.parse(s)) // 有一行 parse 不了这里就炸 → 正是要钉的
  assert.ok(rows.length >= 6, `至少 6 行评估，实测 ${rows.length}`)
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].seq > rows[i - 1].seq, `seq 必须递增：${rows[i - 1].seq} → ${rows[i].seq}`)
  assert.ok(r.maxLive >= 3, `跑的过程中就该看到 ≥3 行（实测最多 ${r.maxLive} 行）—— 攒到最后再写会红`)
  const best = JSON.parse(readFileSync(join(out, 'best.json'), 'utf8'))
  assert.equal(rows.length, best.evaluations.used, '每次真评估一行（缓存命中不落行，used 也不计）')
})
