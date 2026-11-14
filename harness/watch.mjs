// harness/watch.mjs —— 「边跑边看」的最小实时视图
//
// 解决的事只有一件：**跑的时候就能看出过程在发生什么**，不用等跑完翻文件。
// 数据来源只有磁盘（不连引擎、不开端口）：
//   <out>/live.jsonl      cmdloop.mjs 每评估一行（有就画最近 3 个评估点）
//   <out>/nodes/*.json    节点台帐（画每个节点的状态 / 耗时 / 跳过原因）
//   证据包文件            画最新产物的**绝对路径**（手机远程时能直接复制）
//
// 用法：
//   node harness/watch.mjs <out目录> [--once] [--interval 500] [--timeout 60] [--json]
//
//   --once          只画一帧就退出（测试用）
//   --interval N    重画间隔，毫秒（默认 500）
//   --timeout S     到点自动退出，秒（默认 60，避免挂死）
//   --json          不画界面，把一屏数据打成 JSON（给以后的面板直接读）
//
// 退出：读到 nodes/ 里有 finalize（status=done|failed）→ 画最后一屏后 exit 0。
// 截图链路（iter.ps1）不写 live.jsonl：没有实时评估流时第 3 段写一行说明，其余照常。
'use strict';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_ORDER = ['intent', 'target', 'stability', 'precheck', 'search', 'finalize'];
const SYM = { done: '✔', running: '⏝', skipped: '–', degraded: '!', failed: '✗', pending: '·' };
const GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', omega: 'ω' };
const NO_LIVE_TEXT = '（没有实时评估流：这条链路只写节点台帐）';
const HINT_TEXT = 'Ctrl+C 退出 · 跑完自动显示 summary';
const CLEAR = '\x1b[2J\x1b[H';

const USAGE = `用法：node harness/watch.mjs <out目录> [--once] [--interval 500] [--timeout 60] [--json]

  --once          只画一帧就退出（测试用）
  --interval N    重画间隔，毫秒（默认 500）
  --timeout S     到点自动退出，秒（默认 60）
  --json          输出一屏数据为 JSON（不画界面）`;

function parseArgv(argv) {
  const a = { out: '', once: false, interval: 500, timeout: 60, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--once') a.once = true;
    else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--interval' || k === '--timeout') {
      const v = Number(argv[i + 1]);
      i += 1;
      if (!Number.isFinite(v) || v <= 0) throw new Error(`${k} 要一个正数，收到 ${JSON.stringify(argv[i])}`);
      if (k === '--interval') a.interval = Math.max(50, Math.round(v));
      else a.timeout = v;
    } else if (!k.startsWith('-') && !a.out) a.out = k;
    else throw new Error(`不认识的参数：${k}`);
  }
  if (!a.help && !a.out) throw new Error('缺 <out目录>（这次 run 的输出目录）');
  return a;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 读 <out>/nodes/*.json（文件名排序 = seq 顺序）。台帐可能正在写，坏一条就跳过，不炸整屏。
function readNodes(outDir) {
  const dir = join(outDir, 'nodes');
  if (!existsSync(dir)) return [];
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /^\d{2,}-[a-z][a-z0-9_-]*\.json$/.test(n)).sort();
  } catch {
    return [];
  }
  return names
    .map((n) => readJsonSafe(join(dir, n)))
    .filter((x) => x && typeof x === 'object' && typeof x.node === 'string')
    .map((x, i) => ({ ...x, seq: Number.isFinite(Number(x.seq)) ? Number(x.seq) : i + 1 }));
}

// 读 live.jsonl：每行一条评估；写了一半的行跳过（不炸屏）。
function readLive(outDir) {
  const file = join(outDir, 'live.jsonl');
  if (!existsSync(file)) return [];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && Number.isFinite(Number(o.seq))) rows.push(o);
    } catch {
      // 正在追加的那一行：下一次 tick 再读
    }
  }
  rows.sort((a, b) => Number(a.seq) - Number(b.seq));
  return rows;
}

function median(arr) {
  const v = arr.map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

function fmtMs(ms) {
  return Number.isFinite(Number(ms)) ? `${Math.round(Number(ms))}ms` : '';
}

function short(text, max = 40) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return String(parseFloat(n.toFixed(3)));
}

function fmtD(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(4) : '—';
}

// 从最后一次评估的 note 反推"现在跑到哪个节点"（节点文件还没落盘时显示 running）。
function phaseOf(note) {
  const n = String(note || '');
  if (n === 'target' || n === 'start') return 'target';
  if (n === 'stability') return 'stability';
  if (n === 'precheck') return 'precheck';
  if (n === 'search') return 'search';
  return '';
}

// "最新产物"清单：存在才列，顺序固定（人眼里先看两张图，再看报告/台帐）。
function collectArtifacts(outDir) {
  const items = [
    { rel: 'shots/best.png', kind: 'file' },
    { rel: 'shots/target.png', kind: 'file' },
    { rel: 'report.md', kind: 'file' },
    { rel: 'best.json', kind: 'file' },
    { rel: 'curve.csv', kind: 'file' },
    { rel: 'nodes', kind: 'dir' },
  ];
  return items
    .filter((it) => {
      const abs = resolve(outDir, it.rel);
      try {
        return it.kind === 'dir' ? statSync(abs).isDirectory() : statSync(abs).isFile();
      } catch {
        return false;
      }
    })
    .map((it) => ({ rel: it.rel, path: resolve(outDir, it.rel) }));
}

// 一屏的数据（--json 直接吐它；画界面也从它渲染 —— 两边不会漂）。
function snapshot(outDir) {
  const dir = resolve(outDir);
  const nodes = readNodes(dir);
  const live = readLive(dir);
  const bestJson = readJsonSafe(join(dir, 'best.json'));

  const finalize = nodes.find((n) => n.node === 'finalize');
  const finished = Boolean(finalize && (finalize.status === 'done' || finalize.status === 'failed'));

  const last = live.length ? live[live.length - 1] : null;
  const startLine = live.find((l) => l.note === 'start' && Number.isFinite(Number(l.d)));
  const budget = Number.isFinite(Number(last?.budget)) ? Number(last.budget) : Number.isFinite(Number(bestJson?.budget)) ? Number(bestJson.budget) : null;
  const round = last && Number.isFinite(Number(last.round)) ? Math.max(0, Number(last.round)) : null;
  const evaluated = live.length;
  const best = Number.isFinite(Number(last?.best)) ? Number(last.best) : Number.isFinite(Number(bestJson?.bestDist)) ? Number(bestJson.bestDist) : null;
  const startDist = startLine ? Number(startLine.d) : Number.isFinite(Number(bestJson?.startDist)) ? Number(bestJson.startDist) : null;
  const msPerEval = median(live.map((l) => l.evalMs)) ?? (Number.isFinite(Number(bestJson?.meta?.msPerEval)) ? Number(bestJson.meta.msPerEval) : null);
  const dropPct = startDist && startDist > 0 && Number.isFinite(best) ? Number((((startDist - best) / startDist) * 100).toFixed(1)) : null;

  const active = !finished && last ? phaseOf(last.note) : '';
  const byName = new Map();
  for (const n of nodes) byName.set(n.node, n);
  const names = NODE_ORDER.concat([...byName.keys()].filter((n) => !NODE_ORDER.includes(n)));

  const view = names.map((name) => {
    const rec = byName.get(name);
    if (rec) {
      return { node: name, status: rec.status, ms: Number.isFinite(Number(rec.ms)) ? Number(rec.ms) : null, reason: String(rec.reason || ''), seq: rec.seq };
    }
    if (active && name === active) return { node: name, status: 'running', ms: null, reason: '', seq: null };
    return { node: name, status: 'pending', ms: null, reason: '', seq: null };
  });

  const counts = { done: 0, skipped: 0, degraded: 0, failed: 0 };
  for (const n of nodes) if (counts[n.status] !== undefined) counts[n.status] += 1;

  const recent = live.slice(-3).map((l) => ({
    seq: Number(l.seq),
    round: Number.isFinite(Number(l.round)) ? Number(l.round) : null,
    d: Number.isFinite(Number(l.d)) ? Number(l.d) : null,
    note: String(l.note || ''),
    params: l.params && typeof l.params === 'object' ? l.params : {},
  }));

  return {
    outDir: dir,
    run: dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir,
    round,
    budget,
    evaluated,
    best,
    startDist,
    dropPct,
    msPerEval,
    finished,
    live: live.length > 0,
    nodes: view,
    counts,
    recent,
    artifacts: collectArtifacts(dir),
  };
}

function render(snap) {
  const lines = [];
  // 1) 状态行：run · 第 N 轮 / 预算（已评） · best（降幅） · 单次
  const roundTxt = snap.round === null ? '第 — 轮' : `第 ${snap.round} 轮`;
  const budgetTxt = snap.budget === null ? `已评 ${snap.evaluated}` : `预算 ${snap.budget}（已评 ${snap.evaluated}）`;
  const bestTxt =
    snap.best === null
      ? 'best —'
      : `best ${snap.best.toFixed(4)}` +
        (snap.dropPct === null ? '' : `（${snap.dropPct >= 0 ? '-' : '+'}${Math.abs(snap.dropPct).toFixed(1)}%）`);
  const msTxt = `单次 ${snap.msPerEval === null ? '—' : Math.round(snap.msPerEval) + 'ms'}`;
  lines.push(`run ${snap.run}  ·  ${roundTxt} / ${budgetTxt}  ·  ${bestTxt}  ·  ${msTxt}`);

  // 2) 节点行：符号 + 名字 + 状态 + 耗时；skipped/degraded/failed 带原因（截 40 字）
  for (const n of snap.nodes) {
    const sym = SYM[n.status] || '·';
    const name = n.node.padEnd(9);
    if (n.status === 'done') {
      const ms = fmtMs(n.ms);
      lines.push(`${sym} ${name} done${ms ? ' ' + ms : ''}`.trimEnd());
    } else if (n.status === 'running') {
      lines.push(`${sym} ${name} running`.trimEnd());
    } else if (n.status === 'pending') {
      lines.push(`${sym} ${name} pending`.trimEnd());
    } else {
      const why = short(n.reason, 40);
      lines.push(`${sym} ${name} ${n.status}${why ? `（${why}）` : ''}`);
    }
  }
  const failedPart = snap.counts.failed ? ` / ${snap.counts.failed} failed` : '';
  lines.push(`  ${snap.counts.done} done / ${snap.counts.skipped} skipped / ${snap.counts.degraded} degraded${failedPart}`);

  // 3) 最近 3 个评估点（live.jsonl 末尾）
  if (!snap.live) {
    lines.push(NO_LIVE_TEXT);
  } else {
    const items = snap.recent.map((e) => {
      const ps = Object.keys(e.params)
        .slice(0, 4)
        .map((k) => `${GREEK[k] || k}=${fmtNum(e.params[k])}`)
        .join(' ');
      return `#${e.seq} d=${fmtD(e.d)}${ps ? ' ' + ps : ''}`;
    });
    lines.push(items.join('  ·  ') || NO_LIVE_TEXT);
  }

  // 4) 最新产物：绝对路径，每行一个
  if (snap.artifacts.length) {
    for (const a of snap.artifacts) lines.push(a.path);
  } else {
    lines.push('（还没有产物：证据包会在 finalize 时落盘）');
  }

  // 5) 提示
  lines.push(HINT_TEXT);
  process.stdout.write(lines.join('\n') + '\n');
}

function main() {
  let args;
  try {
    args = parseArgv(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(String(e.message) + '\n\n' + USAGE + '\n');
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const outDir = resolve(args.out);
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
    process.stderr.write(`读不到输出目录：${outDir}\n`);
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(snapshot(outDir), null, 2) + '\n');
    return;
  }

  if (args.once) {
    render(snapshot(outDir));
    return;
  }

  let stopped = false;
  const stop = (code) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(watchdog);
    process.exit(code);
  };
  const tick = () => {
    if (stopped) return;
    if (process.stdout.isTTY) process.stdout.write(CLEAR);
    const snap = snapshot(outDir);
    render(snap);
    if (snap.finished) stop(0); // 跑完自动退：最后一屏已经画过了
  };
  const timer = setInterval(tick, args.interval);
  const watchdog = setTimeout(() => stop(0), args.timeout * 1000);
  tick();
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { snapshot, render, parseArgv };
