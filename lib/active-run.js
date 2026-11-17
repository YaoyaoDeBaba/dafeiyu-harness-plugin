// active-run —— 「当前在跑哪个 run」的唯一事实源（2026-11-17 为 UI 加）
//
// 为什么要它：pipeline 是命令行工具，run 目录是用户随手指定���，插件侧的 HTTP 路由
// 不知道「现在在跑哪一个」。所以由 pipeline 每次 status/step/done 时写一个指针文件，
// 插件路由只读它，不在插件里猜路径。
//
// 指针位置可用 DSH_SELFLOOP_STATE 覆盖（测试用），默认 ~/.dsh/dsh-selfloop/active-run.json。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATE_DIR = process.env.DSH_SELFLOOP_STATE || join(homedir(), '.dsh', 'dsh-selfloop')
export const POINTER = join(STATE_DIR, 'active-run.json')

/** 会话级指针：一个 DSH 会话一个订单（用户规则），文件名带会话键。 */
export function pointerFor(sessionKey) {
  const safe = String(sessionKey || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return safe ? join(STATE_DIR, 'active-run-' + safe + '.json') : POINTER
}

/** pipeline 侧调用：记下「现在在跑哪个 run」。失败只吞掉，绝不打断流水线。 */
export function writePointer(runDir, extra, sessionKey) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const body = JSON.stringify({ runDir, at: new Date().toISOString(), ...(extra || {}) }, null, 2)
    writeFileSync(pointerFor(sessionKey), body, 'utf8')
    // 同时写一份全局指针：单会话场景（以及老版本行为）靠它
    if (sessionKey) writeFileSync(POINTER, body, 'utf8')
    return true
  } catch {
    return false
  }
}

export function readPointer(sessionKey) {
  const paths = sessionKey ? [pointerFor(sessionKey), POINTER] : [POINTER]
  for (const file of paths) {
    try {
      const p = JSON.parse(readFileSync(file, 'utf8'))
      if (p && typeof p.runDir === 'string') return p
    } catch { /* 下一个 */ }
  }
  return undefined
}

/** 兜底：在 <base>/runs 里挑「最近被动过」的那个目录（看 pipeline 痕迹文件的最晚 mtime）。 */
export function findRecentRun(baseDir) {
  const runsDir = join(baseDir || process.cwd(), 'runs')
  if (!existsSync(runsDir)) return undefined
  let best
  let bestAt = 0
  for (const name of readdirSync(runsDir)) {
    const dir = join(runsDir, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    let at = 0
    for (const f of ['budget.json', 'intent.json', 'verify.json', 'decide.json']) {
      try {
        const m = statSync(join(dir, f)).mtimeMs
        if (m > at) at = m
      } catch {
        /* 缺就跳过 */
      }
    }
    try {
      for (const f of readdirSync(join(dir, 'stages'))) {
        const m = statSync(join(dir, 'stages', f)).mtimeMs
        if (m > at) at = m
      }
    } catch {
      /* 没有 stages */
    }
    if (at > bestAt) {
      bestAt = at
      best = dir
    }
  }
  return best
}

/** 三档取值：显式 hint > 指针 > 最近被动过的 run。 */
export function resolveRunDir(hint, sessionKey) {
  if (hint && existsSync(hint)) return hint
  const p = readPointer(sessionKey)
  if (p && existsSync(p.runDir)) return p.runDir
  return findRecentRun(process.cwd())
}