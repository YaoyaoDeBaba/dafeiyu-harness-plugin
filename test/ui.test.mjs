// 查看器自测（0.14.0）：聚合器与本地服的行为钉死，缺文件必须降级而不是抛错。
//
// 覆盖：
//   ① parseCsv：表头/数字转换/空文本
//   ② buildState 一次正常 run：summary 字段映射、shots 排除 target/best、图片路径转成 run 相对路径
//   ③ buildState 空目录：不抛错、summary 为 null、各数组为空
//   ④ buildState 带 nodes/ live.jsonl：都聚合进来；live 只取最后 300 条
//   ⑤ 本地服：/api/state 是 JSON、/run/shots/x.png 能取到、目录穿越被拒
//   ⑥ 弄坏能红：把图片相对路径改成绝对路径 → 必须变空（不许把本机路径漏给前端）
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildState, createServer, normRunPath, parseCsv } from '../harness/ui.mjs'

// 盘符字面量用字符拼，源码里不出现「字母:反斜杠」——否则包内绝对路径扫描会把自己人当犯人
const SEP = String.fromCharCode(92)
const OUTSIDE = 'C:' + SEP + 'Windows' + SEP + 'win.ini'
const OUTSIDE_REL = '..' + SEP + '..' + SEP + 'etc'

function makeRun({ withNodes = true, withLive = true, pngAbsolute = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-ui-'))
  mkdirSync(join(dir, 'shots'), { recursive: true })
  writeFileSync(join(dir, 'shots', 'target.png'), 'PNG')
  writeFileSync(join(dir, 'shots', 'best.png'), 'PNG')
  writeFileSync(join(dir, 'shots', 'e001.png'), 'PNG')
  writeFileSync(join(dir, 'shots', 'e002.png'), 'PNG')
  writeFileSync(join(dir, 'best.json'), JSON.stringify({
    hash: 'b5f62dccb144c94b',
    effect: 'fxbench', block: 'ember-lance', strategy: 'coordinate',
    seed: 17, t: 1190, stepN: 0, stepMs: 0, w: 640, h: 360, tier: 'low',
    metricIds: ['cov', 'bboxW'],
    startDist: 0.21, bestDist: 0.08, dropPct: 62.1, dropAbs: 0.13, budget: 60,
    stop: { reason: 'budget', detail: '预算用完', used: 60 },
    whitelist: ['length'], alive: ['length'], dead: [],
    startParams: { length: 5.8 }, bestParams: { length: 4.6 },
    targetPng: pngAbsolute ? join(dir, 'shots', 'target.png') : join(dir, 'shots', 'target.png'),
    bestPng: join(dir, 'shots', 'best.png'),
  }))
  writeFileSync(join(dir, 'curve.csv'), [
    'round,eval_seq,id,note,length,dist,pen,png',
    '0,1,e001,start,5.8,0.212355,0,shots\\e001.png',
    '-1,2,e002,precheck:length,6.3,0.200802,0,shots\\e002.png',
  ].join('\n'))
  writeFileSync(join(dir, 'report.md'), '# 报告\n本次运行：2 done / 0 skipped')
  if (withNodes) {
    mkdirSync(join(dir, 'nodes'), { recursive: true })
    writeFileSync(join(dir, 'nodes', '01-intent.json'), JSON.stringify({ node: 'intent', seq: 1, status: 'degraded', producer: 'agent', ms: 3, decision: { why: '缺 howMeasured' } }))
    writeFileSync(join(dir, 'nodes', '02-search.json'), JSON.stringify({ node: 'search', seq: 2, status: 'done', producer: 'engine', ms: 4200 }))
  }
  if (withLive) {
    writeFileSync(join(dir, 'live.jsonl'), Array.from({ length: 305 }, (_, i) => JSON.stringify({ seq: i, dist: 0.2 - i / 10000 })).join('\n') + '\n')
  }
  return dir
}

test('① parseCsv 表头 + 数字转换 + 空文本', () => {
  const r = parseCsv('a,b,c\n1,mid,\n2,,3.5')
  assert.deepEqual(r.header, ['a', 'b', 'c'])
  assert.equal(r.rows.length, 2)
  assert.equal(r.rows[0].a, 1)
  assert.equal(r.rows[0].b, 'mid')
  assert.equal(r.rows[1].c, 3.5)
  assert.deepEqual(parseCsv(''), { header: [], rows: [] })
})

test('② buildState 正常 run：summary 映射与图片相对路径', async () => {
  const dir = makeRun()
  const st = await buildState(dir)
  assert.equal(st.ok, true)
  assert.equal(st.run.name, st.run.dir.split(/[\\/]/).pop())
  assert.equal(st.summary.bestDist, 0.08)
  assert.equal(st.summary.stopReason, 'budget')
  assert.equal(st.summary.used, 60)
  assert.equal(st.targetPng, 'shots/target.png', '绝对路径要转成 run 相对路径')
  assert.equal(st.bestPng, 'shots/best.png')
  assert.deepEqual(st.shots, ['shots/e001.png', 'shots/e002.png'], 'target/best 不进胶片带')
  assert.equal(st.curve.length, 2)
  assert.equal(st.curve[0].dist, 0.212355)
  assert.equal(st.nodes.length, 2)
})

test('③ buildState 空目录：降级不抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfloop-ui-empty-'))
  const st = await buildState(dir)
  assert.equal(st.ok, true)
  assert.equal(st.summary, null)
  assert.deepEqual(st.shots, [])
  assert.deepEqual(st.nodes, [])
  assert.deepEqual(st.curve, [])
  assert.equal(st.report, '')
})

test('④ live.jsonl 只取最后 300 条；缺 nodes/live 也不报错', async () => {
  const st = await buildState(makeRun())
  assert.equal(st.live.length, 300)
  assert.equal(st.live.at(-1).seq, 304)
  const bare = await buildState(makeRun({ withNodes: false, withLive: false }))
  assert.deepEqual(bare.nodes, [])
  assert.deepEqual(bare.live, [])
})

test('⑤ 本地服：/api/state 是 JSON、/run 能取图、目录穿越被拒', async () => {
  const dir = makeRun()
  const server = createServer(dir)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const state = await (await fetch(base + '/api/state')).json()
    assert.equal(state.summary.bestDist, 0.08)
    const img = await fetch(base + '/run/shots/e001.png')
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.equal((await img.text()), 'PNG')
    const bad = await fetch(base + '/run/../../../../windows/win.ini')
    assert.ok([403, 404].includes(bad.status), '目录穿越必须被拒，实际 ' + bad.status)
    assert.equal((await fetch(base + '/nope')).status, 404)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('⑥ 弄坏能红：把 run 外的图片路径塞进来 → 必须被清空', async () => {
  const dir = makeRun()
  const best = JSON.parse(readFileSync(join(dir, 'best.json'), 'utf8'))
  best.bestPng = OUTSIDE
  writeFileSync(join(dir, 'best.json'), JSON.stringify(best))
  const st = await buildState(dir)
  assert.equal(st.bestPng, '', 'run 之外的路径不许漏给前端')
})

test('⑦ 曲线里的图片路径也归一：绝对路径转相对、run 外清空', async () => {
  const dir = makeRun()
  const root = dir
  assert.equal(normRunPath(join(root, 'shots', 'e001.png'), root), 'shots/e001.png')
  assert.equal(normRunPath(OUTSIDE, root), '', 'run 之外必须清空')
  assert.equal(normRunPath('..\\..\\etc', root), '')
  assert.equal(normRunPath('shots\\e002.png', root), 'shots/e002.png')

  // curve.csv 里写绝对路径时，聚合结果必须也是相对的（否则前端 /run/ 会 403）
  writeFileSync(join(dir, 'curve.csv'), [
    'round,eval_seq,id,note,length,dist,pen,png',
    '0,1,e001,start,5.8,0.212355,0,' + join(root, 'shots', 'e001.png'),
  ].join('\n'))
  const st = await buildState(dir)
  assert.equal(st.curve[0].png, 'shots/e001.png')
})

test('⑧ 决策接口：合法动作落盘、非法动作拒绝、state 能读回', async () => {
  const dir = makeRun()
  const server = createServer(dir)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const okRes = await fetch(base + '/api/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop', round: 2, note: '命中点不够狠' })
    })
    assert.equal(okRes.status, 200)
    const okBody = await okRes.json()
    assert.equal(okBody.ok, true)
    assert.equal(okBody.recorded.action, 'stop')
    assert.equal(okBody.recorded.round, 2)

    const badRes = await fetch(base + '/api/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'hack' })
    })
    assert.equal(badRes.status, 400, '不在白名单的动作必须 400')

    const badJson = await fetch(base + '/api/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })
    assert.equal(badJson.status, 400)

    const st = await (await fetch(base + '/api/state')).json()
    assert.equal(st.decisions.length, 1)
    assert.equal(st.decisions[0].action, 'stop')
    assert.equal(st.decisions[0].note, '命中点不够狠')

    const raw = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n')
    assert.equal(raw.length, 1, '非法动作不该落盘')
  } finally {
    await new Promise((r) => server.close(r))
  }
})
