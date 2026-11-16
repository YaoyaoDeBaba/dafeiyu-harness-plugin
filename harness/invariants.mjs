// harness/invariants.mjs —— 硬不变量（invariants）：把"合格/不合格"从"距离"里拆出来
//
// 为什么有这一层（一句话）：现在只有"距离"一层，penalty 也是加进同一个 d 里 ——
// **等于允许搜索拿底线换分数**。
//   · 压缩到 37% 是**指标**；解压后逐字节相等、不越界是**不变量**。
//   · 接口 p95 延迟是**指标**；HTTP 200 + schema 合法是**不变量**。
// 指标负责"像不像"，不变量负责"是不是"。不追求"更接近"，只判"合格/不合格"。
//
// 契约（写在 intent.invariants 里；core 只认结构，内容由领域/用户给）：
//   "invariants": [
//     { "id": "roundtrip", "check": { "field": "roundtrip", "op": "==", "value": 1 },
//       "why": "解压回不去就是废方案，分数再高也不要" },
//     { "id": "no_overexpose", "check": { "all": [ { "field": "cov", "op": "<=", "value": 0.05 } ] },
//       "why": "超过这个亮核面积就是过曝" }
//   ]
// 文法只认这些（**别发明 DSL**）：
//   比较：{ field, op: ==|!=|<|<=|>|>=, value:<number> }
//   组合：{ all:[check…] } / { any:[check…] } / { not:check }
//   field：observe.metrics 里的指标 id，或命令输出 JSON 里的扁平字段（允许 a.b 点路径）
// 校验是**运行时硬错**：文法不认识 / 字段取不到 / 取到非数字 —— 绝不静默判过。
//
// 本文件只做这些事，互相独立、各自可测：
//   ① resolveInvariants —— 文法校验（结构不对就中文硬错，错误里列出支持的 op）
//   ② createInvariantGate —— 过门禁 + 记账（每个 id 的通过/拒绝次数、最近一次拒绝的原始观测片段）
//   ③ fakeGateFindings —— 假门告警（0.8.0）：rejected==0 且评估够多 → 门可能写宽了（永远为真）
//   ④ thresholdProximityFindings —— 目标贴阈值提醒（0.8.0）：这次过了，但下一次微调就可能翻脸
//   ⑤ invariantSectionLines —— report.md 那一节的渲染（诊断信息全来自 gate.summary() + 上面两个）
'use strict';

export const COMPARE_OPS = ['==', '!=', '<', '<=', '>', '>='];

// 变异开关：**只给测试用**（证明"把门禁改坏，断言真的会红"），不设时行为完全正常。
//   alwaysPass     —— 门禁恒通过（rejected 变 0、违例候选可能成 best）
//   noTargetGate   —— 目标/起点那道硬错不查（自相矛盾的判据也能开跑）
export const INVARIANTS_MUTANT = String(process.env.SELFLOOP_INVARIANTS_MUTANT || '');

const HARD = '[硬不变量] ';

function die(msg) {
  throw new Error(HARD + msg);
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function fmtValue(v) {
  return Number.isFinite(v) ? String(Number(Number(v).toFixed(6))) : JSON.stringify(v);
}

// ---------------------------------------------------------------- ① 文法校验
// 任何"看不懂"都硬错：不变量写错却静默放行，比没写更坏（它会让人以为装了一道门）。
export function resolveInvariants(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    die(
      `intent.invariants 要是数组，收到 ${isPlainObject(raw) ? '对象' : typeof raw}\n` +
        `  形如 [{"id":"roundtrip","check":{"field":"roundtrip","op":"==","value":1},"why":"解压不回去就是废方案"}]；不想要门禁就写 []`,
    );
  }
  const out = [];
  const seen = new Set();
  raw.forEach((item, i) => {
    const at = `intent.invariants[${i}]`;
    if (!isPlainObject(item)) die(`${at} 要是对象 {id, check, why}，收到 ${Array.isArray(item) ? '数组' : typeof item}`);
    const extra = Object.keys(item).filter((k) => !['id', 'check', 'why'].includes(k));
    if (extra.length) die(`${at} 有不认识的键 ${extra.join(' / ')}（只认 id / check / why —— 多写的字段没人读，等于没写）`);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) die(`${at}.id 必须是非空字符串（拒绝时要靠它点名；报告与错误信息都按 id 找）`);
    if (seen.has(id)) die(`${at}.id="${id}" 和前面重复：id 必须唯一`);
    seen.add(id);
    const why = typeof item.why === 'string' ? item.why.trim() : '';
    if (!why) {
      die(
        `${at}.why 不能是空的：不写为什么，将来没人敢删（也不会有人敢信）—— 一句话说清"违反它为什么算废"`,
      );
    }
    if (item.check === undefined || item.check === null) die(`${at}.check 必填（比较 {field,op,value} 或 all/any/not）`);
    validateCheck(item.check, `${at}.check`);
    out.push({ id, why, check: item.check });
  });
  return out;
}

function validateCheck(node, at) {
  if (!isPlainObject(node)) die(`${at} 要是对象（比较 {field,op,value} 或 {all:[…]} / {any:[…]} / {not:…}），收到 ${Array.isArray(node) ? '数组' : typeof node}`);
  const keys = Object.keys(node);
  const combo = ['all', 'any', 'not'].filter((k) => keys.includes(k));
  const cmpKeys = ['field', 'op', 'value'].filter((k) => keys.includes(k));
  if (combo.length && cmpKeys.length) die(`${at} 同时写了组合（${combo[0]}）与比较（${cmpKeys.join('/')}）：一个 check 只能是一种`);
  if (combo.length > 1) die(`${at} 同时写了 ${combo.join(' 与 ')}：一个 check 只能是一种组合`);
  if (combo.length === 1) {
    const k = combo[0];
    const extra = keys.filter((x) => x !== k);
    if (extra.length) die(`${at} 有不认识的键 ${extra.join(' / ')}（${k} 节点只认 ${k} 一个键）`);
    const child = node[k];
    if (k === 'not') {
      validateCheck(child, `${at}.not`);
      return;
    }
    if (!Array.isArray(child)) die(`${at}.${k} 要是数组（收到 ${typeof child}）`);
    if (!child.length) die(`${at}.${k} 是空数组：空组合恒真/恒假，等于装了一道假门 —— 至少写 1 条`);
    child.forEach((c, i) => validateCheck(c, `${at}.${k}[${i}]`));
    return;
  }
  if (!cmpKeys.length) {
    die(
      `${at} 不是能识别的 check：${JSON.stringify(node).slice(0, 120)}\n` +
        `  只认：比较 {field,op,value} / 组合 {all:[…]} / {any:[…]} / {not:…}`,
    );
  }
  const extra = keys.filter((x) => !['field', 'op', 'value'].includes(x));
  if (extra.length) die(`${at} 有不认识的键 ${extra.join(' / ')}（比较节点只认 field / op / value）`);
  if (typeof node.field !== 'string' || !node.field.trim()) die(`${at}.field 必须是非空字符串（指标 id 或输出字段名，可写 a.b）`);
  if (typeof node.op !== 'string' || !COMPARE_OPS.includes(node.op)) {
    die(
      `${at}.op=${JSON.stringify(node.op)} 不支持：只认 ${COMPARE_OPS.join(' ')}\n` +
        `  （核心只实现这一组比较；没有模糊匹配、没有区间语法 —— 要区间就写两条或用 all 组合）`,
    );
  }
  if (!Number.isFinite(node.value)) die(`${at}.value 必须是数字（收到 ${JSON.stringify(node.value)}）；比较只认数字`);
}

// ---------------------------------------------------------------- 取值
// field 先按指标 id 取（observe.metrics 是判据层的正式字段），再按命令输出 JSON 的字段取。
function pickPath(obj, path) {
  if (!isPlainObject(obj)) return undefined;
  const key = String(path);
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  let cur = obj;
  for (const seg of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function availableNames(obs) {
  const out = [];
  if (isPlainObject(obs && obs.metrics)) out.push(...Object.keys(obs.metrics));
  if (isPlainObject(obs && obs.fields)) for (const k of Object.keys(obs.fields)) if (!out.includes(k)) out.push(k);
  return out;
}

// 取不到 / 取到非数字 → 硬错。不变量取不到数就是"这道门没验"，静默判过等于没装。
export function lookupField(obs, field) {
  const metrics = isPlainObject(obs && obs.metrics) ? obs.metrics : {};
  const fields = isPlainObject(obs && obs.fields) ? obs.fields : {};
  let found = false;
  let value;
  let from = '';
  if (Object.prototype.hasOwnProperty.call(metrics, field)) {
    found = true;
    from = 'metrics';
    value = metrics[field];
  } else {
    value = pickPath(fields, field);
    found = value !== undefined;
    from = 'output';
  }
  if (!found) {
    const names = availableNames(obs);
    die(
      `字段 \`${field}\` 在观测里取不到（硬错，不许静默判过）\n` +
        `  观测里有的名字：${names.length ? names.join(' / ') : '（一个都没有）'}\n` +
        `  field 可以是指标 id（observe.metrics），也可以是命令输出 JSON 里的字段（可写 a.b 点路径）`,
    );
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) value = Number(value);
  if (!Number.isFinite(Number(value))) {
    die(
      `字段 \`${field}\`（来自 ${from}）取到的不是数字：${JSON.stringify(value)}\n` +
        `  不变量只做数字比较 —— 要判"合法/非法"就把命令输出成 1/0 再比`,
    );
  }
  return { value: Number(value), from };
}

function evalNode(node, obs) {
  if (Array.isArray(node.all)) return node.all.every((c) => evalNode(c, obs));
  if (Array.isArray(node.any)) return node.any.some((c) => evalNode(c, obs));
  if (isPlainObject(node.not)) return !evalNode(node.not, obs);
  const v = lookupField(obs, node.field).value;
  switch (node.op) {
    case '==':
      return v === node.value;
    case '!=':
      return v !== node.value;
    case '<':
      return v < node.value;
    case '<=':
      return v <= node.value;
    case '>':
      return v > node.value;
    case '>=':
      return v >= node.value;
    default:
      die(`不支持 op=${JSON.stringify(node.op)}：只认 ${COMPARE_OPS.join(' ')}`);
  }
}

// 一条 check 里引用到的所有字段（拒绝片段只摘这些字段，不把整份输出糊上去）
function fieldsOf(node, acc = []) {
  if (Array.isArray(node.all)) for (const c of node.all) fieldsOf(c, acc);
  else if (Array.isArray(node.any)) for (const c of node.any) fieldsOf(c, acc);
  else if (isPlainObject(node.not)) fieldsOf(node.not, acc);
  else if (!acc.includes(node.field)) acc.push(node.field);
  return acc;
}

export function formatCheck(node) {
  if (Array.isArray(node.all)) return `all(${node.all.map(formatCheck).join(' & ')})`;
  if (Array.isArray(node.any)) return `any(${node.any.map(formatCheck).join(' | ')})`;
  if (isPlainObject(node.not)) return `not(${formatCheck(node.not)})`;
  return `${node.field} ${node.op} ${fmtValue(node.value)}`;
}

function valuesOf(fields, obs) {
  const out = {};
  for (const f of fields) {
    try {
      out[f] = lookupField(obs, f).value;
    } catch {
      out[f] = '<取不到>';
    }
  }
  return out;
}

// ---------------------------------------------------------------- ③ 假门告警（0.8.0）
// 一条不变量如果**一次都没拒绝过**，它要么写宽了（永远为真），要么这段参数空间根本不碰它。
// 两种情况下它都没有在干活 —— 而"看起来装了门"比"明说没装"更危险：人会以为底线被守住了。
// 阈值（≥10 次评估）是为了别在小 run 上狼来了：3 次评估没拦住什么都说明不了。
export const FAKE_GATE_MIN_EVALS = 10;

export function fakeGateFindings(summary, opts = {}) {
  const min = Number.isFinite(opts.minEvals) ? opts.minEvals : FAKE_GATE_MIN_EVALS;
  const items = (summary && Array.isArray(summary.items)) ? summary.items : [];
  const out = [];
  for (const it of items) {
    const attempts = Number(it.passed || 0) + Number(it.rejected || 0);
    if (Number(it.rejected || 0) !== 0) continue;
    if (attempts < min) continue;
    out.push({
      id: it.id,
      attempts,
      text: it.text,
      message:
        `硬不变量 ${it.id} 本次一次都没拦住候选（评估 ${attempts} 次，报告里标「本次未拦任何候选」）——门可能是写宽的（永远为真），` +
        `或者这段参数空间根本不碰它。假门比没门更危险，因为它让人以为底线被守住了。`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- ④ 目标贴阈值提醒（0.8.0）
// 目标观测**通过了**，但离边界只差一丁点：今天算合格，判据下一版微调（或者换个舍入/口径）就可能翻脸。
// 只对不等式有"边界"可言：`==` / `!=` 的"通过"天然就贴在那个值上，报了等于每轮都报，等于没报。
const BOUNDARY_OPS = ['<', '<=', '>', '>='];

// 按数值类型选绝对/相对：整数对整数（体积 / 计数 / 0-1 标志）用绝对 1e-6 —— 1% 相对量对它们没意义；
// 小数值（loss / 面积 / 延迟）用相对 1%（分母兜底 1e-12，免得 0 阈值除出 Infinity 之外的花样）。
function nearBoundary(observed, op, threshold) {
  if (!BOUNDARY_OPS.includes(op)) return null;
  const margin = Math.abs(observed - threshold);
  const useAbs = Number.isInteger(observed) && Number.isInteger(threshold);
  const close = useAbs ? margin < 1e-6 : margin / Math.max(Math.abs(threshold), 1e-12) < 0.01;
  if (!close) return null;
  return { margin, mode: useAbs ? 'abs' : 'rel', observed, op, threshold };
}

// 走一遍 check 树，只留"这条叶子自己判过了"的比较节点。
// 为什么不是全留：passing 的 any(...) 里失败的分支贴着阈值**不是**这次通过的原因；
// 为什么跳过 not：not(x) 的"翻脸"是 x 从假变真，那段距离对不上"贴在阈值上"的直觉，宁可不说。
function passingLeaves(node, obs, acc = []) {
  if (Array.isArray(node.all)) {
    for (const c of node.all) passingLeaves(c, obs, acc);
    return acc;
  }
  if (Array.isArray(node.any)) {
    for (const c of node.any) {
      let ok = false;
      try {
        ok = evalNode(c, obs);
      } catch {
        ok = false;
      }
      if (ok) passingLeaves(c, obs, acc);
    }
    return acc;
  }
  if (isPlainObject(node.not)) return acc;
  acc.push(node);
  return acc;
}

// obs 通常是目标那一次的观测（{metrics, fields, stdout}）—— 判据引用到的字段在这里必须取得到，
// 取不到就跳过这一条（gate.check 早就在目标阶段硬错过了，走到这里还取不到的只可能是短路分支）。
export function thresholdProximityFindings(items, obs) {
  const out = [];
  for (const it of items || []) {
    let best = null;
    for (const leaf of passingLeaves(it.check, obs)) {
      let v;
      try {
        v = lookupField(obs, leaf.field).value;
      } catch {
        continue;
      }
      const near = nearBoundary(v, leaf.op, leaf.value);
      if (!near) continue;
      if (best === null || near.margin < best.margin) best = { ...near, field: leaf.field };
    }
    if (!best) continue;
    out.push({
      id: it.id,
      field: best.field,
      op: best.op,
      observed: best.observed,
      threshold: best.threshold,
      margin: best.margin,
      mode: best.mode,
      message:
        `目标离不变量 ${it.id} 的阈值很近（观测 ${fmtValue(best.observed)} / 阈值 ${fmtValue(best.threshold)}）` +
        `——判据下一版微调就可能翻脸`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- ② 门禁 + 记账
// 用法：
//   const gate = createInvariantGate(intent.invariants)
//   const r = gate.check({ metrics: row, fields, stdout }, { seq, phase })   // 每次评估都过一遍
//   if (!r.ok) → 该候选判废（不进距离比较、不能当 best）
//   gate.summary() → report.md / best.json 的记账数据
export function createInvariantGate(items = []) {
  const list = (items || []).map((it) => ({
    id: it.id,
    why: it.why,
    check: it.check,
    text: formatCheck(it.check),
    passed: 0,
    rejected: 0,
    lastReject: null,
  }));
  const declared = list.length > 0;

  const check = (obs, meta = {}) => {
    if (!declared) return { ok: true, failures: [] };
    // 变异体：恒通过 —— 只为证明"门禁拒绝次数"那条断言有牙（正常跑不会到这条分支）
    if (INVARIANTS_MUTANT === 'alwaysPass') {
      for (const it of list) it.passed += 1;
      return { ok: true, failures: [] };
    }
    const failures = [];
    for (const it of list) {
      let ok;
      try {
        ok = evalNode(it.check, obs);
      } catch (e) {
        // 取值/比较阶段的硬错要能点回是哪条不变量写的（不然一堆 check 里不知道谁写错了）
        throw new Error(String(e && e.message ? e.message : e) + `\n  来自硬不变量 id="${it.id}"`);
      }
      if (ok) {
        it.passed += 1;
        continue;
      }
      it.rejected += 1;
      const values = valuesOf(fieldsOf(it.check), obs);
      it.lastReject = {
        seq: meta.seq ?? null,
        phase: String(meta.phase || ''),
        values,
        stdout: String((obs && obs.stdout) || '').slice(0, 400),
      };
      failures.push({ id: it.id, why: it.why, check: it.check, text: it.text, values });
    }
    return { ok: failures.length === 0, failures };
  };

  const summary = () => ({
    declared,
    mutant: INVARIANTS_MUTANT,
    rejected: list.reduce((a, it) => a + it.rejected, 0),
    passed: list.reduce((a, it) => a + it.passed, 0),
    items: list.map((it) => ({
      id: it.id,
      why: it.why,
      check: it.check,
      text: it.text,
      passed: it.passed,
      rejected: it.rejected,
      lastReject: it.lastReject,
    })),
  });

  return { declared, items: list, check, summary };
}

// 目标/起点违规 = 判据或目标自相矛盾 → 中文硬错，点名 id + why + 观测。
export function assertInvariantPass(result, what) {
  if (result && result.ok) return;
  if (INVARIANTS_MUTANT === 'noTargetGate') return; // 变异体：目标/起点那道硬错不查
  const f = result && result.failures && result.failures[0];
  if (!f) die(`${what}没有拿到门禁结论（执行器被动过？）`);
  const more = result.failures.slice(1).map((x) => `id="${x.id}"`).join('、');
  die(
    `${what}违反硬不变量 id="${f.id}"：\`${f.text}\`\n` +
      `  为什么（why）：${f.why}\n` +
      `  观测：${JSON.stringify(f.values)}\n` +
      `  硬不变量不是"扣一点分"，是"合格/不合格"——${what}都过不了，说明判据/目标自相矛盾（比如要求"必须无损"，但目标参数本身就坏），拒绝开跑。` +
      (more ? `\n  同时违反：${more}` : ''),
  );
}

// invariant 段的名字：截图链路暂不支持（见 report.md 已知限制与文档）。
export const SCREENSHOT_LIMIT = '截图链路（`iter.ps1`）暂不支持门禁：它的观测是页面指标、判定在 PowerShell 里，且没有测试守着 PS 侧实现。「暂不支持」= 在截图链路的 intent 里写 invariants 会**硬错**（宁可拒跑，也不假装装了门禁）。';

// ---------------------------------------------------------------- ⑤ report.md 渲染
export function invariantSectionLines(summary, opts = {}) {
  const s = summary || { declared: false, items: [], rejected: 0, passed: 0 };
  const md = [];
  md.push('## 硬不变量（不合格直接判废，不进距离）');
  md.push('');
  if (!s.declared) {
    md.push(
      '**没写硬不变量：搜索会拿底线换分数**' +
        (opts.warnSuppressed ? '（`--no-invariants-warn` 已关掉终端提醒，但门禁确实没装）' : '') +
        ' —— 这次的"最优"只在指标意义上更近，不保证任何底线：解压回不去、接口 500、越界写坏这类**废方案依然可能被选中**。',
    );
    md.push('');
    md.push('改法：`intent.invariants` 里加一条 `{ id, check, why }`（见 `skills/selfloop/references/invariants.md` 的「硬不变量」一节）。');
    md.push('');
    md.push('> ' + SCREENSHOT_LIMIT);
    md.push('');
    return md;
  }
  // 假门（0.8.0）：本次一次都没拦住候选的那几条 —— 报告里**永远**照写，终端开关只关终端。
  const fakeGate = fakeGateFindings(s);
  const fakeById = new Map(fakeGate.map((f) => [f.id, f]));
  const proximity = Array.isArray(opts.nearThreshold) ? opts.nearThreshold : [];
  md.push(
    '硬不变量不是"扣一点分"，是"合格/不合格"：任一候选违反就当废案 —— **不进距离比较、不能成为 best、也不会被缓存成「更优」**。指标负责"像不像"，不变量负责"是不是"。',
  );
  md.push('');
  md.push('| id | 判据 | 为什么 | 通过 | 拒绝 | 本次 | 最近一次拒绝 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const it of s.items) {
    const last = it.lastReject
      ? `seq=${it.lastReject.seq === null ? '—' : it.lastReject.seq}${it.lastReject.phase ? '（' + it.lastReject.phase + '）' : ''} \`${JSON.stringify(it.lastReject.values)}\``
      : '—';
    // 表格单元格里的 `|` 会把列切坏（any(...) 的判据文本带竖线）—— 渲染时转义，原始文本不动
    const text = String(it.text).replace(/\|/g, '\\|');
    const gateCell = fakeById.has(it.id) ? '⚠ 本次未拦任何候选' : '—';
    md.push(`| \`${it.id}\` | \`${text}\` | ${it.why} | ${it.passed} | ${it.rejected} | ${gateCell} | ${last} |`);
  }
  md.push('');
  md.push(`**门禁拒绝 ${s.rejected} 个候选**（共过门禁 ${s.passed + s.rejected} 次判定：每次评估都过；\`target.mode=metrics\` 的目标取值也过一次，不占评估预算）。`);
  md.push('');
  if (fakeGate.length) {
    md.push(
      '**假门告警**' +
        (opts.fakeGateWarnSuppressed ? '（`--no-fake-gate-warn` 关掉了终端提醒，但报告照写 —— 开关不改事实）' : '') +
        '：',
    );
    md.push('');
    for (const f of fakeGate) md.push(`- \`${f.id}\`：${f.message}`);
    md.push('');
    md.push('> 假门比没门更危险：它让人以为底线被守住了，实际每个候选都直接过。改法只有两种 —— 把判据写回真正能失败的样子，或者删掉它（删掉至少诚实）。');
    md.push('');
  }
  if (proximity.length) {
    md.push('**目标贴阈值**（这次合格，但离边界太近）：');
    md.push('');
    for (const p of proximity) md.push(`- ${p.message}`);
    md.push('');
  }
  const lastRejects = s.items.filter((it) => it.lastReject);
  if (lastRejects.length) {
    md.push('最近一次拒绝的原始观测片段（每个 id 一条，只摘判据引用到的字段）：');
    md.push('');
    for (const it of lastRejects) {
      md.push(`- \`${it.id}\`：`);
      md.push('');
      md.push('```json');
      md.push(JSON.stringify({ seq: it.lastReject.seq, phase: it.lastReject.phase || null, values: it.lastReject.values, stdout: it.lastReject.stdout }, null, 2));
      md.push('```');
      md.push('');
    }
  } else {
    md.push('本次没有任何候选被拒（门禁一趟没拦住东西 —— 它到底有没有牙，得靠测试里"弄坏能红"那两条证明）。');
    md.push('');
  }
  md.push('> 目标与起点也过同一道门：它们违规 = 判据/目标自相矛盾，直接硬错（不会开跑）。');
  md.push('');
  md.push('> ' + SCREENSHOT_LIMIT);
  md.push('');
  return md;
}
