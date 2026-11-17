// skill 角色分流（A4·㉖㉙）：执行员不等于主 Agent，别让 skill 怂恿子代理无限迭代。
//
// 事故：`skills/selfloop/SKILL.md` 通篇「闭环 / 搜索 / 先扫活性再搜索」，执行员读同一份 skill
// 就以为自己也该闭环，拿到硬判据后在单次执行里无限自调（exec-cloud5 一晚上调到我们下班），
// 把预算全耗在一个子代理身上。
// 判据：顶部要有角色分流（主 Agent 2.1~2.5 闭环 / 执行员 2.2 只做本轮、做完就交、最多自调 3 轮），
//       references/executor-brief.md 要有三件套与 4 条交付自检，且进 SKILL.md 索引（否则没人读得到）。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILL_DIR = join(ROOT, 'skills', 'selfloop')
const SKILL = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
const BRIEF_PATH = join(SKILL_DIR, 'references', 'executor-brief.md')
const BRIEF = existsSync(BRIEF_PATH) ? readFileSync(BRIEF_PATH, 'utf8').replace(/\r\n/g, '\n') : ''

test('① SKILL.md 顶部有角色分流：主 Agent 闭环 / 执行员只做本轮', () => {
  const head = SKILL.split('\n').slice(0, 30).join('\n')
  assert.match(head, /角色分流|你是谁/, 'SKILL.md 顶部要有「你是谁 / 角色分流」一节（子代理只读得到开头）')
  assert.match(head, /主\s?Agent/, '要点名主 Agent')
  assert.match(head, /执行员/, '要点名执行员')
  assert.match(head, /2\.1~2\.5/, '要写清闭环归 2.1~2.5')
  assert.match(head, /2\.2/, '要写清执行是 2.2')
})

test('② 执行员的重约束：有限自迭代 + 最多自调 + 无显著提升即停 + 如实交', () => {
  const head = SKILL.split('\n').slice(0, 30).join('\n')
  // 用户 2026-11-18 更正：**允许**自迭代，但必须带停止条件（不是禁止）
  assert.match(head, /有限/, '要写「有限」本地自迭代（不是禁止，也不是无限）')
  assert.match(head, /最多自调/, '要写自调上限（maxSelfIterations，默认 3）')
  assert.match(head, /三条停止条件|停止条件/, '要写「三条停止条件」')
  assert.match(head, /无显著提升/, '平台期判据关键词：无显著提升')
  assert.match(head, /如实交/, '停下必须「如实交」')
  assert.match(head, /当前值/, '如实交格式含「当前值」')
  assert.match(head, /差多少/, '还有「差多少」')
  assert.match(head, /卡在/, '还有「卡在哪个约束」')
  assert.match(head, /iters\.md/, '每轮留痕 rounds/r<N>/iters.md')
})

test('②b 三条停止条件在 executor-brief 里写全（达到判据 / 用满预算 / 平台期）', () => {
  assert.match(BRIEF, /达到判据/, '① 达到判据即停')
  assert.match(BRIEF, /用满轮次预算|用满预算/, '② 用满轮次预算即停')
  assert.match(BRIEF, /平台期/, '③ 平台期')
  assert.match(BRIEF, /连续[\s*]*2[\s*]*轮/, '平台期 = 连续 2 轮无显著提升')
  assert.match(BRIEF, /<5%/, '无显著提升的口径：主判据改善 <5%')
  assert.match(BRIEF, /<2%/, '或交付帧平均像素差 <2%')
  assert.match(BRIEF, /maxSelfIterations/, '轮次预算参数名')
  assert.match(BRIEF, /iters\.md/, '每轮自迭代留一行痕')
})

test('②c 禁止空话：如实交要写「当前值 / 差多少 / 卡在哪」，并点名「已优化」这类写法', () => {
  assert.match(BRIEF, /当前值/, '当前值')
  assert.match(BRIEF, /差多少/, '差多少')
  assert.match(BRIEF, /卡在哪/, '卡在哪')
  assert.match(BRIEF, /已优化/, '要显式点名「已优化」= 没交')
})

test('③ references/executor-brief.md 在且进索引（否则没人读得到）', () => {
  assert.ok(BRIEF.length > 400, 'executor-brief.md 缺失或过短')
  assert.match(BRIEF.split('\n').slice(0, 20).join('\n'), /什么时候读/, '开头 20 行内要写「什么时候读」')
  assert.match(SKILL, /references\/executor-brief\.md/, 'SKILL.md 索引表里要点名这篇')
})

test('④ 交付三件套：code/ + scene-params.json + params.md 都写清', () => {
  for (const piece of ['code/', 'scene-params.json', 'params.md']) {
    assert.ok(BRIEF.includes(piece), 'executor-brief.md 缺三件套里的 ' + piece)
  }
  assert.match(BRIEF, /旧值/, 'params.md 要写旧值')
  assert.match(BRIEF, /新值/, 'params.md 要写新值')
  assert.match(BRIEF, /为什么/, 'params.md 要写为什么')
  assert.match(BRIEF, /snapshot\.mjs/, '要给出随时手动快照的命令')
})

test('⑤ 4 条交付自检：完整帧 / 洋红纯色块 / GetShaderMessages==0 / 每项判据一行实测 / 立刻落盘 rounds', () => {
  assert.match(BRIEF, /完整帧/, '① 贴完整帧')
  assert.match(BRIEF, /洋红/, '① 自查无洋红')
  assert.match(BRIEF, /纯色大块|纯色块/, '① 纯色块')
  assert.match(BRIEF, /全黑/, '① 全黑全白')
  assert.match(BRIEF, /crash-check\.mjs/, '自检要给可跑的命令')
  assert.match(BRIEF, /GetShaderMessages/, '② Unity 目标要查 GetShaderMessages')
  assert.match(BRIEF, /判据/, '③ 每项判据一行实测')
  assert.match(BRIEF, /实测/, '③ 要有实测值')
  assert.match(BRIEF, /每完成一项/, '④ 每完成一项立刻落盘')
  assert.match(BRIEF, /rounds\/r<N>/, '④ 落盘位置要具体')
})

test('⑥ mcp.ps1 的 -Json 坑与帧命名约定都在（否则执行员照旧踩）', () => {
  assert.match(BRIEF, /mcp\.ps1/, '要写 mcp.ps1')
  assert.match(BRIEF, /Plain JSON/, '-Json 必须 Plain JSON')
  assert.match(BRIEF, /Invalid property identifier/, '要贴出报错原文，方便对号入座')
  assert.match(BRIEF, /<stage>_<round>_<variant>_<t>\.png/, '帧命名约定')
  assert.match(BRIEF, /frames\.md/, '交活附 frames.md 索引')
})
