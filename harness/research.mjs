// harness/research.mjs —— 调研节点（research）：**开干之前有没有真的去搜、搜到的东西有没有改变开干的方式**
//
// 为什么单独一个节点（用户原话）：
//   "尤其是前期的参考和需求输入之后，有没真正被消化理解，开干之前有没先去搜索调研 —— 还是用现成的即梦举例，
//    它接活之后先把用户需求转译说一遍，过程中展示它搜索到的参考图和文献。"
// intent（01）回答"你要什么被复述清楚了吗"；research（02）回答"为了做到它，你去查了什么、查到的变成了什么"。
//
// 这一版要治的具体病：**装饰性调研** —— agent 搜了一堆图、写了一份好看的文件，但判据和起点一个都没动。
// 于是"调研"变成了开场白，跑完一整轮还是按原判据在调。所以本节点的判据是**引擎自己算出来的 changed**：
//   · changed 非空 → done（调研真的改变了这次搜索往哪走）
//   · 有产物但 changed 为空 → **degraded**（reason 写「装饰性调研」）
//   · 没有产物 → skipped + 终端 warn（跳过要有名字）
// 文件里自报的 `changed` 字段**一律忽略**（读它等于让被检查的人自己出结论）。
//
// 契约（外部产物，agent 填；引擎只读、只应用、只记账）：
//   运行目录 <out>/research.json，或 --research <file>：
//   {
//     "queries": ["二次元火焰特效 参考", "崩坏星穹铁道 火焰 配色"],
//     "findings": [
//       { "kind": "image", "ref": "refs/ref-a.png", "why": "同类高评分火焰，边缘有描边" },
//       { "kind": "doc",   "ref": "https://example.com/article", "why": "配色链：白芯→黄→橙→暗红" }
//     ],
//     "extracted": [
//       { "apply": "criteria", "id": "hue", "weight": 0.25, "target": 28, "confidence": 0.7, "source": "ref-a.png 的色相圆均值" },
//       { "apply": "start", "name": "radius", "value": 0.28, "confidence": 0.5, "source": "参考图里光束更粗" }
//     ],
//     "note": "可选：一句话总结调研结论"
//   }
//
// 落点与顺序（重要）：research 只改两样东西 —— **判据**（criteria 的 weight/target）与**起点值**（start）。
// 覆盖顺序固定为 adapter → intent → research：research 最后压，所以它覆盖掉 intent 写过的同一个值。
// 三条都进 run 指纹（判据/起点/调研内容各一份），两次不同调研的 run 不会撞 hash。
//
// 确定性边界：引擎不认识"参考图里哪个颜色对"，只认识"可以覆盖的东西"。
// 从图里量出色相/亮度这件事**关在 agent 里**（agent 填 extracted，并写 source/confidence 说明依据），
// 引擎保持纯确定性 —— 它只做"值真不真的落到了判据上"这件事的判定。这一层的缺口写在 skills 文档 §7。
//
// 变异开关（**只给测试用**，不设时行为完全正常）：
//   trustSelfReportedChanged —— 直接拿文件里的 changed 当结论（把"引擎自己算"换成"信文件自报"）
//                                → 「装饰性调研是 degraded」那条断言必红；
//   degradedAsDone           —— degraded 记成 done（把装饰性调研洗成 done）→ 同一条必红。
//   （用法：SELFLOOP_RESEARCH_MUTANT=trustSelfReportedChanged node test/research.test.mjs）
'use strict';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const RESEARCH_FILE = 'research.json';
export const RESEARCH_SUMMARY_FILE = 'research.summary.json';
export const APPLY_KINDS = ['criteria', 'start'];
export const FINDING_KINDS = ['image', 'doc'];
// 顺序纪律：research 是**最后**一个压判据的节点（后面再没有任何东西改判据/起点）
export const OVERRIDE_ORDER = 'adapter → intent → research（research 最后压）';
export const SKIPPED_REASON = '没提供调研产物（--research <file>）';
export const DECORATION_REASON = '装饰性调研：搜了/给了产物，但没改变任何判据或起点';
export const RESEARCH_MUTANT = String(process.env.SELFLOOP_RESEARCH_MUTANT || '');

const HARD = '[调研] ';

function die(msg) {
  throw new Error(HARD + msg);
}

// 台帐 artifacts 里一律写相对 run 目录的路径（与其它节点同口径）
function relativeTo(outDir, file) {
  const r = relative(outDir, file);
  return r ? r.split('\\').join('/') : file;
}

// 数怎么写得像人写的：0.2 不是 0.200000，28 不是 28.000
function numText(v) {
  if (v === null || v === undefined) return '（无）';
  const n = Number(v);
  return Number.isFinite(n) ? String(parseFloat(n.toFixed(6))) : String(v);
}

function sameNum(a, b) {
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= 1e-12;
}

// ---------------------------------------------------------------- 读
function readResearchFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    die(`调研产物读不到：${file}（${e?.code ?? e?.message ?? e}）`);
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    die(`调研产物不是合法 JSON：${file}（${e.message}）—— 结构：{queries, findings, extracted, note}`);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    die(`调研产物里要是一个 JSON 对象（收到 ${Array.isArray(j) ? '数组' : typeof j}）：${file} —— 结构：{queries, findings, extracted, note}`);
  }
  return j;
}

// ---------------------------------------------------------------- 校验（全中文硬错，绝不静默忽略）
// 三件事必须在开跑之前说清：
//   ① 说搜过的图**真的在**（图不在，"照着它调"就没有参照物，应用它改判据成了凭感觉）；
//   ② 提取出来的东西**有落点**（criteria 的 id 在 adapter 指标里、start 的 name 在白名单里）；
//   ③ 没搜就**写清为什么**（queries 空 + note 空 = "有没有调研"只能靠猜）。
export function validateResearch(raw, opts = {}) {
  const metricIds = (opts.metricIds || []).map(String);
  const wl = (opts.wl || []).map(String);
  const baseDir = opts.baseDir || process.cwd();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    die(`调研产物里要是一个 JSON 对象（收到 ${Array.isArray(raw) ? '数组' : typeof raw}）—— 结构：{queries, findings, extracted, note}`);
  }

  // ---- queries
  let queries = [];
  if (raw.queries !== undefined && raw.queries !== null) {
    if (!Array.isArray(raw.queries)) die(`research.queries 要是字符串数组（收到 ${typeof raw.queries}）—— 一条 query 一行，写你实际搜过什么`);
    queries = raw.queries.map((q) => String(q).trim()).filter(Boolean);
  }
  const note = String(raw.note ?? '').trim();
  if (!queries.length && !note) {
    die(
      'research.queries 是空数组（等于说这次没搜），但没写 note 说明为什么没搜\n' +
        '  为什么拦：没搜还不写原因，"开干之前有没有先调研"这件事就只能靠猜。离线 / 没有可用参考资料 / 这一轮只是复验同一个点，都算原因 —— 写一句就行\n' +
        '  例："note": "离线环境，没有可查的参考；判据沿用上一轮的调研结论"',
    );
  }

  // ---- findings（参考）
  const findings = [];
  if (raw.findings !== undefined && raw.findings !== null) {
    if (!Array.isArray(raw.findings)) die(`research.findings 要是数组（每项 {kind:"image"|"doc", ref, why}），收到 ${typeof raw.findings}`);
    raw.findings.forEach((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        die(`research.findings[${i}] 不是对象（要 {kind:"image"|"doc", ref, why}）：${JSON.stringify(f)}`);
      }
      const kind = String(f.kind ?? '').trim();
      if (!FINDING_KINDS.includes(kind)) {
        die(
          `research.findings[${i}].kind 只认 "image" 或 "doc"（收到 ${JSON.stringify(f.kind)}）：` +
            `image = 参考图/帧（ref 必须是**真实存在**的文件），doc = 文章/文档/网页（ref 是非空 URL 或路径）`,
        );
      }
      const ref = String(f.ref ?? '').trim();
      if (!ref) die(`research.findings[${i}].ref 是空的（kind=${kind}）—— 没指向东西的"参考"等于没参考`);
      let abs = ref;
      if (kind === 'image') {
        abs = isAbsolute(ref) ? ref : resolve(baseDir, ref);
        if (!existsSync(abs)) {
          die(
            `research.findings[${i}] 指向的参考图不存在：${ref}\n` +
              `  解析成：${abs}（相对的是 research.json 所在目录 ${baseDir}；也可以用绝对路径）\n` +
              `  为什么拦：搜到的图不在，这一轮调研就没有参照物 —— 拿它改判据等于凭感觉改`,
          );
        }
      }
      findings.push({ kind, ref, abs, why: String(f.why ?? '').trim() });
    });
  }

  // ---- extracted（从参考里"看出来的东西"→ 落到判据或起点）
  const extracted = [];
  const seenCriteria = new Set();
  const seenStart = new Set();
  if (raw.extracted !== undefined && raw.extracted !== null) {
    if (!Array.isArray(raw.extracted)) die(`research.extracted 要是数组（每项 {apply:"criteria"|"start", …}），收到 ${typeof raw.extracted}`);
    raw.extracted.forEach((x, i) => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) {
        die(`research.extracted[${i}] 不是对象（要 {apply:"criteria"|"start", …}）：${JSON.stringify(x)}`);
      }
      const apply = String(x.apply ?? '').trim();
      if (!APPLY_KINDS.includes(apply)) {
        die(
          `research.extracted[${i}].apply 只认 "criteria" 与 "start"（收到 ${JSON.stringify(x.apply)}）—— ` +
            `criteria = 改某条指标的 weight/target，start = 改某个参数的起点值；别的落点引擎不认识，绝不静默忽略`,
        );
      }
      let confidence = null;
      if (x.confidence !== undefined && x.confidence !== null) {
        confidence = Number(x.confidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
          die(`research.extracted[${i}].confidence 要是 0~1 的数（收到 ${JSON.stringify(x.confidence)}）—— 它只做记录，不打折、不决定要不要用`);
        }
      }
      const source = String(x.source ?? '').trim();

      if (apply === 'criteria') {
        const id = String(x.id ?? '').trim();
        if (!id) die(`research.extracted[${i}] 是 apply:"criteria" 但缺 id（这份 adapter 的指标是：${metricIds.join(' / ') || '（一个都没有）'}）`);
        if (!metricIds.includes(id)) {
          die(
            `research.extracted[${i}].id=${id} 不在 adapter 指标里（这份 adapter 的指标是：${metricIds.join(' / ') || '（一个都没有）'}）` +
              `\n  绝不静默忽略：写错 id 等于把"从参考里看出来的东西"应用到一个没人用的判据上，整轮搜索都白跑`,
          );
        }
        if (seenCriteria.has(id)) die(`research.extracted 里 criteria ${id} 出现了两次（同一个指标一个值，别给两个答案）`);
        seenCriteria.add(id);
        let weight = null;
        let target = null;
        if (x.weight !== undefined && x.weight !== null) {
          weight = Number(x.weight);
          if (!Number.isFinite(weight) || weight < 0) die(`research.extracted[${i}].weight 要是 ≥0 的数（收到 ${JSON.stringify(x.weight)}）`);
        }
        if (x.target !== undefined && x.target !== null) {
          target = Number(x.target);
          if (!Number.isFinite(target)) die(`research.extracted[${i}].target 要是数（收到 ${JSON.stringify(x.target)}）`);
        }
        if (weight === null && target === null) {
          die(
            `research.extracted[${i}]（criteria ${id}）既没 weight 也没 target：这条"提取"没有任何落点，等于只是写了一句感想\n` +
              `  改法：给它 weight（这条指标多重要）或 target（参考图里量出来的目标值），或者把它写进 note 而不是 extracted`,
          );
        }
        extracted.push({ apply, id, weight, target, confidence, source });
      } else {
        const name = String(x.name ?? '').trim();
        if (!name) die(`research.extracted[${i}] 是 apply:"start" 但缺 name（白名单：${wl.join(' / ') || '（空）'}）`);
        if (!wl.includes(name)) {
          die(
            `research.extracted[${i}].name=${name} 不在参数白名单里（这份 adapter 的白名单：${wl.join(' / ') || '（空）'}）` +
              `\n  绝不静默忽略：起点改到一个不存在（或不在搜索轴里）的参数上，等于这次调研什么都没影响`,
          );
        }
        if (seenStart.has(name)) die(`research.extracted 里 start ${name} 出现了两次（同一个参数一个起点，别给两个答案）`);
        seenStart.add(name);
        let value = null;
        if (x.value !== undefined && x.value !== null) value = Number(x.value);
        if (value === null || !Number.isFinite(value)) {
          die(`research.extracted[${i}].value 要是数（收到 ${JSON.stringify(x.value)}）—— start 是"把这个参数的起点改成多少"`);
        }
        extracted.push({ apply, name, value, confidence, source });
      }
    });
  }

  return { queries, findings, extracted, note };
}

// ---------------------------------------------------------------- 应用 + 算"起效"
// changed **由引擎自己算**：拿"应用 research 之前"的判据/起点跟"之后"比，逐项列出真正变了的。
// 这就是 research 与装饰性调研的分界线：文件写得再厚，changed 为空就是没影响这次搜索。
//   currentWeights / currentStart / currentTargets 必须是**已经过 intent 覆盖**的那一份（覆盖顺序的最后一步）。
export function resolveResearch(opts = {}) {
  const outDir = opts.outDir;
  const metricIds = (opts.metricIds || []).map(String);
  const wl = (opts.wl || []).map(String);
  const currentWeights = opts.currentWeights || {};
  const currentStart = opts.currentStart || {};
  const currentTargets = opts.currentTargets || {};
  const file = opts.researchPath ? resolve(opts.researchPath) : join(outDir, RESEARCH_FILE);

  if (!existsSync(file)) {
    return skippedShape({ reason: SKIPPED_REASON, warnings: [`${SKIPPED_REASON}：开干之前没有"搜索调研"的证据（判据与起点全部沿用 adapter + intent）`] });
  }

  const j = readResearchFile(file);
  const baseDir = dirname(file);
  const normalized = validateResearch(j, { metricIds, wl, baseDir });

  const weights = {};
  const targets = {};
  const start = {};
  const applied = [];
  const changed = [];
  const warnings = [];

  for (const x of normalized.extracted) {
    const origin = [
      x.source ? `依据：${x.source}` : '',
      x.confidence === null ? '' : `confidence ${numText(x.confidence)}`,
    ]
      .filter(Boolean)
      .join('；');
    if (x.apply === 'criteria') {
      if (x.weight !== null) {
        weights[x.id] = x.weight;
        const from = currentWeights[x.id];
        const item = { kind: 'criteria', id: x.id, field: 'weight', from: Number.isFinite(Number(from)) ? Number(from) : null, to: x.weight, origin };
        applied.push(item);
        if (!sameNum(from, x.weight)) changed.push({ ...item, text: `criteria.${x.id}.weight ${numText(item.from)} → ${numText(x.weight)}` });
      }
      if (x.target !== null) {
        targets[x.id] = x.target;
        const from = currentTargets[x.id];
        const item = { kind: 'criteria', id: x.id, field: 'target', from: Number.isFinite(Number(from)) ? Number(from) : null, to: x.target, origin };
        applied.push(item);
        if (!sameNum(from, x.target)) changed.push({ ...item, text: `criteria.${x.id}.target ${numText(item.from)} → ${numText(x.target)}` });
      }
    } else {
      start[x.name] = x.value;
      const from = currentStart[x.name];
      const item = { kind: 'start', id: x.name, field: 'value', from: Number.isFinite(Number(from)) ? Number(from) : null, to: x.value, origin };
      applied.push(item);
      if (!sameNum(from, x.value)) changed.push({ ...item, text: `start.${x.name} ${numText(item.from)} → ${numText(x.value)}` });
    }
  }

  // 文件里自报的 changed：**默认忽略**（读它等于让被检查的人自己出结论）。
  // 变异体 trustSelfReportedChanged 才读它 —— 那是为了证明"装饰性调研必红"这条断言真的接在实现上。
  const selfReported = Array.isArray(j.changed) ? j.changed : null;
  if (selfReported) {
    warnings.push('research.json 里有自报的 changed：已忽略（changed 由引擎自己比对"应用之前/之后"算出来，不认文件自报）');
  }
  let effectiveChanged = changed;
  if (selfReported && RESEARCH_MUTANT === 'trustSelfReportedChanged') {
    effectiveChanged = selfReported.map((c, i) => ({
      kind: 'self',
      id: '',
      field: '',
      from: null,
      to: null,
      origin: '',
      text: typeof c === 'string' ? c : JSON.stringify(c ?? i),
    }));
  }

  const status = effectiveChanged.length ? 'done' : 'degraded';
  const reason = effectiveChanged.length
    ? ''
    : `${DECORATION_REASON}（queries ${normalized.queries.length} 条 / findings ${normalized.findings.length} 条 / 应用 ${applied.length} 项，全部等于原值）`;

  return {
    status: status === 'degraded' && RESEARCH_MUTANT === 'degradedAsDone' ? 'done' : status,
    path: file,
    raw: j,
    queries: normalized.queries,
    findings: normalized.findings,
    extracted: normalized.extracted,
    note: normalized.note,
    weights,
    targets,
    start,
    applied,
    changed: effectiveChanged,
    changedComputed: changed,
    selfReportedIgnored: Boolean(selfReported),
    reason: status === 'degraded' && RESEARCH_MUTANT === 'degradedAsDone' ? '' : reason,
    warnings,
  };
}

// 统一的返回形状（下游不用判断字段在不在）
function skippedShape(o = {}) {
  return {
    status: 'skipped',
    path: '',
    raw: null,
    queries: [],
    findings: [],
    extracted: [],
    note: '',
    weights: {},
    targets: {},
    start: {},
    applied: [],
    changed: [],
    changedComputed: [],
    selfReportedIgnored: false,
    reason: o.reason || SKIPPED_REASON,
    warnings: o.warnings || [],
  };
}

// ---------------------------------------------------------------- 摘要（记录与呈现用）
export function researchSummaryOf(res = {}) {
  const byKind = { image: 0, doc: 0 };
  for (const f of res.findings || []) if (byKind[f.kind] !== undefined) byKind[f.kind] += 1;
  const appliedByKind = { criteria: 0, start: 0 };
  for (const a of res.applied || []) if (appliedByKind[a.kind] !== undefined) appliedByKind[a.kind] += 1;
  return {
    status: res.status || '',
    path: res.path || '',
    queries: res.queries || [],
    findings: {
      total: (res.findings || []).length,
      image: byKind.image,
      doc: byKind.doc,
      items: (res.findings || []).map((f) => ({ kind: f.kind, ref: f.ref, why: f.why || '' })),
    },
    extracted: {
      total: (res.extracted || []).length,
      applied: (res.applied || []).length,
      criteria: appliedByKind.criteria,
      start: appliedByKind.start,
    },
    changed: (res.changed || []).map((c) => ({ kind: c.kind, id: c.id, field: c.field, from: c.from, to: c.to, text: c.text, origin: c.origin || '' })),
    note: res.note || '',
    reason: res.reason || '',
    overrideOrder: OVERRIDE_ORDER,
    // research **会**影响距离（判据/起点都算判据链的一部分）—— 与 intent 的四样（只记录）不同，别混
    affectsDistance: (res.changed || []).length > 0,
  };
}

export function writeResearchSummary(outDir, res) {
  if (!outDir || !res) return '';
  const file = join(outDir, RESEARCH_SUMMARY_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(researchSummaryOf(res), null, 2) + '\n', 'utf8');
  return file;
}

// report.md 顶部"本次运行"汇总行下面那一段（搜了几条 / 几条参考 / 应用了几项 / changed 清单 / note）
export function researchReportLines(summary) {
  if (!summary) return [];
  const state = summary.status === 'skipped' ? 'skipped' : summary.status === 'degraded' ? 'degraded' : 'done';
  const lines = ['**调研（research · ' + state + '）**', ''];
  if (state === 'skipped') {
    lines.push('- ' + (summary.reason || SKIPPED_REASON) + '：开干之前没有"搜索调研"的证据（判据与起点全部沿用 adapter + intent）');
    lines.push('');
    return lines;
  }
  const q = summary.queries || [];
  lines.push(
    q.length
      ? '- **搜索**：' + q.length + ' 条 query —— ' + q.join('；')
      : '- **搜索**：没有搜（`queries` 空）—— 原因：' + (summary.note || '（没写）'),
  );
  const f = summary.findings || { total: 0, image: 0, doc: 0, items: [] };
  const refs = (f.items || []).map((it) => (it.kind === 'image' ? '`' + it.ref + '`' : '`' + it.ref + '`') + (it.why ? '（' + it.why + '）' : ''));
  lines.push('- **参考**：' + f.total + ' 条 findings（image ' + f.image + ' / doc ' + f.doc + '）' + (refs.length ? ' —— ' + refs.join('、') : ''));
  const ex = summary.extracted || { total: 0, applied: 0, criteria: 0, start: 0 };
  lines.push(
    '- **应用**：' + ex.applied + ' 项（criteria ' + ex.criteria + ' / start ' + ex.start + '，来自 ' + ex.total + ' 条 extracted）；' +
      '**真正改了 ' + (summary.changed || []).length + ' 项**（引擎自己比出来的，不认文件自报）',
  );
  if ((summary.changed || []).length) {
    lines.push('- **changed 清单**：');
    for (const c of summary.changed || []) lines.push('  - `' + c.text + '`' + (c.origin ? '（' + c.origin + '）' : ''));
  } else if (state === 'degraded') {
    // reason 本身以"装饰性调研："开头，这里去掉这个标签再写，别写成"装饰性调研：装饰性调研：…"
    const detail = String(summary.reason || '').replace(/^装饰性调研：/, '').trim();
    lines.push('- **装饰性调研**：' + (detail || '搜了/给了产物，但没改变任何判据或起点'));
  }
  if (summary.note) lines.push('- **结论**：' + summary.note);
  lines.push('- **覆盖顺序**：' + (summary.overrideOrder || OVERRIDE_ORDER) + '；判据与起点都会进 run 指纹');
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------- 台帐记录
// 字段固定：node / seq / status / producer / ms / inputs / decision / artifacts / cost / reason
export function researchNodeRecord(res, extra = {}) {
  const artifacts = [];
  if (extra.summaryFile) artifacts.push(extra.summaryFile);
  const queries = res.queries || [];
  const findings = res.findings || [];
  const applied = res.applied || [];
  const changed = res.changed || [];
  const byKind = { image: 0, doc: 0 };
  for (const f of findings) if (byKind[f.kind] !== undefined) byKind[f.kind] += 1;

  const basis = [];
  if (res.status === 'skipped') {
    basis.push(SKIPPED_REASON + '：这一步没做（跳过要有名字）—— 开干之前没有"搜索调研"的证据');
    basis.push('覆盖顺序仍为 adapter → intent（没有 research 这一层）');
  } else {
    basis.push(
      queries.length
        ? `搜了 ${queries.length} 条 query：${queries.join('；')}`
        : '没有搜（queries 空）：' + (res.note || '（没写原因）'),
    );
    basis.push(`参考 ${findings.length} 条（image ${byKind.image} / doc ${byKind.doc}）` + (findings.length ? '：' + findings.map((f) => `${f.kind} ${f.ref}`).join(' / ') : ''));
    basis.push(`应用 ${applied.length} 项（criteria ${applied.filter((a) => a.kind === 'criteria').length} / start ${applied.filter((a) => a.kind === 'start').length}），**真正改了 ${changed.length} 项**`);
    if (changed.length) {
      for (const c of changed) basis.push('改动：' + c.text + (c.origin ? '（' + c.origin + '）' : ''));
    } else {
      basis.push('改动：0 项 —— 应用的值全部等于原值，这次调研没有改变任何判据或起点');
    }
    basis.push('覆盖顺序：' + OVERRIDE_ORDER);
    basis.push('changed 由引擎自己比对"应用 research 之前/之后"算出来' + (res.selfReportedIgnored ? '；文件里自报的 changed 已忽略' : ''));
    if (res.note) basis.push('调研结论：' + res.note);
    for (const w of res.warnings || []) basis.push('提醒：' + w);
  }

  const why =
    res.status === 'skipped'
      ? '没提供调研产物：这一步没做（放行，但台帐要留下"没搜"这件事）'
      : res.status === 'degraded'
        ? `有调研产物，但它没改变任何判据或起点（装饰性调研）—— 记 degraded，不假装 done`
        : `调研改变了判据/起点 ${changed.length} 项，覆盖顺序 ${OVERRIDE_ORDER}`;
  const reason = res.status === 'done' ? '' : res.status === 'skipped' ? SKIPPED_REASON : String(res.reason || DECORATION_REASON);

  return {
    node: 'research',
    status: res.status,
    producer: 'agent',
    ms: extra.ms ?? null,
    inputs: res.path ? [res.path] : [`（没有 ${RESEARCH_FILE}，按 ${SKIPPED_REASON} 跳过）`],
    decision: { why, basis },
    artifacts,
    cost: { evals: 0 },
    reason,
  };
}
