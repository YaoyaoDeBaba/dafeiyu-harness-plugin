// harness/intent-summary.js —— intent 摘要的**唯一实现**（v2 的锚 / 反例 / 自由度 / 验收方式）
//
// 为什么单独一个文件：两条链路都要在 report.md 顶部写同一段摘要 ——
//   命令链路 cmdloop.mjs（ESM，进程内直接拿 resolveIntent 的返回对象）；
//   截图链路 finalize.js（CommonJS，只能读盘上的 <out>/intent.summary.json）。
// 两份实现会漂（口径一漂，"锚几条"这种数就对不上），所以照 ledger.js 的姿势：
// 逻辑放这一份 CommonJS，ESM 那边用 createRequire 拿。
//
// 纪律：这里的一切**不参与距离计算**。展开写清楚是因为"锚进了距离"就等于又把它变成指标 ——
// 那正是 v2 要治的病（指标替代审美）。
'use strict';

const fs = require('fs');
const path = require('path');

const INTENT_SUMMARY_FILE = 'intent.summary.json';

// resolveIntent 的返回 → 一份可落盘/可呈现的摘要
function intentSummaryOf(res) {
  const r = res || {};
  const it = r.intent || {};
  const anchors = Array.isArray(r.anchors) ? r.anchors : [];
  const byKind = { image: 0, text: 0 };
  for (const a of anchors) if (a && byKind[a.kind] !== undefined) byKind[a.kind] += 1;
  const nw = r.notWanted || { present: false, items: [] };
  const fvf = r.freeVsFixed || { present: false, fixed: [], free: [] };
  const hwv = r.howWeVerify || null;
  const confirm = Array.isArray(r.confirm) ? r.confirm : [];
  // v2.1：criteria 的"用户原话 / 怎么量"也进摘要（**不参与距离**，只做人读的台帐）。
  // 缺的字段在报告里写 ⚠ —— 让"这条判据是凭空编的"在报告上就看得见。
  const criteria = (Array.isArray(r.criteria) ? r.criteria : []).map((c) => ({
    id: c.id,
    weight: c.weight === null || c.weight === undefined ? null : Number(c.weight),
    target: c.target === null || c.target === undefined ? null : Number(c.target),
    anchor: String(c.anchor || ''),
    userWords: String(c.userWords || ''),
    howMeasured: String(c.howMeasured || ''),
    hasUserWords: Boolean(String(c.userWords || '').trim()),
    hasHowMeasured: Boolean(String(c.howMeasured || '').trim()),
    humanEyes: Boolean(c.humanEyes),
    why: String(c.why || ''),
  }));
  const prv =
    r.provenance && typeof r.provenance === 'object'
      ? {
          userWords: Number(r.provenance.userWords || 0),
          howMeasured: Number(r.provenance.howMeasured || 0),
          neither: Number(r.provenance.neither || 0),
        }
      : {
          userWords: criteria.filter((c) => c.hasUserWords).length,
          howMeasured: criteria.filter((c) => c.hasHowMeasured).length,
          neither: criteria.filter((c) => !c.hasUserWords && !c.hasHowMeasured).length,
        };
  return {
    version: r.version === undefined ? null : r.version,
    isV1: Boolean(r.isV1),
    status: r.status || '',
    // v1 没有 restate，退回 understood 那句话（同义：一句话复述"我理解你要的是什么"）
    restate: r.restate || String((r.intent || {}).understood || '').trim() || '',
    anchors: anchors.map((a) => ({ kind: a.kind, ref: a.ref, why: a.why || '' })),
    anchorCount: anchors.length,
    anchorsByKind: byKind,
    notWanted: { present: Boolean(nw.present), items: Array.isArray(nw.items) ? nw.items : [] },
    freeVsFixed: { present: Boolean(fvf.present), fixed: fvf.fixed || [], free: fvf.free || [] },
    howWeVerify: hwv ? { human: Boolean(hwv.human), metrics: Boolean(hwv.metrics), note: hwv.note || '' } : null,
    criteria,
    provenance: prv,
    confirm: { total: confirm.length, answered: it.confirmed === true },
    confirmed: it.confirmed === true,
    confirmedBy: String(it.confirmedBy || ''),
    confirmedAt: String(it.confirmedAt || ''),
    degraded: (r.status || '') === 'degraded',
    degradedReason: String(r.reason || ''),
    // 一句话把纪律写进机器可读的地方
    participatesInDistance: false,
  };
}

function writeIntentSummary(outDir, res) {
  if (!outDir || !res) return '';
  const file = path.join(outDir, INTENT_SUMMARY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(intentSummaryOf(res), null, 2) + '\n', 'utf8');
  return file;
}

function readIntentSummary(outDir) {
  const file = path.join(outDir, INTENT_SUMMARY_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// report.md 顶部"本次运行"汇总行下面那一段（restate 一行 + 锚几条 + 谁验收 + 是否 v1 degraded）
function intentSummaryLines(summary) {
  if (!summary) return [];
  const vTag = Number(summary.version) >= 2 ? ' v2' : summary.isV1 ? ' v1' : '';
  const state =
    summary.status === 'skipped' ? 'skipped' : summary.status === 'degraded' ? 'degraded' : 'done';
  const lines = ['**需求转译（intent' + vTag + ' · ' + state + '）**', ''];
  if (summary.status === 'skipped') {
    lines.push('- 本次**没有**需求转译（`--no-intent` 显式跳过）：判据全部按 adapter 原样，没人确认过它是不是你要的');
    lines.push('');
    return lines;
  }
  lines.push('- **复述**：' + (summary.restate || '（空）'));
  const byk = summary.anchorsByKind || {};
  const refs = (summary.anchors || []).map((a) => (a.kind === 'image' ? '`' + a.ref + '`' : '「' + a.ref + '」'));
  lines.push(
    '- **锚**：' +
      (summary.anchorCount || 0) +
      ' 条（image ' +
      (byk.image || 0) +
      ' / text ' +
      (byk.text || 0) +
      '）' +
      (refs.length ? ' —— ' + refs.join('、') : ''),
  );
  const nw = summary.notWanted || { present: false, items: [] };
  lines.push(
    '- **反例**：' +
      (nw.present
        ? nw.items.length + ' 条' + (nw.items.length ? '：' + nw.items.join('；') : '（显式空数组：没有明确不要的）')
        : '（没写 —— 等于把"不要什么"也交给搜索）'),
  );
  const fvf = summary.freeVsFixed || { present: false, fixed: [], free: [] };
  lines.push(
    '- **自由度**：' +
      (fvf.present ? '定死 ' + fvf.fixed.length + ' 条 / 自由 ' + fvf.free.length + ' 条' : '（没写 —— 等于全权交给搜索）') +
      (fvf.present && fvf.fixed.length ? '；定死：' + fvf.fixed.join('、') : '') +
      (fvf.present && fvf.free.length ? '；自由：' + fvf.free.join('、') : ''),
  );
  const hwv = summary.howWeVerify;
  const vText = !hwv
    ? '（没写"谁点头算过"）'
    : hwv.human && hwv.metrics
      ? '人眼 + 指标（两者都要）'
      : hwv.human
        ? '人眼看'
        : '指标阈值';
  lines.push('- **验收**：' + vText + (hwv && hwv.note ? '；' + hwv.note : ''));
  // v2.1：每条判据后面挂"原话 / 量法"（缺的写 ⚠）——
  // 这是这一版要治的病：判据只写"色阶可数"这种看似精确的假指标时，报告上是空白的。
  const cs = Array.isArray(summary.criteria) ? summary.criteria : [];
  if (cs.length) {
    const prv = summary.provenance || { userWords: 0, howMeasured: 0, neither: 0 };
    lines.push(
      '- **判据**：' +
        cs.length +
        ' 条（有原话 ' +
        (prv.userWords || 0) +
        ' / 有量法 ' +
        (prv.howMeasured || 0) +
        ' / 两者都无 ' +
        (prv.neither || 0) +
        '）',
    );
    for (const c of cs) {
      const bits = [];
      if (c.weight !== null && c.weight !== undefined) bits.push('weight=' + c.weight);
      if (c.target !== null && c.target !== undefined) bits.push('target=' + c.target);
      lines.push(
        '  - `' +
          c.id +
          '`' +
          (bits.length ? '（' + bits.join(' ') + '）' : '') +
          '：原话：' +
          (c.hasUserWords ? c.userWords : '⚠') +
          ' / 量法：' +
          (c.hasHowMeasured ? c.howMeasured : '⚠') +
          (c.humanEyes ? '（⚠ 量法靠人看：搜索不能用它当判据，考虑降权或改成可测量的量）' : ''),
      );
    }
  }
  const c = summary.confirm || { total: 0 };
  lines.push(
    '- **确认**：`confirmed=' +
      Boolean(summary.confirmed) +
      '`' +
      (summary.confirmedBy ? '（' + summary.confirmedBy + (summary.confirmedAt ? ' @ ' + summary.confirmedAt : '') + '）' : '') +
      (c.total ? '；**还有 ' + c.total + ' 条待确认问题没答，已按当前判据开跑**' : ''),
  );
  if (summary.degraded) lines.push('- **降级**：' + (summary.degradedReason || '（未写原因）'));
  lines.push('');
  return lines;
}

module.exports = { INTENT_SUMMARY_FILE, intentSummaryOf, writeIntentSummary, readIntentSummary, intentSummaryLines };
