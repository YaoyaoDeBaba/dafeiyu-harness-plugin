// changelog-guard.test.mjs —— 防止「插条目时把历史删了」（2026-11-17 实测）
//
// 当天为了在 CHANGELOG 顶部插一条版本记录，只读了文件前 40 行就整篇回写，
// 267 行历史（0.14.1~0.25.0）被删掉，直到 git show --stat 才发现。
// 这个判据只守一件事：正文的版本条目数量与范围不许缩水。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

test('CHANGELOG 正文的版本条目不许缩水', () => {
  const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const entries = (text.match(/^## \d+\.\d+\.\d+/gm) || []).map((l) => l.replace(/^## /, ''))
  assert.ok(entries.length >= 15, 'CHANGELOG 只剩 ' + entries.length + ' 条版本记录，历史疑似被截断')
  assert.ok(entries.includes('0.14.1'), '缺最老那条 0.14.1')
  assert.ok(entries.includes('0.25.0'), '缺 0.25.0')
  // 顶部必须是最大版本（插条目要插在最前面）
  const top = entries[0].match(/\d+\.\d+\.\d+/)[0]
  const max = entries
    .map((e) => e.match(/\d+\.\d+\.\d+/)[0])
    .sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i]
      return 0
    })[0]
  assert.equal(top, max, 'CHANGELOG 顶部不是最高版本（新条目没插到最前）')
})

test('归档文件仍在且含 0.13.x', () => {
  const archive = readFileSync(join(ROOT, 'CHANGELOG-archive.md'), 'utf8')
  assert.ok(archive.includes('0.13.0'), '归档缺 0.13.0')
})
