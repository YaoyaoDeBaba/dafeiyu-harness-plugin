// harness/ledger.js —— 节点台帐（流水线每一步一行记录，机器可读）
//
// 解决的事只有一件：**"这次运行里哪些节点真的在起效、哪些被绕过"必须有一个能查的答案**。
// 以前这些答案散在日志里（readbackExpr 缺失、参数预判 dead、缓存命中、repeat=1 关掉稳定性闸……），
// 没有一处汇总，于是"被绕过"这件事连名字都没有。台帐就是那处汇总：
//
//   <out>/nodes/NN-<node>.json    每节点一条，字段固定（见 FIELD_ORDER），谁写都长一个样
//   report.md 顶部                 "本次运行：N done / N skipped / N degraded" + 每条 skipped/degraded 的原因
//
// 为什么是 CommonJS：finalize.js（截图链路收尾）要 require 它，cmdloop.mjs（ESM）用 createRequire 拉；
// 与 score.js / metrics2.js 同一层，harness/package.json 已把这一层钉成 commonjs。
//
// 契约纪律（照 skill 硬规则 ④「一个指标只有一个口径」）：
//   · 字段名**固定**，不许每个节点自创字段 —— 界面/测试都按 FIELD_ORDER 读；
//   · skipped / degraded / failed **必须带 reason**（跳过要有名字，降级要有原因）；
//   · 不做"补一条 done 凑数"：没跑的节点就是 skipped，跑了一半的是 degraded。
'use strict';

const fs = require('fs');
const path = require('path');

// 台帐记录的字段顺序（也是 JSON 里的属性顺序 —— 人读的时候顺序稳定）
const FIELD_ORDER = ['node', 'seq', 'status', 'producer', 'ms', 'inputs', 'decision', 'artifacts', 'cost', 'reason'];
const STATUSES = ['done', 'skipped', 'degraded', 'failed'];
const PRODUCERS = ['agent', 'engine', 'host'];
// 带原因的状态：这三类不许空着 reason（"跳过了"和"为什么跳过"是两件事）
const NEEDS_REASON = ['skipped', 'degraded', 'failed'];

function nodesDir(outDir) {
  return path.join(outDir, 'nodes');
}

function shortReason(text, max = 160) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

function ensureField(name, value, want, nodeName) {
  if (want === 'string' && typeof value !== 'string') {
    throw new Error(`[台帐] 节点 ${nodeName} 的 ${name} 要是字符串，收到 ${typeof value}`);
  }
  if (want === 'array' && !Array.isArray(value)) {
    throw new Error(`[台帐] 节点 ${nodeName} 的 ${name} 要是数组，收到 ${typeof value}`);
  }
}

// 归一化一条记录：补齐默认值 + 校验。**校验失败是硬错**（台帐写歪了，比没写更糟：下游会当它是真的）。
function normalize(rec, seq) {
  const node = String(rec.node || '').trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(node)) {
    throw new Error(`[台帐] 节点名不合法：${JSON.stringify(rec.node)}（只认小写字母开头的 a-z0-9_-）`);
  }
  const status = String(rec.status || '');
  if (!STATUSES.includes(status)) {
    throw new Error(`[台帐] 节点 ${node} 的 status=${JSON.stringify(rec.status)} 不认识（只认 ${STATUSES.join(' | ')}）`);
  }
  const producer = String(rec.producer || 'engine');
  if (!PRODUCERS.includes(producer)) {
    throw new Error(`[台帐] 节点 ${node} 的 producer=${JSON.stringify(rec.producer)} 不认识（只认 ${PRODUCERS.join(' | ')}）`);
  }
  const ms = rec.ms === undefined || rec.ms === null ? null : Number(rec.ms);
  if (ms !== null && !Number.isFinite(ms)) throw new Error(`[台帐] 节点 ${node} 的 ms 不是数：${JSON.stringify(rec.ms)}`);
  const inputs = rec.inputs === undefined ? [] : rec.inputs;
  ensureField('inputs', inputs, 'array', node);
  const artifacts = rec.artifacts === undefined ? [] : rec.artifacts;
  ensureField('artifacts', artifacts, 'array', node);
  const decisionRaw = rec.decision && typeof rec.decision === 'object' ? rec.decision : {};
  const basis = decisionRaw.basis === undefined ? [] : decisionRaw.basis;
  ensureField('decision.basis', basis, 'array', node);
  const cost = rec.cost && typeof rec.cost === 'object' && !Array.isArray(rec.cost) ? rec.cost : {};
  const reason = String(rec.reason === undefined || rec.reason === null ? decisionRaw.why || '' : rec.reason).trim();
  if (NEEDS_REASON.includes(status) && !reason) {
    throw new Error(
      `[台帐] 节点 ${node} 的 status=${status} 但没写 reason —— 跳过/降级/失败必须写清"为什么"，` +
        `否则汇总行里只有数字、看不出哪一步被绕过了`,
    );
  }
  return {
    node,
    seq,
    status,
    producer,
    ms,
    inputs: inputs.map(String),
    decision: { why: String(decisionRaw.why || ''), basis: basis.map(String) },
    artifacts: artifacts.map(String),
    cost,
    reason,
  };
}

function fileNameOf(rec) {
  return String(rec.seq).padStart(2, '0') + '-' + rec.node + '.json';
}

// 建一本台帐。
//   mode='fresh'（默认）：把 <out>/nodes 清空重建 —— 一个 out 目录就是一次 run，旧节点的 seq 会和新节点撞号；
//   mode='resume'：接着目录里已有的节点往下编号（截图链路：iter.ps1 先写 01-intent，finalize.js 再补后面几个）。
function createLedger(outDir, opts = {}) {
  const mode = opts.mode === 'resume' ? 'resume' : 'fresh';
  const dir = nodesDir(outDir);
  if (mode === 'fresh') {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  const nodes = mode === 'resume' ? readNodes(dir) : [];

  function add(rec) {
    const seq = nodes.length + 1;
    const out = normalize({ ...rec, seq }, seq);
    fs.writeFileSync(path.join(dir, fileNameOf(out)), JSON.stringify(out, null, 2) + '\n', 'utf8');
    // 回读自校验：写坏/写 0 字节不会自己报错（照抄 apply_params.js 的纪律③）
    const back = JSON.parse(fs.readFileSync(path.join(dir, fileNameOf(out)), 'utf8'));
    if (back.node !== out.node || back.seq !== out.seq) {
      throw new Error(`[台帐] 回读不一致：${fileNameOf(out)} 写的是 node=${out.node} seq=${out.seq}，读回来是 node=${back.node} seq=${back.seq}`);
    }
    nodes.push(back);
    return back;
  }

  return {
    dir,
    mode,
    nodes,
    add,
    counts: () => summarize(nodes),
    summaryLines: (o) => summaryLines(nodes, o),
  };
}

// 读 <out>/nodes 下所有 .json（按文件名排序 = seq 顺序）。目录不存在返回空数组。
function readNodes(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^\d{2,}-[a-z][a-z0-9_-]*\.json$/.test(n))
    .sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

function summarize(nodes) {
  const counts = { done: 0, skipped: 0, degraded: 0, failed: 0 };
  for (const n of nodes) if (n && counts[n.status] !== undefined) counts[n.status] += 1;
  counts.total = nodes.length;
  return counts;
}

// report.md 顶部的汇总块（两行起）：第一行固定形状 `本次运行：N done / N skipped / N degraded`，
// 下面每条 skipped/degraded/failed 一行原因，超过 maxDetail 行就写"还有 N 条见 nodes/"。
function summaryLines(nodes, opts = {}) {
  const maxDetail = Number.isInteger(opts.maxDetail) ? opts.maxDetail : 8;
  const c = summarize(nodes);
  const failedPart = c.failed ? ' / ' + c.failed + ' failed' : '';
  const lines = ['本次运行：' + c.done + ' done / ' + c.skipped + ' skipped / ' + c.degraded + ' degraded' + failedPart];
  const notable = nodes.filter((n) => ['skipped', 'degraded', 'failed'].includes(n.status));
  for (const n of notable.slice(0, maxDetail)) {
    lines.push('- `' + n.status + '` `' + n.node + '` — ' + shortReason(n.reason));
  }
  if (notable.length > maxDetail) {
    lines.push('- 还有 ' + (notable.length - maxDetail) + ' 条见 `nodes/`');
  }
  return lines;
}

module.exports = { FIELD_ORDER, STATUSES, PRODUCERS, nodesDir, createLedger, readNodes, summarize, summaryLines };
