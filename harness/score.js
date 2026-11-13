// P2.5 · 距离（配置驱动）—— 指标组 / 权重 / 归一化 / 惩罚全部从 adapter 里读，代码里不再硬编码任何特效
//
// 距离形式（score.type = "l1"，唯一实现）：
//   nd_i = 第 i 个指标的归一化差（norm.mode 决定，见下）
//   d    = Σ w_i·nd_i / Σ w_i  +  Σ 命中的 penalty.add
//
// 归一化（每个指标自己的 norm，字段语义见 T4\适配层-说明.md §五）：
//   {"mode":"range","range":[lo,hi]}       nd = |m-t| / (hi-lo)       ← 固定跨度，权重才真的能比
//   {"mode":"pctrel","floor":f}            nd = |m-t| / max(|t|,f)    ← 旧口径（相对目标自归一化）
//   {"mode":"abs","scale":s}               nd = |m-t| / s              ← 纯线性缩放到某个量级
//   {"mode":"identity"}                    nd = |m-t|
//  可选 "clamp":true 把 nd 夹到 [0,1]（默认不夹，夹了超范围的点会失去梯度）
//
// 惩罚（score.penalties[]）：
//   { "id":"coreGone", "when":"ratioCore <= 0 || covCore < 0.5 * T.covCore", "add":0.5 }
//   when 是一个**极小的比较式**，只认这几种形状（不是 JS，不用 eval/Function）：
//     <key> <op> <num>          |  <key> <op> <num> * T.<key>  |  <key> <op> T.<key>
//     <op> ∈ < <= > >= ==   多个条件用 || 串起来（任一成立即命中）
//   key 取值顺序：候选帧该行的顶层键 → 该行的 diag 块（诊断量不进距离，但可以被闸门读）
//   T.<key> = 目标帧同名键。任一 key 缺失 → 直接报错（静默不命中的惩罚是坑）
//
// 用法：node score.js <bag.json> <tbag.json> [--adapter <a.json>] [--target <id>] [--ids a,b] [--out d.json]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- 归一化
function normalize(m, t, cfg, id) {
    const v = Number(m);
    if (!Number.isFinite(v)) throw new Error('候选缺指标 ' + id);
    const tv = Number(t);
    if (!Number.isFinite(tv)) throw new Error('目标缺指标 ' + id);
    const norm = cfg.norm || { mode: 'identity' };
    const diff = Math.abs(v - tv);
    let nd;
    if (norm.mode === 'range') {
        const r = norm.range;
        if (!Array.isArray(r) || r.length !== 2) throw new Error(id + '.norm.range 要是 [lo,hi]');
        const span = Number(r[1]) - Number(r[0]);
        if (!(span > 0)) throw new Error(id + '.norm.range 跨度必须 > 0（收到 ' + JSON.stringify(r) + '）');
        nd = diff / span;
    } else if (norm.mode === 'pctrel') {
        const f = Number.isFinite(Number(norm.floor)) ? Math.abs(Number(norm.floor)) : 0;
        nd = diff / Math.max(Math.abs(tv), f);
    } else if (norm.mode === 'abs') {
        const s = Math.abs(Number(norm.scale));
        if (!(s > 0)) throw new Error(id + '.norm.scale 必须 > 0');
        nd = diff / s;
    } else if (norm.mode === 'identity') {
        nd = diff;
    } else {
        throw new Error('不认识的 norm.mode=' + norm.mode + '（range/pctrel/abs/identity）');
    }
    if (norm.clamp) nd = Math.min(1, Math.max(0, nd));
    return nd;
}

// ---------------------------------------------------------------- 惩罚式（极小解析器，无 eval）
function lookup(row, key) {
    if (row && typeof row === 'object') {
        if (row[key] !== undefined && row[key] !== null) return Number(row[key]);
        if (row.diag && row.diag[key] !== undefined && row.diag[key] !== null) return Number(row.diag[key]);
    }
    return NaN;
}

function parseClause(txt, id) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|==|<|>)\s*(.+)$/.exec(txt.trim());
    if (!m) throw new Error('penalty ' + id + ' 的 when 片段看不懂: "' + txt + '"');
    const key = m[1], op = m[2], rhs = m[3].trim();
    let kind, val, tkey, factor = 1;
    let r;
    if ((r = /^T\.([A-Za-z_][A-Za-z0-9_]*)\s*\*\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)$/.exec(rhs))) { kind = 'targetMul'; tkey = r[1]; factor = Number(r[2]); }
    else if ((r = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*\*\s*T\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(rhs))) { kind = 'targetMul'; factor = Number(r[1]); tkey = r[2]; }
    else if ((r = /^T\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(rhs))) { kind = 'target'; tkey = r[1]; }
    else if ((r = /^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.exec(rhs))) { kind = 'value'; val = Number(rhs); }
    else throw new Error('penalty ' + id + ' 的右值看不懂: "' + rhs + '"（只认数 / T.key / 数*T.key）');
    return { key, op, kind, val, tkey, factor };
}

function parseWhen(when, id) {
    if (when && typeof when === 'object') return when;   // 已展开的对象形式原样用（{anyOf:[...]}）
    if (typeof when !== 'string') throw new Error('penalty ' + id + ' 缺 when');
    return { anyOf: when.split('||').map((s) => s.trim()).filter(Boolean).map((s) => parseClause(s, id)) };
}

function cmp(a, op, b) {
    switch (op) {
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
        case '==': return a === b;
        default: throw new Error('不认识的比较符 ' + op);
    }
}

function hitClause(row, trow, c, penId) {
    const a = lookup(row, c.key);
    if (!Number.isFinite(a)) throw new Error('penalty ' + penId + ': 候选行缺键 ' + c.key);
    let b;
    if (c.kind === 'value') b = c.val;
    else {
        const tv = Number(trow[c.tkey]);
        if (!Number.isFinite(tv)) throw new Error('penalty ' + penId + ': 目标行缺键 ' + c.tkey);
        b = c.kind === 'targetMul' ? tv * c.factor : tv;
    }
    return cmp(a, c.op, b);
}

function penaltyHit(row, trow, pen) {
    const w = parseWhen(pen.when, pen.id);
    if (w.anyOf) return w.anyOf.some((c) => hitClause(row, trow, c, pen.id));
    if (w.allOf) return w.allOf.every((c) => hitClause(row, trow, c, pen.id));
    if (w.metric) return hitClause(row, trow, w, pen.id);
    throw new Error('penalty ' + pen.id + ': when 只认 {anyOf|allOf|{key,op,...}}');
}

// ---------------------------------------------------------------- 主计算
function plan(adapter) {
    const raw = adapter && adapter.metrics;
    if (!Array.isArray(raw) || !raw.length) throw new Error('adapter 缺 metrics（P2.5 起必须是 v2 数组）');
    const metrics = raw.map((it) => {
        const m = (typeof it === 'string') ? { id: it, extract: it } : it;
        if (!m.id) throw new Error('metrics 项缺 id: ' + JSON.stringify(it));
        const w = m.weight === undefined ? 1 : Number(m.weight);
        if (!Number.isFinite(w)) throw new Error('metric ' + m.id + ' 的 weight 不是数');
        return { id: String(m.id), extract: m.extract || String(m.id), weight: w, norm: m.norm || { mode: 'identity' }, enabled: m.enabled !== false };
    });
    const sc = adapter.score || {};
    if (!sc.type) throw new Error('adapter 缺 score.type（本版只实现 "l1"）');
    if (sc.type !== 'l1') throw new Error('score.type=' + sc.type + ' 未实现（本版只支持 l1）');
    const penalties = (sc.penalties || []).map((p) => {
        if (!p.id) throw new Error('penalty 缺 id');
        const add = Number(p.add);
        if (!Number.isFinite(add)) throw new Error('penalty ' + p.id + ' 缺 add');
        return { id: String(p.id), when: p.when, add };
    });
    return { metrics: metrics.filter((m) => m.enabled), penalties };
}

function dist(row, trow, P) {
    let num = 0, den = 0;
    const parts = {}, wparts = {};
    for (const m of P.metrics) {
        const nd = normalize(row[m.id], trow[m.id], m, m.id);
        parts[m.id] = nd;
        wparts[m.id] = nd * m.weight;
        num += nd * m.weight;
        den += m.weight;
    }
    if (!(den > 0)) throw new Error('所有指标权重都是 0');
    const base = num / den;
    const pens = [];
    let penSum = 0;
    for (const p of P.penalties) if (penaltyHit(row, trow, p)) { pens.push(p.id); penSum += p.add; }
    return { d: base + penSum, base, parts, wparts, pens, penSum };
}

function planText(P) {
    const ms = P.metrics.map((m) => m.id + '=' + m.extract + '×' + m.weight + '[' + (m.norm.mode === 'range' ? m.norm.range.join(',') : m.norm.mode) + ']');
    const ps = P.penalties.map((p) => p.id + '(' + (typeof p.when === 'string' ? p.when : JSON.stringify(p.when)) + ')');
    return 'metrics: ' + ms.join(' ') + (ps.length ? '  penalties: ' + ps.join(' ') : '  penalties: -');
}

function cfgDigest(adapter) {
    const o = { metrics: adapter.metrics, score: adapter.score };
    return crypto.createHash('sha256').update(JSON.stringify(o), 'utf8').digest('hex').slice(0, 16);
}

function main() {
    const args = process.argv.slice(2);
    const bagPath = args[0], tbagPath = args[1];
    if (!bagPath || !tbagPath) { console.error('用法: node score.js <bag.json> <tbag.json> [--adapter a.json] [--target id] [--ids a,b] [--out d.json]'); process.exit(1); }
    const pick = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
    const adapterPath = pick('--adapter') || path.join(__dirname, 'adapter.json');
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf8'));
    const P = plan(adapter);
    const bag = JSON.parse(fs.readFileSync(bagPath, 'utf8'));
    const tbag = JSON.parse(fs.readFileSync(tbagPath, 'utf8'));
    const tKey = pick('--target') || Object.keys(tbag)[0];
    const trow = tbag[tKey];
    if (!trow) { console.error('tbag 里没有 ' + tKey); process.exit(1); }
    const idsArg = pick('--ids');
    const ids = idsArg ? idsArg.split(',') : Object.keys(bag).sort();

    console.log('[plan] adapter=' + (adapter.name || '?') + '  cfgSha=' + cfgDigest(adapter) + '  ' + planText(P));
    const out = [];
    for (const id of ids) {
        const row = bag[id];
        if (!row) continue;
        const r = dist(row, trow, P);
        const rec = {
            id,
            d: +r.d.toFixed(6),
            base: +r.base.toFixed(6),
            parts: r.parts,
            wparts: r.wparts,
            pens: r.pens,
            pen: +r.penSum.toFixed(4),
            cfgSha: cfgDigest(adapter)
        };
        // 历史字段别名（iter.ps1 只按位置读这三个，语义 = 配置里第 1/2/3 个分量）
        const mids = P.metrics.map((m) => m.id);
        rec.dprof = mids[0] ? +r.parts[mids[0]].toFixed(4) : 0;
        rec.dlap = mids[1] ? +r.parts[mids[1]].toFixed(4) : 0;
        rec.dwarm = mids[2] ? +r.parts[mids[2]].toFixed(4) : 0;
        // 指标原值 + 诊断量透传（只做记录，不参与任何计算）
        for (const m of P.metrics) rec[m.id] = row[m.id];
        if (row.diag) rec.diag = row.diag;
        out.push(rec);
    }
    out.sort((a, b) => a.d - b.d);
    console.log('target=' + tKey + '  ' + P.metrics.map((m) => m.id + '=' + trow[m.id]).join(' ') + (trow.covCore !== undefined ? ' covCore=' + trow.covCore : ''));
    for (const r of out) {
        const comp = P.metrics.map((m) => m.id + ' ' + r.parts[m.id].toFixed(4)).join(' / ');
        console.log(r.id.padEnd(16) + 'd=' + r.d.toFixed(4) + '  (' + comp + (r.pens.length ? '  pen[' + r.pens.join('+') + ']=' + r.pen : '  pen=0') + ')');
    }
    const o = pick('--out');
    if (o) { fs.writeFileSync(o, JSON.stringify(out, null, 1)); console.log('WROTE ' + o + ' (' + out.length + ')'); }
}

if (require.main === module) main();
module.exports = { dist, plan, planText, cfgDigest, normalize, parseWhen };
