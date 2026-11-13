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
//
// 产出（--out 下）：curve.csv / best.json / report.md / params\ / outputs\
'use strict';

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MUTANT,
  OUTPUT_CAP_BYTES,
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
  --help              这份说明

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
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--help' || k === '-h') {
      a.help = true;
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

  const log = (s) => console.log(s);

  log(`[init] adapter=${plan.adapterName || '(未命名)'}  ${adapterFile}`);
  log(`[init] 命令观测：parse=${plan.observe.parse}  timeout=${plan.observe.timeoutMs}ms  cmd=${plan.observe.cmdRaw}`);
  log(`[init] 参数文件基线=${plan.baseFile}${plan.baseFile && existsSync(plan.baseFile) ? '' : '（不在！白名单只能用 name=值 形式）'}`);
  log(`[init] 白名单 ${plan.wl.length} 个: ${plan.wl.map((k) => k + '=' + plan.startParams[k]).join('  ')}`);
  log(`[init] 判据 ${plan.scoreText}`);
  log(`[init] Out=${outDir}  budget=${args.budget} seed=${args.seed} step=${args.stepRatio * 100}% strategy=${args.strategy}`);

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

  // ---------------------------------------------------------------- 起点
  const startGot = evaluateCached(plan.startParams, { id: 'e001', round: 0, note: 'start', phase: 'start' });
  if (!startGot) throw new Error('预算太小：起点都没跑成（--budget 至少 1）');
  const startRec = evals[startGot.seq - 1];
  const startDist = startRec.dist;
  const baseParams = { ...plan.startParams };
  log(`[start] d=${startDist.toFixed(4)}  ${keyOf(baseParams, plan.wl)}`);

  // ---------------------------------------------------------------- 观测稳定性闸（0.4.1）
  // 位置有讲究：起点已评估（它那一次就是第 1 次采样）→ **活性预检之前**（噪声会把参数误判成 dead/alive，
  // 判错了这个参数就再也进不了搜索轴）→ 一定在花预算的搜索之前。
  // 截图链路的等价物是 freeze.verify=strict（同 URL 连拍两张逐字节比）；命令链路原来什么都没有，这是最大的洞。
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

  // ---------------------------------------------------------------- 活性预检（照抄 iter.ps1 §5.3）
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

  // ---------------------------------------------------------------- 搜索（照抄 iter.ps1 §5.4 的坐标下降）
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
    target: targetInfo.kind === 'metrics' ? sortObj(targetInfo.spec) : plan.observe.metricIds.reduce((o, id) => ((o[id] = r6(trow[id])), o), {}),
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
  writeFileSync(join(outDir, 'report.md'), buildReport({ plan, args, evals, precheckRows, alive, dead, roundLog, startDist, bestDist, bestVec, baseParams, dropPct, dropAbs, usage, stopReason, stopDetail, hash, trow, targetInfo, elapsedSec, msPerEval, outputs, outDir, startedAt, endedAt, stability, stabCfg }), 'utf8');

  const summary = `HASH ${hash}\nstart=${r6(startDist)} best=${r6(bestDist)} drop=${dropPct === null ? 'n/a' : dropPct + '%'} stability=${stability ? (stability.checked ? 'ok' : 'off') : 'skipped'} stop=${stopReason} used=${usage.used}/${args.budget} elapsed=${elapsedSec}s`;
  log(summary);
  return { hash, startDist, bestDist, dropPct, stopReason, usage, elapsedSec, outDir, plan, evals, precheckRows, alive, dead, bestJson };
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
  return parts.join(' ');
}

// ---------------------------------------------------------------- report.md（结构与 iter.ps1 的证据包同构）
function buildReport(ctx) {
  const {
    plan, args, evals, precheckRows, alive, dead, roundLog, startDist, bestDist, bestVec, baseParams,
    dropPct, dropAbs, usage, stopReason, stopDetail, hash, trow, targetInfo, elapsedSec, msPerEval, outDir, startedAt, endedAt,
    stability,
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
    // 失败要响：中文原因 + 非零退出码（绝不给一个"跑了但其实没测"的 0）
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}

// 直接执行才跑 main()；被 test/ 或别的脚本 import 时只导出（parseArgs / run 给测试用）
const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { run, parseArgs, buildReport };
