// harness/audit.mjs —— 拿今天的标准复算历史 run（0.8.0；批量与"判不了"的区分见下）
//
// 为什么有它：门禁只在**当下**判。事后给 intent 加了一条不变量、或者把阈值收紧了，
// 旧 run 的 best 是不是还合格 —— 以前没有任何机制回答这件事，那份"最优"会一直被当成结论用。
//
// 它读旧 run 的 best.json / curve.csv / outputs/（每次评估的原始 stdout），
// 用**当前** intent.invariants 对**每个历史评估点**重新判定，然后回答四件事：
//   ① 有多少点现在不合格（N/total）；
//   ② 当时的 best 按今天的标准还合不合格；
//   ③ 不合格时，在"今天合格"的点里按**当时记录的距离**挑新的最优，并给出它的参数；
//   ④ 一个合格点都没有：明说"按今天的标准，这一轮没有可用结果"。
//
// 用法：
//   node harness/audit.mjs <run目录> --intent <intent.json> [--json] [--strict]
//   node harness/audit.mjs --dir <runs根> --intent <intent.json> [--json] [--strict]
//
// 三种判定，**不许互相冒充**（这一版的重点）：
//   ok           过得了今天的门禁
//   fail         今天不合格（真的判出来了，观测完整）
//   undecidable  判不了：字段取不到 / stdout 解析不出来 / **原始输出被截断（capped:true）**
//                —— 它是"证据不够"，不是"不合格"。两份证据包里，一份判废、一份判不了，
//                混成一类就等于把"证据坏了"写成"结论坏了"，那是最坏的一种看起来确定。
//
// 退出码：
//   0  best 今天仍合格（--strict 时还要求"没有更优点"）
//   1  best 今天不合格（--strict 时"有更优点"也算 1）
//   2  跑不起来：缺 best.json / curve.csv / outputs/、截图链路的 run、intent 文法错；
//      或**某个 run 的所有评估点都不可判定**（证据包坏了 —— 别把它读成合格，也别读成不合格）
//   3  best 那个点判不了（值不值得管它取决于你：补证据再来，别当成"合格"）
//   --dir 批量时取"最严重"的那个：有一个 1 就是 1，其次 2，其次 3，全合格才是 0。
//
// 只对命令链路（cmdloop.mjs）的 run 生效。截图链路（iter.ps1）的观测是页面指标，
// 只有 best.json 里的结论、没有可复算的原始输出与字段表 → 遇到就说"暂不支持截图链路"。
//
// 复算的边界（重要，别当成全量重跑）：
//   · 门禁用今天的 `intent.invariants`；**距离仍是当时记录的 d**。
//     今天改了 `criteria` 的权重/目标值不会重算距离 —— 所以"新的最优"是
//     「在今天合格的点里、按当时的距离」挑出来的，不是"按今天的判据重新排序"。
//   · 每个点的观测 = outputs/eNNN.json 里的 metrics + 用 best.json 的 observe.parse
//     把 stdout **重新解析**出的字段表（不变量可以引用输出字段，只读 metrics 不够）。
//   · outputs/ 被清掉的 run 无法复算 → exit 2：best.json 里的指标是"当时判的结论"，
//     拿结论去证明结论不算复算。
//   · 被截断的证据（capped:true）同样无法复算字段型不变量 → 该点记 undecidable。
'use strict';

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_CAP_BYTES, parseOutput } from './cmdlib.mjs';
import { createInvariantGate, resolveInvariants } from './invariants.mjs';

const USAGE = `用法：
  node harness/audit.mjs <run目录> --intent <intent.json> [--json] [--strict]
  node harness/audit.mjs --dir <runs根> --intent <intent.json> [--json] [--strict]

  拿**今天**的 intent.invariants，对旧 run 的每个历史评估点重新判定一次。

选项：
  --intent <file>  今天的标准（只读它的 invariants；criteria 不参与复算 —— 距离用当时记录的 d）
  --dir <runs根>   批量：扫这个目录**下面一层**的每个子目录（一个 run 一个目录），逐个复算，
                   最后给一张总表（名字 / 点数 / 今天不合格数 / best 是否合格 / exit）
  --json           结构化输出（给人看的那几行不打印，机器读这一份）
  --strict         更严：best 今天仍合格、但有更优的合格点时也 exit 1
  --help           这份说明

判定三类（不许互相冒充）：
  ok            过得了今天的门禁
  fail          今天不合格（观测完整，真的判出来了）
  undecidable   判不了：字段取不到 / stdout 解析不出来 / 原始输出被截断（capped:true）
                —— "证据不够"不是"不合格"，也不算进不合格数

退出码：
  0  best 今天仍合格（--strict 时还要"没有更优点"）
  1  best 今天不合格（--strict 时"有更优点"也算 1）
  2  跑不起来（缺 best.json / curve.csv / outputs/、截图链路的 run、intent 文法错），
     或某个 run 的**所有评估点都不可判定**（证据包坏了）
  3  best 那个点判不了（证据不够，既不算合格也不算不合格）
  --dir 批量时取最严重的那个：有 1 → 1，其次 2，其次 3，全合格才 0

只对**命令链路**（cmdloop.mjs）的 run 生效：截图链路（iter.ps1）没有 outputs/ 与字段表，
它的观测是页面指标、只剩 best.json 里的结论 —— 遇到直接说"暂不支持截图链路"，不瞎算。`;

class AuditError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

// 变异开关：**只给测试用**（证明"不可判定"与"capped"这两条断言真有牙），不设时行为完全正常。
//   undecidableAsInvalid —— 把"不可判定"当成"不合格"（正是这一版要拆开的那两件事）
//   ignoreCapped         —— 不认 capped / truncated 标记（拿半份原文照复算）
export const AUDIT_MUTANT = String(process.env.SELFLOOP_AUDIT_MUTANT || '');

function parseArgs(argv) {
  const a = { run: '', dir: '', intent: '', json: false, strict: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--help' || k === '-h') {
      a.help = true;
      continue;
    }
    if (k === '--json') {
      a.json = true;
      continue;
    }
    if (k === '--strict') {
      a.strict = true;
      continue;
    }
    if (k === '--intent') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new AuditError('[audit] --intent 缺值（今天的标准从哪来）');
      a.intent = v;
      i += 1;
      continue;
    }
    if (k === '--dir') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new AuditError('[audit] --dir 缺值（runs 根目录在哪）');
      a.dir = v;
      i += 1;
      continue;
    }
    if (k.startsWith('--')) throw new AuditError(`[audit] 不认识的参数 ${k}（--help 看用法）`);
    if (a.run) throw new AuditError(`[audit] 多给了一个 run 目录：${k}（一次只复算一个 run；要批量扫用 --dir）`);
    a.run = k;
  }
  if (a.run && a.dir) throw new AuditError('[audit] --dir 与单个 run 目录不能同时给：要么复算一个 run，要么扫一层子目录');
  if (!a.help && !a.run && !a.dir) throw new AuditError('[audit] 缺 run 目录（或 --dir <runs根>）：复算哪一个？');
  return a;
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new AuditError(`[audit] ${what} 读不出来：${file}\n  ${e.message}`);
  }
}

const f6 = (v) => (Number.isFinite(Number(v)) ? String(Number(Number(v).toFixed(6))) : String(v));
const d4 = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(4) : 'n/a');

function paramsText(params) {
  const o = params && typeof params === 'object' ? params : {};
  return '{' + Object.keys(o).map((k) => `${k}=${f6(o[k])}`).join(', ') + '}';
}

// ---------------------------------------------------------------- 今天的标准（一次读好，批量时共用）
function prepareStandard(args) {
  if (!args.intent) {
    throw new AuditError('[audit] 缺 --intent：今天的标准从哪来？用法 node harness/audit.mjs <run目录> --intent <intent.json>');
  }
  const intentFile = resolve(args.intent);
  if (!existsSync(intentFile)) throw new AuditError(`[audit] intent 文件不存在：${intentFile}`);
  const intentDoc = readJson(intentFile, 'intent.json');
  let items;
  try {
    items = resolveInvariants(intentDoc.invariants);
  } catch (e) {
    throw new AuditError(`[audit] 今天的 intent 里 invariants 文法不对，没法复算（不猜、不跳过）：\n${e.message}`);
  }
  const warnings = [];
  if (!items.length) {
    warnings.push('今天的 intent 没有 invariants（或写了 []）：每个点都会"合格"，这次复算没有信息量 —— 先补上不变量再跑。');
  }
  const crit = Array.isArray(intentDoc.criteria) ? intentDoc.criteria.filter((c) => c && (c.weight !== undefined || c.target !== undefined)) : [];
  if (crit.length) {
    warnings.push(
      `intent.criteria 里改了 ${crit.length} 条判据（${crit.map((c) => c.id).join(' / ')}）—— 复算**不重算距离**（距离用当时记录的 d），` +
        `所以"新的最优"是按当时的距离挑的，不是按今天的权重重新排序。`,
    );
  }
  return { intentFile, intentDoc, items, warnings };
}

// ---------------------------------------------------------------- 复算一个 run
// 返回 { exitCode, lines, json }；结构化失败一律抛 AuditError（=> exit 2）。
export function auditRun({ run, intentFile, intentDoc, items, strict = false, standardWarnings = [] }) {
  const runDir = resolve(run);
  if (!existsSync(runDir)) throw new AuditError(`[audit] run 目录不存在：${runDir}`);

  // ---------------------------------------------------------------- 读证据包本体
  const bestFile = join(runDir, 'best.json');
  if (!existsSync(bestFile)) {
    throw new AuditError(
      `[audit] 找不到 ${bestFile}：这里不像是一次命令观测的 run（证据包必须有 best.json）。\n` +
        `  如果这是截图链路（iter.ps1）的 run，它没有 outputs/ 与字段表 —— **暂不支持截图链路**，只对命令链路（cmdloop.mjs）的 run 生效。`,
    );
  }
  const best = readJson(bestFile, 'best.json');
  if (best.schema !== 'cmd-iter/1' || !best.observe || typeof best.observe.parse !== 'string') {
    throw new AuditError(
      `[audit] 暂不支持截图链路（iter.ps1）的 run：best.json 的 schema=${JSON.stringify(best.schema ?? null)}，` +
        `不是命令链路的 \`cmd-iter/1\`；也没有 outputs/ 与字段表 —— 观测是页面指标、只留在 best.json 里，没有可复算的原始输出。\n` +
        `  复算只对命令链路（\`node harness/cmdloop.mjs\`）的 run 生效：${runDir}`,
    );
  }
  const outputsDir = join(runDir, 'outputs');
  if (!existsSync(outputsDir)) {
    throw new AuditError(
      `[audit] 这个 run 没有 outputs/（每次评估的原始 stdout 是复算的唯一依据）：${outputsDir}\n` +
        `  best.json / curve.csv 里的指标是"当时算的结论"，不是原始观测 —— 拿结论去证明结论不算复算。\n` +
        `  （截图链路的 run 本来就没有 outputs/ —— 那种 run 暂不支持。）`,
    );
  }
  const curveFile = join(runDir, 'curve.csv');
  if (!existsSync(curveFile)) {
    throw new AuditError(
      `[audit] 找不到 ${curveFile}：命令链路的证据包必须带 curve.csv（每个评估点一行），缺它就没法确认评估序列的完整性。`,
    );
  }

  const warnings = standardWarnings.slice();

  // ---------------------------------------------------------------- 每个历史点的观测
  const metricIds = Array.isArray(best.metricIds) ? best.metricIds.map(String) : [];
  const parseMode = String(best.observe.parse || 'json');
  const points = Array.isArray(best.curve) ? best.curve.slice() : [];
  if (!points.length) {
    throw new AuditError('[audit] best.json 里没有 curve（评估序列）：这份证据包不完整，没法逐点复算。');
  }
  const csvRows = readFileSync(curveFile, 'utf8').trim().split(/\r?\n/).filter((l) => l.trim() !== '');
  const csvCount = Math.max(0, csvRows.length - 1);
  if (csvCount !== points.length) {
    warnings.push(`curve.csv 有 ${csvCount} 行评估点，best.json 的 curve 有 ${points.length} 条 —— 两者对不上，按 best.json 复算。`);
  }

  const missing = [];
  const resolved = points.map((p) => {
    const rel = String(p.output || '').trim() || join('outputs', 'e' + String(p.seq).padStart(3, '0') + '.json');
    const file = join(runDir, rel);
    if (!existsSync(file)) missing.push(rel);
    return { p, rel, file };
  });
  if (missing.length) {
    throw new AuditError(
      `[audit] outputs/ 里缺 ${missing.length} 份评估输出（共 ${points.length} 个点）：${missing.slice(0, 5).join(' / ')}${missing.length > 5 ? ' …' : ''}\n` +
        `  复算要求**每个评估点**都有原始 stdout，少一份就不能说"这一轮整体合格/不合格"。\n` +
        `  旧 run 的 outputs/ 被清掉时只有一个办法：用 best.json 里的 meta.command 原样重跑一次（会换一个 --out 目录，不覆盖旧证据）。`,
    );
  }

  const capBytes = Number(best.meta && best.meta.outputCapBytes) || OUTPUT_CAP_BYTES;
  const gate = createInvariantGate(items);
  const judged = resolved.map(({ p, rel, file }) => {
    const doc = readJson(file, rel);
    const dist = Number(p.dist);
    // 截断过的证据：字段型不变量没法复算 —— 原文的尾巴已经不在了。
    // 它既不是"合格"也不是"不合格"，是"判不了"；硬闯下去就是拿半份 stdout 下结论。
    // capped 是本版起的机器标记，truncated 是老证据包里同一件事的措辞（两边都认）。
    const capped = (doc.capped === true || doc.truncated === true) && AUDIT_MUTANT !== 'ignoreCapped';
    if (capped) {
      const why = `原始输出被截断（capped=true，单份 ${capBytes}B 上限）—— 字段型不变量无法复算`;
      return { p, status: 'undecidable', ok: false, failures: [], reason: `不可判定：${why}`, dist };
    }
    const stdout = String(doc.stdout ?? '');
    let fields = {};
    let fieldsErr = '';
    try {
      fields = parseOutput(stdout, parseMode, metricIds);
    } catch (e) {
      // 解析不出字段表不代表这个点合格 —— 后面 gate.check 会因为取不到字段硬错，这里把原因留住
      fieldsErr = String(e && e.message ? e.message : e);
    }
    try {
      const r = gate.check(
        { metrics: doc.metrics && typeof doc.metrics === 'object' ? doc.metrics : {}, fields, stdout, stderr: String(doc.stderr ?? '') },
        { seq: p.seq, phase: 'audit' },
      );
      const failures = r.failures.map((f) => ({ id: f.id, text: f.text, values: f.values }));
      const reason = failures.map((f) => `违反 ${f.id}（${f.text}；观测 ${JSON.stringify(f.values)}）`).join('；');
      return { p, status: r.ok ? 'ok' : 'fail', ok: r.ok, failures, reason, dist };
    } catch (e) {
      // 取不到字段 / 文法在这个点上爆掉 = 判不了。判不了就**不能算合格**（跟运行时"不许静默判过"同一个立场），
      // 但也不能算不合格 —— 那是"证据不够"，不是"结论是坏的"。
      const why = String(e && e.message ? e.message : e).split('\n')[0];
      const reason = `不可判定：${why}${fieldsErr ? '（stdout 也没解析成字段表：' + fieldsErr.split('\n')[0] + '）' : ''}`;
      return { p, status: 'undecidable', ok: false, failures: [], reason, dist };
    }
  });
  // 变异体：把"判不了"当成"不合格" —— 只为证明下面那几条断言真的接在实现上
  if (AUDIT_MUTANT === 'undecidableAsInvalid') {
    for (const j of judged) {
      if (j.status === 'undecidable') {
        j.status = 'fail';
        j.reason = '不可判定（变异体当成不合格）：' + j.reason;
      }
    }
  }

  // ---------------------------------------------------------------- 当时的 best 是哪一个点
  const wl = Array.isArray(best.whitelist) ? best.whitelist.map(String) : [];
  const sameParams = (a, b) =>
    wl.length > 0 && wl.every((k) => Number.isFinite(Number(a && a[k])) && Number.isFinite(Number(b && b[k])) && Math.abs(Number(a[k]) - Number(b[k])) < 1e-9);
  let bestIdx = judged.findIndex((j) => sameParams(j.p.params, best.bestParams) && Math.abs(j.dist - Number(best.bestDist)) < 1e-9);
  if (bestIdx < 0) bestIdx = judged.findIndex((j) => sameParams(j.p.params, best.bestParams));
  if (bestIdx < 0) {
    // 退化：best.json 的 bestParams 和 curve 对不上（老版本证据包 / 手改过）—— 按当时的最小距离兜底
    let m = Infinity;
    judged.forEach((j, i) => {
      if (Number.isFinite(j.dist) && j.dist < m) {
        m = j.dist;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) warnings.push('best.json 的 bestParams 在 curve 里对不上，按"当时距离最小"的那个点认作 best。');
  }
  if (bestIdx < 0) throw new AuditError('[audit] 找不到当时的 best 对应哪个评估点（best.json 的 curve 里没有可比的距离/参数）。');

  const bestPoint = judged[bestIdx];
  const bestStatus = bestPoint.status;
  const bestOk = bestStatus === 'ok';
  const nowInvalid = judged.filter((j) => j.status === 'fail');
  const undecidablePoints = judged.filter((j) => j.status === 'undecidable');
  const allUndecidable = judged.length > 0 && undecidablePoints.length === judged.length;
  if (undecidablePoints.length) {
    warnings.push(
      `有 ${undecidablePoints.length} 个评估点判不了（字段取不到 / 原始输出被截断）：它们**不算不合格**，也不算合格 —— ` +
        `要下结论得先补证据（重跑一份没被截断的 outputs/，或把不变量改成引用 metrics 里的字段）。`,
    );
  }
  // 候选集里**排除目标锚点**：目标那个点 d 恒为 0（它就是"离目标的距离"的定义），
  // 把它当"新的最优"等于说"最优就是目标参数"—— 一句话废话，还会把真正的候选挤掉。
  // 认锚点优先用 best.json 的 target.seq（精确）；老证据包没这个字段时退回 note/id。
  const targetSeq = best.target && Number.isFinite(Number(best.target.seq)) ? Number(best.target.seq) : null;
  const isTargetPoint = (p) =>
    (targetSeq !== null && Number(p.seq) === targetSeq) || String(p.note || '') === 'target' || String(p.id || '') === 'target';
  const targetPoint = targetSeq !== null ? judged.find((j) => Number(j.p.seq) === targetSeq) || null : null;
  const passing = judged.filter((j) => j.status === 'ok' && !isTargetPoint(j.p) && Number.isFinite(j.dist)).sort((a, b) => a.dist - b.dist);
  const suggested = passing.length ? passing[0] : null;
  const betterExists = Boolean(bestOk && suggested && suggested.dist < Number(best.bestDist) - 1e-9);

  // exit：证据全烂（2）优先于"best 判不了"（3）；真判出不合格就是 1；都不占才是 0。
  let exitCode = 0;
  if (allUndecidable) exitCode = 2;
  else if (bestStatus === 'fail') exitCode = 1;
  else if (bestStatus === 'undecidable') exitCode = 3;
  else if (strict && betterExists) exitCode = 1;

  // ---------------------------------------------------------------- 人看的那几行
  const lines = [];
  lines.push(`[audit] run：${runDir}`);
  lines.push(
    `[audit] 今天的标准：${intentFile}，硬不变量 ${items.length} 条` +
      (items.length ? `（${items.map((it) => it.id).join(' / ')}）` : '（没有门禁）'),
  );
  lines.push(`[audit] 评估点 ${points.length} 个（outputs/ ${judged.length} 份原始输出逐点复算）`);
  lines.push(
    `[audit] 现在不合格：${nowInvalid.length} / ${judged.length}` +
      (undecidablePoints.length ? `（另有 ${undecidablePoints.length} 个不可判定：证据被截断/字段取不到，不算不合格也不算合格）` : ''),
  );
  for (const j of nowInvalid) {
    lines.push(`[audit]   - seq=${j.p.seq} d=${d4(j.dist)} 参数 ${paramsText(j.p.params)}：${j.reason}`);
  }
  for (const j of undecidablePoints) {
    lines.push(`[audit]   ~ seq=${j.p.seq} d=${d4(j.dist)} 参数 ${paramsText(j.p.params)}：${j.reason}`);
  }
  if (allUndecidable) {
    lines.push(
      `[audit] ⚠ 这个 run 的 ${judged.length} 个评估点**全部不可判定** —— 证据包坏了（原始输出被截断 / 字段取不到）。` +
        `别把它读成"合格"，也别读成"不合格"：这两种结论都需要一份能复算的证据，而这份不是。`,
    );
  }
  if (targetPoint && targetPoint.status === 'fail') {
    lines.push(
      `[audit] 注意：目标锚点（seq=${targetPoint.p.seq}）本身也过不了今天的门禁 —— 今天的判据和当时的目标自相矛盾，先修判据，别急着换最优。`,
    );
  } else if (targetPoint && targetPoint.status === 'undecidable') {
    lines.push(`[audit] 注意：目标锚点（seq=${targetPoint.p.seq}）判不了 —— ${targetPoint.reason}`);
  }
  const bestHead = `[audit] 当时的 best（seq=${bestPoint.p.seq} d=${d4(Number(best.bestDist))} 参数 ${paramsText(bestPoint.p.params)}）：`;
  if (bestStatus === 'ok') {
    lines.push(bestHead + '✓ 按今天的标准仍合格');
  } else if (bestStatus === 'fail') {
    lines.push(bestHead + '✗ 按今天的标准不合格 —— ' + bestPoint.reason);
  } else {
    lines.push(bestHead + '? 今天判不了（不可判定）—— ' + bestPoint.reason);
    lines.push('[audit] 判不了不等于合格：补证据（没被截断的 outputs/、取得到的字段）再来复算，或者按"不确定"处理。');
  }
  if (!passing.length) {
    const okCount = judged.filter((j) => j.status === 'ok').length;
    lines.push(
      `[audit] 按今天的标准，这一轮没有可用结果（${judged.length} 个评估点里 ${okCount} 个过门禁` +
        `${undecidablePoints.length ? `，${undecidablePoints.length} 个判不了` : ''}` +
        `${okCount > 0 ? '，但它们全是目标锚点（d 恒为 0，不算候选）' : ''}）—— 别拿它当结论。`,
    );
  } else if (bestStatus === 'fail') {
    lines.push(
      `[audit] 新的最优（在今天合格的点里、按当时记录的距离）：seq=${suggested.p.seq} d=${d4(suggested.dist)} 参数 ${paramsText(suggested.p.params)}`,
    );
  } else if (betterExists) {
    lines.push(
      `[audit] 更优的合格点：seq=${suggested.p.seq} d=${d4(suggested.dist)}（当时 best d=${d4(Number(best.bestDist))}）参数 ${paramsText(suggested.p.params)}` +
        (strict ? ' —— --strict 下这算不合格' : ''),
    );
  } else if (bestStatus === 'ok') {
    lines.push('[audit] 今天的合格点里没有比它更优的：这份结论不需要改。');
  }
  for (const w of warnings) lines.push(`[audit][warn] ${w}`);
  lines.push(`[audit] exit ${exitCode}`);

  const json = {
    tool: 'selfloop-audit/1',
    run: runDir,
    intent: intentFile,
    chain: 'command',
    strict: Boolean(strict),
    invariants: items.map((it) => ({ id: it.id, why: it.why, text: it.text, check: it.check })),
    total: judged.length,
    // nowInvalid 只数**真的判出不合格**的点；undecidable 单列（它不是不合格）
    nowInvalid: nowInvalid.length,
    undecidable: undecidablePoints.length,
    allUndecidable,
    bestOk,
    bestStatus,
    best: { seq: bestPoint.p.seq, params: bestPoint.p.params, dist: Number(best.bestDist), reasons: bestOk ? [] : [bestPoint.reason] },
    suggestedBest: suggested ? { seq: suggested.p.seq, params: suggested.p.params, dist: suggested.dist } : null,
    betterExists,
    // 扁平的原因清单（界面直接读这一条）：每个不合格点一条
    reasons: nowInvalid.map((j) => `seq=${j.p.seq}：${j.reason}`),
    undecidableReasons: undecidablePoints.map((j) => `seq=${j.p.seq}：${j.reason}`),
    points: judged.map((j) => ({
      seq: j.p.seq,
      dist: Number.isFinite(j.dist) ? j.dist : null,
      params: j.p.params,
      status: j.status,
      ok: j.ok,
      reasons: j.status === 'ok' ? [] : [j.reason],
    })),
    warnings,
    exitCode,
  };
  return { exitCode, lines, json };
}

// 单 run 入口（保留原来的签名：--json 的那份就是 selfloop-audit/1）
export function audit(args) {
  const standard = prepareStandard(args);
  return auditRun({
    run: args.run,
    intentFile: standard.intentFile,
    intentDoc: standard.intentDoc,
    items: standard.items,
    strict: Boolean(args.strict),
    standardWarnings: standard.warnings,
  });
}

// ---------------------------------------------------------------- 批量：--dir <runs根>
// 为什么要有：发版前要一条命令扫完历史证据包。一个 run 一个目录，逐个复算，最后一张总表。
// 单个 run"跑不起来"在这里**不中断整批**（它是一条坏证据，不是这次的语法错误）；
// 但 intent 读不出来是全局错 —— 那说明今天的标准本身没准备好，扫了也白扫。
function auditDir(args) {
  const root = resolve(args.dir);
  if (!existsSync(root)) throw new AuditError(`[audit] --dir 目录不存在：${root}`);
  if (!statSync(root).isDirectory()) throw new AuditError(`[audit] --dir 要一个目录（扫它下面一层的每个 run）：${root}`);
  const standard = prepareStandard(args);
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
  if (!dirs.length) {
    throw new AuditError(`[audit] --dir ${root} 下面没有任何子目录：没有可扫的 run（约定：一个 run 一个目录，里面放 best.json / curve.csv / outputs/）。`);
  }

  const runs = dirs.map((dir) => {
    const name = basename(dir);
    try {
      const res = auditRun({
        run: dir,
        intentFile: standard.intentFile,
        intentDoc: standard.intentDoc,
        items: standard.items,
        strict: Boolean(args.strict),
        standardWarnings: standard.warnings,
      });
      return { name, dir, exitCode: res.exitCode, json: res.json, lines: res.lines, broken: false };
    } catch (e) {
      if (!(e instanceof AuditError)) throw e;
      const reason = String(e.message).split('\n')[0];
      return { name, dir, exitCode: 2, broken: true, reason, lines: [], json: null };
    }
  });

  // 一个不合格就是 1（发版前那条命令的语义）；其次证据坏了 2；其次 best 判不了 3；全好才是 0
  const codes = runs.map((r) => r.exitCode);
  let exitCode = 0;
  if (codes.includes(1)) exitCode = 1;
  else if (codes.includes(2)) exitCode = 2;
  else if (codes.includes(3)) exitCode = 3;

  const rows = runs.map((r) => ({
    name: r.name,
    broken: Boolean(r.broken),
    total: r.broken ? 0 : r.json.total,
    nowInvalid: r.broken ? 0 : r.json.nowInvalid,
    undecidable: r.broken ? 0 : r.json.undecidable,
    best: r.broken ? '跑不起来' : r.json.bestStatus === 'ok' ? '合格' : r.json.bestStatus === 'fail' ? '不合格' : '判不了',
    exitCode: r.exitCode,
    reason: r.broken ? r.reason : '',
    dir: r.dir,
    detail: r.json,
  }));

  const lines = [];
  lines.push(`[audit] 批量扫描：${root}（${runs.length} 个 run）`);
  lines.push(`[audit] 今天的标准：${standard.intentFile}，硬不变量 ${standard.items.length} 条` + (standard.items.length ? `（${standard.items.map((it) => it.id).join(' / ')}）` : '（没有门禁）'));
  for (const w of standard.warnings) lines.push(`[audit][warn] ${w}`);
  lines.push('');
  // 逐 run 一行（人扫一眼就知道哪个有问题）
  for (const row of rows) {
    lines.push(
      `[audit] ${row.name}：${row.total} 个点 / 不合格 ${row.nowInvalid} / 不可判定 ${row.undecidable} / best ${row.best} / exit ${row.exitCode}` +
        (row.reason ? `（${row.reason}）` : ''),
    );
  }
  lines.push('');
  // 总表
  const head = ['run', '点数', '不合格', '不可判定', 'best', 'exit'];
  const table = [head, ...rows.map((r) => [r.name, String(r.total), String(r.nowInvalid), String(r.undecidable), r.best, String(r.exitCode)])];
  // 列宽按**显示宽度**算（中文占两格），否则表头和数据会错位
  const dw = (s) => [...s].reduce((n, ch) => n + (/[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
  const w = head.map((_, i) => Math.max(...table.map((t) => dw(t[i]))));
  const padL = (s, n) => ' '.repeat(Math.max(0, n - dw(s))) + s;
  const padR = (s, n) => s + ' '.repeat(Math.max(0, n - dw(s)));
  const fmt = (t) => t.map((c, i) => (i === 0 ? padR(c, w[i]) : padL(c, w[i]))).join('  ');
  lines.push('[audit] ── 总表 ──');
  lines.push('[audit] ' + fmt(head));
  for (const t of table.slice(1)) lines.push('[audit] ' + fmt(t));
  const cnt = (code) => rows.filter((r) => r.exitCode === code).length;
  lines.push('');
  lines.push(
    `[audit] 合计 ${rows.length} 个 run：合格 ${cnt(0)} / 不合格 ${cnt(1)} / 证据坏了 ${cnt(2)} / best 判不了 ${cnt(3)}`,
  );
  const failed = rows.filter((r) => r.exitCode === 1).map((r) => r.name);
  const broken = rows.filter((r) => r.exitCode === 2).map((r) => r.name);
  const unsure = rows.filter((r) => r.exitCode === 3).map((r) => r.name);
  if (failed.length) lines.push(`[audit] 明天之前要处理的（best 今天不合格）：${failed.join(' / ')}`);
  if (broken.length) lines.push(`[audit] 证据包坏了（跑不起来 / 全部不可判定）：${broken.join(' / ')}`);
  if (unsure.length) lines.push(`[audit] best 判不了（证据不够，别当合格）：${unsure.join(' / ')}`);
  lines.push(`[audit] exit ${exitCode}`);

  const json = {
    tool: 'selfloop-audit/1',
    mode: 'dir',
    root,
    intent: standard.intentFile,
    strict: Boolean(args.strict),
    invariants: standard.items.map((it) => ({ id: it.id, why: it.why, text: it.text, check: it.check })),
    runs: rows.map((r) => {
      const base = { name: r.name, run: r.dir, exitCode: r.exitCode };
      if (r.broken) {
        return { ...base, broken: true, reason: r.reason, total: 0, nowInvalid: 0, undecidable: 0, bestStatus: null, bestOk: null, points: [], reasons: [r.reason], undecidableReasons: [] };
      }
      const d = r.detail;
      return {
        ...base,
        total: d.total,
        nowInvalid: d.nowInvalid,
        undecidable: d.undecidable,
        allUndecidable: d.allUndecidable,
        bestStatus: d.bestStatus,
        bestOk: d.bestOk,
        points: d.points,
        reasons: d.reasons,
        undecidableReasons: d.undecidableReasons,
      };
    }),
    totals: { runs: runs.length, ok: cnt(0), failed: cnt(1), broken: cnt(2), undecidableBest: cnt(3) },
    warnings: standard.warnings,
    exitCode,
  };
  return { exitCode, lines, json };
}

export function auditBatch(args) {
  return auditDir(args);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e && e.message ? e.message : e));
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  try {
    const res = args.dir ? auditDir(args) : audit(args);
    if (args.json) console.log(JSON.stringify(res.json, null, 2));
    else console.log(res.lines.join('\n'));
    process.exit(res.exitCode);
  } catch (e) {
    const code = e instanceof AuditError ? e.code : 2;
    console.error(String(e && e.message ? e.message : e));
    process.exit(code);
  }
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { parseArgs };
