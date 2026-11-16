// 调研闸自测（0.16.0）：有参考图却没量过 → 不许开跑。
//
// 背景（2026-11-16 实战）：agent 拿到参考图没量就拍阈值，判据全错。
// 这条闸把"调查员必须干活"从自觉变成硬错。
//
// 覆盖：
//   ① 有图片锚点 + 没有 research.json → exit 1，错误里点明怎么补
//   ② 有 research.json 且 extracted 非空 → exit 0
//   ③ --no-research 显式跳过 → exit 0（跳过有名字）
//   ④ 没有图片锚点 → 不拦（纯数值目标不需要量参考）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ADAPTER = join(ROOT, 'examples', 'minimal.json')
const ICON = join(ROOT, 'icon.png')

function makeRun({ anchorKind = 'image', research = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-research-gate-'))
  const ref = join(dir, 'ref.png')
  copyFileSync(ICON, ref)
  const intent = {
    version: '2',
    restate: '把观测压缩到目标值附近',
    anchors: [{ kind: anchorKind, ref: anchorKind === 'image' ? ref : '一段描述', why: '同类的参考' }],
    criteria: [{ id: 'cov', anchor: '覆盖面积要接近参考', userWords: '体积差不多就行', howMeasured: '按 luma>40 统计亮区面积占比', weight: 1 }],
    notWanted: ['不要塌成 0'],
    freeVsFixed: { fixed: ['必须是整数'], free: ['迭代路径'] },
    howWeVerify: { human: true, metrics: true, note: '跑完读 report.md 的 best，人再看一眼' },
    uncertain: [],
    confirm: [],
    confirmed: true,
    confirmedBy: 'test',
    confirmedAt: new Date().toISOString()
  }
  writeFileSync(join(dir, 'intent.json'), JSON.stringify(intent, null, 2))
  if (research) writeFileSync(join(dir, 'research.json'), JSON.stringify(research, null, 2))
  return dir
}

const runGate = (dir, extra = []) => spawnSync(process.execPath, [join(ROOT, 'harness', 'intent.mjs'), 'gate', '--out', dir, '--adapter', ADAPTER, ...extra], { encoding: 'utf8' })

test('① 有图片锚点但没量参考 → 硬错并给出补救命令', () => {
  const dir = makeRun()
  const r = runGate(dir)
  assert.equal(r.status, 1, '必须拒跑')
  assert.match(r.stderr, /调研闸/)
  assert.match(r.stderr, /ref-probe\.mjs/, '要告诉人用什么量')
  assert.match(r.stderr, /--no-research/, '要给出显式跳过的方式')
})

test('② 量过了（research.extracted 非空）→ 放行', () => {
  const dir = makeRun({ research: { findings: [], extracted: [{ what: 'mean', value: 0.3, source: 'ref.png' }], changed: [] } })
  const r = runGate(dir)
  assert.equal(r.status, 0, r.stderr || r.stdout)
})

test('③ 显式 --no-research → 放行（跳过有名字）', () => {
  const dir = makeRun()
  const r = runGate(dir, ['--no-research'])
  assert.equal(r.status, 0, r.stderr || r.stdout)
})

test('④ 没有图片锚点（纯数值目标）→ 不拦', () => {
  const dir = makeRun({ anchorKind: 'text' })
  const r = runGate(dir)
  assert.equal(r.status, 0, r.stderr || r.stdout)
})
