// test/mask-sentinel.test.mjs —— 掩膜哨兵（0.13.0）
//
// 要拦的故障（真发生过）：第二轮实验里 luma:200 的 content 掩膜只圈到枪口白芯（recall 0.09~0.38），
// 三个参数不同、输出 SHA 不同的候选，掩膜内指标向量**逐位相同**（最大连通域在"枪口团"和"射线"之间跳）。
// maskSuspicious 只能拦"圈太小"，拦不住"掩膜冻在同一小块像素"—— 这个哨兵补的就是那一段。
//
// 跑法：node test/mask-sentinel.test.mjs
//   弄坏能红：MASK_SENTINEL_MUTANT=threshold999 node test/mask-sentinel.test.mjs  ← 第 ① 条必红
//            MASK_SENTINEL_MUTANT=constHash     node test/mask-sentinel.test.mjs  ← 第 ② 条必红
//
// 这里全部走**真执行器子进程**（node harness/cmdloop.mjs），不 in-process 复刻：
// 哨兵住在评估循环里，绕开执行器测等于测了个克隆。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'harness', 'cmdloop.mjs')
const INTENT_CLI = join(ROOT, 'harness', 'intent.mjs')
const MUTANT = process.env.MASK_SENTINEL_MUTANT || ''

function tmp(tag) {
  return mkdtempSync(join(tmpdir(), `selfloop-mask-${tag}-`))
}

function runCli(args, env = {}) {
  const withGate = args.some((a) => a === '--no-intent' || a === '--intent') ? args : [...args, '--no-intent']
  const r = spawnSync(process.execPath, [CLI, ...withGate], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MASK_SENTINEL_MUTANT: MUTANT, ...env },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// ---------------------------------------------------------------- 合成 PNG（8bit RGB、非隔行、filter 0）
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const t = Buffer.from(type, 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function pngGray(w, h, fn) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // RGB，三通道同值 ⇒ luma 恰好等于灰度
  const stride = 1 + w * 3
  const raw = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y))))
      const p = y * stride + 1 + x * 3
      raw[p] = v
      raw[p + 1] = v
      raw[p + 2] = v
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// 探针：读参数 → 写一张 16x16 的 PNG → stdout 打印它的路径（parse=image 只认一行路径）
const PROBE_HEAD = `import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) { const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]) }
function pngGray(w, h, fn) { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; const stride = 1 + w * 3; const raw = Buffer.alloc(h * stride); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.max(0, Math.min(255, Math.round(fn(x, y)))); const p = y * stride + 1 + x * 3; raw[p] = v; raw[p + 1] = v; raw[p + 2] = v } return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]) }
const p = JSON.parse(readFileSync(process.env.SELFLOOP_PARAMS, 'utf8')).params
const gain = Number(p.gain ?? 1), scale = Number(p.scale ?? 1)
const W = 16, H = 16
const fn = (x, y) => {`

// 冻住：唯一的亮像素永远在 (0,0)（content luma:200 只会圈到它）；掩膜外那个点随参数变 → PNG sha 不同。
const FROZEN_BODY = `  if (x === 0 && y === 0) return 255
  if (x === 1 && y === 0) return 10 + Math.round(gain * 10) + Math.round(scale * 20)
  return 0 }`

// 正常：3x3 亮块随参数移动（掩膜跟着变），块本身恒为 255 ⇒ 掩膜内指标逐位相同、maskHash 不同。
const NORMAL_BODY = `  const bx = 4 + Math.round((scale - 1) * 10)
  const by = 4 + Math.round((gain - 1) * 10)
  if (x >= bx && x < bx + 3 && y >= by && y < by + 3) return 255
  return 0 }`

const PROBE_TAIL = `
const file = join(dirname(process.env.SELFLOOP_PARAMS), 'shot.png')
writeFileSync(file, pngGray(W, H, fn))
console.log(file)`

function makeSite(tag, { body, params, mask }) {
  const dir = tmp(tag)
  writeFileSync(join(dir, 'base.json'), JSON.stringify({ params: { gain: 1, scale: 1 } }), 'utf8')
  writeFileSync(join(dir, 'probe.mjs'), `${PROBE_HEAD}\n${body}\n${PROBE_TAIL}`, 'utf8')
  // dilate:0 —— 实验里那个掩膜是"固定 1×1 像素"（默认 dilate:1 会把外沿一圈也纳进来，邻点一变就不是冻住了）
  const maskCfg = mask ?? { mode: 'content', luma: 200, minAreaPct: 0, dilate: 0 }
  const adapter = {
    schema: 'closed-loop-adapter/3',
    domain: 'command',
    name: `test-mask-${tag}`,
    config: { path: 'base.json', format: 'flat-params' },
    observe: {
      type: 'command',
      cmd: 'node ./probe.mjs',
      timeoutMs: 15000,
      parse: 'image',
      // 关掉稳定性闸（repeat=1）：本文件测的是哨兵，不是"同一参数重复跑"的抖动
      stability: { repeat: 1, maxSpread: 0.02 },
      metrics: [
        { id: 'mean', extract: 'mean', opts: { mask: maskCfg }, norm: { mode: 'abs', scale: 255 }, weight: 1 },
        { id: 'cov', extract: 'cov', opts: { mask: maskCfg }, norm: { mode: 'abs', scale: 1 }, weight: 1 },
      ],
    },
    target: { mode: 'metrics', metrics: { mean: 0, cov: 0 } },
    params: { mode: 'list', list: params },
    score: { type: 'l1', penalties: [] },
    guard: { protectPaths: [] },
  }
  const file = join(dir, 'adapter.json')
  writeFileSync(file, JSON.stringify(adapter, null, 2), 'utf8')
  return { dir, file }
}

function readReport(out) {
  return readFileSync(join(out, 'report.md'), 'utf8')
}

function nodeRecords(out) {
  const d = join(out, 'nodes')
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(d, n), 'utf8')))
}

// 一次性真跑（① 与 ⑤ 共用）
let frozenRun1
function frozenRun() {
  if (!frozenRun1) {
    const site = makeSite('frozen', { body: FROZEN_BODY, params: ['gain', 'scale'] })
    const out = tmp('frozen-out')
    const r = runCli(['--adapter', site.file, '--out', out, '--budget', '20'])
    frozenRun1 = { r, out, site }
  }
  return frozenRun1
}

// ---------------------------------------------------------------- ① 真冻住 → maskFrozen 硬错
test('① 真冻住：3 个参数不同、PNG sha 不同，但掩膜圈在同一小块像素 → 硬错 maskFrozen', () => {
  const { r, out } = frozenRun()
  assert.notEqual(r.status, 0, `掩膜冻住必须硬错（exit=0 就是把"看起来专业地量错"放过去了）\n${r.out.slice(-2000)}`)
  assert.match(r.out, /maskFrozen/, '错误里必须有 maskFrozen 这个词（测试/门禁要能 grep 到）')
  assert.match(r.out, /同一小块像素/, '错误信息要写清这是"掩膜退化到同一小块像素"的典型信号')
  assert.match(r.out, /roi/)
  assert.match(r.out, /diff/)
  // 记账：nodes/ 的 search 节点写 failed + reason
  const search = nodeRecords(out).find((n) => n.node === 'search')
  assert.ok(search, '硬错也要留痕：nodes/ 里必须有 search 节点')
  assert.equal(search.status, 'failed', '掩膜哨兵触发 = search 节点 failed')
  assert.match(String(search.reason), /maskFrozen/)
  console.log(`    硬错原文：${String(r.stderr).split('\n')[0]}`)
  console.log(`    search 节点：status=${search.status} reason=${String(search.reason).split('\n')[0]}`)
})

// ---------------------------------------------------------------- ② 正常场景不误报
test('② 正常场景（掩膜随参数移动）→ 不误报，报告里有"未发现冻住"一行', () => {
  const site = makeSite('normal', { body: NORMAL_BODY, params: ['gain', 'scale'] })
  const out = tmp('normal-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '20'])
  assert.equal(r.status, 0, `正常场景不该硬错\n${r.out.slice(-2000)}`)
  const md = readReport(out)
  assert.match(md, /掩膜哨兵 \| \d+ 个候选 \/ 未发现冻住/, `report.md 的硬不变量附近要有这一行：\n${md.split('\n').filter((l) => l.includes('掩膜哨兵')).join('\n')}`)
  assert.match(r.out, /掩膜哨兵\].*未发现冻住|未发现冻住/)
  console.log(`    实测：${md.split('\n').find((l) => l.includes('掩膜哨兵 |'))}`)
})

// ---------------------------------------------------------------- ③ --no-mask-sentinel
test('③ --no-mask-sentinel：不检测（真冻住也放行），但 warn「本次不检测掩膜冻住」', () => {
  const site = makeSite('off', { body: FROZEN_BODY, params: ['gain', 'scale'] })
  const out = tmp('off-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '20', '--no-mask-sentinel'])
  assert.equal(r.status, 0, `关掉哨兵后不该硬错\n${r.out.slice(-2000)}`)
  assert.match(r.out, /本次不检测掩膜冻住/, '关掉时必须 warn 一句，不能静默')
  assert.match(r.out, /--no-mask-sentinel/)
  assert.match(readReport(out), /掩膜哨兵 \| \*\*已关闭\*\*/, '报告里也要写"已关闭"，不能看起来像"查过没问题"')
  // 复现命令要带上开关（否则重跑等于换了一套默认）
  const best = JSON.parse(readFileSync(join(out, 'best.json'), 'utf8'))
  assert.match(best.meta.command, /--no-mask-sentinel/)
})

// ---------------------------------------------------------------- ④ 两个候选冻住（不足 3）→ 只 warn
test('④ 阈值边界：只有 2 个候选冻住 → 不硬错，但 warn（阈值 3 的下沿）', () => {
  // 单参数：start + 预检 = 2 个候选；两个指标的掩膜内向量完全相同 ⇒ 预检判 dead，搜索不跑（不会冒出第 3 个）
  const site = makeSite('pair', { body: FROZEN_BODY, params: ['gain'] })
  const out = tmp('pair-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '20'])
  assert.equal(r.status, 0, `只有 2 个候选不该硬错\n${r.out.slice(-2000)}`)
  assert.match(r.out, /掩膜哨兵\]\[warn\]/, '2 个候选必须 warn')
  assert.match(r.out, /未到硬错阈值 3，仅 warn/)
  const md = readReport(out)
  assert.match(md, /掩膜哨兵 \| 2 个候选 \/ .*2 个候选掩膜冻在同一块像素.*仅 warn/)
  console.log(`    实测：${md.split('\n').find((l) => l.includes('掩膜哨兵 |'))}`)
})

// ---------------------------------------------------------------- ⑤ 弄坏能红 ×2（用变异开关现场演示）
test('⑤ 弄坏能红：阈值 3→999（等于关掉）时①不再硬错；maskHash 换成常量时②会被误报', () => {
  // ① 阈值 999：真冻住也不再硬错 —— 证明第 ① 条断言真的接在阈值上（不是别的东西在报错）
  const siteA = makeSite('mut-th', { body: FROZEN_BODY, params: ['gain', 'scale'] })
  const outA = tmp('mut-th-out')
  const rA = runCli(['--adapter', siteA.file, '--out', outA, '--budget', '20'], { MASK_SENTINEL_MUTANT: 'threshold999' })
  assert.equal(rA.status, 0, `阈值改成 999 后不该硬错（这正是"①会红"的另一面）\n${rA.out.slice(-2000)}`)
  assert.match(rA.out, /仅 warn/)
  // ② maskHash 常量：正常场景（掩膜局部逐像素不同）被误判成"冻住"—— 证明第 ② 条断言真的接在 maskHash 上
  const siteB = makeSite('mut-hash', { body: NORMAL_BODY, params: ['gain', 'scale'] })
  const outB = tmp('mut-hash-out')
  const rB = runCli(['--adapter', siteB.file, '--out', outB, '--budget', '20'], { MASK_SENTINEL_MUTANT: 'constHash' })
  assert.notEqual(rB.status, 0, `maskHash 换成常量后正常场景必须被误报（这正是"②会红"的另一面）\n${rB.out.slice(-2000)}`)
  assert.match(rB.out, /maskFrozen/)
})

// ---------------------------------------------------------------- ⑥ 截图链路要求哨兵 → 硬错
test('⑥ 截图链路在 intent 里要求哨兵 → 硬错（与硬不变量同一处理；哨兵只在命令链路有）', () => {
  const site = makeSite('intent', { body: NORMAL_BODY, params: ['gain'] })
  const out = tmp('intent-out')
  const intentFile = join(site.dir, 'intent.json')
  writeFileSync(
    intentFile,
    JSON.stringify({ restate: '把掩膜冻住这件事当成硬错拦下来', confirmed: true, maskSentinel: true }, null, 2),
    'utf8',
  )
  const r = spawnSync(process.execPath, [INTENT_CLI, 'gate', '--out', out, '--adapter', site.file, '--intent', intentFile, '--chain', 'screenshot'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const text = (r.stdout ?? '') + (r.stderr ?? '')
  assert.equal(r.status, 1, `截图链路要求哨兵必须拒跑\n${text.slice(-1500)}`)
  assert.match(text, /截图链路不支持掩膜哨兵/)
  assert.match(text, /maskSentinel/)
  // 同一份 intent 走命令链路能过（true = 要求，不是"不支持"）
  const r2 = spawnSync(process.execPath, [INTENT_CLI, 'gate', '--out', tmp('intent-cmd-out'), '--adapter', site.file, '--intent', intentFile, '--chain', 'cmd'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(r2.status, 0, `命令链路要认这个要求\n${((r2.stdout ?? '') + (r2.stderr ?? '')).slice(-1500)}`)
})

// ---------------------------------------------------------------- ⑦ roi 不参与硬错（maskHash 恒定是设计如此）
test('⑦ roi 口径：maskHash 天然恒定 → 不硬错（那更像"指标对参数不敏感"，只 warn）', () => {
  // 固定 ROI = const 掩膜；图像随参数移动但 ROI 内指标相同 ⇒ 同组 3 个。若哨兵硬错，roi 这条"唯一稳口径"就没法用了。
  const site = makeSite('roi', { body: NORMAL_BODY, params: ['gain', 'scale'], mask: { mode: 'roi', rect: [0, 0, 16, 16], dilate: 0 } })
  const out = tmp('roi-out')
  const r = runCli(['--adapter', site.file, '--out', out, '--budget', '20'])
  assert.equal(r.status, 0, `roi 恒定不该被硬错\n${r.out.slice(-2000)}`)
  assert.match(r.out, /指标对参数不敏感/, 'roi 下要 warn 的是"指标不敏感"，不是"掩膜冻住"')
  assert.match(r.out, /roi/)
  assert.match(readReport(out), /掩膜哨兵 \| 3 个候选 \/ 未发现冻住/)
})
