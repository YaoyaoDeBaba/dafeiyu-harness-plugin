// ref-probe 自测（0.16.0）：参考量测工具必须"算得对"，否则调查员拿到的数是假的。
//
// 覆盖：
//   ① 合成像素的精确断言（全黑 / 半白半黑 / 纯蓝）
//   ② 真 PNG 解码（包里的 icon.png）能出数
//   ③ summarize 的 min/med/max
//   ④ 弄坏能红：宽高对不上时不许静默给数
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { decodePng, probeImage, summarize } from '../harness/ref-probe.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function synth(w, h, fn) {
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4
      const [r, g, b, a] = fn(x, y)
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a ?? 255
    }
  }
  return { width: w, height: h, channels: 4, data }
}

test('① 全黑 4×4：亮度和冷色全 0', () => {
  const r = probeImage(synth(4, 4, () => [0, 0, 0]))
  assert.equal(r.mean, 0)
  assert.equal(r.coldFrac, 0)
  assert.equal(r.glowFrac, 0)
  assert.equal(r.brightFrac, 0)
  assert.equal(r.nonBlackFrac, 0)
  assert.equal(r.width, 4)
  assert.equal(r.height, 4)
})

test('② 左半白右半黑：mean≈0.5，上部覆盖率按四角背景判', () => {
  const r = probeImage(synth(8, 8, (x) => (x < 4 ? [255, 255, 255] : [0, 0, 0])))
  assert.ok(Math.abs(r.mean - 0.5) < 0.02, 'mean 应约 0.5，实际 ' + r.mean)
  assert.equal(r.coldFrac, 0, '白色 b-r=0，不算冷色')
})

test('③ 纯蓝 (0,0.5,1)：冷色 1、光晕 1、亮部 0', () => {
  const r = probeImage(synth(4, 4, () => [0, 128, 255]))
  assert.equal(r.coldFrac, 1)
  assert.equal(r.glowFrac, 1, 'L≈0.41 落在 0.40~0.75 且偏蓝')
  assert.equal(r.brightFrac, 0, 'L 不到 0.85')
  assert.equal(r.warmFrac, 0)
})

test('④ 真 PNG（包里的 icon.png）能解码并出数', () => {
  const img = decodePng(readFileSync(join(ROOT, 'icon.png')))
  assert.ok(img.width > 0 && img.height > 0)
  const r = probeImage(img)
  assert.ok(Number.isFinite(r.mean))
  assert.ok(r.mean >= 0 && r.mean <= 1)
})

test('⑤ summarize：给出 min / med / max', () => {
  const rows = [0.1, 0.5, 0.9].map((v) => ({ mean: v, coldFrac: v, warmFrac: 0, glowFrac: v, brightFrac: v, p50: v, p95: v, p99: v, topCoverage: v }))
  const s = summarize(rows)
  assert.equal(s.count, 3)
  assert.equal(s.mean.min, 0.1)
  assert.equal(s.mean.med, 0.5)
  assert.equal(s.mean.max, 0.9)
})

test('⑥ 弄坏能红：非法 PNG 头必须抛错，不许返回假数', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /不是 PNG/)
})
