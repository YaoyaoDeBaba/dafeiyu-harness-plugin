// 需求翻译器增量自测（0.13.2）：把 2026-11-16 吸收进来的三处实拍证据钉住，防止漂回去。
//
// 覆盖：
//   ① demand-translator.md 带统一元信息（来源 / 许可 / 适用宿主 / 吸收说明），且写明第二轮增量
//   ② §3.5 的四个新增口径还在（比值+绝对尺寸、数量区间、色散强度、fwidth 反推带宽）
//   ③ §7 自检从七问扩到十问，且后三问（端点断言 / 可数性口径 / 做不到的公式）都在
//   ④ glsl-guardrails.md 的 11 条硬契约 + 3 条实现铁律完整
//   ⑤ 弄坏能红：删掉「色散强度」或把十问改回七问，检查必须报缺
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REFS = join(ROOT, 'domains', 'vfx-render', 'references')
const read = (f) => readFileSync(join(REFS, f), 'utf8')

/** 纯函数：返回缺失的关键词（弄坏能红靠它单测） */
function missingNeedles(text, needles) {
  return needles.filter((n) => !text.includes(n))
}

const TRANSLATOR = read('demand-translator.md')
const GUARDRAILS = read('glsl-guardrails.md')

test('① 元信息四行齐全，且写明第二轮增量', () => {
  const miss = missingNeedles(TRANSLATOR, ['> 来源：', '> 许可：', '> 适用宿主：', '> 吸收说明：', '第二轮增量'])
  assert.deepEqual(miss, [], '元信息缺：' + miss.join(', '))
})

test('② §3.5 的四个新增口径还在', () => {
  const miss = missingNeedles(TRANSLATOR, ['比值 + 绝对尺寸必须同时约束', '数量区间 + 尺寸范围', '色散强度', '由屏幕梯度反推', 'fwidth(场) × 目标像素数'])
  assert.deepEqual(miss, [], '§3.5 口径丢了：' + miss.join(' / '))
})

test('③ §7 自检是十问，后三问都在', () => {
  const miss = missingNeedles(TRANSLATOR, ['**十问**', '时间轴 vs 端点断言', '可数性口径', '做不到的公式', '在哪个范围、以什么为基准、怎么算出来的'])
  assert.deepEqual(miss, [], '§7 自检缺：' + miss.join(', '))
  assert.ok(TRANSLATOR.includes('过不了这十条的需求书不要发'), '收尾那句还写着七条')
})

test('④ 十一条硬契约与三条实现铁律完整', () => {
  const miss = missingNeedles(GUARDRAILS, ['十一条硬契约', '铁律 1', '铁律 2', '铁律 3', 'uDebug'])
  assert.deepEqual(miss, [], '护栏文档缺：' + miss.join(', '))
  const rows = GUARDRAILS.split('\n').filter((l) => /^\| \d+ \|/.test(l.trim()))
  assert.equal(rows.length, 11, '硬契约表应为 11 行，实际 ' + rows.length)
})

test('⑤ 弄坏能红：删「色散强度」必报缺，十问改回七问必报缺', () => {
  const broken1 = TRANSLATOR.replace(/色散强度/g, '')
  assert.deepEqual(missingNeedles(broken1, ['色散强度']), ['色散强度'], '删掉后检查没红')
  const broken2 = TRANSLATOR.replace('**十问**', '**七问**')
  assert.deepEqual(missingNeedles(broken2, ['**十问**']), ['**十问**'], '改回七问后检查没红')
  assert.deepEqual(missingNeedles(TRANSLATOR, ['**十问**']), [], '原文件不该报缺')
})
