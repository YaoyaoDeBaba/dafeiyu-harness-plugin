// harness/audit.mjs —— 拿今天的标准复算历史 run（0.8.0）
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
//
// 退出码：
//   0  best 今天仍合格（--strict 时还要求"没有更优点"）
//   1  best 今天不合格（--strict 时"有更优点"也算 1）
//   2  跑不起来：缺 best.json / curve.csv / outputs/、截图链路的 run、intent 文法错
//      —— 一律中文说明，绝不"算个大概"
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
'use strict';

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOutput } from './cmdlib.mjs';
import { createInvariantGate, resolveInvariants } from './invariants.mjs';

const USAGE = `用法：
  node harness/audit.mjs <run目录> --intent <intent.json> [--json] [--strict]

  拿**今天**的 intent.invariants，对旧 run 的每个历史评估点重新判定一次。

选项：
  --intent <file>  今天的标准（只读它的 invariants；criteria 不参与复算 —— 距离用当时记录的 d）
  --json           结构化输出（给人看的那几行不打印，机器读这一份）
  --strict         更严：best 今天仍合格、但有更优的合格点时也 exit 1
  --help           这份说明

退出码：
  0  best 今天仍合格（--strict 时还要"没有更优点"）
  1  best 今天不合格（--strict 时"有更优点"也算 1）
  2  跑不起来（缺 best.json / curve.csv / outputs/、截图链路的 run、intent 文法错）

只对**命令链路**（cmdloop.mjs）的 run 生效：截图链路（iter.ps1）没有 outputs/ 与字段表，
它的观测是页面指标、只剩 best.json 里的结论 —— 遇到直接说"暂不支持截图链路"，不瞎算。`;

class AuditError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const a = { run: '', intent: '', json: false, strict: false, help: false };
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
    if (k.startsWith('--')) throw new AuditError(`[audit] 不认识的参数 ${k}（--help 看用法）`);
    if (a.run) throw new AuditError(`[audit] 多给了一个 run 目录：${k}（一次只复算一个 run）`);
    a.run = k;
  }
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

// 复算一个 run。返回 { exitCode, lines, json }；结构化失败一律抛 AuditError（=> exit 2）。
export function audit(args) {
  const runDir = resolve(args.run);
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

  // ---------------------------------------------------------------- 今天的标准
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

  const gate = createInvariantGate(items);
  const judged = resolved.map(({ p, rel, file }) => {
    const doc = readJson(file, rel);
    const stdout = String(doc.stdout ?? '');
    let fields = {};
    let fieldsErr = '';
    try {
      fields = parseOutput(stdout, parseMode, metricIds);
    } catch (e) {
      // 解析不出字段表不代表这个点合格 —— 后面 gate.check 会因为取不到字段硬错，这里把原因留住
      fieldsErr = String(e && e.message ? e.message : e);
    }
    let ok = false;
    let failures = [];
    let undecidable = '';
    try {
      const r = gate.check(
        { metrics: doc.metrics && typeof doc.metrics === 'object' ? doc.metrics : {}, fields, stdout, stderr: String(doc.stderr ?? '') },
        { seq: p.seq, phase: 'audit' },
      );
      ok = r.ok;
      failures = r.failures.map((f) => ({ id: f.id, text: f.text, values: f.values }));
    } catch (e) {
      // 取不到字段 / 文法在这个点上爆掉 = 判不了。判不了就**不能算合格**（跟运行时"不许静默判过"同一个立场）。
      ok = false;
      undecidable = String(e && e.message ? e.message : e).split('\n')[0];
      failures = [{ id: '（不可判定）', text: undecidable, values: {} }];
    }
    const reason = undecidable
      ? `不可判定：${undecidable}${fieldsErr ? '（stdout 也没解析成字段表：' + fieldsErr.split('\n')[0] + '）' : ''}`
      : failures.map((f) => `违反 ${f.id}（${f.text}；观测 ${JSON.stringify(f.values)}）`).join('；');
    return { p, ok, failures, reason, undecidable: Boolean(undecidable), dist: Number(p.dist) };
  });

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
  const bestOk = bestPoint.ok;
  const nowInvalid = judged.filter((j) => !j.ok);
  // 候选集里**排除目标锚点**：目标那个点 d 恒为 0（它就是"离目标的距离"的定义），
  // 把它当"新的最优"等于说"最优就是目标参数"—— 一句话废话，还会把真正的候选挤掉。
  // 认锚点优先用 best.json 的 target.seq（精确）；老证据包没这个字段时退回 note/id。
  const targetSeq = best.target && Number.isFinite(Number(best.target.seq)) ? Number(best.target.seq) : null;
  const isTargetPoint = (p) =>
    (targetSeq !== null && Number(p.seq) === targetSeq) || String(p.note || '') === 'target' || String(p.id || '') === 'target';
  const targetPoint = targetSeq !== null ? judged.find((j) => Number(j.p.seq) === targetSeq) || null : null;
  const passing = judged.filter((j) => j.ok && !isTargetPoint(j.p) && Number.isFinite(j.dist)).sort((a, b) => a.dist - b.dist);
  const suggested = passing.length ? passing[0] : null;
  const betterExists = Boolean(bestOk && suggested && suggested.dist < Number(best.bestDist) - 1e-9);

  let exitCode = 0;
  if (!bestOk) exitCode = 1;
  else if (args.strict && betterExists) exitCode = 1;

  // ---------------------------------------------------------------- 人看的那几行
  const lines = [];
  lines.push(`[audit] run：${runDir}`);
  lines.push(
    `[audit] 今天的标准：${intentFile}，硬不变量 ${items.length} 条` +
      (items.length ? `（${items.map((it) => it.id).join(' / ')}）` : '（没有门禁）'),
  );
  lines.push(`[audit] 评估点 ${points.length} 个（outputs/ ${judged.length} 份原始输出逐点复算）`);
  lines.push(`[audit] 现在不合格：${nowInvalid.length} / ${judged.length}`);
  for (const j of nowInvalid) {
    lines.push(`[audit]   - seq=${j.p.seq} d=${d4(j.dist)} 参数 ${paramsText(j.p.params)}：${j.reason}`);
  }
  if (targetPoint && !targetPoint.ok) {
    lines.push(
      `[audit] 注意：目标锚点（seq=${targetPoint.p.seq}）本身也过不了今天的门禁 —— 今天的判据和当时的目标自相矛盾，先修判据，别急着换最优。`,
    );
  }
  lines.push(
    `[audit] 当时的 best（seq=${bestPoint.p.seq} d=${d4(Number(best.bestDist))} 参数 ${paramsText(bestPoint.p.params)}）：` +
      (bestOk ? '✓ 按今天的标准仍合格' : '✗ 按今天的标准不合格 —— ' + bestPoint.reason),
  );
  if (!passing.length) {
    const okCount = judged.filter((j) => j.ok).length;
    lines.push(
      `[audit] 按今天的标准，这一轮没有可用结果（${judged.length} 个评估点里 ${okCount} 个过门禁` +
        `${okCount > 0 ? '，但它们全是目标锚点（d 恒为 0，不算候选）' : ''}）—— 别拿它当结论。`,
    );
  } else if (!bestOk) {
    lines.push(
      `[audit] 新的最优（在今天合格的点里、按当时记录的距离）：seq=${suggested.p.seq} d=${d4(suggested.dist)} 参数 ${paramsText(suggested.p.params)}`,
    );
  } else if (betterExists) {
    lines.push(
      `[audit] 更优的合格点：seq=${suggested.p.seq} d=${d4(suggested.dist)}（当时 best d=${d4(Number(best.bestDist))}）参数 ${paramsText(suggested.p.params)}` +
        (args.strict ? ' —— --strict 下这算不合格' : ''),
    );
  } else {
    lines.push('[audit] 今天的合格点里没有比它更优的：这份结论不需要改。');
  }
  for (const w of warnings) lines.push(`[audit][warn] ${w}`);
  lines.push(`[audit] exit ${exitCode}`);

  const json = {
    tool: 'selfloop-audit/1',
    run: runDir,
    intent: intentFile,
    chain: 'command',
    strict: Boolean(args.strict),
    invariants: items.map((it) => ({ id: it.id, why: it.why, text: it.text, check: it.check })),
    total: judged.length,
    nowInvalid: nowInvalid.length,
    bestOk,
    best: { seq: bestPoint.p.seq, params: bestPoint.p.params, dist: Number(best.bestDist), reasons: bestPoint.ok ? [] : [bestPoint.reason] },
    suggestedBest: suggested ? { seq: suggested.p.seq, params: suggested.p.params, dist: suggested.dist } : null,
    betterExists,
    // 扁平的原因清单（界面直接读这一条）：每个不合格点一条
    reasons: nowInvalid.map((j) => `seq=${j.p.seq}：${j.reason}`),
    points: judged.map((j) => ({ seq: j.p.seq, dist: Number.isFinite(j.dist) ? j.dist : null, params: j.p.params, ok: j.ok, reasons: j.ok ? [] : [j.reason] })),
    warnings,
    exitCode,
  };
  return { exitCode, lines, json };
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
    const res = audit(args);
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
