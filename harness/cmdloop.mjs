// harness/cmdloop.mjs —— 「命令观测」闭环执行器（跨平台，纯 node，不依赖 PowerShell）
//
// 一条命令 = 解析 adapter.observe → 跑目标 → 扫参数活性 → 坐标下降 → 出证据包。
// 它跟 harness/iter.ps1 是**并列的两个入口**，不是它的分支：
//   iter.ps1   观测来源 = 浏览器截图（起静态服 + 浏览器 + 冻帧 + metrics2.js 量像素）
//   cmdloop.mjs 观测来源 = 一条命令的 stdout（parse=json | number | line:k=v）
// 判据那一层两边共用 score.js（本脚本 require 同一份），搜索那一层是**照抄 iter.ps1 的坐标下降语义**
// （Get-Step / New-Vector / Key-Of / 预算与缓存 / 停滞停）——为什么是复制、差在哪，见 cmdlib.mjs 顶部。
//
// 用法：
//   node harness/cmdloop.mjs --adapter <a.json> --out <run目录> [--budget 30] [--seed 12345]
//        [--step-ratio 0.1] [--max-rounds 20] [--max-stagnant 2] [--strategy coordinate|random]
//        [--params a,b,c]            # 覆盖 adapter.params.list（name 或 name=初值）
//        [--intent <file>] [--no-intent]   # 需求转译闸（0.5.0）：默认读 <out>/intent.json
//
// 产出（--out 下）：curve.csv / best.json / report.md / params\ / outputs\ / **nodes\（节点台帐 0.5.0）**
'use strict';

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MUTANT,
  OUTPUT_CAP_BYTES,
  applyMetricOverrides,
  assertStability,
  capOutputDoc,
  evaluate,
  ensureOutDir,
  keyOf,
  measureStability,
  newVector,
  readJson,
  resolveCommandPlan,
  round6,
  sha256Text,
  stepOf,
} from './cmdlib.mjs';
import { INTENT_MUTANT, NO_INTENT_REASON, criteriaOverrides, intentNodeRecord, resolveIntent } from './intent.mjs';

// ledger.js 是 CommonJS（截图链路的 finalize.js 也 require 它），这里用 createRequire 拉。
const requireCjs = createRequire(import.meta.url);
const { createLedger, summaryLines } = requireCjs('./ledger.js');

// 运行期台帐句柄：main() 的 catch 要拿它补一条 failed 节点（"哪一步炸的"要留在台帐里）
let RUN_LEDGER = null;
let RUN_PHASE = '';

const USAGE = `用法：
  node harness/cmdloop.mjs --adapter <a.json> --out <run目录> [选项]

选项：
  --budget N          评估次数上限（默认 30；目标帧/起点/预检/搜索共用）
  --seed N            种子（默认 12345；进证据包 hash，同 seed 同参数的轨迹必须一致）
  --step-ratio F      相对步长（默认 0.1；零基参数自动改绝对步长 0.05，与 iter.ps1 同口径）
  --max-rounds N      最多几轮坐标下降（默认 20）
  --max-stagnant N    连续几轮没改进就停（默认 2）
  --strategy S        coordinate（默认）| random
  --params a,b=3      覆盖 adapter.params.list（name 取基线现值，name=值 显式起跑）
  --intent <file>     需求转译文件（缺省读 <out>/intent.json）；没有它 = 硬错（会写出 intent.template.json）
  --no-intent         显式跳过需求转译（放行的唯一姿势；台帐 nodes/01-intent.json 记 skipped 并写明原因）
  --help              这份说明

需求转译闸（0.5.0，比活性预检更早，因为它会改判据）：
  跑之前必须有一份**经过确认**的需求转译（understood / criteria / uncertain / confirm / confirmed:true）。
  criteria 里按 id 覆盖指标的权重与目标值；id 在 adapter 里不存在 = 硬错（绝不静默忽略）。
  confirmed 不是 true = 硬错，并把 confirm[] 里待确认的问题原样列出来。
  确实不想走这一步就显式 --no-intent：放行，但台帐会记一条 skipped —— 跳过要有名字。

观测稳定性闸（0.4.1）：搜索前先用起点参数把命令连跑 observe.stability.repeat 次（默认 3），
任一指标相对离散度 (max-min)/max(|mean|,1e-9) 超过 maxSpread（默认 0.02）就中文硬错。
这几次是真实评估、记进预算（默认多花 2 次）；预算不够会硬错提示提高 --budget 或显式 repeat=1。`;

function parseArgs(argv) {
  const a = {
    adapter: '',
    out: '',
    budget: 30,
    seed: 12345,
    stepRatio: 0.1,
    maxRounds: 20,
    maxStagnant: 2,
    strategy: 'coordinate',
    params: '',
    intent: '',
    noIntent: false,
    help: false,
  };
  const takes = {
    '--adapter': 'adapter',
    '--out': 'out',
    '--budget': 'budget',
    '--seed': 'seed',
    '--step-ratio': 'stepRatio',
    '--max-rounds': 'maxRounds',
    '--max-stagnant': 'maxStagnant',
    '--strategy': 'strategy',
    '--params': 'params',
    '--intent': 'intent',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--help' || k === '-h') {
      a.help = true;
      continue;
    }
    if (k === '--no-intent') {
      a.noIntent = true;
      continue;
    }
    const key = takes[k];
    if (!key) throw new Error(`不认识的参数 ${k}（--help 看用法）`);
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${k} 缺值`);
    i += 1;
    if (['budget', 'seed', 'maxRounds', 'maxStagnant'].includes(key)) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${k} 要非负整数（收到 ${v}）`);
      a[key] = n;
    } else if (key === 'stepRatio') {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} 要正数（收到 ${v}）`);
      a.stepRatio = n;
    } else a[key] = v;
  }
  if (a.help) return a;
  if (!a.adapter) throw new Error('缺 --adapter（命令观测的 adapter.json 绝对/相对路径）');
  if (!a.out) throw new Error('缺 --out（证据包目录；不覆盖别人的 run 目录）');
  if (!a.budget || a.budget < 1) throw new Error('--budget 至少 1');
  if (a.intent && a.noIntent) throw new Error('--intent 与 --no-intent 不能同时给：要么给一份确认过的需求转译，要么显式跳过');
  if (!['coordinate', 'random'].includes(a.strategy)) throw new Error(`--strategy=${a.strategy} 只支持 coordinate | random`);
  return a;
}

// 可复现的伪随机（只给 random 策略用）。iter.ps1 那边是 .NET [Random]::new(seed)，
// 两边序列**不同**（换语言没法逐位对齐），所以 random 策略的轨迹不跨执行器可比；
// coordinate 策略是确定性的，两边口径一致。这条差别写进文档，别让读者以为换执行器 hash 还会一样。
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function r6(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(6)) : null;
}

function sortObj(o) {
  if (Array.isArray(o)) return o.map(sortObj);
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = sortObj(o[k]);
    return out;
  }
  return o;
}

function f6(v) {
  if (v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(6) : '';
}
function d4(v) {
  if (v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(4) : '';
}
function num(v) {
  if (v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(parseFloat(n.toFixed(4))) : '';
}

function median(arr) {
  const v = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

function run(args) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const adapterFile = resolve(args.adapter);
  if (!existsSync(adapterFile)) throw new Error(`读不到 adapter：${adapterFile}`);
  const adapter = readJson(adapterFile, 'adapter');
  const plan = resolveCommandPlan(adapter, adapterFile, { params: args.params });
  const outDir = ensureOutDir(args.out);
  for (const sub of ['params', 'outputs']) mkdirSync(join(outDir, sub), { recursive: true });

  const usage = { used: 0, target: 0, start: 0, stability: 0, precheck: 0, search: 0, cache: 0 };
  const evals = [];
  const cache = new Map();
  const outputs = new Map(); // seq -> 写进 outputs/ 的相对路径
  let ledger = null; // 节点台帐（0.5.0）：每节点一条 <out>/nodes/NN-<node>.json
  let intentTargetsOverride = {}; // intent.criteria[].target：拿到目标行之后覆盖

  const log = (s) => console.log(s);

  log(`[init] adapter=${plan.adapterName || '(未命名)'}  ${adapterFile}`);
  log(`[init] 命令观测：parse=${plan.observe.parse}  timeout=${plan.observe.timeoutMs}ms  cmd=${plan.observe.cmdRaw}`);
  log(`[init] 参数文件基线=${plan.baseFile}${plan.baseFile && existsSync(plan.baseFile) ? '' : '（不在！白名单只能用 name=值 形式）'}`);
  log(`[init] 白名单 ${plan.wl.length} 个: ${plan.wl.map((k) => k + '=' + plan.startParams[k]).join('  ')}`);
  log(`[init] 判据（adapter 原样）${plan.scoreText}`);
  log(`[init] Out=${outDir}  budget=${args.budget} seed=${args.seed} step=${args.stepRatio * 100}% strategy=${args.strategy}`);

  // ---------------------------------------------------------------- 节点台帐（0.5.0）
  // 一个 --out 目录 = 一次 run：开跑先把 nodes/ 清空（旧节点的 seq 会和新节点撞号）。
  // RUN_LEDGER / RUN_PHASE 挂到模块级，是为了让 main() 的 catch 在硬错时补一条 failed 节点 ——
  // "哪一步炸的"必须留在台帐里，而不是只在终端的最后三行。
  ledger = createLedger(outDir);
  RUN_LEDGER = ledger;

  // ---------------------------------------------------------------- 需求转译闸（0.5.0）
  // 位置：**所有评估之前**（比目标帧/目标指标、比活性预检、比稳定性闸都早），因为它会改判据。
  {
    const gt0 = Date.now();
    RUN_PHASE = 'intent';
    const intent = resolveIntent({
      outDir,
      intentPath: args.intent,
      noIntent: args.noIntent,
      metricIds: plan.observe.metricIds,
      chain: 'cmd',
    });
    const { weights: intentWeights, targets: intentTargets } = criteriaOverrides(intent.criteria);
    if (Object.keys(intentWeights).length) {
      applyMetricOverrides(plan, { weights: intentWeights });
      log(`[intent] 判据被覆盖：${plan.scoreText}`);
    }
    // --no-intent 的台帐记录**不许省**（跳过要有名字）；变异体 dropSkipRecord 只为证明这条断言有牙。
    if (!(INTENT_MUTANT === 'dropSkipRecord' && intent.status === 'skipped')) {
      ledger.add(intentNodeRecord(intent, { ms: Date.now() - gt0 }));
    }
    RUN_PHASE = '';
    if (intent.status === 'done') {
      log(`[intent] 过闸：${intent.path}（criteria ${intent.criteria.length} 条：${intent.criteria.map((c) => c.id).join(', ') || '无'}）`);
      if (intent.understood) log(`[intent] understood：${intent.understood}`);
      for (const c of intent.criteria) {
        log(
          `[intent] ${c.id} weight=${c.weight === null ? '(未改)' : c.weight} target=${c.target === null ? '(未改)' : c.target}` +
            (c.why ? `  // ${c.why}` : ''),
        );
      }
      for (const w of intent.warnings) log(`[intent][warn] ${w}`);
    } else if (intent.status === 'skipped') {
      log(`[intent][warn] ${NO_INTENT_REASON}：判据全部按 adapter 原样，没人确认过它是不是你要的（台帐记 skipped）`);
    } else {
      log(`[intent][warn] ${intent.reason}`);
    }
    intentTargetsOverride = intentTargets;
  }

  // 真正跑一次命令并把它记进证据包（**不查缓存、也不写缓存**）。
  // 稳定性闸要拿同一组参数连跑 repeat 次：走缓存的话第 2 次就"命中"了，等于什么都没验。
  const runEval = (params, meta) => {
    const seq = evals.length + 1;
    const res = evaluate(plan, { params, outDir, seq, trow });
    usage.used += 1;
    if (meta.phase) usage[meta.phase] += 1;
    const rec = {
      seq,
      id: meta.id,
      round: meta.round,
      note: meta.note,
      params,
      row: res.row,
      stdout: res.stdout,
      stderr: res.stderr,
      ms: res.ms,
      stdoutSha: res.stdoutSha,
      paramsFile: res.paramsFile,
      argv: res.argv,
      dist: res.dist ? res.dist.d : null,
      base: res.dist ? res.dist.base : null,
      parts: res.dist ? res.dist.parts : {},
      pens: res.dist ? res.dist.pens : [],
      pen: res.dist ? res.dist.penSum : 0,
    };
    evals.push(rec);
    const doc = {
      seq,
      id: rec.id,
      round: rec.round,
      note: rec.note,
      cmd: plan.observe.cmdRaw,
      argv: rec.argv,
      paramsFile: relative(outDir, rec.paramsFile),
      params,
      ms: rec.ms,
      metrics: rec.row,
      dist: r6(rec.dist),
      parts: rec.parts,
      pens: rec.pens,
      stdout: rec.stdout,
      stderr: rec.stderr,
    };
    const capped = capOutputDoc(doc);
    const rel = join('outputs', 'e' + String(seq).padStart(3, '0') + '.json');
    writeFileSync(join(outDir, rel), capped.text, 'utf8');
    outputs.set(seq, rel);
    return { seq, rec, cached: false };
  };

  // 一次评估（带缓存与预算闸）；返回 { seq, rec } 或 null（预算耗尽）
  const evaluateCached = (params, meta) => {
    const key = keyOf(params, plan.wl);
    if (cache.has(key)) {
      usage.cache += 1;
      return { seq: cache.get(key), rec: evals[cache.get(key) - 1], cached: true };
    }
    if (usage.used >= args.budget) return null;
    const got = runEval(params, meta);
    cache.set(key, got.seq);
    return got;
  };

  // ---------------------------------------------------------------- 目标
  let trow;
  let targetInfo;
  RUN_PHASE = 'target';
  const tTarget = Date.now();
  if (plan.target.mode === 'metrics') {
    trow = { ...plan.target.metrics };
    targetInfo = { kind: 'metrics', spec: plan.target.metrics, seq: null, stdoutSha: '' };
    log(`[target] 直接给的目标数值 ${JSON.stringify(trow)}（不跑命令，不占预算）`);
  } else {
    for (const k of Object.keys(plan.target.params)) {
      if (!plan.wl.includes(k)) log(`[warn] 目标参数 ${k} 不在白名单里（只影响目标，不影响搜索轴）`);
    }
    const tp = {};
    for (const [k, v] of Object.entries(plan.target.params)) {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`target.params.${k} 不是数：${JSON.stringify(v)}`);
      tp[k] = round6(n);
    }
    const got = evaluateCached(tp, { id: 'target', round: 0, note: 'target', phase: 'target' });
    if (!got) throw new Error('预算太小：连目标都没跑成（--budget 至少 1）');
    const rec = evals[got.seq - 1];
    trow = rec.row;
    targetInfo = {
      kind: 'params',
      spec: tp,
      seq: rec.seq,
      stdoutSha: rec.stdoutSha,
      metrics: rec.row,
    };
    log(`[target] 参数目标 ${JSON.stringify(tp)} → ${plan.observe.metricIds.map((id) => id + '=' + rec.row[id]).join('  ')}`);
  }

  // intent 的 criteria[].target 在这里落地：**必须在算任何距离之前**（起点距离用的就是覆盖后的目标）。
  const targetOverrides = [];
  for (const [id, v] of Object.entries(intentTargetsOverride)) {
    const from = trow[id];
    if (from !== v) targetOverrides.push({ id, from: from === undefined ? null : from, to: v });
    trow[id] = v;
  }
  if (targetOverrides.length) {
    log(`[target] intent 覆盖目标值：${targetOverrides.map((o) => `${o.id} ${num(o.from)} → ${num(o.to)}`).join('  ')}`);
  }
  // 指纹与报告都用**实际生效**的目标值（覆盖过就不是 adapter 原来那个了 —— 否则 hash 会和真实判据脱钩）
  targetInfo.effective = { ...trow };
  if (targetOverrides.length) targetInfo.intentOverrides = targetOverrides;

  // ---------------------------------------------------------------- 起点
  const startGot = evaluateCached(plan.startParams, { id: 'e001', round: 0, note: 'start', phase: 'start' });
  if (!startGot) throw new Error('预算太小：起点都没跑成（--budget 至少 1）');
  const startRec = evals[startGot.seq - 1];
  const startDist = startRec.dist;
  const baseParams = { ...plan.startParams };
  log(`[start] d=${startDist.toFixed(4)}  ${keyOf(baseParams, plan.wl)}`);

  // 台帐 · target（目标帧/目标指标 + 起点）：起点那一次评估也算这一步花的预算
  ledger.add({
    node: 'target',
    status: 'done',
    producer: 'engine',
    ms: Date.now() - tTarget,
    inputs: targetInfo.kind === 'metrics' ? ['adapter.target.metrics', 'intent.criteria[].target'] : ['adapter.target.params', 'adapter.config.path', 'intent.criteria[].target'],
    decision: {
      why:
        targetInfo.kind === 'metrics'
          ? 'adapter.target.mode=metrics：目标就是那组数值，不跑命令、不占预算；随后用起点参数跑一次拿起点距离'
          : 'adapter.target.mode=params：目标参数跑一次命令取指标当锚点，再用起点参数跑一次拿起点距离',
      basis: [
        `目标（生效值）：${plan.observe.metricIds.map((id) => id + '=' + num(trow[id])).join('  ')}`,
        ...targetOverrides.map((o) => `intent 覆盖 ${o.id}：${num(o.from)} → ${num(o.to)}`),
        `起点距离 d=${d4(startDist)}`,
        `起点参数：${plan.wl.map((k) => k + '=' + num(baseParams[k])).join('  ')}`,
      ],
    },
    artifacts: [],
    cost: { evals: usage.target + usage.start },
  });
  RUN_PHASE = '';

  // ---------------------------------------------------------------- 观测稳定性闸（0.4.1）
  // 位置有讲究：起点已评估（它那一次就是第 1 次采样）→ **活性预检之前**（噪声会把参数误判成 dead/alive，
  // 判错了这个参数就再也进不了搜索轴）→ 一定在花预算的搜索之前。
  // 截图链路的等价物是 freeze.verify=strict（同 URL 连拍两张逐字节比）；命令链路原来什么都没有，这是最大的洞。
  RUN_PHASE = 'stability';
  const tStability = Date.now();
  const stabCfg = plan.observe.stability;
  let stability = null;
  if (MUTANT === 'noStability') {
    log('[stability][mutant] noStability：整段稳定性检查被跳过（只为证明测试断言有牙，正常跑不会到这里）');
  } else if (stabCfg.repeat <= 1) {
    stability = {
      repeat: 1,
      maxSpread: stabCfg.maxSpread,
      checked: false,
      ok: false,
      spreads: {},
      values: {},
      spend: 0,
      reason: 'repeat=1：显式关闭观测稳定性检查',
    };
    log(
      '[stability][warn] 本次不验证观测稳定性（observe.stability.repeat=1 显式关掉了检查）：命令若有随机性，收敛结果不可信 —— 这个 run 的"最优"不能当结论。',
    );
  } else {
    const need = stabCfg.repeat - 1;
    if (usage.used + need > args.budget) {
      throw new Error(
        `[命令观测] 预算太小：稳定性检查要在起点参数上再连跑 ${need} 次（repeat=${stabCfg.repeat}，起点那一次算第 1 次采样），` +
          `但 --budget ${args.budget} 只剩 ${args.budget - usage.used} 次。提高 --budget，或在 adapter 里显式写 observe.stability.repeat=1 关掉检查（会 warn）`,
      );
    }
    log(`[stability] 用起点参数连跑 ${stabCfg.repeat} 次（起点那一次已跑过），任一指标相对离散度 > ${stabCfg.maxSpread} 就硬错`);
    const vals = {};
    for (const id of plan.observe.metricIds) vals[id] = [startRec.row[id]];
    for (let i = 1; i < stabCfg.repeat; i += 1) {
      const got = runEval(baseParams, { id: 'stab' + (i + 1), round: 0, note: 'stability:' + (i + 1), phase: 'stability' });
      for (const id of plan.observe.metricIds) vals[id].push(got.rec.row[id]);
    }
    const st = measureStability(vals, stabCfg);
    for (const id of plan.observe.metricIds) {
      const sp = st.spreads[id];
      log(
        `[stability] ${id}: ${st.values[id].map((v) => num(v)).join(' / ')}  spread=${sp === null ? 'n/a' : Number(sp).toFixed(6)}  ${st.okById[id] ? 'ok' : '超阈值'}`,
      );
    }
    assertStability(st, plan.observe.metricIds); // 不稳定 → 中文硬错（不降级、不平均）
    stability = { ...st, checked: true, spend: need };
    log(`[stability] 通过：repeat=${stabCfg.repeat} maxSpread=${stabCfg.maxSpread}，花掉 ${need} 次评估（已记进预算）`);
  }

  // 台帐 · stability：`repeat=1` 是"显式关掉检查"→ degraded（跑过，但没验）。
  // 变异体 noStability 时整段没了 → skipped（这里也照实说，不假装验过）。
  {
    const stMs = Date.now() - tStability;
    if (!stability) {
      ledger.add({
        node: 'stability',
        status: 'skipped',
        producer: 'engine',
        ms: stMs,
        inputs: ['adapter.observe.stability'],
        decision: { why: '变异体 noStability：整段稳定性闸被删掉（只为证明测试断言有牙）', basis: [] },
        artifacts: [],
        cost: { evals: 0 },
        reason: MUTANT === 'noStability' ? '变异体 noStability：整段稳定性闸被删掉' : '稳定性闸没有跑（执行器被动过？）',
      });
    } else if (!stability.checked) {
      ledger.add({
        node: 'stability',
        status: 'degraded',
        producer: 'engine',
        ms: stMs,
        inputs: ['adapter.observe.stability'],
        decision: { why: 'repeat=1：显式关闭观测稳定性检查', basis: ['命令若有随机性，本次"最优"不能当结论'] },
        artifacts: [],
        cost: { evals: 0 },
        reason: 'observe.stability.repeat=1 显式关闭观测稳定性检查（能跑，但没验过观测可重复）',
      });
    } else {
      ledger.add({
        node: 'stability',
        status: 'done',
        producer: 'engine',
        ms: stMs,
        inputs: ['adapter.observe.stability', 'plan.startParams'],
        decision: {
          why: `用起点参数连跑 ${stability.repeat} 次，任一指标相对离散度 > maxSpread 就硬错`,
          basis: [
            `repeat=${stability.repeat} maxSpread=${stability.maxSpread}`,
            ...plan.observe.metricIds.map((id) => `${id}: spread=${Number(stability.spreads[id] ?? 0).toFixed(6)} ${stability.okById[id] ? 'ok' : '超阈值'}`),
          ],
        },
        artifacts: [],
        cost: { evals: usage.stability },
      });
    }
    RUN_PHASE = '';
  }

  // ---------------------------------------------------------------- 活性预检（照抄 iter.ps1 §5.3）
  RUN_PHASE = 'precheck';
  const tPrecheck = Date.now();
  log('[precheck] 每个参数改一档（+1 步），Δd=0 记 dead 并跳过');
  const precheckRows = [];
  const alive = [];
  const dead = [];
  for (const k of plan.wl) {
    if (usage.used >= args.budget) {
      log('[precheck][warn] 预检阶段预算耗尽，后面的参数没扫到');
      break;
    }
    const pv = newVector(baseParams, k, 1, args.stepRatio);
    const got = evaluateCached(pv, { id: 'pc_' + k, round: -1, note: 'precheck:' + k, phase: 'precheck' });
    if (!got) break;
    const rec = evals[got.seq - 1];
    const dDelta = Math.abs(rec.dist - startDist);
    const outputSame = rec.stdoutSha === startRec.stdoutSha;
    const verdict = dDelta <= 1e-9 ? 'dead' : 'alive';
    (verdict === 'alive' ? alive : dead).push(k);
    precheckRows.push({
      param: k,
      start: r6(baseParams[k]),
      perturbed: r6(pv[k]),
      dist: r6(rec.dist),
      dDelta: r6(dDelta),
      outputSame,
      verdict,
      seq: rec.seq,
    });
    log(
      `[precheck] ${k} ${num(baseParams[k])}->${num(pv[k])}  d=${rec.dist.toFixed(4)}  Δd=${dDelta.toFixed(6)}  输出同=${outputSame ? 'Y' : 'N'}  => ${verdict}`,
    );
  }

  let stopReason = '';
  let stopDetail = '';
  if (alive.length === 0) {
    stopReason = dead.length ? 'all-dead' : 'no-alive-after-precheck';
    stopDetail = dead.length
      ? `白名单 ${dead.length} 个参数全部 dead（改一档距离一点不动），一次搜索都没跑`
      : '预检阶段预算耗尽，一个参数都没扫出来';
  }

  // 台帐 · precheck：扫完才是 done；预算中途断 → degraded（"扫了一半"这种事必须留下来）
  {
    const notScanned = plan.wl.length - precheckRows.length;
    ledger.add({
      node: 'precheck',
      status: notScanned > 0 ? 'degraded' : 'done',
      producer: 'engine',
      ms: Date.now() - tPrecheck,
      inputs: ['adapter.params.list（白名单）', 'plan.startParams', '起点距离 d=' + d4(startDist)],
      decision: {
        why: '每个参数在起点基础上 +1 步，与起点比 Δd；Δd==0 判 dead 并从搜索轴剔除（不花预算）',
        basis: [
          `活 ${alive.length} 个：${alive.join(' / ') || '（无）'}`,
          `dead ${dead.length} 个：${dead.join(' / ') || '（无）'}`,
          ...precheckRows.map((r) => `${r.param}: ${num(r.start)}→${num(r.perturbed)} Δd=${r.dDelta === 0 ? '0' : f6(r.dDelta)} → ${r.verdict}`),
        ],
      },
      artifacts: [],
      cost: { evals: usage.precheck },
      reason: notScanned > 0 ? `预检阶段预算耗尽：白名单 ${plan.wl.length} 个只扫到 ${precheckRows.length} 个` : '',
    });
    RUN_PHASE = '';
  }

  // ---------------------------------------------------------------- 搜索（照抄 iter.ps1 §5.4 的坐标下降）
  RUN_PHASE = 'search';
  const tSearch = Date.now();
  let bestVec = { ...baseParams };
  let bestSeq = startRec.seq;
  let bestDist = startDist;
  const roundLog = [];
  let roundNo = 0;
  let stagnant = 0;
  const rng = args.strategy === 'random' ? mulberry32(args.seed) : null;

  while (!stopReason && roundNo < args.maxRounds) {
    roundNo += 1;
    const cands = [{ note: 'none', vec: { ...bestVec } }];
    if (args.strategy === 'coordinate') {
      for (const k of alive) {
        cands.push({ note: k + '-', vec: newVector(bestVec, k, -1, args.stepRatio) });
        cands.push({ note: k + '+', vec: newVector(bestVec, k, 1, args.stepRatio) });
      }
    } else {
      // random：以当前最优为盒心，每轴 ±3 步长内均匀采样（2×活参数 个样本）——照抄 iter.ps1 的盒子
      const n = Math.max(2, 2 * alive.length);
      for (let i = 0; i < n; i += 1) {
        const v = {};
        for (const k of plan.wl) {
          if (alive.includes(k)) {
            const s = stepOf(Number(bestVec[k]), args.stepRatio);
            v[k] = round6(Number(bestVec[k]) + (rng() * 6 - 3) * s);
          } else v[k] = bestVec[k];
        }
        cands.push({ note: 'rand' + (i + 1), vec: v });
      }
    }

    const hit = [];
    let budgetHit = false;
    for (const c of cands) {
      const got = evaluateCached(c.vec, { id: `r${roundNo}_s${evals.length + 1}`, round: roundNo, note: c.note, phase: 'search' });
      if (!got) {
        budgetHit = true;
        break;
      }
      hit.push({ note: c.note, vec: c.vec, seq: got.seq });
    }
    if (!hit.length) {
      stopReason = 'budget';
      stopDetail = '预算在换轮前耗尽';
      break;
    }
    if (budgetHit) {
      stopReason = 'budget';
      stopDetail = `第 ${roundNo} 轮候选没评完，预算已用尽`;
    }

    let pick = null;
    for (const h of hit) {
      const rec = evals[h.seq - 1];
      if (pick === null || rec.dist < pick.dist) pick = { seq: h.seq, dist: rec.dist, note: h.note, vec: h.vec };
    }
    if (!pick) throw new Error(`第 ${roundNo} 轮没有任何可用评估`);

    roundLog.push({ round: roundNo, cands: hit.map((h) => ({ note: h.note, seq: h.seq })), winner: pick.seq });
    log(
      `[round ${roundNo}] ${hit.map((h) => h.note + '=' + d4(evals[h.seq - 1].dist)).join('  ')}   -> 胜出 ${pick.note} d=${d4(pick.dist)}  已用 ${usage.used}/${args.budget}`,
    );

    if (pick.dist < bestDist - 1e-9) {
      bestVec = pick.vec;
      bestDist = pick.dist;
      bestSeq = pick.seq;
      stagnant = 0;
    } else stagnant += 1;

    if (!stopReason && stagnant >= args.maxStagnant) {
      stopReason = 'stagnant';
      stopDetail = `连续 ${stagnant} 轮没有改进（每轮 ±${args.stepRatio * 100}% 都变差）`;
    }
  }
  if (!stopReason) {
    stopReason = 'max-rounds';
    stopDetail = `达到 --max-rounds ${args.maxRounds}`;
  }

  log(
    `[budget] 已用 ${usage.used} 次评估 / 上限 ${args.budget}（目标 ${usage.target} + 起点 ${usage.start} + 稳定性 ${usage.stability} + 预检 ${usage.precheck} + 搜索 ${usage.search}，缓存命中 ${usage.cache}）`,
  );
  log(`[stop] ${stopReason}  ${stopDetail}`);

  // 台帐 · search（整个搜索循环）：轮数 / 评估次数 / 胜出轨迹摘要。
  // "一次都没跑"必须是 skipped 并且说清为什么（all-dead 是预检的功劳，不是搜索的失败）。
  {
    ledger.add({
      node: 'search',
      status: roundLog.length ? 'done' : 'skipped',
      producer: 'engine',
      ms: Date.now() - tSearch,
      inputs: ['precheck 判活的参数轴：' + (alive.join(' / ') || '（无）'), `strategy=${args.strategy} stepRatio=${args.stepRatio}`],
      decision: {
        why: roundLog.length
          ? `坐标下降 ${roundLog.length} 轮；每轮只动一根轴 ±1 步，胜出者必须比当前最优严格更小才接受`
          : `不跑搜索：${stopDetail}`,
        basis: [
          `轮数 ${roundLog.length}，评估 ${usage.search} 次（缓存命中 ${usage.cache}）`,
          ...roundLog.map((r) => `第 ${r.round} 轮胜出 seq=${r.winner}（候选 ${r.cands.map((c) => c.note).join(',')}）`),
          `起点 d=${d4(startDist)} → 最佳 d=${d4(bestDist)}`,
          `终止 ${stopReason}${stopDetail ? ' — ' + stopDetail : ''}`,
        ],
      },
      artifacts: [],
      cost: { evals: usage.search },
      reason: roundLog.length ? '' : `${stopReason}：${stopDetail}`,
    });
    RUN_PHASE = '';
  }

  // ---------------------------------------------------------------- 决策指纹 → hash
  // 口径照抄 finalize.js：只放"决定搜到哪"的东西，**不放**时间、路径、原始输出字节。
  // 所以换一个 --out 目录再跑一次，hash 必须一样（test/command.test.mjs 钉住了这条）。
  const fp = {
    v: 'cmd-iter/1',
    seed: args.seed,
    stepRatio: r6(args.stepRatio),
    budget: args.budget,
    maxRounds: args.maxRounds,
    maxStagnant: args.maxStagnant,
    strategy: args.strategy,
    mutant: MUTANT,
    cmd: plan.observe.cmdRaw,
    parse: plan.observe.parse,
    timeoutMs: plan.observe.timeoutMs,
    // 稳定性闸的**配置**进指纹（换阈值/换样数本来就该换 hash）；
    // 采样到的**数值**不进指纹 —— 那是观测，不是决策（同 seed 同参数的重跑必须还是一个 hash）。
    stability: { repeat: stabCfg.repeat, maxSpread: stabCfg.maxSpread, checked: stability ? stability.checked : false },
    whitelist: plan.wl.map((k) => k + ':' + r6(baseParams[k])),
    base: plan.baseSha256,
    metricsCfg: { metrics: JSON.stringify(plan.scoreCfg.metrics ?? plan.observe.metrics), score: JSON.stringify(plan.scoreCfg) },
    // 目标锚点用**实际生效**的那组数（intent 覆盖过 target 时，hash 必须跟着变，否则会和真实判据脱钩）
    target: sortObj(targetInfo.effective),
    pre: precheckRows.map((r) => [r.param, r.perturbed, r.dist, r.verdict]),
    evals: evals.map((e) => [e.seq, plan.wl.map((k) => r6(e.params[k])), r6(e.dist), e.pen ? 1 : 0]),
    best: { params: plan.wl.map((k) => r6(bestVec[k])), dist: r6(bestDist) },
    stop: stopReason,
  };
  const hash = sha256Text(JSON.stringify(sortObj(fp)));
  const elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(3));
  const endedAt = new Date().toISOString();
  const msPerEval = median(evals.map((e) => e.ms));
  const dropAbs = r6(startDist - bestDist);
  const dropPct = startDist ? Number(((dropAbs / startDist) * 100).toFixed(1)) : null;

  // 台帐 · finalize（哈希 + 清理结果）。
  // "cleanup" 在命令链路里是：证据包全落在 --out 下，**不写 adapter / clientRoot**；
  // 每次评估写的参数文件都在 <out>/params/（命令读它的副本），所以没有"跑完要还原"的东西 —— 这句话必须写进台帐，
  // 否则下一版的人会以为这里漏了。
  RUN_PHASE = 'finalize';
  const tFinalize = Date.now();
  ledger.add({
    node: 'finalize',
    status: 'done',
    producer: 'engine',
    ms: Date.now() - tFinalize,
    inputs: ['curve.csv 的评估序列', '决策指纹（seed/判据/白名单/预检/每点参数与距离/终止原因）'],
    decision: {
      why: '把"决定搜到哪"的东西规范化后取 sha256 当复验判据；换 --out 目录重跑 hash 必须一样',
      basis: [
        `hash=${hash}`,
        `终止 ${stopReason}${stopDetail ? ' — ' + stopDetail : ''}`,
        'cleanup：无（命令链路不碰 adapter 与基线，参数文件全在 <out>/params/，无需还原）',
        `评估 ${usage.used}/${args.budget}，用时 ${elapsedSec}s（单次 ${msPerEval}ms 中位数）`,
      ],
    },
    artifacts: ['curve.csv', 'best.json', 'report.md', 'outputs/', 'params/'],
    cost: { evals: usage.used, ms: Date.now() - t0 },
  });
  RUN_PHASE = '';

  // ---------------------------------------------------------------- curve.csv
  const hdr = ['round', 'eval_seq', 'id', 'note']
    .concat(plan.wl, ['dist', 'pen'])
    .concat(plan.observe.metricIds.map((id) => 'm:' + id))
    .concat(plan.observe.metricIds.map((id) => 'nd:' + id))
    .concat(['output']);
  const lines = [hdr.join(',')];
  for (const e of evals) {
    const row = [e.round, e.seq, e.id, e.note]
      .concat(plan.wl.map((k) => f6(e.params[k])))
      .concat([f6(e.dist), f6(e.pen)])
      .concat(plan.observe.metricIds.map((id) => f6(e.row[id])))
      .concat(plan.observe.metricIds.map((id) => f6(e.parts[id])))
      .concat([outputs.get(e.seq) ?? '']);
    lines.push(row.join(','));
  }
  writeFileSync(join(outDir, 'curve.csv'), lines.join('\n') + '\n', 'utf8');

  // ---------------------------------------------------------------- best.json
  const bestJson = {
    schema: 'cmd-iter/1',
    hash,
    hashOf:
      '决策指纹：目标锚点指标 / 指标与距离配置 / 命令与解析方式 / 种子与步长 / 白名单与起始值 / 基线参数文件 / 预检结果 / 每点参数与距离 / 终止原因。不含时间、路径、原始命令输出',
    metricIds: plan.observe.metricIds,
    metricsCfg: { metrics: plan.observe.metrics, score: plan.scoreCfg },
    target: targetInfo,
    observe: {
      type: plan.observe.type,
      cmd: plan.observe.cmdRaw,
      cwd: plan.observe.cwd,
      parse: plan.observe.parse,
      timeoutMs: plan.observe.timeoutMs,
    },
    // 观测稳定性闸（0.4.1）：repeat 次的指标原值 / 每条指标的 spread / 判定结论。
    // 这个字段缺席 = 这一步根本没跑（正常跑不会缺席，只有变异体 noStability 会）。
    ...(stability ? { stability } : {}),
    seed: args.seed,
    stepRatio: args.stepRatio,
    budget: args.budget,
    maxRounds: args.maxRounds,
    maxStagnant: args.maxStagnant,
    strategy: args.strategy,
    whitelist: plan.wl,
    dead,
    alive,
    startParams: baseParams,
    bestParams: bestVec,
    startDist: r6(startDist),
    bestDist: r6(bestDist),
    dropAbs,
    dropPct,
    stop: { reason: stopReason, detail: stopDetail },
    // 节点台帐（0.5.0）：机器读的那一份（每节点一条 <out>/nodes/NN-<node>.json，这里只做索引）
    nodes: {
      dir: 'nodes',
      counts: ledger.counts(),
      items: ledger.nodes.map((n) => ({ seq: n.seq, node: n.node, status: n.status, reason: n.reason })),
    },
    evaluations: usage,
    curve: evals.map((e) => {
      const o = {
        round: e.round,
        seq: e.seq,
        id: e.id,
        note: e.note,
        params: e.params,
        dist: r6(e.dist),
        pen: e.pen,
        parts: e.parts,
        pens: e.pens,
        output: outputs.get(e.seq) ?? '',
        ms: e.ms,
      };
      for (const id of plan.observe.metricIds) o['m_' + id] = r6(e.row[id]);
      return o;
    }),
    precheck: { rows: precheckRows },
    rounds: roundLog,
    meta: {
      adapter: plan.adapterFile,
      adapterName: plan.adapterName,
      baseFile: plan.baseFile,
      baseSha256: plan.baseSha256,
      outDir,
      startedAt,
      endedAt,
      elapsedSec,
      msPerEval,
      outputCapBytes: OUTPUT_CAP_BYTES,
      mutant: MUTANT,
      command: reproduceCommand(args),
    },
  };
  writeFileSync(join(outDir, 'best.json'), JSON.stringify(bestJson, null, 2), 'utf8');

  // ---------------------------------------------------------------- report.md
  writeFileSync(join(outDir, 'report.md'), buildReport({ plan, args, evals, precheckRows, alive, dead, roundLog, startDist, bestDist, bestVec, baseParams, dropPct, dropAbs, usage, stopReason, stopDetail, hash, trow, targetInfo, elapsedSec, msPerEval, outputs, outDir, startedAt, endedAt, stability, stabCfg, nodes: ledger.nodes }), 'utf8');

  const summary = `HASH ${hash}\nstart=${r6(startDist)} best=${r6(bestDist)} drop=${dropPct === null ? 'n/a' : dropPct + '%'} stability=${stability ? (stability.checked ? 'ok' : 'off') : 'skipped'} stop=${stopReason} used=${usage.used}/${args.budget} elapsed=${elapsedSec}s nodes=${ledger.nodes.length}`;
  log(summary);
  return { hash, startDist, bestDist, dropPct, stopReason, usage, elapsedSec, outDir, plan, evals, precheckRows, alive, dead, bestJson, nodes: ledger.nodes };
}

function reproduceCommand(args) {
  const parts = [
    'node harness/cmdloop.mjs',
    `--adapter "${args.adapter}"`,
    `--out "${args.out}"`,
    `--budget ${args.budget}`,
    `--seed ${args.seed}`,
    `--step-ratio ${args.stepRatio}`,
    `--max-rounds ${args.maxRounds}`,
    `--max-stagnant ${args.maxStagnant}`,
    `--strategy ${args.strategy}`,
  ];
  if (args.params) parts.push(`--params ${args.params}`);
  // 复现命令里必须带上这道闸的选择：不带的话重跑的判据来源和这次不一样（--no-intent 与 intent 是两种 run）
  if (args.noIntent) parts.push('--no-intent');
  else if (args.intent) parts.push(`--intent "${args.intent}"`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- report.md（结构与 iter.ps1 的证据包同构）
function buildReport(ctx) {
  const {
    plan, args, evals, precheckRows, alive, dead, roundLog, startDist, bestDist, bestVec, baseParams,
    dropPct, dropAbs, usage, stopReason, stopDetail, hash, trow, targetInfo, elapsedSec, msPerEval, outDir, startedAt, endedAt,
    stability, nodes,
  } = ctx;
  const WL = plan.wl;
  const MID = plan.observe.metricIds;
  const SPARK = '▁▂▃▄▅▆▇█';
  const spark = (vals) => {
    const v = vals.filter((x) => Number.isFinite(x));
    if (!v.length) return '';
    const mn = Math.min(...v);
    const mx = Math.max(...v);
    return v
      .map((x) => (mx - mn < 1e-12 ? SPARK[3] : SPARK[Math.round(((x - mn) / (mx - mn)) * (SPARK.length - 1))]))
      .join('');
  };
  const deadRows = precheckRows.filter((r) => r.verdict !== 'alive');

  // 每轮的行（照抄 finalize.js 的 roundRows 口径：优先用驱动写的 rounds 日志）
  const seqMap = new Map(evals.map((e) => [e.seq, e]));
  const roundRows = roundLog
    .map((r) => {
      const cands = r.cands.map((c) => ({ note: c.note, e: seqMap.get(c.seq) })).filter((c) => c.e);
      const fallback = cands.find((c) => c.note === 'none') || cands[cands.length - 1];
      const win = seqMap.get(r.winner) || (fallback && fallback.e);
      const wc = win ? cands.find((c) => c.e.seq === win.seq) : null;
      return { round: r.round, cands, win, winNote: wc ? wc.note : win ? win.note : '' };
    })
    .filter((r) => r.win);

  const conclusion = (() => {
    if (stopReason === 'all-dead') {
      return `白名单 ${WL.length} 个参数**全部 dead**（改一档距离一点不动），预检阶段就终止，一次搜索都没跑 —— 「在空轴上转到底」被挡住。`;
    }
    if (stopReason === 'no-alive-after-precheck') return '白名单没有一个活参数，预检后终止。';
    const deadTxt = deadRows.length ? `其中 ${deadRows.length} 个标 dead 已跳过` : '白名单全活';
    return `距离 **${d4(startDist)} → ${d4(bestDist)}**（降 **${dropPct === null ? 'n/a' : dropPct + '%'}**），${roundRows.length} 轮 / ${usage.used} 次评估，终止原因 \`${stopReason}\`；${deadTxt}。`;
  })();

  const md = [];
  // 稳定性闸的一句话结论（表格行 + 专门那一节都要用）
  const stabWorst = stability
    ? MID.map((id) => stability.spreads[id]).filter((s) => Number.isFinite(s)).reduce((a, b) => Math.max(a, b), -Infinity)
    : null;
  const stabWorstTxt = Number.isFinite(stabWorst) ? Number(stabWorst).toFixed(6) : 'n/a';
  const stabLine = !stability
    ? '**没有这一步**（整段被跳过，执行器被动过？）'
    : !stability.checked
      ? '**未验证**：`observe.stability.repeat=1` 显式关闭（命令若有随机性，本次"最优"不可信）'
      : '`repeat=' + stability.repeat + '` · `maxSpread=' + stability.maxSpread + '` · **通过**（额外花 ' + stability.spend + ' 次评估，最差指标 spread ' + stabWorstTxt + '）';
  const stabBlock = [];
  // 整段没跑（只有变异体）→ 报告里连标题都不留：证据包里"看不出这一步跑过"，正是没这道闸时的样子
  if (stability) {
    stabBlock.push('## 观测稳定性闸（搜索前必过）');
    stabBlock.push('');
    if (!stability.checked) {
      stabBlock.push(
        '**未验证**：`observe.stability.repeat=1` 显式关掉了检查。命令只要有随机性（时间戳 / 并发 / 浮点不确定性 / 真实接口抖动），这个 run 的"最优"就是噪声里的偶然点，不能当结论。',
      );
      stabBlock.push('');
    } else {
      stabBlock.push(
        '口径与截图链路的 `freeze.verify=strict`（同一个 URL 连拍两张、逐字节比）同构：**用起点参数把命令连跑 ' +
          stability.repeat +
          ' 次**（起点那一次算第 1 次采样，额外花 ' +
          stability.spend +
          ' 次评估、**已记进预算**），对每条指标算相对离散度 `spread=(max-min)/max(|mean|,1e-9)`；任一超过 `maxSpread=' +
          stability.maxSpread +
          '` 就硬错（不降级、不自动取平均）。',
      );
      stabBlock.push('');
      const heads = Array.from({ length: stability.repeat }, (_, i) => '第 ' + (i + 1) + ' 次');
      stabBlock.push('| 指标 | ' + heads.join(' | ') + ' | spread | 上限 | 判定 |');
      stabBlock.push('|---|' + heads.map(() => '---').join('|') + '|---|---|---|');
      for (const id of MID) {
        const vals = stability.values[id] ?? [];
        const cells = heads.map((_, i) => num(vals[i]));
        const sp = stability.spreads[id];
        stabBlock.push(
          '| `' + id + '` | ' + cells.join(' | ') + ' | ' + (sp === null || sp === undefined ? 'n/a' : Number(sp).toFixed(6)) + ' | ' + stability.maxSpread + ' | ' + (stability.okById[id] ? '通过' : '**超阈值**') + ' |',
        );
      }
      stabBlock.push('');
      stabBlock.push('**结论：通过**（最差指标 spread ' + stabWorstTxt + ' ≤ ' + stability.maxSpread + '）。后面的每一条"变好/变差"都落在这个抖动之上，至少能说清"不是噪声"。');
      stabBlock.push('');
    }
  }
  md.push('# 命令观测 · 参数搜索证据包');
  md.push('');
  md.push(`**run hash: \`${hash}\`**`);
  md.push('');
  // 节点台帐汇总（0.5.0）：一行数字 + 每条被跳过/被降级的原因。
  // 这是"哪些节点被绕过"的唯一答案 —— 以前它散在日志里，等于没有。
  md.push(...summaryLines(nodes || []));
  md.push('');
  md.push('> ' + conclusion);
  md.push('');
  md.push('| 项 | 值 |');
  md.push('|---|---|');
  md.push(
    '| 观测来源 | `command` — `' + plan.observe.cmdRaw + '`（parse=' + plan.observe.parse + '，timeout=' + plan.observe.timeoutMs + 'ms） |',
  );
  md.push('| 观测稳定性 | ' + stabLine + ' |');
  md.push(
    '| 目标 | ' +
      (targetInfo.kind === 'metrics'
        ? '目标数值 `' + JSON.stringify(targetInfo.spec) + '`（不跑命令）'
        : '目标参数 `' + JSON.stringify(targetInfo.spec) + '`（跑一次命令取指标）') +
      ' |',
  );
  md.push('| 白名单 | `' + WL.join(' / ') + '` |');
  md.push('| 指标组 | `' + JSON.stringify(plan.observe.metrics) + '` |');
  md.push('| 距离口径 | `' + JSON.stringify(plan.scoreCfg) + '`（score.js 的 l1：Σ(nd×w)/Σw + Σpenalty） |');
  md.push('| 基线参数文件 | `' + plan.baseFile + '`' + (plan.baseSha256 ? ' sha256=`' + plan.baseSha256.slice(0, 16) + '…`' : '') + ' |');
  md.push('| 起始 / 最佳距离 | ' + d4(startDist) + ' / **' + d4(bestDist) + '** |');
  md.push('| 降幅 | **' + (dropPct === null ? 'n/a' : dropPct.toFixed(1) + '%') + '**（绝对 ' + d4(dropAbs) + '） |');
  md.push(
    '| 评估次数 | **' + usage.used + ' / 上限 ' + args.budget + '**（目标 ' + usage.target + ' + 起点 ' + usage.start + ' + 稳定性 ' + usage.stability + ' + 预检 ' + usage.precheck + ' + 搜索 ' + usage.search + '，缓存命中 ' + usage.cache + '） |',
  );
  md.push('| 终止原因 | `' + stopReason + '`' + (stopDetail ? ' — ' + stopDetail : '') + ' |');
  md.push('| 搜索策略 | `' + args.strategy + '`（步长 ±' + args.stepRatio * 100 + '%，maxRounds ' + args.maxRounds + ' / maxStagnant ' + args.maxStagnant + '） |');
  md.push('| 种子 | `' + args.seed + '` |');
  md.push('| 总耗时 | ' + elapsedSec + 's（单次评估 ' + msPerEval + 'ms 中位数） |');
  md.push('');
  md.push(...stabBlock);
  md.push('## 1. 参数活性预检');
  md.push('');
  md.push('口径与 `iter.ps1` §5.3 一致：对每个参数在起始点基础上 +1 步，与起点比 `Δd`。`Δd==0` → `dead`（`输出同` 列说明是"命令输出逐字节相同"还是"输出变了但判据没动"）。');
  md.push('');
  md.push('| 参数 | 起始值 | 扰动值 | 该点距离 | Δd | 输出同 | 判定 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const r of precheckRows) {
    md.push(
      `| \`${r.param}\` | ${num(r.start)} | ${num(r.perturbed)} | ${d4(r.dist)} | ${r.dDelta === 0 ? '0' : f6(r.dDelta)} | ${r.outputSame ? '是' : '否'} | ${r.verdict === 'alive' ? '活' : '**dead**'} |`,
    );
  }
  md.push('');
  if (deadRows.length) md.push('**dead: `' + deadRows.map((r) => r.param).join('`, `') + '`** —— 已从搜索轴里剔除，不花预算。');
  else md.push('**预检结果：白名单全活。**');
  md.push('');
  md.push('## 2. 距离曲线（文字版）');
  md.push('');
  if (!roundRows.length) {
    md.push('**本次没有搜索轮次**（' + stopReason + '）—— 只有起始点 `d=' + d4(startDist) + '`。');
    md.push('');
  } else {
    md.push('每轮最优点：`' + spark(roundRows.map((r) => r.win.dist)) + '`（左=第 1 轮，右=最后一轮，越低越好）');
    md.push('');
    if (args.strategy === 'coordinate') {
      md.push('| 轮 | 起点 d | ' + WL.map((k) => '`' + k + '`−').join(' | ') + ' | ' + WL.map((k) => '`' + k + '`+').join(' | ') + ' | 胜出 | 本轮 d |');
      md.push('|---|---|' + WL.map(() => '---').join('|') + '|' + WL.map(() => '---').join('|') + '|---|---|');
      for (const rr of roundRows) {
        const byNote = {};
        let noneE = null;
        for (const c of rr.cands) {
          byNote[c.note] = c.e;
          if (c.note === 'none') noneE = c.e;
        }
        const cells = [];
        for (const k of WL) {
          const e = byNote[k + '-'];
          cells.push(e ? (rr.winNote === k + '-' ? '**' + d4(e.dist) + '**' : d4(e.dist)) : '·');
        }
        for (const k of WL) {
          const e = byNote[k + '+'];
          cells.push(e ? (rr.winNote === k + '+' ? '**' + d4(e.dist) + '**' : d4(e.dist)) : '·');
        }
        md.push('| ' + rr.round + ' | ' + d4(noneE ? noneE.dist : rr.win.dist) + ' | ' + cells.join(' | ') + ' | `' + (rr.winNote === 'none' ? 'none（无改进）' : rr.winNote) + '` | ' + d4(rr.win.dist) + ' |');
      }
    } else {
      const seen = [];
      for (const rr of roundRows) for (const c of rr.cands) if (!seen.includes(c.note)) seen.push(c.note);
      md.push('| 轮 | 起点 d | ' + seen.map((n) => '`' + n + '`').join(' | ') + ' | 胜出 | 本轮 d |');
      md.push('|---|---|' + seen.map(() => '---').join('|') + '|---|---|');
      for (const rr of roundRows) {
        const byNote = {};
        for (const c of rr.cands) byNote[c.note] = c.e;
        const noneE = byNote['none'];
        const cells = seen.map((n) => {
          const e = byNote[n];
          return e ? (rr.winNote === n ? '**' + d4(e.dist) + '**' : d4(e.dist)) : '·';
        });
        md.push('| ' + rr.round + ' | ' + d4(noneE ? noneE.dist : rr.win.dist) + ' | ' + cells.join(' | ') + ' | `' + (rr.winNote === 'none' ? 'none（无改进）' : rr.winNote) + '` | ' + d4(rr.win.dist) + ' |');
      }
    }
    md.push('');
    md.push('（`none` = 本轮起点，多数是上一轮胜出点，命中缓存不重复评估；加粗 = 本轮胜出方向；`·` = 预算先花完了没评到。）');
    md.push('');
    md.push('## 3. 参数轨迹');
    md.push('');
    md.push('| 轮 | ' + WL.map((k) => '`' + k + '`').join(' | ') + ' | d | ' + MID.map((id) => '`' + id + '`').join(' | ') + ' |');
    md.push('|---|' + WL.map(() => '---').join('|') + '|---|' + MID.map(() => '---').join('|') + '|');
    for (const rr of roundRows) md.push('| ' + rr.round + ' | ' + WL.map((k) => num(rr.win.params[k])).join(' | ') + ' | **' + d4(rr.win.dist) + '** | ' + MID.map((id) => num(rr.win.row[id])).join(' | ') + ' |');
    md.push('');
  }
  md.push('## 4. 证据包清单');
  md.push('');
  md.push('| 文件 | 内容 |');
  md.push('|---|---|');
  md.push('| `curve.csv` | 每个评估点一行（' + evals.length + ' 行）：轮次 / 参数 / 距离 / 评估序号 / 指标与归一化分量 / 原始输出路径 |');
  md.push('| `best.json` | 最佳参数 + 距离 + 降幅 + `hash` + 全轨迹 + 预检 + 元信息 |');
  md.push('| `outputs/` | 每次评估的**原始命令输出**（stdout / stderr / argv / 指标 / 距离），单份截断到 ' + OUTPUT_CAP_BYTES + ' 字节 |');
  md.push('| `params/` | 每次评估交给命令的参数文件（`{params}` 占位 / `SELFLOOP_PARAMS` 指向的就是它） |');
  md.push('| `report.md` | 本文件 |');
  md.push('');
  md.push('## 5. 复现');
  md.push('');
  md.push('```bash');
  md.push(reproduceCommand(args));
  md.push('```');
  md.push('');
  md.push('同 `--seed` 同参数再跑一次（**换一个 --out 目录也行**），`best.json` 里的 `hash` 必须与本文件顶部一致 —— 这个 hash 就是判据。');
  md.push('');
  md.push('## 6. 已知限制（本工具内置，别当 bug）');
  md.push('');
  md.push('- **单步单轴**：坐标下降每轮每参数只试 −一步 / +一步，局部极小之后走不出来。要越过去得换策略（`--strategy random` 已实现）。');
  md.push('- **random 策略不跨执行器可比**：`cmdloop.mjs` 用自己的伪随机（`iter.ps1` 是 .NET `[Random]`），同 seed 只在同一个执行器里可复现；`coordinate` 两边口径一致。');
  md.push('- **只认标量指标**：命令输出里取到的必须是数（数组型指标要 metrics2.js 的提取器，那是浏览器链路）。');
  md.push('- **判据只做粗筛**：它能把候选排序、把坏掉的报警；"这个数好不好"不能问它。');
  md.push('- **命令必须是确定性的**：同一个参数跑两次给不同的数，那就不是观测、是噪声。0.4.1 起**先验一遍再搜**（观测稳定性闸：起点参数连跑 `observe.stability.repeat` 次，任一指标相对离散度 > `maxSpread` 就硬错），比"跑完再解释为什么结果怪"省事得多。');
  md.push('- **稳定性闸只看"同一个参数重复跑"**：它证明观测可重复，不证明**判据**本身有意义；而且相对离散度在指标接近 0 时会放大（分母兜底 1e-9），0 附近的指标请自己看一眼 spread 的绝对值。');
  md.push('- **本次统计**：' + evals.length + ' 个评估点，`outputs/` ' + ctx.outputs.size + ' 份原始输出。');
  md.push('');
  md.push(`生成时间：${ctx.startedAt} → ${ctx.endedAt}；输出目录：\`${ctx.outDir}\`。`);
  md.push('');
  return md.join('\n');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message));
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  try {
    run(args);
  } catch (e) {
    // 硬错也要留痕：台帐里补一条 failed 节点，写清是哪一步炸的。
    // 没有它的话，"这次跑到哪一步断的"只存在于终端最后几行，run 目录里看不出来。
    const msg = String(e?.message ?? e);
    if (RUN_LEDGER && RUN_PHASE) {
      try {
        RUN_LEDGER.add({
          node: RUN_PHASE,
          status: 'failed',
          producer: 'engine',
          ms: null,
          inputs: [],
          decision: { why: msg.split('\n')[0].slice(0, 200), basis: msg.split('\n').slice(0, 8).map((s) => s.trim()) },
          artifacts: [],
          cost: {},
          reason: msg,
        });
      } catch {
        // 台帐写不进去不能盖掉真正的错误（那才是用户要看的那句中文）
      }
    }
    // 失败要响：中文原因 + 非零退出码（绝不给一个"跑了但其实没测"的 0）
    console.error(msg);
    process.exit(1);
  }
}

// 直接执行才跑 main()；被 test/ 或别的脚本 import 时只导出（parseArgs / run 给测试用）
const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { run, parseArgs, buildReport };
