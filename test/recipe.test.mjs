// 配方（R1）+ baseline 变体（R5）+ 配方库 CLI（R4）自测
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PIPE = join(ROOT, 'harness', 'pipeline.mjs')
const RECIPE = join(ROOT, 'harness', 'recipe.mjs')
const run = (...a) => spawnSync(process.execPath, [PIPE, ...a], { encoding: 'utf8' })
const rec = (...a) => spawnSync(process.execPath, [RECIPE, ...a], { encoding: 'utf8' })

function baseFindings(withRecipe) {
  const f = [
    { kind: 'environment', url: 'http://127.0.0.1:8791/x', summary: '本机可跑', used: true, usedFor: '观测通道' },
    { kind: 'opensource', url: 'https://github.com/Token-Gremlin/natural-disasters/blob/main/src/sky/Clouds.js', summary: '密度链', used: true, usedFor: '密度' },
    { kind: 'paper', url: 'https://example.org/hzd.pdf', summary: 'HZD', used: true, usedFor: 'powder' },
  ]
  if (withRecipe) {
    f[1].recipe = {
      steps: ['ray-box 求交', '密度链', '光 march'],
      params: {
        sigma_m: { range: [0.02, 0.15], unit: '1/m', source: 'Clouds.js:322' },
        ambient_frac: { range: [0.005, 0.06], unit: '相对太阳', source: 'Clouds.js:309' },
        lightSteps: { range: [4, 8], unit: '步', source: 'Clouds.js:336' },
      },
      discriminators: [{ key: 'sigma_m' }],
      antiPatterns: [{ symptom: '云像均匀发亮的雾', cause: 'sigma 太小 + ambient 太高' }],
    }
  }
  return f
}

function makeGateRun(withRecipe, research = 'high') {
  const dir = mkdtempSync(join(tmpdir(), 'sl-recipe-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research, maxRounds: 1, useCritic: false, resupply: false }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({
    findings: baseFindings(withRecipe),
    extracted: [{ what: 'sigma_m', value: 0.05, min: 0.04, max: 0.06 }],
  }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.3-research-env', '1.4-research-doc']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  return dir
}

test('① tier≥2 且没人写 recipe → 1.6 调研闸挡住', () => {
  const dir = makeGateRun(false)
  const r = run('done', '--run', dir, '--stage', '1.6-gate')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /recipe/)
  assert.match(r.stdout, /steps \/ params|antiPatterns/)
})

test('② 带合格 recipe（steps+params+反例+可测判别量）→ 放行', () => {
  const dir = makeGateRun(true)
  const r = run('done', '--run', dir, '--stage', '1.6-gate')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('③ recipe 的判别量不可测 → 挡住（要能落到判据上）', () => {
  const dir = makeGateRun(true)
  const rj = JSON.parse(readFileSync(join(dir, 'research.json'), 'utf8'))
  rj.findings[1].recipe.discriminators = [{ key: 'vibes' }]
  writeFileSync(join(dir, 'research.json'), JSON.stringify(rj))
  const r = run('done', '--run', dir, '--stage', '1.6-gate')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /判别量不可测/)
})

test('④ research=low（tier<2）不强制 recipe', () => {
  const dir = makeGateRun(false, 'low')
  const r = run('done', '--run', dir, '--stage', '1.6-gate')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

function execRun(roundBody) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-base-'))
  mkdirSync(join(dir, 'stages'), { recursive: true })
  mkdirSync(join(dir, 'rounds'), { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), '# 需求\n')
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ research: 'low', maxRounds: 1, useCritic: false, resupply: false }))
  writeFileSync(join(dir, 'research.json'), JSON.stringify({ findings: [], extracted: [{ what: 'x', value: 1, min: 0.5, max: 1.5 }] }))
  for (const id of ['1.1-preflight', '1.2-translate1', '1.6-gate', '1.7-absorb', '1.8-translate2', '1.9-confirm', '1.10-translate3', '2.1-plan-r1']) {
    writeFileSync(join(dir, 'stages', id + '.json'), JSON.stringify({ stage: id, status: 'done' }))
  }
  writeFileSync(join(dir, 'rounds', '01.json'), JSON.stringify(roundBody))
  return dir
}

test('⑤ 变体里没有 isBaseline → 挡住（先照参考默认参数跑一遍）', () => {
  const dir = execRun({
    changes: ['x'], shot: 'a.png', readFiles: [],
    variants: [{ name: 'v1', shot: 'a.png' }, { name: 'v2', shot: 'a.png' }, { name: 'v3', shot: 'a.png' }],
    abShots: ['ab.png'],
  })
  const r = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /isBaseline/)
})

test('⑥ 带 baseline → 放行', () => {
  const dir = execRun({
    changes: ['x'], shot: 'a.png', readFiles: [],
    variants: [{ name: 'baseline', shot: 'a.png', isBaseline: true }, { name: 'v2', shot: 'a.png' }, { name: 'v3', shot: 'a.png' }],
    abShots: ['ab.png'],
  })
  const r = run('done', '--run', dir, '--stage', '2.2-exec-r1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('⑦ 配方库 CLI：list / search / show', () => {
  const lib = mkdtempSync(join(tmpdir(), 'sl-lib-'))
  mkdirSync(join(lib, 'volumetric-cloud'), { recursive: true })
  writeFileSync(join(lib, 'volumetric-cloud', 'recipes.md'), '# 配方\n## 夜雷暴体积云\nsigma_m 0.02~0.15\n', 'utf8')
  const list = rec('list', '--lib=' + lib)
  assert.match(list.stdout, /volumetric-cloud/)
  const search = rec('search', '体积云', '--lib=' + lib)
  assert.match(search.stdout, /sigma_m/)
  const show = rec('show', 'volumetric-cloud', '--lib=' + lib)
  assert.match(show.stdout, /夜雷暴体积云/)
  const miss = rec('show', 'nope', '--lib=' + lib)
  assert.equal(miss.status, 2, '没有的主题要 exit 2')
})
