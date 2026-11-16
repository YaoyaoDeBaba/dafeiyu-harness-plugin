// 调研闸（Research Gate）：有参考图，就必须先量过、且做过有来源的外部调研。
//
// 为什么单独一个文件（0.19.0）：这条规矩在 0.16→0.17.2 之间被打了三次补丁，
// 内联在 intent.mjs 里把主流程淹没了。抽出来之后 intent.mjs 只留一句调用。
//
// 四条规矩，缺一条就抛错（调用方负责转成中文硬错 + 非零退出）：
//   ① 有图片锚点 → 必须有 research.json
//   ② extracted[] 非空（参考被量过，不是凭感觉）
//   ③ findings[] ≥2 条带 http(s) URL，且 ≥1 条 used=true
//   ④ 每条 used=true 必须写 usedFor（改了哪条判据/做法）；且至少 1 条 kind=opensource|paper
// 逃生口：--no-research（台帐留名）；复用上一轮调研：research.reusedFrom
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const RESEARCH_FILE = 'research.json'

const hasUrl = (f) => f && typeof f.url === 'string' && /^https?:\/\//i.test(f.url)
const isVerified = (f) => ['opensource', 'paper'].includes(String(f?.kind ?? ''))

export function checkResearchGate({ outDir, anchors = [], noResearch = false, notes = [] } = {}) {
  if (noResearch) return
  const imageAnchors = (anchors || []).filter((x) => x && x.kind === 'image')
  if (imageAnchors.length === 0) return

  const researchPath = join(outDir, RESEARCH_FILE)
  let research = null
  try { research = JSON.parse(readFileSync(researchPath, 'utf8')) } catch { research = null }
  if (research == null) {
    throw new Error(
      '[调研闸] 这份 intent 声明了 ' + imageAnchors.length + ' 个图片锚点，但没有 ' + RESEARCH_FILE + '：' +
      '\n  ' + researchPath +
      '\n  先跑：node harness/ref-probe.mjs <参考图或帧目录> --json <out>/ref.extracted.json' +
      '\n  再派调查员做外部调研（算法/开源实现/文献），把结果写进 findings[]。' +
      '\n  确实要跳过：加 --no-research（台帐会记一条 skipped research）'
    )
  }

  let extracted = Array.isArray(research.extracted) ? research.extracted : []
  let findings = Array.isArray(research.findings) ? research.findings : []

  // 复用上一轮调研：登记了才认，且要能核对到
  if (typeof research.reusedFrom === 'string' && research.reusedFrom.trim() !== '') {
    let reused = null
    try { reused = JSON.parse(readFileSync(resolve(outDir, research.reusedFrom), 'utf8')) } catch { reused = null }
    if (reused == null) {
      throw new Error('[调研闸] research.reusedFrom 指向的文件读不到：' + research.reusedFrom + '（复用要能被核对）')
    }
    if (extracted.length === 0 && Array.isArray(reused.extracted)) extracted = reused.extracted
    findings = [...(Array.isArray(reused.findings) ? reused.findings : []), ...findings]
    notes.push('调研闸：复用 ' + research.reusedFrom + ' 的 findings')
  }

  if (extracted.length === 0) {
    throw new Error(
      '[调研闸] research.extracted[] 是空的：说明参考图没被量过，判据阈值就是凭感觉拍的。' +
      '\n  先跑：node harness/ref-probe.mjs <参考图或帧目录> --json <out>/ref.extracted.json' +
      '\n  再把结果并进 ' + researchPath + ' 的 extracted[]（每条写清 what / value / source）'
    )
  }

  const withUrl = findings.filter(hasUrl)
  const used = findings.filter((f) => f && f.used === true)
  if (withUrl.length < 2 || used.length < 1) {
    throw new Error(
      '[调研闸] 调研不算做完：findings 里带 http(s) 来源的只有 ' + withUrl.length + ' 条、used=true 的 ' + used.length + ' 条。' +
      '\n  要求：至少 2 条外部来源（开源实现 / 文章 / 论文，给真 URL），且至少 1 条 marked used=true —— ' +
      '用来证明「调研真的改变了做法」，不是自言自语。' +
      '\n  做法：派一个调查员子代理去查（别自己随手搜一下就算），把它的产出写进 findings[]。'
    )
  }

  const usedWithoutWhy = used.filter((f) => !(typeof f.usedFor === 'string' && f.usedFor.trim() !== ''))
  if (usedWithoutWhy.length > 0) {
    throw new Error(
      '[调研闸] 有 ' + usedWithoutWhy.length + ' 条 findings 标了 used=true，但没写 usedFor（它改了哪条判据 / 哪项做法）。' +
      '\n  used 不是"我看过了"的标记，是"这条调研改变了做法"的证据：每条都要写清改了什么。'
    )
  }

  const verified = withUrl.filter(isVerified)
  if (verified.length < 1) {
    throw new Error(
      '[调研闸] 外部来源里没有一条能核到原型：带 URL 的 ' + withUrl.length + ' 条中，kind 为 opensource/paper 的 0 条。' +
      '\n  二手博客容易抄错（这次就有人把「中点位移不分叉」写成「能分叉」）。' +
      '\n  要求：至少 1 条 kind="opensource"（能读代码）或 "paper"（有正文）。'
    )
  }

  notes.push('调研闸：锚点 ' + imageAnchors.length + ' 个 / 实测 ' + extracted.length + ' 条 / 外部来源 ' + withUrl.length + ' 条（可核 ' + verified.length + '）/ 采用 ' + used.length + ' 条')
}
