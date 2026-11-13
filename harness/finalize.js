// T3 迭代器 · 收尾：把 _run.json（PS 驱动写的原始轨迹）变成标准证据包
//   curve.csv   每轮每候选一行：轮次 / 参数 / 距离 / 评估序号
//   best.json   最佳参数 + 最终距离 + 起始距离 + 降幅 + 可复现 hash
//   report.md   自动生成：一句话结论 + 曲线文字版 + 参数轨迹 + 图路径
//
// 用法：node finalize.js <run.json> <outDir>
//
// 关于 hash（可复现判据）：
//   hash = sha256(canonical JSON of 决策指纹)，指纹里**只放决定结果的东西**：
//   seed / 冻结时刻 / 视口 / 画质档 / 策略 / 步长 / 预算 / 白名单 / 基线指纹 /
//   目标规格 / 起始参数 / 预检结果 / 每个评估点的参数与距离（保留 6 位小数）/ 终止原因。
//   刻意**不放**：时间戳、耗时、命令行、绝对路径、png 字节 —— 那些不影响"搜到哪"。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [runPath, outDir] = process.argv.slice(2);
if (!runPath || !outDir) { console.error('用法: node finalize.js <run.json> <outDir>'); process.exit(2); }
const B = JSON.parse(fs.readFileSync(runPath, 'utf8'));
const M = B.meta;
const WL = M.whitelist;
// 指标组来自 adapter（P2.5）：老 run.json 没有 metricIds 时退回火柱那套列名，只为让旧证据包还能生成
const MID = (Array.isArray(M.metricIds) && M.metricIds.length) ? M.metricIds : ['cov', 'lapVar', 'tone'];
const metricOf = (e, id) => (e.mvals && e.mvals[id] !== undefined && e.mvals[id] !== null) ? e.mvals[id] : null;
const ndOf = (e, id) => (e.parts && e.parts[id] !== undefined && e.parts[id] !== null) ? e.parts[id] : null;

function r6(v) { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(6)) : null; }
function sortObj(o) {
    if (Array.isArray(o)) return o.map(sortObj);
    if (o && typeof o === 'object') {
        const r = {};
        for (const k of Object.keys(o).sort()) r[k] = sortObj(o[k]);
        return r;
    }
    return o;
}
function pv(params) { // 按白名单顺序取值，输出数组（顺序本身是身份的一部分）
    return WL.map((k) => r6(params[k]));
}
function f6(v) { const n = Number(v); return Number.isFinite(n) ? n.toFixed(6) : ''; }
function d4(v) { const n = Number(v); return Number.isFinite(n) ? n.toFixed(4) : ''; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? String(parseFloat(n.toFixed(4))) : ''; }
// 直方图类指标（hueHist）的值是数组：r6/num 会把它变成 null/空串，报告里就看不见了。
// run.json 留原数组（谁要复算谁自己算距离），报告表格里只标桶数——18 个数塞不进一格。
function metricCell(v) { return Array.isArray(v) ? '[' + v.length + '桶]' : num(v); }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function padL(s, n) { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; }

const start = r6(B.startDist);
const best = r6(B.best.dist);
const dropAbs = Number.isFinite(start) && Number.isFinite(best) ? start - best : null;
const dropPct = Number.isFinite(dropAbs) && start ? +(dropAbs / start * 100).toFixed(1) : null;

// ---------- 决策指纹 -> hash ----------
// P2.5：目标锚点 = 配置里声明的那几个指标（不是写死的 prof/lap/warm）；
//       指标与距离的**配置本身**也进指纹 —— 换配置必须换 hash，否则"只改配置"这件事在证据里看不见。
const targetAnchor = {};
for (const id of MID) targetAnchor[id] = r6((B.target.metrics || {})[id]);
const fp = {
    v: 't3-iter/2',
    seed: M.seed, t: M.t, stepN: M.stepN, stepMs: M.stepMs,
    w: M.w, h: M.h, tier: M.tier, effect: M.effect, block: M.block,
    strategy: M.strategy, stepRatio: r6(M.stepRatio), budget: M.budget,
    whitelist: WL.map((k) => k + ':' + r6(B.startParams[k])),
    base: M.baseSha256,
    metricsCfg: { metrics: M.metricsJson || '', score: M.scoreJson || '' },
    // 目标只取"搜索实际看得到的东西"= 锚点指标。所以 png 目标和渲染出来的 json 目标会得到同一个 hash
    // （证明两条目标路径等价）；换目标帧就会变。
    target: targetAnchor,
    pre: B.precheck.rows.map((r) => [r.param, r6(r.perturbed), r6(r.dist), r.verdict]),
    evals: B.evals.map((e) => [e.seq, pv(e.params), r6(e.dist), e.pen ? 1 : 0]),
    best: { params: pv(B.best.params), dist: best },
    stop: B.stop.reason
};
const hash = crypto.createHash('sha256').update(JSON.stringify(sortObj(fp)), 'utf8').digest('hex');

// ---------- curve.csv ----------
const hdr = ['round', 'eval_seq', 'id', 'note'].concat(WL, ['dist', 'pen'])
    .concat(MID.map((id) => 'm:' + id))
    .concat(MID.map((id) => 'nd:' + id))
    .concat(['png']);
const lines = [hdr.join(',')];
for (const e of B.evals) {
    const rel = path.relative(outDir, e.png);
    const row = [e.round, e.seq, e.id, e.note]
        .concat(WL.map((k) => f6(e.params[k])), [f6(e.dist), f6(e.pen)])
        .concat(MID.map((id) => f6(metricOf(e, id))))
        .concat(MID.map((id) => f6(ndOf(e, id))))
        .concat([rel]);
    lines.push(row.join(','));
}
fs.writeFileSync(path.join(outDir, 'curve.csv'), lines.join('\n') + '\n', 'utf8');

// ---------- best.json ----------
const bestJson = {
    schema: 't3-iter/2',
    hash,
    hashOf: '决策指纹：目标锚点指标（配置里声明的那些）/ 指标与距离配置 / 种子与冻结相位 / 白名单与起始值 / 基线 vfx.json / 预检结果 / 每点参数与距离 / 终止原因。不含时间、路径、图片字节',
    metricIds: MID,
    metricsCfg: { metrics: M.metricsJson || '', score: M.scoreJson || '' },
    target: B.target,
    seed: M.seed, t: M.t, stepN: M.stepN, stepMs: M.stepMs,
    w: M.w, h: M.h, tier: M.tier,
    effect: M.effect, block: M.block,
    strategy: M.strategy, stepRatio: M.stepRatio, budget: M.budget,
    whitelist: WL, dead: B.dead, alive: B.alive,
    startParams: B.startParams,
    bestParams: B.best.params,
    startDist: start,
    bestDist: best,
    dropAbs: dropAbs === null ? null : r6(dropAbs),
    dropPct,
    stop: B.stop,
    evaluations: B.usage,
    bestPng: B.best.png,
    targetPng: B.target.png,
    curve: B.evals.map((e) => {
        const o = {
            round: e.round, seq: e.seq, id: e.id, note: e.note,
            params: e.params, dist: r6(e.dist), pen: e.pen,
            mvals: e.mvals || null, parts: e.parts || null
        };
        for (const id of MID) {
            const v = metricOf(e, id);
            o['m_' + id] = Array.isArray(v) ? v : r6(v);
        }
        for (const id of MID) o['nd_' + id] = r6(ndOf(e, id));
        return o;
    }),
    precheck: B.precheck,
    meta: {
        command: M.command, url: M.url, mirror: M.mirror, mirrorJson: M.mirrorJson,
        baseSha256: M.baseSha256, mirrorShaBefore: M.mirrorShaBefore, mirrorShaAfter: M.mirrorShaAfter,
        bodyShaBefore: M.bodyShaBefore, bodyShaAfter: M.bodyShaAfter,
        startedAt: M.startedAt, endedAt: M.endedAt, elapsedSec: M.elapsedSec, msPerEval: M.msPerEval,
        metricsJs: M.metricsJs, toolDir: M.toolDir
    }
};
fs.writeFileSync(path.join(outDir, 'best.json'), JSON.stringify(bestJson, null, 2), 'utf8');

// ---------- report.md ----------
const SPARK = '▁▂▃▄▅▆▇█';
function spark(vals) {
    const v = vals.filter((x) => Number.isFinite(x));
    if (!v.length) return '';
    const mn = Math.min(...v), mx = Math.max(...v);
    return v.map((x) => {
        if (mx - mn < 1e-12) return SPARK[3];
        const i = Math.round((x - mn) / (mx - mn) * (SPARK.length - 1));
        return SPARK[i];
    }).join('');
}

// 每轮的行：优先用驱动写的 rounds 日志（含缓存命中的候选），否则退回按 eval.round 分组
const seqMap = new Map(B.evals.map((e) => [e.seq, e]));
const roundRows = (() => {
    if (Array.isArray(B.rounds) && B.rounds.length) {
        return B.rounds.map((r) => {
            const cands = r.cands.map((c) => ({ note: c.note, e: seqMap.get(c.seq) })).filter((c) => c.e);
            const fallback = (cands.find((c) => c.note === 'none') || cands[cands.length - 1]);
            const win = seqMap.get(r.winner) || (fallback && fallback.e);
            const wc = win ? cands.find((c) => c.e.seq === win.seq) : null;
            return { round: r.round, cands, win, winNote: (wc ? wc.note : (win ? win.note : '')) };
        }).filter((r) => r.win);
    }
    const byRound = new Map();
    for (const e of B.evals) {
        if (e.round > 0) {
            if (!byRound.has(e.round)) byRound.set(e.round, []);
            byRound.get(e.round).push(e);
        }
    }
    return [...byRound.keys()].sort((a, b) => a - b).map((rd) => {
        const arr = byRound.get(rd);
        const win = arr.reduce((p, c) => (c.dist < p.dist ? c : p), arr[0]);
        return { round: rd, cands: arr.map((e) => ({ note: e.note, e })), win, winNote: win.note };
    });
})();

const deadRows = B.precheck.rows.filter((r) => r.verdict !== 'alive');
const conclusion = (() => {
    if (B.stop.reason === 'all-dead') {
        return `白名单 ${WL.length} 个参数**全部 dead**（改一档距离一点不动），预检阶段就终止，一次搜索都没跑 —— E2 挖的坑（在空轴上转到底）被挡住。`;
    }
    if (B.stop.reason === 'no-alive-after-precheck') {
        return `白名单没有一个活参数，预检后终止。`;
    }
    const deadTxt = deadRows.length ? `其中 ${deadRows.length} 个标 dead 已跳过` : '白名单全活';
    return `距离 **${start.toFixed(4)} → ${best.toFixed(4)}**（降 **${dropPct.toFixed(1)}%**），`
        + `${roundRows.length} 轮 / ${B.usage.used} 次评估，终止原因 \`${B.stop.reason}\`；${deadTxt}。`;
})();

const md = [];
md.push('# T3 迭代器 · 参数搜索证据包');
md.push('');
md.push('**run hash: `' + hash + '`**');
md.push('');
md.push('> ' + conclusion);
md.push('');
md.push('| 项 | 值 |');
md.push('|---|---|');
md.push('| 目标 | ' + (B.target.kind === 'json' ? '参数 `' + JSON.stringify(B.target.spec) + '`（内部渲染成目标帧）' : '帧 `' + path.basename(B.target.src || 'png') + '`') + ' |');
md.push('| 白名单 | `' + WL.join(' / ') + '` |');
md.push('| 指标组（来自 adapter） | `' + (M.metricsJson || '(老证据包，未记录)') + '` |');
md.push('| 距离口径 | `' + (M.scoreJson || '(老证据包，未记录)') + '` |');
md.push('| 相位锁 | seed=' + M.seed + '，t=' + M.t + 'ms（step(' + M.stepN + ',' + M.stepMs + ')），' + M.w + '×' + M.h + '，tier=' + M.tier + ' |');
md.push('| 基线 vfx.json | `' + M.baseSha256.slice(0, 16) + '…` |');
md.push('| 起始 / 最佳距离 | ' + d4(start) + ' / **' + d4(best) + '** |');
md.push('| 降幅 | **' + dropPct.toFixed(1) + '%** |');
md.push('| 评估次数 | **' + B.usage.used + ' / 上限 ' + M.budget + '**（目标帧 ' + B.usage.target + ' + 起始帧 ' + (B.usage.start || 0) + ' + 预检 ' + B.usage.precheck + ' + 搜索 ' + B.usage.search + '，缓存命中 ' + B.usage.cache + '） |');
md.push('| 终止原因 | `' + B.stop.reason + '`' + (B.stop.detail ? ' — ' + B.stop.detail : '') + ' |');
md.push('| 搜索策略 | `' + M.strategy + '`（步长 ±' + (M.stepRatio * 100) + '%） |');
md.push('| 总耗时 | ' + M.elapsedSec + 's（单次评估 ' + M.msPerEval + 'ms 中位数） |');
md.push('');
md.push('## 1. 参数活性预检（E2 的坑：不预检会在空轴上转到底）');
md.push('');
md.push('口径：对每个参数在起始点基础上改一档（+步长），与起始帧比 `Δd`。`Δd==0` → `dead`（`像素同` 列说明是"真的没成像差异"还是"成像变了但距离没动"）。');
md.push('');
md.push('| 参数 | 起始值 | 扰动值 | 该点距离 | Δd | 像素同 | 判定 |');
md.push('|---|---|---|---|---|---|---|');
for (const r of B.precheck.rows) {
    md.push('| `' + r.param + '` | ' + num(r.start) + ' | ' + num(r.perturbed) + ' | ' + d4(r.dist) + ' | ' + (r.dDelta === 0 ? '0' : f6(r.dDelta)) + ' | ' + (r.pixelSame ? '是' : '否') + ' | ' + (r.verdict === 'alive' ? '活' : '**dead**') + ' |');
}
md.push('');
if (deadRows.length) {
    md.push('**dead: `' + deadRows.map((r) => r.param).join('`, `') + '`** —— 已从搜索轴里剔除，不花预算。');
} else {
    md.push('**预检结果：白名单全活。**');
}
md.push('');
md.push('## 2. 距离曲线（文字版）');
md.push('');
if (!roundRows.length) {
    md.push('**本次没有搜索轮次**（' + B.stop.reason + '）—— 只有起始帧 `d=' + d4(start) + '`。');
    md.push('');
    md.push('## 3. 参数轨迹');
    md.push('');
    md.push('（无：没有搜索轮次，起始参数即最佳参数）');
    md.push('');
} else {
md.push('每轮最优点：`' + spark(roundRows.map((r) => r.win.dist)) + '`（左=第 1 轮，右=最后一轮，越低越好）');
md.push('');
if (M.strategy !== 'coordinate') {
    // 非坐标下降：候选没有"轴±"语义，按候选序号出表
    const seen = [];
    for (const rr of roundRows) for (const c of rr.cands) if (!seen.includes(c.note)) seen.push(c.note);
    md.push('| 轮 | 起点 d | ' + seen.map((n) => '`' + n + '`').join(' | ') + ' | 胜出 | 本轮 d |');
    md.push('|---|---|' + seen.map(() => '---').join('|') + '|---|---|');
    for (const rr of roundRows) {
        const byNote = {};
        for (const c of rr.cands) byNote[c.note] = c.e;
        const noneE = byNote['none'];
        const cells = seen.map((n) => { const e = byNote[n]; return e ? (rr.winNote === n ? '**' + d4(e.dist) + '**' : d4(e.dist)) : '·'; });
        md.push('| ' + rr.round + ' | ' + d4(noneE ? noneE.dist : rr.win.dist) + ' | ' + cells.join(' | ') + ' | `' + (rr.winNote === 'none' ? 'none（无改进）' : rr.winNote) + '` | ' + d4(rr.win.dist) + ' |');
    }
} else {
md.push('| 轮 | 起点 d | ' + WL.map((k) => '`' + k + '`−').join(' | ') + ' | ' + WL.map((k) => '`' + k + '`+').join(' | ') + ' | 胜出 | 本轮 d |');
md.push('|---|---|' + WL.map(() => '---').join('|') + '|' + WL.map(() => '---').join('|') + '|---|---|');
for (const rr of roundRows) {
    let noneE = null;
    const byNote = {};
    for (const c of rr.cands) { byNote[c.note] = c.e; if (c.note === 'none') noneE = c.e; }
    const cells = [];
    for (const k of WL) { const e = byNote[k + '-']; cells.push(e ? (rr.winNote === k + '-' ? '**' + d4(e.dist) + '**' : d4(e.dist)) : '·'); }
    for (const k of WL) { const e = byNote[k + '+']; cells.push(e ? (rr.winNote === k + '+' ? '**' + d4(e.dist) + '**' : d4(e.dist)) : '·'); }
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
for (const rr of roundRows) {
    const w = rr.win;
    md.push('| ' + rr.round + ' | ' + WL.map((k) => num(w.params[k])).join(' | ') + ' | **' + d4(w.dist) + '** | ' + MID.map((id) => metricCell(metricOf(w, id))).join(' | ') + ' |');
}
md.push('');
}
md.push('## 4. 证据包清单');
md.push('');
md.push('| 文件 | 内容 |');
md.push('|---|---|');
md.push('| `curve.csv` | 每个评估点一行（' + B.evals.length + ' 行）：轮次 / 参数 / 距离 / 评估序号 / 分量 |');
md.push('| `best.json` | 最佳参数 + 距离 + 降幅 + `hash` + 全轨迹 + 元信息 |');
md.push('| `shots/best.png` | 最佳帧 |');
md.push('| `shots/target.png` | 目标帧 |');
md.push('| `shots/thumbs/` | 每 ' + M.thumbEvery + ' 轮一张的过程图（' + B.thumbs.length + ' 张） |');
if (B.hiPng) md.push('| `shots/run.png` | B 档留档（' + M.hiW + '×' + M.hiH + ' + high，不进距离） |');
md.push('| `logs/` | `_run.json`（原始轨迹）/ `target_metrics.json` + `tgt.json`（目标指标）/ `bag_*.json`（每批 metrics）/ `d_*.json`（每批距离） |');
md.push('');
md.push('看图（相对本目录）：`shots/best.png` vs `shots/target.png`' + (B.hiPng ? '，留档大图 `' + B.hiPng + '`' : ''));
md.push('');
md.push('## 5. 复现');
md.push('');
md.push('```powershell');
md.push(M.command);
md.push('```');
md.push('');
md.push('同 `-Seed` 同参数再跑一次，`best.json` 里的 `hash` 必须与本文件顶部一致（本 hash 就是判据）。');
md.push('');
md.push('## 6. 已知限制（本工具内置，别当 bug）');
md.push('');
md.push('- **单步单轴**：坐标下降每轮每参数只试 −一步 / +一步，局部极小之后走不出来（E2 §8.2 的 `distM` 宽浅极小点就是这种）。要越过去得换策略（`-Strategy random` 已实现，`bayes` 只留钩子）。');
md.push('- **距离不对称**：`d = f(候选, 目标)`，方向固定为"候选→目标"；把 target 和 candidate 换个位置数字会变（E2 §6）。');
md.push('- **无多目标合成**：一次只对一个目标帧。');
md.push('- **留档图体积**：`shots/` 每张约 20KB（' + M.w + '×' + M.h + '），thumbs 每 ' + M.thumbEvery + ' 轮一张；B 档 `run.png` 约 50KB。');
md.push('- **只在 ' + (M.pageFile ? M.pageFile.split('/').pop() : '冻帧页') + ' 单页跑**：本证据包只覆盖这一页的观测，其它页面的行为不在本次范围内。');
md.push('- **参数活性是"当前交付态"的性质**：`directDraw=1` 时美术类旋钮全死（E2 §3.1），换个实现就得重跑预检。');
md.push('');

fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n'), 'utf8');

console.log('HASH ' + hash);
console.log('start=' + start + ' best=' + best + ' drop=' + (dropPct === null ? 'n/a' : dropPct + '%') + ' stop=' + B.stop.reason + ' used=' + B.usage.used + '/' + M.budget);
