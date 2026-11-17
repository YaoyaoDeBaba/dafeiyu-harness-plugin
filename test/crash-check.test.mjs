// 崩坏自检（A3·㉞）：崩溃的帧不许被数值判据放行。
//
// 三条规则（任一命中 → fail）：① 洋红像素占比 > 0.1%；② 纯色大块（块内方差 <0.002 且面积 >1% 屏）；
// ③ 全黑（均值 <0.01）/ 全白（均值 >0.97 且方差 <0.002）。
// 判据：手写三张极小 PNG（洋红 / 全黑 / 正常噪声）→ 只有正常图 pass；且 checks.verified 会拦。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { crc32 as crc32fn, deflateSync } from 'node:zlib'

const { crashCheck, RULES } = await import('../harness/crash-check.mjs')
const { checks } = await import('../harness/pipeline.mjs')

const tmp = (tag) => mkdtempSync(join(tmpdir(), 'sl-crashcheck-' + tag + '-'))

/** 极简 PNG 编码（8bit、非隔行、RGB）：只为了造判据用的假图。 */
function png(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32fn(Buffer.concat([t, data])) >>> 0, 0)
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // colorType: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function solid(width, height, [r, g, b]) {
  const buf = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    buf[i * 3] = r
    buf[i * 3 + 1] = g
    buf[i * 3 + 2] = b
  }
  return buf
}

/** 确定性"噪声"：值落在 60~190 之间，既不洋红也不黑不白，块内方差足够大。 */
function noise(width, height) {
  const buf = Buffer.alloc(width * height * 3)
  let s = 12345
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return 60 + (s % 131)
  }
  for (let i = 0; i < width * height * 3; i += 1) buf[i] = next()
  return buf
}

function writePng(dir, name, width, height, rgb) {
  const file = join(dir, name)
  writeFileSync(file, png(width, height, rgb))
  return file
}

test('① 洋红图（255,0,255）→ magenta 占比 100% → fail，理由里有「洋红」', () => {
  const dir = tmp('magenta')
  const file = writePng(dir, 'magenta.png', 32, 32, solid(32, 32, [255, 0, 255]))
  const r = crashCheck(file)
  assert.equal(r.width, 32)
  assert.equal(r.magenta, 1, '整张洋红，占比必须是 1')
  assert.equal(r.magentaHit, true)
  assert.ok(r.magenta > RULES.magentaRatioMax)
  assert.equal(r.fail, true, '洋红图必须判崩：' + JSON.stringify(r))
  assert.ok(r.reasons.some((x) => x.includes('洋红')), '理由要写清是洋红：' + r.reasons.join('｜'))
})

test('② 全黑图 → black=true、fail=true', () => {
  const dir = tmp('black')
  const file = writePng(dir, 'black.png', 32, 32, solid(32, 32, [0, 0, 0]))
  const r = crashCheck(file)
  assert.equal(r.black, true)
  assert.equal(r.fail, true)
  assert.ok(r.reasons.some((x) => x.includes('全黑')), r.reasons.join('｜'))
})

test('③ 全白图 → white=true（要求均值 >0.97 且方差 <0.002）', () => {
  const dir = tmp('white')
  const file = writePng(dir, 'white.png', 32, 32, solid(32, 32, [255, 255, 255]))
  const r = crashCheck(file)
  assert.equal(r.white, true)
  assert.equal(r.fail, true)
  assert.ok(r.reasons.some((x) => x.includes('全白')), r.reasons.join('｜'))
})

test('④ 正常噪声图 → 三项都不命中，pass（不许误报）', () => {
  const dir = tmp('ok')
  const file = writePng(dir, 'ok.png', 64, 64, noise(64, 64))
  const r = crashCheck(file)
  assert.equal(r.magentaHit, false, '噪声里不该有洋红：' + r.magenta)
  assert.equal(r.flatBlock, false, '噪声不该被当成纯色大块：' + r.flatBlockArea)
  assert.equal(r.black, false)
  assert.equal(r.white, false)
  assert.equal(r.fail, false, '正常图必须 pass：' + JSON.stringify(r.reasons))
  assert.deepEqual(r.reasons, [])
})

test('⑤b 中性灰半屏（地板/天空）→ 不许判崩坏（2026-11-18 真实误报）', () => {
  const dir = tmp('grayhalf')
  const W = 64
  const H = 64
  const buf = noise(W, H)
  for (let y = 0; y < H; y += 1) {
    for (let x = W / 2; x < W; x += 1) {
      const i = (y * W + x) * 3
      buf[i] = 128
      buf[i + 1] = 128
      buf[i + 2] = 128
    }
  }
  const file = writePng(dir, 'grayhalf.png', W, H, buf)
  const r = crashCheck(file)
  assert.equal(r.flatBlock, false, '中性灰不该算纯色大块（地板误报）：' + r.flatBlockArea)
  assert.equal(r.fail, false, '中性灰半屏必须 pass：' + JSON.stringify(r.reasons))
})
test('⑤ 半屏纯色：单块面积 >1% 屏 → flatBlock 命中（正常底噪里的一块死区）', () => {
  const dir = tmp('half')
  const W = 64
  const H = 64
  const buf = noise(W, H)
  // 右半屏写成同一个高饱和错误色（绿幕）：方差 0、饱和度高、面积 50% > 1%
  // 注：中性灰不再算崩坏——2026-11-18 实测，灰色棋盘地板会把它误报成「纯色大块 88%」
  for (let y = 0; y < H; y += 1) {
    for (let x = W / 2; x < W; x += 1) {
      const i = (y * W + x) * 3
      buf[i] = 0
      buf[i + 1] = 255
      buf[i + 2] = 0
    }
  }
  const file = writePng(dir, 'half.png', W, H, buf)
  const r = crashCheck(file)
  assert.ok(r.flatBlockArea > 0.4, '半屏纯色的最大连通块应接近 50%：' + r.flatBlockArea)
  assert.equal(r.flatBlock, true)
  assert.equal(r.fail, true)
  assert.ok(r.reasons.some((x) => x.includes('纯色大块')), r.reasons.join('｜'))
})

test('⑥ 读不了的文件 → fail（不静默当通过）', () => {
  const dir = tmp('bad')
  const file = join(dir, 'broken.png')
  writeFileSync(file, 'not a png')
  const r = crashCheck(file)
  assert.equal(r.fail, true)
  assert.ok(r.reasons.length >= 1)
})

test('⑦ checks.verified：verify.shots 列了洋红图 → 不放行；正常图 → 放行', () => {
  const dir = tmp('pipe')
  mkdirSync(join(dir, 'shots'), { recursive: true })
  writePng(join(dir, 'shots'), 'bad.png', 32, 32, solid(32, 32, [255, 0, 255]))
  writePng(join(dir, 'shots'), 'ok.png', 64, 64, noise(64, 64))
  const verify = (shots) => writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots }))

  verify(['shots/bad.png'])
  const bad = checks.verified(dir)
  assert.ok(bad.length >= 1, '崩坏帧不许放行')
  assert.match(bad.join('\n'), /崩坏自检不通过/, '报错要指名崩坏自检：' + bad.join('｜'))
  assert.match(bad.join('\n'), /bad\.png/)

  verify(['shots/ok.png'])
  assert.deepEqual(checks.verified(dir), [], '正常帧不该被拦：' + JSON.stringify(checks.verified(dir)))

  verify(['shots/missing.png'])
  assert.match(checks.verified(dir).join('\n'), /不存在/, '点名了不存在的帧也要拦')
})

test('⑧ 崩坏自检优先：数值判据全过（runs/visible=true）也拦', () => {
  const dir = tmp('priority')
  mkdirSync(join(dir, 'shots'), { recursive: true })
  writePng(join(dir, 'shots'), 'blank.png', 32, 32, solid(32, 32, [0, 0, 0]))
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots: ['shots/blank.png'] }))
  const out = checks.verified(dir)
  assert.equal(out.length >= 1, true)
  assert.match(out[0], /崩坏自检/, '崩坏自检要排在问题列表最前面：' + out.join('｜'))
})