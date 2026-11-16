// harness/intent.mjs —— 需求转译插槽 + **intent 硬闸**（跑之前必须有一份经过确认的需求转译）
//
// 为什么要有这道闸（用户原话）：
//   "需求输入之后有没有真被消化理解、开干之前有没有先去搜索调研" —— 现状是**根本没有这一段**：
//   引擎直接从"活性扫描 → 搜索"开始，于是它"虚"不是缺 UI，是头两段不存在。
//   而 agent 接过一句"太丑了"，自己没定义"什么叫好"就开跑，等于把球又踢回给人。
//
// 这道闸只做四件事（不多做，多了就是替用户拍板）：
//   ① 没有 intent 文件 → 中文硬错，并**写一份模板**到 <out>/intent.template.json（告诉用户填什么、怎么确认、怎么显式跳过）；
//   ② 有文件但 confirmed !== true → 中文硬错，把 confirm[] 里待确认的问题**原样列出来**；
//   ③ confirmed === true → 通过，把 criteria 覆盖到 adapter 的 metrics 上（按 id 匹配）：
//        · 权重：改 metric.weight（判据层，两个入口共用 score.js）
//        · 目标：改该指标的 target 值（命令链路；截图链路的目标来自目标帧实测，见下）
//      **id 在 adapter 里不存在 → 硬错，绝不静默忽略**（写错一个 id 就悄悄按原判据跑完，是最坏的一种"看起来做了"）；
//   ④ 显式跳过（命令链路 --no-intent / 截图链路 -NoIntent）→ 放行，但**必须在台帐里记一条 skipped**，
//      reason 写"显式 --no-intent 跳过需求转译" —— 跳过要有名字，否则等于又回到"被绕过但没人看见"。
//
// 位置纪律：intent 是**第 01 个节点**，排在所有评估之前（比活性预检、比目标帧/目标指标都早），
// 因为它会改判据 —— 判据改了，后面每一次距离的含义才成立。
//
// 确定性边界（里程碑 9 §6）：引擎不认识"需求"，只认识"可以覆盖的东西"（criteria）；
// 把模糊的话变成 criteria 的那层不确定，关在 agent 里（agent 填文件、用户点确认），引擎保持纯确定性。
//
// ════════════════ v2（0.5.1）：给 intent 补"锚 / 反例 / 自由度 / 验收方式" ════════════════
// 为什么升：三份真实实验复盘的结论是「提示词写法是第一杠杆，模型只抬上限不抬下限」，
// 而最大坑是「指标替代审美」—— 每轮都在追可数指标，单步有"改进证据"，累积把观感磨平。
// 只有"指标 + 权重 + 目标"的 v1 intent 等于把这个坑**制度化**。v2 补的四样全来自那轮实验的实证：
//   · anchors（锚）      —— 具体参照物（参考图 / 具体游戏名 / 前作 / 一句话观感）。"3A 次世代"不是锚；
//                            kind:"image" 的 ref **必须真实存在**（锚不住东西的锚等于空话）；
//   · notWanted（反例）  —— 明确不要什么。原实验里写"拒绝写实/PBR"比只写"要二次元"有效得多；
//   · freeVsFixed（自由度 vs 定死项）—— 原实验的教训：需求书把形态全锁成"严格直线"，锁出了僵直激光；
//   · howWeVerify（验收方式）—— 怎么算过（人眼 / 指标阈值 / 两者都要），把"谁来点头"写进契约。
// v1 的 intent **仍然能跑**，但会打中文 warn、台帐 01-intent 记 degraded（不是 done）——
// 缺了这四样，等于把审美全交给指标。
//
// ════════════════ v2.1：给每条 criteria 补"用户原话 / 怎么量"（专治"编假指标"）════════════════
// 为什么再升（外部实跑得出的硬教训，一句话）：
//   **把用户嘴里的观感词（脆 / 糊 / 有主次）原样下发，等于没说**；而为了显得专业去编一个
//   看似精确的假指标（比如拿"色阶可数"当审美），会诱导搜索优化错方向 —— 历史上"越修越平"就是这么来的。
// 所以每条判据必须回答两个问题：**用户原话是什么**（来源）+ **这个数怎么量**（可复算）。
//   · userWords   —— 照抄用户怎么说，不翻译（他说"看着发虚、没有锐劲"，就写这句）；
//   · howMeasured —— 这个数怎么量出来的（"沿法线扫 alpha 25%→75% 的像素距离，越短越锐"）。
// 判定：
//   两个都有 → 这条判据记 done；
//   只有一个 → 允许，但 intent 节点 degraded，reason 点名缺哪个（来源不可追溯 / 没人能复算）；
//   两个都没有 → **硬错**："这条判据没有任何用户原话/量法，等于凭空编的指标——要么写用户怎么说，
//                要么写怎么量，要么删掉"（比 warn 更硬：假指标一旦进了搜索，跑完一整轮才知道方向错了）；
//   howMeasured 里明说"靠人看"（暂无口径 / 靠参考图对照）→ **允许**（这是诚实的说法），但该条 warn：
//                搜索不能用它当判据 —— 考虑降权或改成可测量的量。不硬错（诚实 > 假装精确）。
// 三个字段（userWords / howMeasured / why）**都不进距离计算**，只进台帐与报告。
//
// 用法（给人看）：
//   node harness/intent.mjs gate --out <run目录> --adapter <a.json> [--intent <file>] [--no-intent]
//        [--chain cmd|screenshot] [--metric-ids cov,lapVar]
//        → 过一个闸：stdout 打印一行 JSON 回执；过不了：中文错误 + 退出码 1
// 用法（给代码用）：import { resolveIntent, intentNodeRecord } from './intent.mjs'
'use strict';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCREENSHOT_LIMIT, formatCheck, resolveInvariants } from './invariants.mjs';

// ledger.js 是 CommonJS（截图链路的 finalize.js 也要 require 它），这里用 createRequire 拉进来 ——
// 与 cmdlib.mjs 拉 score.js 同口径。
const requireCjs = createRequire(import.meta.url);
const { createLedger } = requireCjs('./ledger.js');
// intent 摘要的唯一实现（CommonJS：截图链路的 finalize.js 也要 require 它）
const intentSummaryCjs = requireCjs('./intent-summary.js');

export const INTENT_FILE = 'intent.json';
export const RESEARCH_FILE = 'research.json';
const TEMPLATE_FILE = 'intent.template.json';
export const NO_INTENT_REASON = '显式 --no-intent 跳过需求转译';
// v2 的硬上限（全部来自"轻合规"：写越厚，花在做到上的预算越少）
export const INTENT_VERSION = 2;
export const RESTATE_MAX_CHARS = 200;
export const MAX_CRITERIA = 5;
export const MAX_CONFIRM = 3;
// intent 摘要在 run 目录里的落点（不参与距离计算，只做记录与呈现；finalize.js 也从这里读）
// 常量与实现都在 harness/intent-summary.js（唯一实现），这里只转出去给调用方用。
export const INTENT_SUMMARY_FILE = intentSummaryCjs.INTENT_SUMMARY_FILE;
export const V1_WARNING = '这是 v1 intent（没有锚/反例/自由度），等于把审美全交给指标——建议升级到 v2';
// v2.1：howMeasured 里出现这些字样 = 作者**诚实地**承认"这个数只能靠人看"。
// 它不算硬错（诚实 > 假装精确），但搜索不能用它当判据 —— 该条 warn。
export const HUMAN_EYES_PATTERNS = ['暂无口径', '靠参考图对照', '靠人看', '靠人眼', '人眼对照', '人眼判断', '肉眼对照'];
export const HUMAN_EYES_RE = new RegExp(HUMAN_EYES_PATTERNS.join('|'));
export const HUMAN_EYES_WARNING_HEAD = '这条口径是「靠人看」，搜索不能用它当判据——考虑降权或改成可测量的量';

// 变异开关：**只给测试用**（证明"改动门禁后测试真的会红"），不设时行为完全正常。
//   alwaysPass      —— 闸恒放行（没有文件也不报错）→ "无 intent 必须硬错"那条断言必红；
//   dropSkipRecord  —— --no-intent 时不写台帐 → "skipped 必须有记录且 reason 含 --no-intent"那条断言必红；
//   anchorAlwaysTrue—— 锚的存在性检查恒真（v2 的"锚不住东西的锚等于空话"失效）→ 第 2 条必红；
//   v1AsDone        —— v1 intent 记 done 而不是 degraded → 第 5 条必红。
export const INTENT_MUTANT = String(process.env.SELFLOOP_INTENT_MUTANT || '');

const HARD = '[需求转译闸] ';
const CHAINS = ['cmd', 'screenshot'];

function die(msg) {
  throw new Error(HARD + msg);
}

// 台帐 artifacts 里一律写相对 run 目录的路径（与其它节点同口径：'shots/target.png' 这种）
function relativeTo(outDir, file) {
  const r = relative(outDir, file);
  return r ? r.split('\\').join('/') : file;
}

// ---------------------------------------------------------------- 模板
export function intentTemplate(metricIds = [], chain = 'cmd') {
  const ids = metricIds.length ? metricIds.join(' / ') : '（这份 adapter 一条指标都没有）';
  const targetNote =
    chain === 'screenshot'
      ? '截图链路的目标来自目标帧实测：criteria[].target 会被记进台帐但**不参与距离**（只按权重覆盖生效）'
      : 'criteria[].target 会覆盖该指标的目标值（adapter.target.metrics[id] 或目标帧跑出来的那个数）';
  return {
    _说明: [
      '这是需求转译（intent v2）模板：引擎在开跑之前要求一份**经过确认**的需求转译，否则拒跑。',
      '① 复述：restate（一句话说清"你要什么"，≤200 字，得让人三秒判对错）。v1 的 understood 仍认，但空着会进台帐当提醒。',
      '② 锚：anchors 至少 1 条具体参照物 {kind:"image"|"text", ref, why}。image 的 ref 必须是**真实存在的文件**（相对本 intent 文件或绝对路径）；' +
        'text 的 ref 是具体游戏名 / 前作 / 一句话观感 —— "3A 次世代"这种抽象口号不是锚。',
      '③ 判据：criteria 最多 5 条（轻合规：写越厚，花在做到上的预算越少），每条都要 anchor（指向某个 anchors[i] 或一句具体参照）。' +
        'id 必须是这份 adapter 里真实存在的指标 id：' + ids + '。写错 id 是硬错，不会静默忽略。',
      '③-b 每条判据还要回答两个问题（v2.1，专治"编假指标"）：' +
        'userWords = 用户原话（他说"看着发虚、没有锐劲"就照抄，别翻译成"色阶可数"这种看似精确的数）；' +
        'howMeasured = 这个数怎么量（例："沿法线扫 alpha 25%→75% 的像素距离，越短越锐"）。' +
        '两个都空 = 硬错（"等于凭空编的指标"）；只写一个 = 能跑但 intent 记 degraded（缺原话 → 来源不可追溯，缺量法 → 没人能复算）；' +
        'howMeasured 写"暂无口径/靠参考图对照"是允许的（诚实的说法），但该条会 warn：搜索不能用它当判据。这两个字段不参与距离。',
      '④ ' + targetNote + '。',
      '⑤ 反例 / 自由度 / 验收：notWanted（明确不要什么）、freeVsFixed{fixed,free}（哪些必须对、哪些可以自由）、' +
        'howWeVerify{human,metrics,note}（怎么算过）。**字段缺失 = 降级**（台帐 degraded）：没写反例/自由度，等于全权交给搜索。',
      '⑥ confirm 最多 3 条（要用户拍板的问题）；confirmed:true 时若有未答的 confirm，会 warn 一句"还有 N 条待确认问题没答，已按当前判据开跑"。',
      '⑦ 填完怎么确认：把 confirmed 改成 true，写上 confirmedBy（谁确认的）与 confirmedAt（ISO 8601，如 2026-11-14T10:46:00+08:00），然后重跑同一条命令。',
      '⑧ 不想走这一步：命令行加 --no-intent（截图链路 -NoIntent）显式跳过 —— 台帐会记一条 skipped 并写明原因；跳过有名字，但这次就没有"需求被消化"的证据。',
      '⑨ 硬不变量（0.7.0，可选但强烈建议）：invariants 数组，每条 {id, check, why} —— 不合格直接判废，不进距离（指标负责"像不像"，不变量负责"是不是"）。' +
        'check 只认：比较 {field, op:==|!=|<|<=|>|>=, value:<数字>} / 组合 {all:[…]}、{any:[…]}、{not:…}；field 是指标 id 或命令输出里的字段（可写 a.b）。' +
        '写错文法 / 字段取不到 = 硬错；不写 = 不拦，但会 warn「没写硬不变量：搜索会拿底线换分数」。截图链路暂不支持（写了会硬错）。',
      '⑩ 掩膜哨兵（0.13.0，可选）：maskSentinel:true = 要求"掩膜冻在同一小块像素"必须被拦（命令链路默认就开着；' +
        '只有 parse=image + opts.mask 的观测才有掩膜指纹）。截图链路不实现哨兵 —— 在那里写 true 会硬错（宁可拒跑，也不假装有哨兵）。',
    ],
    version: INTENT_VERSION,
    restate: '',
    anchors: [{ kind: 'image', ref: 'refs/（改成真实存在的参考图路径）', why: '同类高评分…' }],
    criteria: [],
    notWanted: [],
    freeVsFixed: { fixed: [], free: [] },
    howWeVerify: { human: true, metrics: true, note: '' },
    invariants: [],
    maskSentinel: false,
    uncertain: [],
    confirm: [],
    confirmed: false,
    confirmedBy: '',
    confirmedAt: '',
  };
}

export function writeTemplate(tplPath, metricIds, chain) {
  mkdirSync(dirname(tplPath), { recursive: true });
  writeFileSync(tplPath, JSON.stringify(intentTemplate(metricIds, chain), null, 2) + '\n', 'utf8');
  return tplPath;
}

// ---------------------------------------------------------------- 读 + 校验
function readIntentFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    die(`需求转译文件读不到：${file}（${e?.code ?? e?.message ?? e}）`);
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    die(`需求转译文件不是合法 JSON：${file}（${e.message}）—— 结构见 ${TEMPLATE_FILE}`);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    die(`需求转译文件里要是一个 JSON 对象（收到 ${Array.isArray(j) ? '数组' : typeof j}）：${file}`);
  }
  return j;
}

// ---------------------------------------------------------------- 校验：v2 的四样（锚 / 反例 / 自由度 / 验收方式）
// 锚：至少 1 条；kind=image 的 ref 必须**真实存在**（相对 intent 文件所在目录或绝对路径都可）。
// 为什么非存在不可：锚不住东西的锚等于空话 —— 一句"参考某张图"但图不在，等于没有参照物，
// 搜索结果只能退化成"指标更好看"，也就是这一版要治的那个病。
export function validateAnchors(raw, baseDir) {
  if (raw === undefined || raw === null) {
    die(
      'intent（v2）必须有 anchors：至少 1 条具体参照物 {kind:"image"|"text", ref, why}\n' +
        '  锚 = 参考图 / 具体游戏名 / 前作 / 一句话观感；"3A 次世代"这种抽象口号不是锚。\n' +
        '  为什么拦：只有指标 + 权重 + 目标时，每轮都只追可数指标，累积会把观感磨平 —— 锚是唯一能把"像不像"钉住的参照物',
    );
  }
  if (!Array.isArray(raw)) die(`intent.anchors 要是数组（每项 {kind:"image"|"text", ref, why}），收到 ${typeof raw}`);
  if (!raw.length) die('intent.anchors 是空数组：锚不住东西的锚等于空话 —— 至少给 1 条具体参照物（参考图 / 具体游戏名 / 前作）');
  const out = [];
  raw.forEach((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) die(`intent.anchors[${i}] 不是对象（要 {kind:"image"|"text", ref, why}）：${JSON.stringify(a)}`);
    const kind = String(a.kind ?? '').trim();
    if (kind !== 'image' && kind !== 'text') {
      die(`intent.anchors[${i}].kind 只认 "image" 或 "text"（收到 ${JSON.stringify(a.kind)}）：image=参考图/帧，text=具体游戏名/前作/一句话观感`);
    }
    const ref = String(a.ref ?? '').trim();
    if (!ref) die(`intent.anchors[${i}].ref 是空的（kind=${kind}）—— 锚不住东西的锚等于空话`);
    const why = String(a.why ?? '').trim();
    let abs = ref;
    if (kind === 'image') {
      abs = isAbsolute(ref) ? ref : resolve(baseDir, ref);
      if (INTENT_MUTANT !== 'anchorAlwaysTrue' && !existsSync(abs)) {
        die(
          `intent.anchors[${i}] 指向的参考图不存在：${ref}\n` +
            `  解析成：${abs}（相对的是 intent 文件所在目录 ${baseDir}；也可以用绝对路径）\n` +
            `  为什么拦：锚不住东西的锚等于空话 —— 图不在，"照着它调"这件事就没有参照物，剩下的只有指标`,
        );
      }
    }
    out.push({ kind, ref, abs, why });
  });
  return out;
}

// criteria 校验：条数上限（轻合规）、id 必须存在、权重/目标值必须是数、不许重复；
// v2 每条还必须带 anchor（指向某个 anchors[i] 或一句具体参照）；
// v2.1 每条还必须带 userWords / howMeasured 至少一个（两个都空 = 硬错："凭空编的指标"）。
// 返回 [{id, weight|null, target|null, anchor, userWords, howMeasured, hasUserWords, hasHowMeasured,
//        humanEyes, why}]（null = 这一项没提，不该覆盖）。
export function validateCriteria(raw, metricIds, opts = {}) {
  const known = metricIds.map(String);
  const anchors = Array.isArray(opts.anchors) ? opts.anchors : [];
  const requireAnchor = Boolean(opts.requireAnchor);
  // v2 才硬要来源与量法；v1 老写法只降级（向后兼容：老文件不许被这一条拦死）
  const requireProvenance = Boolean(opts.requireProvenance);
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) die(`intent.criteria 要是数组（每项 {id, weight, target, anchor, userWords, howMeasured, why}），收到 ${typeof raw}`);
  if (raw.length > MAX_CRITERIA) {
    die(
      `intent.criteria 有 ${raw.length} 条 > 上限 ${MAX_CRITERIA} 条（轻合规：写越厚，花在做到上的预算越少）\n` +
        `  改法：把判据收敛到最关键的 ${MAX_CRITERIA} 条以内；次要的写进 anchors / notWanted / freeVsFixed，别都塞进距离里`,
    );
  }
  const out = [];
  const seen = new Set();
  const unknown = [];
  raw.forEach((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) die(`intent.criteria[${i}] 不是对象（要 {id, weight, target, anchor, userWords, howMeasured, why}）：${JSON.stringify(c)}`);
    const id = String(c.id ?? '').trim();
    if (!id) die(`intent.criteria[${i}] 缺 id（这份 adapter 的指标是：${known.join(' / ') || '（一个都没有）'}）`);
    if (!known.includes(id)) {
      unknown.push(id);
      return;
    }
    if (seen.has(id)) die(`intent.criteria 里 ${id} 出现了两次（同一个指标一个权重，别给两个答案）`);
    seen.add(id);
    let weight = null;
    if (c.weight !== undefined && c.weight !== null) {
      weight = Number(c.weight);
      if (!Number.isFinite(weight) || weight < 0) die(`intent.criteria.${id}.weight 要是 ≥0 的数（收到 ${JSON.stringify(c.weight)}）`);
    }
    let target = null;
    if (c.target !== undefined && c.target !== null) {
      target = Number(c.target);
      if (!Number.isFinite(target)) die(`intent.criteria.${id}.target 要是数（收到 ${JSON.stringify(c.target)}）`);
    }
    const anchor = String(c.anchor ?? '').trim();
    if (!anchor) {
      if (requireAnchor) {
        die(
          `intent.criteria.${id} 缺 anchor：每条判据都要指向"这条指标在参照物里的哪个部位/哪个数"` +
            `（写 anchors[0]、anchors[1] 这种，或一句具体参照如"参考图里的亮核占比"）\n` +
            `  为什么拦：不带锚的判据（更粗/更亮）没有参照物，搜索只会把它推到指标极值，观感就磨平了`,
        );
      }
    } else {
      const m = /^anchors\s*\[\s*(\d+)\s*\]/.exec(anchor);
      if (m) {
        const idx = Number(m[1]);
        if (!(idx >= 0 && idx < anchors.length)) {
          die(`intent.criteria.${id}.anchor 指向 ${anchor}，但 intent.anchors 只有 ${anchors.length} 条（下标 ${idx} 越界）—— 悬空的锚等于没锚`);
        }
      }
    }
    // ---- v2.1：用户原话 + 怎么量（专治"编假指标"；这两个字段**不进距离**）----
    // 空串和"没写"一样算没有：字段在但写了个空串，等于什么都没说（这正是"凭空编"的常见装法）。
    const userWords = String(c.userWords ?? '').trim();
    const howMeasured = String(c.howMeasured ?? '').trim();
    const hasUserWords = Boolean(userWords);
    const hasHowMeasured = Boolean(howMeasured);
    if (!hasUserWords && !hasHowMeasured && requireProvenance && INTENT_MUTANT !== 'provenanceWarnOnly') {
      die(
        `intent.criteria.${id}：这条判据没有任何用户原话/量法，等于凭空编的指标——要么写用户怎么说，要么写怎么量，要么删掉\n` +
          `  userWords   照抄用户怎么说（他说"看着发虚、没有锐劲"就写这句，别翻译成"色阶可数"这种看似精确的数）\n` +
          `  howMeasured 这个数怎么量（例：沿法线扫 alpha 25%→75% 的像素距离，越短越锐）\n` +
          `  为什么拦：观感词原样下发等于没说；为了显得专业编一个假指标，会诱导搜索优化错方向 —— 历史上"越修越平"就是这么来的`,
      );
    }
    // 诚实地说"这个数只能靠人看"是允许的，但搜索不能用它当判据 → 该条 warn（不硬错）
    const humanEyes = hasHowMeasured && HUMAN_EYES_RE.test(howMeasured);
    out.push({ id, weight, target, anchor, userWords, howMeasured, hasUserWords, hasHowMeasured, humanEyes, why: String(c.why ?? '') });
  });
  if (unknown.length) {
    die(
      `intent.criteria 里有 adapter 不认识的指标 id：${unknown.join('、')}` +
        `（这份 adapter 的指标是：${known.join(' / ') || '（一个都没有）'}）—— 绝不静默忽略：` +
        `写错 id 等于对着一个没人用的判据把整轮预算跑完`,
    );
  }
  return out;
}

// 反例：明确不要什么。**可以是空数组**，但字段缺失和显式空数组是两件事（缺失 = 降级）。
export function validateNotWanted(raw) {
  if (raw === undefined || raw === null) return { present: false, items: [] };
  if (!Array.isArray(raw)) die(`intent.notWanted 要是字符串数组（明确不要什么），收到 ${typeof raw}`);
  return { present: true, items: raw.map((s) => String(s).trim()).filter(Boolean) };
}

// 自由度 vs 定死项：哪些必须对（fixed）、哪些可以自由（free）。
// 原实验的教训：需求书把形态全锁成"严格直线"，锁出了僵直激光 —— 该自由的地方定死，等于把搜索的手绑住。
export function validateFreeVsFixed(raw) {
  if (raw === undefined || raw === null) return { present: false, fixed: [], free: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    die('intent.freeVsFixed 要是对象 {fixed:[...], free:[...]}（缺了就等于全权交给搜索：没写清哪些必须对、哪些可以自由）');
  }
  const arr = (v, name) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) die(`intent.freeVsFixed.${name} 要是字符串数组（收到 ${typeof v}）`);
    return v.map((s) => String(s).trim()).filter(Boolean);
  };
  return { present: true, fixed: arr(raw.fixed, 'fixed'), free: arr(raw.free, 'free') };
}

// 验收方式：怎么算过（人眼看 / 指标阈值 / 两者都要）。把"谁来点头"写进契约。
export function validateHowWeVerify(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) die('intent.howWeVerify 要是对象 {human:bool, metrics:bool, note:"…"}');
  const human = raw.human === true;
  const metrics = raw.metrics === true;
  if (!human && !metrics) {
    die('intent.howWeVerify 里 human 和 metrics 都是 false/没写：那这次"算什么过"就没有验收人 —— 至少选一个（人眼看 / 指标阈值 / 两者都要）');
  }
  return { human, metrics, note: String(raw.note ?? '').trim() };
}

// ---------------------------------------------------------------- 闸
// 返回：
//   status 'done'      —— 有一份 confirmed:true 的 v2 转译（锚/反例/自由度/验收方式齐全；criteria 已校验）
//   status 'degraded'  —— 过了闸但缺东西（v1 老写法 / 没写 notWanted / 没写 freeVsFixed），reason 写清缺什么
//   status 'skipped'   —— 显式 --no-intent（调用方必须写一条 skipped 台帐）
// 抛错 = 硬错（没有文件 / 没确认 / criteria 里的 id 不存在 / 锚指向不存在的图 / 条数超限 / restate 空）。
export function resolveIntent(opts = {}) {
  const outDir = opts.outDir;
  const chain = CHAINS.includes(opts.chain) ? opts.chain : 'cmd';
  const metricIds = (opts.metricIds || []).map(String);
  const noIntent = Boolean(opts.noIntent);
  const tplPath = join(outDir, TEMPLATE_FILE);
  if (noIntent) {
    return skippedShape({
      chain,
      reason: NO_INTENT_REASON,
      warnings: ['这次没有"需求被消化"的证据：判据全部按 adapter 原样，没人确认过它是不是你要的'],
    });
  }
  const file = opts.intentPath ? resolve(opts.intentPath) : join(outDir, INTENT_FILE);
  if (!existsSync(file)) {
    writeTemplate(tplPath, metricIds, chain);
    if (INTENT_MUTANT !== 'alwaysPass') {
      const skipSwitch = chain === 'screenshot' ? '-NoIntent' : '--no-intent';
      die(
        `没有需求转译文件：${file}\n` +
          `  ① 要填什么：restate（一句话复述需求）/ anchors（至少 1 条具体参照物，image 的 ref 必须真实存在）/ ` +
          `criteria（最多 5 条：对哪些指标下手、权重、目标值、anchor）/ notWanted（不要什么）/ freeVsFixed（哪些定死、哪些自由）/ ` +
          `howWeVerify（人眼还是指标算过）/ uncertain / confirm（要用户拍板的问题，最多 3 条）；` +
          `这份 adapter 的指标是 ${metricIds.join(' / ') || '（一个都没有）'}；模板已写到 ${tplPath}\n` +
          `  ② 填完怎么确认：把 confirmed 改成 true，写上 confirmedBy / confirmedAt（ISO 8601），再重跑同一条命令\n` +
          `  ③ 确实不填：命令行加 ${skipSwitch} 显式跳过 —— 台帐会记一条 skipped 并写明原因（跳过有名字，但这次没有"需求被消化"的证据）\n` +
          `  为什么拦：需求输入之后必须先被消化；没确认过的判据，跑完一整轮也不知道"变好"是相对谁说的`,
      );
    }
    return skippedShape({ status: 'degraded', chain, templatePath: tplPath, reason: '（变异体 alwaysPass：闸被改成恒放行）' });
  }

  const j = readIntentFile(file);
  if (j.confirmed !== true && INTENT_MUTANT !== 'alwaysPass') {
    const q = Array.isArray(j.confirm) ? j.confirm.map((s) => String(s)) : [];
    const qBlock = q.length
      ? '  待确认的问题（confirm[]，原样列出）：\n' + q.map((s, i) => `   ${i + 1}. ${s}`).join('\n')
      : '  confirm[] 是空的：确认时至少要写清一条"我还不确定的地方"，或者把 confirmed 改成 true 表示已经拍板';
    const skipSwitch = chain === 'screenshot' ? '-NoIntent' : '--no-intent';
    die(
      `需求转译还没被确认：${file} 里 confirmed=${JSON.stringify(j.confirmed)}\n` +
        qBlock +
        `\n  改法：这些问题问清楚之后把 confirmed 改成 true、写上 confirmedBy / confirmedAt 再重跑；` +
        `不想走这一步用 ${skipSwitch} 显式跳过\n` +
        `  为什么拦：一份"我觉得我懂了"的自述不算消化 —— 没被点头的转译，等于替用户改了判据`,
    );
  }

  // ------------------------------------------------------------ v1 / v2 分流
  // v1 = 没有 version 且 criteria 没有 anchor 的老写法：**仍然能跑**，但必须留一条中文 warn、
  // 台帐记 degraded（不是 done）。因为它只有"指标 + 权重 + 目标"，等于把审美全交给指标。
  const version = Number.isFinite(Number(j.version)) ? Number(j.version) : 1;
  const isV1 = !(version >= 2);
  const baseDir = dirname(file);
  const warnings = [];
  const degradedWhy = [];

  const restate = String(j.restate ?? '').trim();
  if (!isV1) {
    if (!restate) {
      die(
        `intent.restate 是空的：v2 必须有一句话复述"你要什么"（≤${RESTATE_MAX_CHARS} 字）\n` +
          `  为什么拦：复述是"三秒判对错"的那一行 —— 连这句都没有，后面所有的锚/判据都在替一个没被说清的需求干活`,
      );
    }
    const chars = [...restate].length;
    if (chars > RESTATE_MAX_CHARS) {
      die(`intent.restate 太长：${chars} 字 > 上限 ${RESTATE_MAX_CHARS} 字（复述不是需求书，是一句话）—— 删到一句能三秒判对错的长度`);
    }
  }

  // 锚：v2 必填；v1 写了也校验（图不在同样硬错，别让"锚"在 v1 里变成可以随口写的装饰）
  let anchors = [];
  if (j.anchors !== undefined && j.anchors !== null) anchors = validateAnchors(j.anchors, baseDir);
  else if (!isV1) anchors = validateAnchors(undefined, baseDir);
  const criteria = validateCriteria(j.criteria, metricIds, { anchors, requireAnchor: !isV1, requireProvenance: !isV1 });

  let confirmArr = [];
  if (j.confirm !== undefined && j.confirm !== null) {
    if (!Array.isArray(j.confirm)) die(`intent.confirm 要是字符串数组（要用户拍板的问题），收到 ${typeof j.confirm}`);
    confirmArr = j.confirm.map((s) => String(s).trim()).filter(Boolean);
  }
  if (confirmArr.length > MAX_CONFIRM) {
    die(
      `intent.confirm 有 ${confirmArr.length} 条 > 上限 ${MAX_CONFIRM} 条（轻合规：写越厚，花在做到上的预算越少）\n` +
        `  改法：只留最需要用户拍板的 ${MAX_CONFIRM} 条以内；其余写进 uncertain（记录用），别都当"必须回答才能开跑"`,
    );
  }

  const nw = validateNotWanted(j.notWanted);
  const fvf = validateFreeVsFixed(j.freeVsFixed);
  const hwv = validateHowWeVerify(j.howWeVerify);

  // ------------------------------------------------------------ 硬不变量（0.7.0）
  // 文法在闸这里就校验（而不是留到搜索里第一次评估才炸）：写错的不变量等于没装门，
  // 必须在开跑之前用中文硬错说清"哪个 id / 哪个 op / 支持哪些"。
  const invariants = resolveInvariants(j.invariants);
  // 截图链路（iter.ps1 / finalize.js）不实现门禁 → **fail-closed**：
  // 写了 invariants 就硬错，绝不静默忽略（静默忽略比拒跑更坏：用户以为装了门，其实没有）。
  if (chain === 'screenshot' && invariants.length) {
    die(
      `截图链路不支持硬不变量（intent.invariants 里写了 ${invariants.length} 条：${invariants.map((x) => x.id).join(' / ')}）\n` +
        `  ${SCREENSHOT_LIMIT}\n` +
        `  改法：把 invariants 去掉（截图链路仍按原来的指标判据跑），或改走命令观测链路（cmdloop.mjs）—— 那里门禁真的生效`,
    );
  }

  // 掩膜哨兵（0.13.0）：intent 可以**要求**"掩膜冻住必须被拦"。
  // 截图链路（iter.ps1 / finalize.js）不实现哨兵 → 与硬不变量同一处理：要求了就 fail-closed 硬错。
  if (j.maskSentinel !== undefined && typeof j.maskSentinel !== 'boolean') {
    die(`intent.maskSentinel 只认 true / false（收到 ${JSON.stringify(j.maskSentinel)}）—— 它表达的是"要不要必须拦掩膜冻住"，不是配置对象`);
  }
  const maskSentinel = j.maskSentinel === true;
  if (chain === 'screenshot' && maskSentinel) {
    die(
      '截图链路不支持掩膜哨兵（intent.maskSentinel=true）\n' +
        '  哨兵只在命令链路（cmdloop.mjs）里有：它要读掩膜位图与掩膜内指标向量，而 iter.ps1 的观测是页面指标、判定在 PowerShell 侧，\n' +
        '  没有测试守着那个实现（和硬不变量同一处理：宁可拒跑，也不假装有哨兵）。\n' +
        '  改法：把 intent.maskSentinel 去掉/改成 false（截图链路仍按原来的指标判据跑），或改走命令观测链路（cmdloop.mjs，parse=image + opts.mask）',
    );
  }

  const understood = String(j.understood ?? restate ?? '').trim();

  // ------------------------------------------------------------ v2.1：判据的来源与量法（不参与距离）
  // 回答两个问题：**用户原话是什么**（来源可追溯）+ **这个数怎么量**（别人能复算）。
  // 两个都有 = 这条判据站得住；只有一个 = 能跑但降级；两个都空 = 上一段已经硬错（v2）。
  const prov = { userWords: 0, howMeasured: 0, neither: 0 };
  for (const c of criteria) {
    if (c.hasUserWords) prov.userWords += 1;
    if (c.hasHowMeasured) prov.howMeasured += 1;
    if (!c.hasUserWords && !c.hasHowMeasured) prov.neither += 1;
  }
  const missingWords = criteria.filter((c) => !c.hasUserWords).map((c) => c.id);
  const missingMeas = criteria.filter((c) => !c.hasHowMeasured).map((c) => c.id);
  if (isV1) {
    // v1 老写法不许被拦死：只把这条欠账补进 reason（"也缺 userWords/howMeasured"）
    if (prov.neither > 0) {
      degradedWhy.push(
        `v1 intent 也缺 userWords/howMeasured（criteria: ${criteria.filter((c) => !c.hasUserWords && !c.hasHowMeasured).map((c) => c.id).join('、')}）` +
          `：判据没有用户原话，来源不可追溯；也没有量法，没人能复算这个数`,
      );
    }
  } else {
    if (missingWords.length) {
      warnings.push(`缺 userWords（criteria: ${missingWords.join('、')}）：这条判据没有用户原话，来源不可追溯`);
      degradedWhy.push(`缺 userWords（criteria: ${missingWords.join('、')}）：这条判据没有用户原话，来源不可追溯`);
    }
    if (missingMeas.length) {
      warnings.push(`缺 howMeasured（criteria: ${missingMeas.join('、')}）：没人能复算这个数`);
      degradedWhy.push(`缺 howMeasured（criteria: ${missingMeas.join('、')}）：没人能复算这个数`);
    }
  }
  // 诚实地说"靠人看"是允许的，但搜索不能用它当判据 → 每条 warn 一句（不硬错、不降级）
  for (const c of criteria) {
    if (c.humanEyes) warnings.push(`criteria.${c.id} ${HUMAN_EYES_WARNING_HEAD}（量法：${c.howMeasured}）`);
  }

  if (isV1) {
    warnings.push(V1_WARNING);
    degradedWhy.push('v1 intent（无 version / criteria 无 anchor）：缺锚、反例、自由度、验收方式 —— 审美全交给指标');
  } else {
    if (!nw.present) {
      warnings.push('没写反例（notWanted）：等于把"不要什么"也交给搜索自己猜 —— 原实验里"拒绝写实/PBR"比只写"要二次元"有效得多');
      degradedWhy.push('缺 notWanted（反例）');
    }
    if (!fvf.present) {
      warnings.push('没写自由度（freeVsFixed.fixed / .free）：等于全权交给搜索 —— 需求书把形态全锁成"严格直线"，锁出了僵直激光');
      degradedWhy.push('缺 freeVsFixed（自由度）');
    }
  }
  if (!hwv) warnings.push('没写验收方式（howWeVerify）：这次"谁点头算过"没写进契约（人眼看 / 指标阈值 / 两者都要）');
  if (!understood) warnings.push('intent.understood 是空的：确认了 confirmed，但没留下"我理解你要的是什么"那句话');
  if (!criteria.length) warnings.push('intent.criteria 是空的：这次没有覆盖任何判据（只留了复述记录）');
  // 允许通过，但要 warn 一句（"还有待确认的问题没答"不是硬错：用户可能就是要先跑一版看看）
  if (confirmArr.length) {
    warnings.push(`还有 ${confirmArr.length} 条待确认问题没答，已按当前判据开跑：` + confirmArr.join('；'));
  }

  // 变异体 v1AsDone 只回滚"v1 → degraded"这一条判定（证明第 5 条测试有牙），其它降级照旧。
  let status = degradedWhy.length ? 'degraded' : 'done';
  if (isV1 && INTENT_MUTANT === 'v1AsDone') status = 'done';
  return {
    status,
    chain,
    path: file,
    templatePath: '',
    intent: j,
    version,
    isV1,
    restate,
    anchors,
    criteria,
    // v2.1：有原话几条 / 有量法几条 / 两者都无几条（只做记录与呈现，**不参与距离**）
    provenance: prov,
    notWanted: nw,
    freeVsFixed: fvf,
    howWeVerify: hwv,
    // 硬不变量（0.7.0）：已经过文法校验的 [{id, why, check}]；空数组 = 不拦（cmdloop 会 warn）
    invariants,
    // 掩膜哨兵（0.13.0）：intent 要求"掩膜冻住必须被拦"；false = 没这个要求（命令链路默认仍开着哨兵）
    maskSentinel,
    confirm: confirmArr,
    understood,
    reason: degradedWhy.join('；'),
    warnings,
  };
}

// 统一的返回形状（各处带全字段，下游不用判断字段在不在）
function skippedShape(o = {}) {
  return {
    status: o.status || 'skipped',
    chain: o.chain || 'cmd',
    path: o.path || '',
    templatePath: o.templatePath || '',
    intent: null,
    version: null,
    isV1: false,
    restate: '',
    anchors: [],
    criteria: [],
    provenance: { userWords: 0, howMeasured: 0, neither: 0 },
    notWanted: { present: false, items: [] },
    freeVsFixed: { present: false, fixed: [], free: [] },
    howWeVerify: null,
    // 跳过需求转译 = 没有 invariants（不拦；cmdloop 会 warn 一句"搜索会拿底线换分数"）
    invariants: [],
    // 跳过需求转译 = 也没人要求过哨兵（命令链路的哨兵仍按默认开着）
    maskSentinel: false,
    confirm: [],
    understood: '',
    reason: o.reason || '',
    warnings: o.warnings || [],
  };
}

// ---------------------------------------------------------------- 覆盖判据
// criteria → {weights:{id:w}, targets:{id:t}}（只取真的给了的部分）
export function criteriaOverrides(criteria = []) {
  const weights = {};
  const targets = {};
  for (const c of criteria) {
    if (c.weight !== null && c.weight !== undefined) weights[c.id] = Number(c.weight);
    if (c.target !== null && c.target !== undefined) targets[c.id] = Number(c.target);
  }
  return { weights, targets };
}

// 截图链路的判据配置在 adapter 文件里（metrics2.js / score.js 都按 --adapter 读它），
// 所以覆盖权重只能给一份**派生 adapter**：只改 metrics[].weight，其它字段原样。
// v1 字符串写法的指标没有 weight 槽位 —— 硬错，不偷偷改写形状（那会顺带改掉提取语义）。
export function effectiveAdapterFile(adapterFile, outDir, criteria) {
  const j = JSON.parse(readFileSync(adapterFile, 'utf8'));
  const raw = Array.isArray(j.metrics) ? j.metrics : [];
  if (!raw.length) die(`adapter 没有 metrics 数组，没法按 intent 覆盖判据：${adapterFile}`);
  const notes = [];
  for (const c of criteria) {
    if (c.weight === null || c.weight === undefined) continue;
    const idx = raw.findIndex((it) => (typeof it === 'string' ? it : it && it.id) === c.id);
    if (idx < 0) die(`intent.criteria.${c.id} 不在 adapter.metrics 里（${adapterFile}）`);
    const it = raw[idx];
    if (typeof it === 'string') {
      die(
        `adapter.metrics[${idx}]="${it}" 是 v1 字符串写法，没有 weight 槽位 —— ` +
          `要用 intent 覆盖权重，请把它写成 {id:"${it}", extract:"…", weight:…} 的 v2 对象`,
      );
    }
    const from = it.weight === undefined ? 1 : Number(it.weight);
    it.weight = c.weight;
    notes.push(`${c.id}: weight ${from} → ${c.weight}`);
  }
  const dir = join(outDir, 'intent');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'adapter.effective.json');
  writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');
  return { file, notes };
}

// ---------------------------------------------------------------- intent 摘要（记录与呈现用，**不参与距离**）
// v2 的四样（restate / anchors / notWanted / freeVsFixed / howWeVerify）不进任何判据 ——
// 它们只是"这次转译到底说了什么"的记录：写进台帐（artifacts 指向本文件 + decision.basis）
// 和 report.md 顶部的摘要段。**不参与距离计算**是一条纪律：锚一旦进了距离，就又变成"指标替代审美"。
// 实现只有一份：harness/intent-summary.js（CommonJS，finalize.js 也要 require 它），顶部已 createRequire 拉进来。
export const intentSummaryOf = intentSummaryCjs.intentSummaryOf;
export const writeIntentSummary = intentSummaryCjs.writeIntentSummary;
export const readIntentSummary = intentSummaryCjs.readIntentSummary;
export const intentSummaryLines = intentSummaryCjs.intentSummaryLines;

// ---------------------------------------------------------------- 台帐记录（两个入口共用同一个形状）
// 字段固定：node / seq / status / producer / ms / inputs / decision / artifacts / cost / reason
export function intentNodeRecord(res, extra = {}) {
  const chain = res.chain === 'screenshot' ? 'screenshot' : 'command';
  const artifacts = [];
  if (extra.summaryFile) artifacts.push(extra.summaryFile);
  if (extra.effectiveAdapter) artifacts.push(extra.effectiveAdapter);
  const basis = [];
  if (res.status === 'skipped') {
    basis.push('--no-intent：显式跳过需求转译（本次判据 = adapter 原样，没人确认过它是不是你要的）');
    basis.push('硬不变量 0 条（--no-intent：门禁没装，搜索会拿底线换分数）');
  } else {
    const it = res.intent || {};
    basis.push(`intent 版本：v${res.version ?? 1}${res.isV1 ? '（v1 老写法：没有锚/反例/自由度，等于把审美全交给指标）' : ''}`);
    basis.push('confirmed=true' + (it.confirmedBy ? `（${it.confirmedBy}）` : '') + (it.confirmedAt ? ' @ ' + it.confirmedAt : ''));
    if (res.restate) basis.push('restate: ' + res.restate);
    if (res.understood && res.understood !== res.restate) basis.push('understood: ' + res.understood);
    // 锚 / 反例 / 自由度 / 验收方式：写进台帐只为记录与呈现（**不参与距离**）
    const anchors = Array.isArray(res.anchors) ? res.anchors : [];
    if (anchors.length) {
      basis.push(
        '锚 ' + anchors.length + ' 条：' + anchors.map((a, i) => `anchors[${i}](${a.kind}) ${a.ref}${a.why ? ' —— ' + a.why : ''}`).join(' / '),
      );
    } else {
      basis.push('锚 0 条（v1：没有参照物，只剩指标）');
    }
    const nw = res.notWanted || { present: false, items: [] };
    if (nw.present) basis.push('反例 ' + nw.items.length + ' 条：' + (nw.items.join(' / ') || '（显式空数组）'));
    const fvf = res.freeVsFixed || { present: false, fixed: [], free: [] };
    if (fvf.present) basis.push('自由度：定死 ' + fvf.fixed.length + ' 条（' + (fvf.fixed.join(' / ') || '无') + '） / 自由 ' + fvf.free.length + ' 条（' + (fvf.free.join(' / ') || '无') + '）');
    if (res.howWeVerify) {
      const h = res.howWeVerify;
      basis.push('验收方式：' + (h.human && h.metrics ? '人眼 + 指标' : h.human ? '人眼' : '指标阈值') + (h.note ? '（' + h.note + '）' : ''));
    }
    basis.push('以上（restate / 锚 / 反例 / 自由度 / 验收方式）**不参与距离计算**，只做记录与呈现');
    // 硬不变量（0.7.0）：**改的是判据结构**（合格/不合格），不是距离权重 —— 所以它单独一条，别混进上面那行。
    const invs = Array.isArray(res.invariants) ? res.invariants : [];
    if (invs.length) {
      basis.push(
        '硬不变量 ' + invs.length + ' 条（不合格直接判废，不进距离）：' + invs.map((x) => '`' + x.id + '` ' + formatCheck(x.check) + ' —— ' + x.why).join(' / '),
      );
    } else {
      basis.push('硬不变量 0 条（没写：搜索会拿底线换分数）');
    }
    if (res.criteria.length) {
      for (const c of res.criteria) {
        const bits = [];
        if (c.weight !== null) bits.push('weight=' + c.weight);
        if (c.target !== null) bits.push('target=' + c.target);
        // v2.1：来源与量法也逐条记账（缺的写 ⚠，一眼看出哪条判据是"凭空"的）
        const provBits =
          '（原话：' + (c.hasUserWords ? c.userWords : '⚠') + ' / 量法：' + (c.hasHowMeasured ? c.howMeasured : '⚠') + '）';
        basis.push(
          `覆盖判据 ${c.id}：${bits.join(' ')}${c.anchor ? '（锚：' + c.anchor + '）' : ''}${c.why ? '（原因：' + c.why + '）' : ''}${provBits}`,
        );
      }
      // v2.1：来源与量法的分项计数（回答"这次判据里有多少条真的说得出来源/量法"）
      const prv = res.provenance || { userWords: 0, howMeasured: 0, neither: 0 };
      basis.push(`判据来源：有原话 ${prv.userWords} 条 / 有量法 ${prv.howMeasured} 条 / 两者都无 ${prv.neither} 条`);
      if (res.criteria.some((c) => c.humanEyes)) {
        basis.push(
          '量法靠人看的判据：' +
            res.criteria.filter((c) => c.humanEyes).map((c) => '`' + c.id + '`').join(' / ') +
            '（搜索不能用它当判据 —— 考虑降权或改成可测量的量）',
        );
      }
    } else {
      basis.push('criteria 为空：没有覆盖任何判据');
      basis.push('判据来源：有原话 0 条 / 有量法 0 条 / 两者都无 0 条');
    }
    for (const w of extra.notes || []) basis.push('adapter 派生：' + w);
    for (const w of res.warnings || []) basis.push('提醒：' + w);
    if (res.reason) basis.push('降级原因：' + res.reason);
  }
  const why =
    res.status === 'skipped'
      ? '显式跳过需求转译：放行，但这一步没有产物，判据全部按 adapter 原样'
      : res.status === 'degraded'
        ? `需求转译过了闸，但缺东西（${res.reason}）—— 记 degraded，不假装 done`
        : `需求转译已过闸（${chain === 'screenshot' ? '截图链路' : '命令链路'}，v${res.version ?? 1}）：criteria 覆盖 ${res.criteria.length} 条判据，锚 ${(res.anchors || []).length} 条`;
  const reason =
    res.status === 'done' ? '' : res.status === 'skipped' ? NO_INTENT_REASON + '（台帐：跳过有名字）' : String(res.reason || '（变异体）');
  return {
    node: 'intent',
    status: res.status,
    producer: 'agent',
    ms: extra.ms ?? null,
    inputs: res.path ? [res.path] : ['（无 intent 文件，显式跳过）'],
    decision: { why, basis },
    artifacts,
    cost: { evals: 0 },
    reason,
  };
}

// ---------------------------------------------------------------- CLI（截图链路 iter.ps1 用：逻辑只有这一份，PS 只转发）
function parseArgs(argv) {
  const a = { cmd: '', out: '', adapter: '', intent: '', noIntent: false, noResearch: false, chain: 'cmd', metricIds: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--no-intent') {
      a.noIntent = true;
      continue;
    }
    if (k === '--no-research') {
      a.noResearch = true;
      continue;
    }
    const v = argv[i + 1];
    if (k === '--out') a.out = v ?? '';
    else if (k === '--adapter') a.adapter = v ?? '';
    else if (k === '--intent') a.intent = v ?? '';
    else if (k === '--chain') a.chain = v ?? '';
    else if (k === '--metric-ids') a.metricIds = v ?? '';
    else throw new Error(`不认识的参数 ${k}（gate 只认 --out/--adapter/--intent/--no-intent/--no-research/--chain/--metric-ids）`);
    i += 1;
  }
  return a;
}

function gateCli(argv) {
  const a = parseArgs(argv);
  if (!a.out) throw new Error('缺 --out（台帐与模板要落到 run 目录）');
  if (!a.adapter) throw new Error('缺 --adapter（criteria 的 id 要拿它校验）');
  const chain = CHAINS.includes(a.chain) ? a.chain : 'cmd';
  const metricIds = a.metricIds
    ? a.metricIds.split(',').map((s) => s.trim()).filter(Boolean)
    : adapterMetricIds(a.adapter);
  const outDir = resolve(a.out);
  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const res = resolveIntent({ outDir, intentPath: a.intent, noIntent: a.noIntent, metricIds, chain });
  const notes = [];
  let effectiveAdapter = '';
  if (res.status === 'done' || res.status === 'degraded') {
    const hasWeight = res.criteria.some((c) => c.weight !== null);
    const hasTarget = res.criteria.some((c) => c.target !== null);
    if (hasWeight) {
      const eff = effectiveAdapterFile(resolve(a.adapter), outDir, res.criteria);
      effectiveAdapter = eff.file;
      notes.push(...eff.notes);
    }
    if (hasTarget && chain === 'screenshot') {
      // 记账诚实：目标值在截图链路没有落点（锚点来自目标帧实测），所以这条闸降级而不是假装生效
      res.criteria = res.criteria.map((c) => (c.target === null ? c : { ...c, target: null }));
      res.status = 'degraded';
      res.reason = [res.reason, 'criteria[].target 在截图链路不生效（目标锚点来自目标帧实测，不在 adapter 里）：已记账，未参与距离']
        .filter(Boolean)
        .join('；');
    }
  }
  // ── 调研闸（0.16.0 起；0.17.0 加严）────────────────────────────────────
  // 2026-11-16 实战教训：agent 拿到参考图后**没量就拍阈值**，判据全错；
  // 更糟的是「调查员」这个角色根本没被派出去——只随手搜一下，连外部来源都没留下。
  // 现在的规矩有三条，缺一条就硬错：
  //   ① 有图片锚点，就必须有 research.json；
  //   ② extracted[] 不能空（说明量过参考，不是凭感觉）；
  //   ③ findings[] 至少 2 条、每条带 http(s) URL、且至少 1 条 used=true
  //      ——「调研过」的证据是外部来源 + 真的改变了做法，不是自言自语。
  if ((res.status === 'done' || res.status === 'degraded') && !a.noResearch) {
    const imageAnchors = (res.anchors || []).filter((x) => x && x.kind === 'image');
    if (imageAnchors.length > 0) {
      let research = null;
      const researchPath = join(outDir, RESEARCH_FILE);
      try { research = JSON.parse(readFileSync(researchPath, 'utf8')); } catch { research = null; }
      if (research == null) {
        throw new Error(
          '[调研闸] 这份 intent 声明了 ' + imageAnchors.length + ' 个图片锚点，但没有 research.json：' +
          '\n  ' + researchPath +
          '\n  先跑：node harness/ref-probe.mjs <参考图或帧目录> --json <out>/ref.extracted.json' +
          '\n  再派调查员做外部调研（算法/开源实现/文献），把结果写进 findings[]。' +
          '\n  确实要跳过：加 --no-research（台帐会记一条 skipped research）'
        );
      }
      const extracted = Array.isArray(research.extracted) ? research.extracted : [];
      if (extracted.length === 0) {
        throw new Error(
          '[调研闸] research.extracted[] 是空的：说明参考图没被量过，判据阈值就是凭感觉拍的。' +
          '\n  先跑：node harness/ref-probe.mjs <参考图或帧目录> --json <out>/ref.extracted.json' +
          '\n  再把结果并进 ' + researchPath + ' 的 extracted[]（每条写清 what / value / source）'
        );
      }
      const findings = Array.isArray(research.findings) ? research.findings : [];
      const withUrl = findings.filter((f) => f && typeof f.url === 'string' && /^https?:\/\//i.test(f.url));
      const used = findings.filter((f) => f && f.used === true);
      if (withUrl.length < 2 || used.length < 1) {
        throw new Error(
          '[调研闸] 调研不算做完：findings 里带 http(s) 来源的只有 ' + withUrl.length + ' 条、used=true 的 ' + used.length + ' 条。' +
          '\n  要求：至少 2 条外部来源（开源实现 / 文章 / 论文，给真 URL），且至少 1 条 marked used=true —— ' +
          '用来证明「调研真的改变了做法」，不是自言自语。' +
          '\n  做法：派一个调查员子代理去查（别自己随手搜一下就算），把它的产出写进 findings[]。' +
          '\n  确实要跳过：--no-research'
        );
      }
      notes.push('调研闸：锚点 ' + imageAnchors.length + ' 个 / 实测 ' + extracted.length + ' 条 / 外部来源 ' + withUrl.length + ' 条 / 采用 ' + used.length + ' 条');
    }
  }

  // 摘要落盘（v2 的四样：记录与呈现用，**不参与距离**）—— finalize.js 从 <out>/intent.summary.json 读它
  const summaryAbs = writeIntentSummary(outDir, res);
  const summaryRel = summaryAbs ? relativeTo(outDir, summaryAbs) : '';
  const ledger = createLedger(outDir);
  ledger.add(intentNodeRecord(res, { ms: Date.now() - t0, effectiveAdapter, notes, summaryFile: summaryRel }));
  console.log(
    JSON.stringify({
      status: res.status,
      nodeFile: join('nodes', '01-intent.json'),
      version: res.version ?? null,
      isV1: Boolean(res.isV1),
      restate: res.restate || '',
      anchorCount: (res.anchors || []).length,
      // 硬不变量只在命令链路生效（0.7.0）；截图链路写了就已在上面硬错。
      invariantCount: (res.invariants || []).length,
      summaryFile: summaryRel,
      effectiveAdapter,
      criteria: res.criteria,
      // v2.1：有原话几条 / 有量法几条 / 两者都无几条（不参与距离，只做记录与呈现）
      provenance: res.provenance || { userWords: 0, howMeasured: 0, neither: 0 },
      warnings: res.warnings || [],
    }),
  );
}

function adapterMetricIds(adapterFile) {
  const j = JSON.parse(readFileSync(adapterFile, 'utf8'));
  const raw = Array.isArray(j.metrics) ? j.metrics : Array.isArray(j.observe?.metrics) ? j.observe.metrics : [];
  return raw.map((it) => (typeof it === 'string' ? it : String(it?.id ?? ''))).filter(Boolean);
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] !== 'gate') {
    console.error('用法: node harness/intent.mjs gate --out <run目录> --adapter <a.json> [--intent <file>] [--no-intent] [--chain cmd|screenshot] [--metric-ids a,b]');
    process.exit(2);
  }
  try {
    gateCli(argv.slice(1));
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
