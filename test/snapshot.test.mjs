// 交活即快照三件套（A5·㊱）—— 今晚丢了用户认可的那版云：代码能找回，参数与场景序列化值全丢。
//
// 判据：
//   ① writeSnapshot 三件套落位（rounds/r<N>/snapshot/：code/ + scene-params.json + params.md）
//   ② --tag 走 snapshot-<名字>/，且 missingPieces() 能如实报缺
//   ③ CLI 手动快照：齐全 exit 0、缺件 exit 3
//   ④ pipeline done --stage 2.2-exec-r1：缺快照 → verify.caveat 留痕，但**不硬拦**（exit 0）
//   ⑤ 三件齐全时 pipe 不再写 verify.json（不留假 caveat）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const SNAP = join(ROOT, 'harness', 'snapshot.mjs')
const { writeSnapshot, missingPieces, snapshotDir, roundOfRun, paramsMarkdown } = await import('../harness/snapshot.mjs')

const tmp = (tag) => mkdtempSync(join(tmpdir(), 'sl-snap-' + tag + '-'))
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

function makeRun(tag) {
  const dir = tmp(tag)
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n把雷云做得像参考片\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, userReview: false, resupply: true }))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  return dir
}

/** 把 run 推到「当前节点 = 2.2-exec-r1」：阶段 1 全 done + 2.1-plan-r1 done + 本轮台账 */
function reachedExec(dir) {
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done', at: new Date().toISOString() }))
  }
  mkdirSync(join(dir, 'shots'), { recursive: true })
  writeFileSync(join(dir, 'shots', 'r1.png'), 'fake-png')
  // 2026-11-18：执行员交活现在有「工作量下限」（variants ≥3 + 1 张 A/B 帧），夹具按契约补齐
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({
    shot: 'shots/r1.png',
    changes: [{ path: 'Assets/Cloud.cs' }],
    params: [{ name: 'cloudCoverage', from: 0.6, to: 0.88, why: '参考片更厚' }],
    variants: [{ name: 'v1', shot: 'shots/r1.png' }, { name: 'v2', shot: 'shots/r1.png' }, { name: 'v3', shot: 'shots/r1.png' }],
    abShots: ['shots/r1.png'],
    readFiles: [],
  }))
  return dir
}

test('① writeSnapshot：三件套落 rounds/r1/snapshot/，missingPieces 为空', () => {
  const dir = makeRun('write')
  const src = join(dir, 'Cloud.cs')
  writeFileSync(src, '// 改过的源文件\n')
  const r = writeSnapshot(dir, { files: [src], scene: { cloudCoverage: 0.88, mat: 'CloudMat' }, params: 'cloudCoverage 0.6 → 0.88（参考片更厚）' })
  assert.equal(r.dir, join(dir, 'rounds', 'r1', 'snapshot'))
  assert.deepEqual(r.code, ['Cloud.cs'])
  assert.equal(r.scene, true)
  assert.equal(r.params, true)
  assert.deepEqual(r.missing, [], '三件齐全时不许报缺：' + JSON.stringify(r.missing))
  assert.ok(existsSync(join(r.dir, 'code', 'Cloud.cs')))
  assert.deepEqual(readJson(join(r.dir, 'scene-params.json')), { cloudCoverage: 0.88, mat: 'CloudMat' })
  assert.match(readFileSync(join(r.dir, 'params.md'), 'utf8'), /0\.6 → 0\.88|0\.88/)
})

test('② --tag 走 snapshot-<tag>/；缺件如实报；台账参数能生成 params.md', () => {
  const dir = reachedExec(makeRun('tag'))
  assert.equal(roundOfRun(dir), 1)
  const r = writeSnapshot(dir, { tag: 'after-fix', round: 1 })
  assert.equal(r.dir, join(dir, 'rounds', 'r1', 'snapshot-after-fix'))
  // scene 没给来源 → 缺它（不许编一份假的出来）
  assert.ok(r.missing.includes('scene-params.json'), '没导出场景参数就该报缺：' + JSON.stringify(r.missing))
  // 台账里 changes[].path 指向的文件不存在 → code/ 报缺（只认真实文件）
  assert.ok(r.missing.includes('code/'), '没有真实源文件就该报 code/ 缺：' + JSON.stringify(r.missing))
  assert.match(readFileSync(join(r.dir, 'params.md'), 'utf8'), /cloudCoverage/, '台账 params 要能自动编出 params.md')
  assert.match(readFileSync(join(r.dir, 'params.md'), 'utf8'), /旧值/, 'params.md 表头要写旧值→新值→为什么')

  // 三件都不给 → 三件全缺
  const bare = makeRun('bare')
  assert.deepEqual(missingPieces(bare, 1), ['code/', 'scene-params.json', 'params.md'])
  assert.equal(snapshotDir(bare, 1), join(bare, 'rounds', 'r1', 'snapshot'))
})

test('②b paramsMarkdown：数组与对象两种写法都能读，空参数老实写"没有记录"', () => {
  const md = paramsMarkdown([{ name: 'a', from: 1, to: 2, why: '更亮' }], 2)
  assert.match(md, /第 2 轮/)
  assert.match(md, /\| a \| 1 \| 2 \| 更亮 \|/)
  const md2 = paramsMarkdown({ b: { from: 3, to: 4, why: '更粗' } }, 3)
  assert.match(md2, /\| b \| 3 \| 4 \| 更粗 \|/)
  assert.match(paramsMarkdown(null, 1), /没有参数记录/)
})

test('③ CLI：齐全 → exit 0 且三件落盘；缺件 → exit 3（不装成功）', () => {
  const dir = makeRun('cli')
  const src = join(dir, 'Beam.cs')
  writeFileSync(src, '// beam\n')
  const scene = join(dir, 'scene.json')
  writeFileSync(scene, JSON.stringify({ beamWidth: 0.3 }))
  const params = join(dir, 'p.md')
  writeFileSync(params, 'beamWidth 0.2 → 0.3（参考更粗）\n')
  const ok = spawnSync(process.execPath, [SNAP, '--run', dir, '--tag', 'manual', '--file', src, '--scene', scene, '--params', params, '--json'], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const out = JSON.parse(ok.stdout)
  assert.equal(out.dir, join(dir, 'rounds', 'r1', 'snapshot-manual'))
  assert.deepEqual(out.missing, [])
  for (const f of ['code/Beam.cs', 'scene-params.json', 'params.md']) assert.ok(existsSync(join(out.dir, f)), '缺 ' + f)

  const bad = spawnSync(process.execPath, [SNAP, '--run', makeRun('cli-bad')], { encoding: 'utf8' })
  assert.equal(bad.status, 3, '缺件要 exit 3（别装成成功）')
  assert.match(bad.stdout + bad.stderr, /缺件|params\.md/)
})

test('④ pipeline done 2.2-exec-r1：缺快照 → 写 verify.caveat 留痕，但不硬拦（exit 0）', () => {
  const dir = reachedExec(makeRun('pipe-miss'))
  const r = spawnSync(process.execPath, [PIPE, 'done', '--run', dir, '--stage', '2.2-exec-r1'], { encoding: 'utf8' })
  assert.equal(r.status, 0, '缺快照不许硬拦（留痕即可）：' + r.stdout + r.stderr)
  assert.match(r.stdout, /快照留痕/, '终端要说一句')
  const v = readJson(join(dir, 'verify.json'))
  assert.ok(Array.isArray(v.caveat) && v.caveat.length >= 1, 'verify.caveat 要列缺件：' + JSON.stringify(v))
  const joined = v.caveat.join(' ');
  for (const piece of ['code/', 'scene-params.json', 'params.md']) assert.ok(joined.includes(piece), 'caveat 要写清缺 ' + piece)
  assert.match(joined, /r1 快照不全/)
  // 节点本身仍然要记 done
  assert.equal(readJson(join(dir, 'stages', '2.2-exec-r1.json')).status, 'done')
})

test('⑤ 三件齐全 → pipeline 不写 verify.json（不留假 caveat）', () => {
  const dir = reachedExec(makeRun('pipe-ok'))
  mkdirSync(join(dir, 'rounds', 'r1', 'snapshot', 'code'), { recursive: true })
  writeFileSync(join(dir, 'rounds', 'r1', 'snapshot', 'code', 'Cloud.cs'), '// ok\n')
  writeFileSync(join(dir, 'rounds', 'r1', 'snapshot', 'scene-params.json'), JSON.stringify({ cloudCoverage: 0.88 }))
  writeFileSync(join(dir, 'rounds', 'r1', 'snapshot', 'params.md'), 'cloudCoverage 0.6 → 0.88\n')
  const r = spawnSync(process.execPath, [PIPE, 'done', '--run', dir, '--stage', '2.2-exec-r1'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout, /快照留痕/)
  assert.equal(existsSync(join(dir, 'verify.json')), false, '三件齐全时不该凭空生出 verify.json')
})
