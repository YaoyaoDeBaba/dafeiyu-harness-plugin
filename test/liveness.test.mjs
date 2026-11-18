// 活性扫描（试刀教训）+ plan 里 variables 必须扫过活性
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { withParam } from '../harness/liveness-core.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const LIVE = join(ROOT, 'harness', 'liveness.mjs')
const ICON = join(ROOT, 'icon.png')

/** 合成一张有梯度和噪声的 PNG（纯色图会被崩坏自检挡掉） */
function synthPng(path, w = 64, h = 64) {
  const raw = []
  for (let y = 0; y < h; y += 1) {
    raw.push(0)
    for (let x = 0; x < w; x += 1) {
      const n = ((x * 7 + y * 13) % 17) / 17
      const v = Math.round(40 + 150 * (x / w) * (y / h) + 20 * n)
      raw.push(v, v, Math.min(255, v + 12))
    }
  }
  const idat = deflateSync(Buffer.from(raw))
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  let table = null
  function crc32(buf) {
    if (!table) {
      table = new Int32Array(256)
      for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c }
    }
    let c = -1
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
    return c ^ -1
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]))
  return path
}
const run = (...a) => spawnSync(process.execPath, [PIPE, ...a], { encoding: 'utf8' })
const live = (...a) => spawnSync(process.execPath, [LIVE, ...a], { encoding: 'utf8' })

/** 假抓帧器：参数里带 live=1 就换一张图（证明"会动"），否则原样复制（死参数） */
function fakeCapture(dir) {
  const script = join(dir, 'cap.mjs')
  writeFileSync(script, [
    "import { copyFileSync, existsSync } from 'node:fs'",
    "const q = process.argv[process.argv.indexOf('--query') + 1] || ''",
    "const out = process.argv[process.argv.indexOf('--out') + 1]",
    "const srcLive = q.includes('live=1') ? " + JSON.stringify(ICON) + " : (q.includes('dead=1') ? " + JSON.stringify(ICON) + " : " + JSON.stringify(ICON) + ")",
    "copyFileSync(srcLive, out)",
  ].join('\n'), 'utf8')
  // 让"活参数"真的换字节：用 live=1 时写一个不同的文件（把 icon 复制成另一个名字不行，得改内容）
  writeFileSync(script, [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "const q = process.argv[process.argv.indexOf('--query') + 1] || ''",
    "const out = process.argv[process.argv.indexOf('--out') + 1]",
    "const base = readFileSync(" + JSON.stringify(ICON) + ")",
    "const buf = Buffer.from(base)",
    "// live=1 时把最后一个字节改掉 → 逐字节不同；dead 参数不动",
    "if (q.includes('live=1')) buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff",
    "writeFileSync(out, buf)",
  ].join('\n'), 'utf8')
  return script
}

function makeRun(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-live-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, ...(opts.budget || {}) }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [{ what: 'x', value: 1, min: 0.5, max: 1.5 }] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  // 2.1 表单
  mkdirSync(join(dir, 'forms'), { recursive: true })
  writeFileSync(join(dir, 'forms', '2.1-plan-r1.json'), JSON.stringify({
    stage: '2.1-plan-r1',
    fields: [{ id: 'orders', type: 'list', value: ['o1'] }, { id: 'executor', type: 'text', value: 'm' },
             { id: 'variables', type: 'list', value: ['liveParam'] }, { id: 'risks', type: 'list', value: ['r'] }],
  }))
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({
    round: 1, orders: [{ id: 'o1', task: 't', files: ['a.js'] }], executor: { model: 'm' },
    variables: opts.variables || ['liveParam'],
  }))
  return dir
}

test('① liveness：活参数判 live、死参数判 dead（逐字节相同）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-lv-'))
  const cap = fakeCapture(dir)
  const probe = join(dir, 'probe.json')
  writeFileSync(probe, JSON.stringify({
    capture: 'node "' + cap + '" --out {out} --query "{params}"',
    baseline: 'live=0',
    params: { liveParam: ['live=0', 'live=1'], deadParam: ['dead=0', 'dead=1'] },
  }))
  const r = live('--run', dir, '--probe', probe)
  assert.equal(r.status, 3, '有死参数要 exit 3：' + r.stdout + r.stderr)
  const out = JSON.parse(readFileSync(join(dir, 'params-liveness.json'), 'utf8'))
  const byName = Object.fromEntries(out.params.map((p) => [p.name, p.status]))
  assert.equal(byName.liveParam, 'live')
  assert.equal(byName.deadParam, 'dead')
})

test('② plan：没扫活性 → 2.1 挡（并给出命令）', () => {
  const dir = makeRun()
  const r = run('done', '--run', dir, '--stage', '2.1-plan-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /params-liveness\.json/)
  assert.match(r.stdout, /liveness\.mjs/)
})

test('③ plan：死参数进了 variables → 挡', () => {
  const dir = makeRun({ variables: ['deadParam'] })
  writeFileSync(join(dir, 'params-liveness.json'), JSON.stringify({
    capture: 'node cap.mjs', baseline: 'b', params: [{ name: 'deadParam', status: 'dead', evidence: {} }],
  }))
  const r = run('done', '--run', dir, '--stage', '2.1-plan-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /死参数/)
})

test('④ plan：变量没扫过 → 挡', () => {
  const dir = makeRun({ variables: ['liveParam'] })
  writeFileSync(join(dir, 'params-liveness.json'), JSON.stringify({
    capture: 'node cap.mjs', baseline: 'b', params: [{ name: 'other', status: 'live', evidence: {} }],
  }))
  const r = run('done', '--run', dir, '--stage', '2.1-plan-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /没做过活性扫描/)
})

test('⑤ plan：全活 → 放行', () => {
  const dir = makeRun({ variables: ['liveParam'] })
  writeFileSync(join(dir, 'params-liveness.json'), JSON.stringify({
    capture: 'node cap.mjs', baseline: 'b', params: [{ name: 'liveParam', status: 'live', evidence: { shaChanged: [true, true] } }],
  }))
  const r = run('done', '--run', dir, '--stage', '2.1-plan-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('⑥ budget.probe=false → 不要求活性扫描（老 run 退路）', () => {
  const dir = makeRun({ budget: { probe: false } })
  const r = run('done', '--run', dir, '--stage', '2.1-plan-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('⑦ withParam：同名键替换而不是追加（追加会让 URLSearchParams 取首个 = 参数白改）', () => {
  assert.equal(withParam('a=1&b=2', 'a', '9'), 'a=9&b=2')
  assert.equal(withParam('a=1', 'c', '3'), 'a=1&c=3')
  assert.equal(withParam('', 'a', '1'), 'a=1')
})

test('⑧ capture 支持 argv 数组（字符串走 shell 时查询串里的 & 会被吞掉）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-argv-'))
  const cap = fakeCapture(dir)
  const probe = join(dir, 'probe.json')
  writeFileSync(probe, JSON.stringify({
    capture: [process.execPath, cap, '--out', '{out}', '--query', '{params}'],
    baseline: 'live=0',
    params: { liveParam: ['live=0', 'live=1'] },
  }))
  const r = live('--run', dir, '--probe', probe)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(readFileSync(join(dir, 'params-liveness.json'), 'utf8'))
  assert.equal(out.params[0].status, 'live')
})

// ── 快照必须硬拦（2026-11-18：昨晚 mimo 余额耗尽、成果没存下来，无法复原）──
test('⑨ 2.3 验收：缺快照三件套 → 硬拦（以前只写 caveat，等于没规矩）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-snap-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, probe: false }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [{ what: 'x', value: 1, min: 0.5, max: 1.5 }] }))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({ restate: 'x', confirmed: true, anchors: [{ kind: 'text', ref: 'x', why: 'x' }], criteria: [] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ changes: ['x'], shot: 'a.png' }))
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots: [] }))
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /快照不全/)
  assert.match(r.stdout, /snapshot\.mjs/)
})

test('⑩ budget.requireSnapshot=false → 老 run 退路', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-snap2-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, probe: false, requireSnapshot: false }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [] }))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({ restate: 'x', confirmed: true, anchors: [{ kind: 'text', ref: 'x', why: 'x' }], criteria: [] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ changes: ['x'], shot: 'a.png' }))
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots: [] }))
  mkdirSync(join(dir, 'forms'), { recursive: true })
  writeFileSync(join(dir, 'forms', '2.3-verify-r1.json'), JSON.stringify({ stage: '2.3-verify-r1', fields: [
    { id: 'runsEvidence', type: 'text', value: 'ok' }, { id: 'visibleEvidence', type: 'text', value: 'ok' },
    { id: 'caveat', type: 'list', value: ['无'] }, { id: 'notVerified', type: 'list', value: ['无'] },
  ] }))
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

// ── 标量判据也进 2.3 闸（回放测试暴露：灰雾云暗部 0.039 却通过）──
function verifyRun(band) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-scalar-'))
  for (const d of ['stages', 'rounds', 'forms']) mkdirSync(join(dir, d), { recursive: true })
  const snap = join(dir, 'rounds', 'r1', 'snapshot')
  mkdirSync(join(snap, 'code'), { recursive: true })
  writeFileSync(join(snap, 'scene-params.json'), '{}')
  writeFileSync(join(snap, 'params.md'), '# s\n')
  writeFileSync(join(snap, 'code', 'a.js'), '//\n')
  writeFileSync(join(join(dir, 'rounds'), '01.json'), JSON.stringify({ changes: ['x'], shot: 'a.png' }))
  writeFileSync(join(dir, 'requirement.md'), '# r\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, probe: false }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [{ what: 'mean', value: (band[0] + band[1]) / 2, min: band[0], max: band[1] }] }))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({ restate: 'r', confirmed: true, anchors: [{ kind: 'image', ref: 'x', why: 'x' }], criteria: [{ id: 'C1', metric: 'mean', target: (band[0] + band[1]) / 2, dir: 'two-sided' }] }))
  writeFileSync(join(dir, 'forms', '2.3-verify-r1.json'), JSON.stringify({ stage: '2.3-verify-r1', fields: [
    { id: 'runsEvidence', type: 'text', value: 'ok' }, { id: 'visibleEvidence', type: 'text', value: 'ok' },
    { id: 'caveat', type: 'list', value: ['无'] }, { id: 'notVerified', type: 'list', value: ['无'] }] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  const shot = synthPng(join(dir, 'shot.png'))
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots: [shot] }))
  return dir
}

test('⑪ 标量判据出带 → 2.3 拦（灰雾云那个洞）', () => {
  const dir = verifyRun([0.95, 1.0])      // 图标明显不在这个亮度带里
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /判据 C1 出带/)
})

test('⑫ 标量判据在带内 → 放行', () => {
  const dir = verifyRun([0.0, 1.0])
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

// ── lite 模式：标准已给全时跳过调研/吸收/二次转译（A/B 里这几步是纯开销）──
test('⑬ lite 模式：节点表只剩必须的闸', async () => {
  const m = await import('../harness/pipeline.mjs')
  const full = { research: 'low', maxRounds: 1, useCritic: true, userReview: false, resupply: false, split: false, probe: true, mode: 'full' }
  const lite = Object.assign({}, full, { mode: 'lite' })
  const a = m.phase1Nodes(full).map((n) => n.id)
  const b = m.phase1Nodes(lite).map((n) => n.id)
  assert.ok(a.length > b.length, 'lite 的节点必须更少：' + a.length + ' vs ' + b.length)
  assert.ok(!b.some((x) => x.includes('research')), 'lite 不该有调研节点：' + b.join(','))
  assert.ok(!b.some((x) => x.includes('absorb') || x.includes('translate2')), 'lite 不该有吸收/二次转译：' + b.join(','))
  const ra = m.roundNodes(1, full).map((n) => n.id)
  const rb = m.roundNodes(1, lite).map((n) => n.id)
  assert.ok(!rb.some((x) => x.includes('critique')), 'lite 跳过观察员：' + rb.join(','))
  assert.ok(rb.includes('2.3-verify-r1'), 'lite 仍必须保留验收闸')
  assert.ok(rb.includes('2.2-exec-r1'), 'lite 仍必须保留执行节点')
})

// ── 判据自查闸：掩膜只罩亮带 / 阈值敏感 → 1.10 不许过 ──
function intentRun(extracted, intentExtra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-maskgate-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# r\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, probe: false }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted }))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify(Object.assign({ restate: 'r', confirmed: true,
    anchors: [{ kind: 'image', ref: 'x', why: 'x' }], criteria: [{ id: 'C1', metric: 'topCoverage', target: 0.7, dir: 'two-sided' }] }, intentExtra)))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  // 让 step 生成空白表单，再按字段类型填满（字段名以 forms.mjs 为准，别硬编码）
  run('step', '--run', dir)
  const fp = join(dir, 'forms', '1.10-translate3.json')
  if (existsSync(fp)) {
    const f = JSON.parse(readFileSync(fp, 'utf8'))
    for (const x of (f.fields || [])) x.value = x.type === 'list' ? ['x', 'y'] : 'x'
    writeFileSync(fp, JSON.stringify(f))
  }
  return dir
}

test('⑭ 掩膜只罩住亮带（bandMax 0.9）→ 1.10 挡住', () => {
  const dir = intentRun([{ what: 'topCoverage', value: 0.7, min: 0.6, max: 0.8 },
    { what: 'maskRowBandMax', value: 0.9 }, { what: 'maskSensitivity', value: 0.1 }])
  const r = run('done', '--run', dir, '--stage', '1.10-translate3')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /掩膜健康度不过/)
})

test('⑮ 掩膜太敏感（换阈值结论就翻）→ 1.10 挡住', () => {
  const dir = intentRun([{ what: 'topCoverage', value: 0.7, min: 0.6, max: 0.8 },
    { what: 'maskRowBandMax', value: 0.2 }, { what: 'maskSensitivity', value: 0.4 }])
  const r = run('done', '--run', dir, '--stage', '1.10-translate3')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /掩膜敏感性不过/)
})

test('⑯ 写 maskAccepted 承认风险 → 放行', () => {
  const dir = intentRun([{ what: 'topCoverage', value: 0.7, min: 0.6, max: 0.8 },
    { what: 'maskRowBandMax', value: 0.9 }, { what: 'maskSensitivity', value: 0.4 }], { maskAccepted: true })
  const r = run('done', '--run', dir, '--stage', '1.10-translate3')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

// ── 判据必须可量（用户点破：走 selfloop 却连"做完"的标准都达不到）──
test('⑰ 判据没有量法 → 2.3 必须挡（以前静默跳过）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-unmeasurable-'))
  for (const d of ['stages', 'rounds', 'forms']) mkdirSync(join(dir, d), { recursive: true })
  const snap = join(dir, 'rounds', 'r1', 'snapshot')
  mkdirSync(join(snap, 'code'), { recursive: true })
  writeFileSync(join(snap, 'scene-params.json'), '{}'); writeFileSync(join(snap, 'params.md'), '# s\n'); writeFileSync(join(snap, 'code', 'a.js'), '//\n')
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ changes: ['x'], shot: 'a.png' }))
  writeFileSync(join(dir, 'requirement.md'), '# r\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, probe: false }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [] }))
  // 判据用了根本没有量法的指标名
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({ restate: 'r', confirmed: true, anchors: [{ kind: 'image', ref: 'x', why: 'x' }],
    criteria: [{ id: 'C1', metric: 'horizonSagPx', target: 1, dir: 'upper' }] }))
  writeFileSync(join(dir, 'forms', '2.3-verify-r1.json'), JSON.stringify({ stage: '2.3-verify-r1', fields: [
    { id: 'runsEvidence', type: 'text', value: 'ok' }, { id: 'visibleEvidence', type: 'text', value: 'ok' },
    { id: 'caveat', type: 'list', value: ['无'] }, { id: 'notVerified', type: 'list', value: ['无'] }] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  const shot = synthPng(join(dir, 'shot.png'))
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots: [shot] }))
  const r = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r.status, 1, '量不了的判据必须挡住：' + r.stdout)
  assert.match(r.stdout, /没法量/)
})

test('⑱ 人工判据要签字（manual + verify.manualSignoff）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-manual-'))
  for (const d of ['stages', 'rounds', 'forms']) mkdirSync(join(dir, d), { recursive: true })
  const snap = join(dir, 'rounds', 'r1', 'snapshot')
  mkdirSync(join(snap, 'code'), { recursive: true })
  writeFileSync(join(snap, 'scene-params.json'), '{}'); writeFileSync(join(snap, 'params.md'), '# s\n'); writeFileSync(join(snap, 'code', 'a.js'), '//\n')
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify({ changes: ['x'], shot: 'a.png' }))
  writeFileSync(join(dir, 'requirement.md'), '# r\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false, probe: false }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [] }))
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({ restate: 'r', confirmed: true, anchors: [{ kind: 'image', ref: 'x', why: 'x' }],
    criteria: [{ id: 'C1', manual: true, what: '观感是否像 3A' }] }))
  writeFileSync(join(dir, 'forms', '2.3-verify-r1.json'), JSON.stringify({ stage: '2.3-verify-r1', fields: [
    { id: 'runsEvidence', type: 'text', value: 'ok' }, { id: 'visibleEvidence', type: 'text', value: 'ok' },
    { id: 'caveat', type: 'list', value: ['无'] }, { id: 'notVerified', type: 'list', value: ['无'] }] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1', '2.2-exec-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  const shot = synthPng(join(dir, 'shot.png'))
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots: [shot] }))
  const r1 = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r1.status, 1)
  assert.match(r1.stdout, /人工判据还没签字/)
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ runs: true, visible: true, shots: [shot], manualSignoff: ['C1'] }))
  const r2 = run('done', '--run', dir, '--stage', '2.3-verify-r1')
  assert.equal(r2.status, 0, r2.stdout + r2.stderr)
})
