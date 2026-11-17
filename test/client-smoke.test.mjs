// client-smoke.test.mjs —— 真跑一遍客户端 bundle（子进程隔离，避免污染全局）
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

test('dist/client.cjs 在假宿主里能真加载并挂上两个槽位', () => {
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-client.mjs')], { stdio: 'pipe' })
  const out = execFileSync(process.execPath, [join(ROOT, 'tools', 'smoke-client.cjs')], { stdio: 'pipe' }).toString()
  assert.match(out, /smoke-client 通过/)
  assert.match(out, /composer\.dock#dsh-selfloop-chip/)
  assert.match(out, /header\.actions#dsh-selfloop-header/)
  assert.match(out, /composer\.dock#dsh-selfloop-new/)
})
