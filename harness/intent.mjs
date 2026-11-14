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
// 用法（给人看）：
//   node harness/intent.mjs gate --out <run目录> --adapter <a.json> [--intent <file>] [--no-intent]
//        [--chain cmd|screenshot] [--metric-ids cov,lapVar]
//        → 过一个闸：stdout 打印一行 JSON 回执；过不了：中文错误 + 退出码 1
// 用法（给代码用）：import { resolveIntent, intentNodeRecord } from './intent.mjs'
'use strict';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ledger.js 是 CommonJS（截图链路的 finalize.js 也要 require 它），这里用 createRequire 拉进来 ——
// 与 cmdlib.mjs 拉 score.js 同口径。
const requireCjs = createRequire(import.meta.url);
const { createLedger } = requireCjs('./ledger.js');

export const INTENT_FILE = 'intent.json';
export const TEMPLATE_FILE = 'intent.template.json';
export const NO_INTENT_REASON = '显式 --no-intent 跳过需求转译';

// 变异开关：**只给测试用**（证明"改动门禁后测试真的会红"），不设时行为完全正常。
//   alwaysPass    —— 闸恒放行（没有文件也不报错）→ "无 intent 必须硬错"那条断言必红；
//   dropSkipRecord—— --no-intent 时不写台帐 → "skipped 必须有记录且 reason 含 --no-intent"那条断言必红。
export const INTENT_MUTANT = String(process.env.SELFLOOP_INTENT_MUTANT || '');

const HARD = '[需求转译闸] ';
const CHAINS = ['cmd', 'screenshot'];

function die(msg) {
  throw new Error(HARD + msg);
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
      '这是需求转译（intent）模板：引擎在开跑之前要求一份**经过确认**的需求转译，否则拒跑。',
      '① 填什么：understood（一句话复述"我理解你要的是什么"）/ criteria（要对哪些指标下手、权重多少、目标值多少）/ uncertain（还没说清的地方）/ confirm（要用户拍板的问题）。',
      '② criteria[].id 必须是这份 adapter 里真实存在的指标 id：' + ids + '。写错 id 是硬错，不会静默忽略。',
      '③ ' + targetNote + '。',
      '④ 填完怎么确认：把 confirmed 改成 true，写上 confirmedBy（谁确认的）与 confirmedAt（ISO 8601，如 2026-11-14T10:46:00+08:00），然后重跑同一条命令。',
      '⑤ 不想走这一步：命令行加 --no-intent（截图链路 -NoIntent）显式跳过 —— 台帐会记一条 skipped 并写明原因；跳过有名字，但这次就没有"需求被消化"的证据。',
    ],
    understood: '',
    criteria: [],
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

// criteria 校验：id 必须存在、权重/目标值必须是数、不许重复。
// 返回 [{id, weight|null, target|null, why}]（null = 这一项没提，不该覆盖）。
export function validateCriteria(raw, metricIds) {
  const known = metricIds.map(String);
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) die(`intent.criteria 要是数组（每项 {id, weight, target, why}），收到 ${typeof raw}`);
  const out = [];
  const seen = new Set();
  const unknown = [];
  raw.forEach((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) die(`intent.criteria[${i}] 不是对象（要 {id, weight, target, why}）：${JSON.stringify(c)}`);
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
    out.push({ id, weight, target, why: String(c.why ?? '') });
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

// ---------------------------------------------------------------- 闸
// 返回：
//   status 'done'      —— 有一份 confirmed:true 的转译（criteria 已校验，交给调用方覆盖判据）
//   status 'skipped'   —— 显式 --no-intent（调用方必须写一条 skipped 台帐）
// 抛错 = 硬错（没有文件 / 没确认 / criteria 里的 id 不存在）。
export function resolveIntent(opts = {}) {
  const outDir = opts.outDir;
  const chain = CHAINS.includes(opts.chain) ? opts.chain : 'cmd';
  const metricIds = (opts.metricIds || []).map(String);
  const noIntent = Boolean(opts.noIntent);
  const tplPath = join(outDir, TEMPLATE_FILE);
  if (noIntent) {
    return {
      status: 'skipped',
      chain,
      path: '',
      templatePath: '',
      intent: null,
      criteria: [],
      understood: '',
      reason: NO_INTENT_REASON,
      warnings: ['这次没有"需求被消化"的证据：判据全部按 adapter 原样，没人确认过它是不是你要的'],
    };
  }
  const file = opts.intentPath ? resolve(opts.intentPath) : join(outDir, INTENT_FILE);
  if (!existsSync(file)) {
    writeTemplate(tplPath, metricIds, chain);
    if (INTENT_MUTANT !== 'alwaysPass') {
      const skipSwitch = chain === 'screenshot' ? '-NoIntent' : '--no-intent';
      die(
        `没有需求转译文件：${file}\n` +
          `  ① 要填什么：understood（一句话复述需求）/ criteria（对哪些指标下手、权重与目标值）/ uncertain（没说清的地方）/ confirm（要用户拍板的问题）；` +
          `这份 adapter 的指标是 ${metricIds.join(' / ') || '（一个都没有）'}；模板已写到 ${tplPath}\n` +
          `  ② 填完怎么确认：把 confirmed 改成 true，写上 confirmedBy / confirmedAt（ISO 8601），再重跑同一条命令\n` +
          `  ③ 确实不填：命令行加 ${skipSwitch} 显式跳过 —— 台帐会记一条 skipped 并写明原因（跳过有名字，但这次没有"需求被消化"的证据）\n` +
          `  为什么拦：需求输入之后必须先被消化；没确认过的判据，跑完一整轮也不知道"变好"是相对谁说的`,
      );
    }
    return { status: 'degraded', chain, path: '', templatePath: tplPath, intent: null, criteria: [], understood: '', reason: '（变异体 alwaysPass：闸被改成恒放行）', warnings: [] };
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

  const criteria = validateCriteria(j.criteria, metricIds);
  const understood = String(j.understood ?? '').trim();
  const warnings = [];
  if (!understood) warnings.push('intent.understood 是空的：确认了 confirmed，但没留下"我理解你要的是什么"那句话');
  if (!criteria.length) warnings.push('intent.criteria 是空的：这次没有覆盖任何判据（只留了复述记录）');
  return {
    status: 'done',
    chain,
    path: file,
    templatePath: '',
    intent: j,
    criteria,
    understood,
    reason: '',
    warnings,
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

// ---------------------------------------------------------------- 台帐记录（两个入口共用同一个形状）
// 字段固定：node / seq / status / producer / ms / inputs / decision / artifacts / cost / reason
export function intentNodeRecord(res, extra = {}) {
  const chain = res.chain === 'screenshot' ? 'screenshot' : 'command';
  const artifacts = [];
  if (extra.effectiveAdapter) artifacts.push(extra.effectiveAdapter);
  const basis = [];
  if (res.status === 'skipped') {
    basis.push('--no-intent：显式跳过需求转译（本次判据 = adapter 原样，没人确认过它是不是你要的）');
  } else {
    const it = res.intent || {};
    basis.push('confirmed=true' + (it.confirmedBy ? `（${it.confirmedBy}）` : '') + (it.confirmedAt ? ' @ ' + it.confirmedAt : ''));
    if (res.understood) basis.push('understood: ' + res.understood);
    if (res.criteria.length) {
      for (const c of res.criteria) {
        const bits = [];
        if (c.weight !== null) bits.push('weight=' + c.weight);
        if (c.target !== null) bits.push('target=' + c.target);
        basis.push(`覆盖判据 ${c.id}：${bits.join(' ')}${c.why ? '（原因：' + c.why + '）' : ''}`);
      }
    } else {
      basis.push('criteria 为空：没有覆盖任何判据');
    }
    for (const w of extra.notes || []) basis.push('adapter 派生：' + w);
    for (const w of res.warnings || []) basis.push('提醒：' + w);
    if (res.reason) basis.push('降级原因：' + res.reason);
  }
  const why =
    res.status === 'skipped'
      ? '显式跳过需求转译：放行，但这一步没有产物，判据全部按 adapter 原样'
      : res.status === 'degraded'
        ? `需求转译过了闸，但有一部分没生效（${res.reason}）`
        : `需求转译已过闸（${chain === 'screenshot' ? '截图链路' : '命令链路'}）：criteria 覆盖 ${res.criteria.length} 条判据`;
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
  const a = { cmd: '', out: '', adapter: '', intent: '', noIntent: false, chain: 'cmd', metricIds: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--no-intent') {
      a.noIntent = true;
      continue;
    }
    const v = argv[i + 1];
    if (k === '--out') a.out = v ?? '';
    else if (k === '--adapter') a.adapter = v ?? '';
    else if (k === '--intent') a.intent = v ?? '';
    else if (k === '--chain') a.chain = v ?? '';
    else if (k === '--metric-ids') a.metricIds = v ?? '';
    else throw new Error(`不认识的参数 ${k}（gate 只认 --out/--adapter/--intent/--no-intent/--chain/--metric-ids）`);
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
  if (res.status === 'done') {
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
      res.reason = 'criteria[].target 在截图链路不生效（目标锚点来自目标帧实测，不在 adapter 里）：已记账，未参与距离';
    }
  }
  const ledger = createLedger(outDir);
  ledger.add(intentNodeRecord(res, { ms: Date.now() - t0, effectiveAdapter, notes }));
  console.log(
    JSON.stringify({
      status: res.status,
      nodeFile: join('nodes', '01-intent.json'),
      effectiveAdapter,
      criteria: res.criteria,
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
