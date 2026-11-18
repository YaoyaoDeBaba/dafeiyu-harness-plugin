// 先验区间（R2）+ 执行员卡片（S1）+ 只许读票面文件（S2）+ 验收实测（S4）自测
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const run = (...a) => spawnSync(process.execPath, [PIPE, ...a], { encoding: 'utf8' })

const PRIOR_KEYS = ['cloudDarkFrac', 'cloudBrightFrac']        // 只有判别量必须有判据
const PARAM_KEYS = ['sigma_m', 'ambient_frac', 'lightSteps', 'powder']
const MEDIANS = { sigma_m: 0.05, ambient_frac: 0.03, lightSteps: 6, powder: 0.6, cloudDarkFrac: 0.25, cloudBrightFrac: 0.02 }

function makeRun(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-r2-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n示例\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false }))
  const extracted = [...PRIOR_KEYS, ...PARAM_KEYS].map((k) => ({ what: k, value: MEDIANS[k], min: MEDIANS[k] * 0.8, max: MEDIANS[k] * 1.2 }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  const criteria = opts.criteria || PRIOR_KEYS.map((k) => ({ id: k, metric: k, target: MEDIANS[k], dir: 'two-sided' }))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify(Object.assign({
    restate: '测试', confirmed: true, domain: 'volumetric-cloud',
    anchors: [{ kind: 'text', ref: 'x', why: 'x' }],
    criteria,
  }, opts.intent || {})))
  // 1.10 有必填表单
  run('step', '--run', dir)
  const fp = join(dir, 'forms', '1.10-translate3.json')
  try {
    const f = JSON.parse(readFileSync(fp, 'utf8'))
    for (const x of f.fields) x.value = x.type === 'list' ? ['x'] : 'x'
    writeFileSync(fp, JSON.stringify(f))
  } catch { /* 没表单就算了 */ }
  return dir
}
const doneIntent = (dir) => run('done', '--run', dir, '--stage', '1.10-translate3')

test('① 先验区间全部落在带内 → 放行', () => {
  const dir = makeRun()
  const r = doneIntent(dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('② 靶超出先验区间 → 挡住，并点名区间与理由', () => {
  const dir = makeRun()
  // 把 cloudBrightFrac 的实测区间挪宽，让靶能落在实测里、但故意破先验（先验上限 0.06）
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  const e = rj.extracted.find((x) => x.what === 'cloudBrightFrac')
  e.value = 0.3; e.min = 0.2; e.max = 0.4
  writeFileSync(join(dir, 'research.json'), JSON.stringify(rj))
  const it = JSON.parse(readFileSync(join(dir, 'intent.json'), 'utf8'))
  it.criteria.find((c) => c.metric === 'cloudBrightFrac').target = 0.3
  writeFileSync(join(dir, 'intent.json'), JSON.stringify(it))
  const r = doneIntent(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /不在先验区间/)
})

test('③ 写 priorException 就能破例', () => {
  const dir = makeRun()
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  const e = rj.extracted.find((x) => x.what === 'cloudBrightFrac')
  e.value = 0.3; e.min = 0.2; e.max = 0.4
  writeFileSync(join(dir, 'research.json'), JSON.stringify(rj))
  const it = JSON.parse(readFileSync(join(dir, 'intent.json'), 'utf8'))
  const c = it.criteria.find((x) => x.metric === 'cloudBrightFrac')
  c.target = 0.3
  c.priorException = '这一轮故意做过曝对照'
  writeFileSync(join(dir, 'intent.json'), JSON.stringify(it))
  const r = doneIntent(dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('④ 先验里的判别量没有对应判据 → 挡住（治判据缺项）', () => {
  const criteria = PRIOR_KEYS.filter((k) => k !== 'cloudDarkFrac').map((k) => ({ id: k, metric: k, target: MEDIANS[k], dir: 'two-sided' }))
  const dir = makeRun({ criteria })
  const r = doneIntent(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /cloudDarkFrac/)
  assert.match(r.stdout, /priorWaived|没有对应判据/)
})

test('⑤ priorWaived 写理由就能不测', () => {
  const criteria = PRIOR_KEYS.filter((k) => k !== 'cloudDarkFrac').map((k) => ({ id: k, metric: k, target: MEDIANS[k], dir: 'two-sided' }))
  const dir = makeRun({ criteria, intent: { priorWaived: [{ key: 'cloudDarkFrac', why: '这一轮只做构图，明暗下一轮' }] } })
  const r = doneIntent(dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('⑥ 执行员卡片：四段齐全 + 允许读 + 窄票逐条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-card-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, split: true }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [{ what: 'x', value: 1, min: 0.5, max: 1.5 }] }))
  writeFileSync(join(dir, 'split.json'), JSON.stringify({ tasks: [
    { id: 'T1', goal: '改云体', files: ['src/cloud.js'], accept: [{ id: 'topCoverage', target: 0.7, dir: 'two-sided' }] },
    { id: 'T2', goal: '改闪电', files: ['src/bolt.js'], accept: [{ id: 'p99', target: 0.7, dir: 'two-sided' }] },
  ] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2a-split-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  run('step', '--run', dir)
  const ticket = JSON.parse(readFileSync(join(dir, 'tickets', '2.2-exec-r1.json'), 'utf8'))
  for (const pat of [/执行员卡片/, /允许读/, /停止条件/, /交活字段/, /窄票 T1/, /窄票 T2/]) assert.match(ticket.prompt, pat)
  assert.ok(ticket.prompt.length < 1500, '卡片+票面要短，现在 ' + ticket.prompt.length + ' 字符')
})

test('⑦ 读了票面之外的文件 → 交活被挡（S2）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-read-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, split: true }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [{ what: 'x', value: 1, min: 0.5, max: 1.5 }] }))
  writeFileSync(join(dir, 'split.json'), JSON.stringify({ tasks: [
    { id: 'T1', goal: 'g', files: ['src/cloud.js'], accept: [{ id: 'a', target: 1, dir: 'two-sided' }] },
    { id: 'T2', goal: 'g', files: ['src/bolt.js'], accept: [{ id: 'b', target: 1, dir: 'two-sided' }] },
  ] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2a-split-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  const base = { changes: ['x'], shot: 'a.png', abShots: ['ab.png'] }
  const mk = (readFiles) => writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify(Object.assign({}, base, {
    readFiles,
    tasks: [
      { id: 'T1', variants: [{ name: 'b', isBaseline: true, shot: 'a.png' }, { name: '1', shot: 'a.png' }, { name: '2', shot: 'a.png' }], abShots: ['ab.png'], acceptEvidence: [{ id: 'a', measured: 1 }] },
      { id: 'T2', variants: [{ name: 'b', isBaseline: true, shot: 'a.png' }, { name: '1', shot: 'a.png' }, { name: '2', shot: 'a.png' }], abShots: ['ab.png'], acceptEvidence: [{ id: 'b', measured: 1 }] },
    ],
  })))
  mk(['src/cloud.js', 'src/secret.sh'])
  const bad = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(bad.status, 1, bad.stdout)
  assert.match(bad.stdout, /读了票面之外的文件/)
  mk(['src/cloud.js', 'src/bolt.js'])
  const good = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(good.status, 0, good.stdout + good.stderr)
})

test('⑧ 窄票的验收没给实测 → 挡住（S4）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-acc-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, split: true }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [{ what: 'x', value: 1, min: 0.5, max: 1.5 }] }))
  writeFileSync(join(dir, 'split.json'), JSON.stringify({ tasks: [
    { id: 'T1', goal: 'g', files: ['a.js'], accept: [{ id: 'a', target: 1, dir: 'two-sided' }] },
    { id: 'T2', goal: 'g', files: ['b.js'], accept: [{ id: 'b', target: 1, dir: 'two-sided' }] },
  ] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2a-split-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({
    changes: ['x'], shot: 'a.png', readFiles: [],
    tasks: [
      { id: 'T1', variants: [{ name: 'b', isBaseline: true, shot: 'a.png' }, { name: '1', shot: 'a.png' }, { name: '2', shot: 'a.png' }], abShots: ['ab.png'] },
      { id: 'T2', variants: [{ name: 'b', isBaseline: true, shot: 'a.png' }, { name: '1', shot: 'a.png' }, { name: '2', shot: 'a.png' }], abShots: ['ab.png'], acceptEvidence: [{ id: 'b', measured: 1 }] },
    ],
  }))
  const r = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /没给实测 acceptEvidence：a/)
})
