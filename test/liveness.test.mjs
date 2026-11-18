// 活性扫描（试刀教训）+ plan 里 variables 必须扫过活性
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const LIVE = join(ROOT, 'harness', 'liveness.mjs')
const ICON = join(ROOT, 'icon.png')
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
