// P2.5 · 指标提取器注册表 + 配置驱动 CLI
//
// 一句话：**代码里备一套通用提取器，配置只做「选哪个 / 怎么配参数」**。
//   - 每个提取器是纯函数 (px, opts, ref) => number；px 是解码后的像素视图（同一张图只解码一次）。
//   - 提取器清单与参数见 EXTRACTORS；配置里 `extract` 选名字，`opts` 传该提取器自己的参数。
//   - 本文件**不认识**任何具体特效：特效名 / 色系 / 阈值 / 归一化 / 权重全在 adapter 里。
//
// 用法：
//   node metrics2.js <png...> [--out bag.json] [--adapter <adapter.json>] [--ref <png>] [--print-plan] [--no-diag]
//
// adapter 里的取法（v2）：
//   "metrics": [ { "id":"cov", "extract":"cov", "opts":{"luma":40} }, ... ]
//   id    = 产出的键名（score.js 认这个，可重复用同一个 extract 起不同名字）
//   extract = 提取器名（见 EXTRACTORS）
//   opts  = 该提取器自己的参数（省略 = 提取器默认值）
//
// 产出（每张图一个对象，按 png 文件名去扩展名做键）：
//   { file,w,h, <每个配置的 id>: 数值, diag:{...}, plan:{id:extract} }
//   diag 是**只读诊断**（不进距离，score.js 一行都不读它），用来给人看 / 给 finalize 打印；
//   若某个诊断键与配置 id 重名，以配置为准（不覆盖配置值）。
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

// ---------------------------------------------------------------- PNG 解码
// 自包含副本（照 E1 metrics.js 的写法，不改共享脚本）；支持 8bit 非隔行 + 调色板。
function decodePng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
    let off = 8, w = 0, h = 0, depth = 0, ct = 0, interlace = 0;
    const idat = [];
    let palette = null;
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; interlace = data[12]; }
        else if (type === 'PLTE') { palette = data; }
        else if (type === 'IDAT') { idat.push(data); }
        else if (type === 'IEND') { break; }
        off += 12 + len;
    }
    if (depth !== 8 || interlace !== 0) throw new Error('只支持 8bit 非隔行 depth=' + depth + ' il=' + interlace);
    const ch0 = ct === 6 ? 4 : (ct === 2 ? 3 : (ct === 0 ? 1 : (ct === 3 ? 1 : 0)));
    if (!ch0) throw new Error('不支持 colorType=' + ct);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch0;
    const out = Buffer.alloc(w * h * ch0);
    let pos = 0;
    for (let y = 0; y < h; y++) {
        const f = raw[pos++];
        const line = raw.subarray(pos, pos + stride);
        pos += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= ch0 ? cur[x - ch0] : 0;
            const b = prev ? prev[x] : 0;
            const c = (prev && x >= ch0) ? prev[x - ch0] : 0;
            let v = line[x];
            switch (f) {
                case 0: break;
                case 1: v += a; break;
                case 2: v += b; break;
                case 3: v += (a + b) >> 1; break;
                case 4: {
                    const p = a + b - c;
                    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                    break;
                }
                default: throw new Error('未知 filter ' + f);
            }
            cur[x] = v & 0xff;
        }
    }
    // 调色板 → RGB
    if (ct === 3) {
        const rgb = Buffer.alloc(w * h * 3);
        for (let i = 0; i < w * h; i++) { const k = out[i] * 3; rgb[i * 3] = palette[k]; rgb[i * 3 + 1] = palette[k + 1]; rgb[i * 3 + 2] = palette[k + 2]; }
        return { w, h, ch: 3, data: rgb };
    }
    return { w, h, ch: ch0, data: out };
}

// ---------------------------------------------------------------- 像素视图
// 一张图解码一次 → px：{w,h,n,ch,data,lum,mask(thr),bbox(thr),fill(thr)}
// luma 用 Rec709（与 E1 metrics.js 同口径，保证火柱的历史数字可比）。
function makePx(img) {
    const { w, h, ch, data } = img;
    const n = w * h;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const p = i * ch;
        const r = data[p], g = ch >= 3 ? data[p + 1] : data[p], b = ch >= 3 ? data[p + 2] : data[p];
        lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const maskCache = new Map();
    const bboxCache = new Map();
    function mask(thr) {
        const k = Number(thr);
        if (!maskCache.has(k)) {
            const m = new Uint8Array(n);
            for (let i = 0; i < n; i++) m[i] = lum[i] > k ? 1 : 0;
            maskCache.set(k, m);
        }
        return maskCache.get(k);
    }
    function bbox(thr) {
        const k = Number(thr);
        if (!bboxCache.has(k)) {
            const m = mask(k);
            let x0 = w, y0 = h, x1 = -1, y1 = -1, cnt = 0;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (!m[y * w + x]) continue;
                    cnt++;
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
            }
            bboxCache.set(k, { x0, y0, x1, y1, w: x1 >= 0 ? x1 - x0 + 1 : 0, h: y1 >= 0 ? y1 - y0 + 1 : 0, cnt });
        }
        return bboxCache.get(k);
    }
    return {
        w, h, n, ch, data, lum,
        mask, bbox,
        rgbAt(i) {
            const p = i * ch;
            return [data[p], ch >= 3 ? data[p + 1] : data[p], ch >= 3 ? data[p + 2] : data[p]];
        }
    };
}

// ---------------------------------------------------------------- 提取器注册表
// 约定：fn(px, opts, ref) -> number | null
//   px  候选帧（当前图）的像素视图
//   opts 该提取器自己的参数（来自配置；缺省用 defaults）
//   ref 参考帧的像素视图（只有 needsRef 的提取器用得上；没给 → 返回 null）
// 所有"占比"一律输出 **0~1 的小数**（不是百分数），这样 range 归一化能写成 [0,1]/[0,0.3] 这种直觉区间。
const EXTRACTORS = {
    mean: {
        desc: '平均亮度（Rec709 luma，0~255）',
        defaults: {},
        fn(px) {
            let s = 0;
            for (let i = 0; i < px.n; i++) s += px.lum[i];
            return +(s / px.n).toFixed(4);
        }
    },
    p160: {
        desc: '高光面积：luma > thr 的像素占全图比例（0~1）',
        defaults: { thr: 160 },
        fn(px, o) {
            const m = px.mask(o.thr);
            let c = 0;
            for (let i = 0; i < px.n; i++) if (m[i]) c++;
            return +(c / px.n).toFixed(5);
        }
    },
    lapVar: {
        desc: '细节能量：Laplacian 方差（只在 luma > luma 的内点上统计）',
        defaults: { luma: 40 },
        fn(px, o) {
            const L = px.lum, { w, h } = px;
            let s = 0, s2 = 0, cnt = 0;
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (L[i] <= o.luma) continue;
                    const lap = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w];
                    s += lap; s2 += lap * lap; cnt++;
                }
            }
            if (!cnt) return 0;
            const m = s / cnt;
            return +(s2 / cnt - m * m).toFixed(2);
        }
    },
    warmFrac: {
        desc: '暖色占比：亮像素中 r>rMin 且 r>g*rg 且 g>=b*gb 的比例（0~1）',
        defaults: { luma: 80, rMin: 140, rg: 1.15, gb: 0.9 },
        fn(px, o) {
            let bright = 0, warm = 0;
            const L = px.lum;
            for (let i = 0; i < px.n; i++) {
                if (L[i] < o.luma) continue;
                bright++;
                const [r, g, b] = px.rgbAt(i);
                if (r > o.rMin && r > g * o.rg && g >= b * o.gb) warm++;
            }
            return bright ? +(warm / bright).toFixed(4) : 0;
        }
    },
    coldFrac: {
        desc: '冷色占比：全图中 luma>luma 且 b>r+delta 的像素比例（0~1）',
        defaults: { luma: 20, delta: 8 },
        fn(px, o) {
            let c = 0;
            const L = px.lum;
            for (let i = 0; i < px.n; i++) {
                if (L[i] <= o.luma) continue;
                const [r, , b] = px.rgbAt(i);
                if (b > r + o.delta) c++;
            }
            return +(c / px.n).toFixed(5);
        }
    },
    cov: {
        desc: '亮区面积：luma > luma 的像素占全图比例（0~1）',
        defaults: { luma: 40 },
        fn(px, o) {
            const m = px.mask(o.luma);
            let c = 0;
            for (let i = 0; i < px.n; i++) if (m[i]) c++;
            return +(c / px.n).toFixed(5);
        }
    },
    maskIoU: {
        desc: '亮区掩码重叠率：|A∩B|/|A∪B|（luma>luma；A=候选，B=参考帧）',
        defaults: { luma: 40 },
        needsRef: true,
        fn(px, o, ref) {
            if (!ref) return null;
            if (ref.w !== px.w || ref.h !== px.h) throw new Error('maskIoU: 参考帧尺寸不一致 ' + px.w + 'x' + px.h + ' vs ' + ref.w + 'x' + ref.h);
            const a = px.mask(o.luma), b = ref.mask(o.luma);
            let inter = 0, uni = 0;
            for (let i = 0; i < px.n; i++) {
                const x = a[i], y = b[i];
                if (x && y) inter++;
                if (x || y) uni++;
            }
            return uni ? +(inter / uni).toFixed(4) : 0;
        }
    },
    bbox: {
        desc: '包围盒：亮区外接矩形的 w / h / area / aspect / fill，field 选一个（单值输出）',
        defaults: { luma: 40, field: 'w' },
        fn(px, o) {
            const bb = px.bbox(o.luma);
            const f = o.field || 'w';
            if (f === 'w') return bb.w;
            if (f === 'h') return bb.h;
            if (f === 'area') return bb.w * bb.h;
            if (f === 'aspect') return bb.h ? +(bb.w / bb.h).toFixed(4) : 0;
            if (f === 'fill') return (bb.w * bb.h) ? +(bb.cnt / (bb.w * bb.h)).toFixed(4) : 0;
            throw new Error('bbox: 不认识的 field=' + f + '（w/h/area/aspect/fill）');
        }
    }
};

// 诊断块（不进距离）：用一套固定口径把"人看的东西"一起吐出来，省得再跑一遍别的脚本。
function diagnostics(px, ref) {
    const d = {
        mean: EXTRACTORS.mean.fn(px, {}),
        p160: EXTRACTORS.p160.fn(px, EXTRACTORS.p160.defaults),
        cov40: EXTRACTORS.cov.fn(px, EXTRACTORS.cov.defaults),
        lapVar40: EXTRACTORS.lapVar.fn(px, EXTRACTORS.lapVar.defaults),
        warmFrac: EXTRACTORS.warmFrac.fn(px, EXTRACTORS.warmFrac.defaults),
        coldFrac: EXTRACTORS.coldFrac.fn(px, EXTRACTORS.coldFrac.defaults),
        bboxW: EXTRACTORS.bbox.fn(px, EXTRACTORS.bbox.defaults),
        bboxH: EXTRACTORS.bbox.fn(px, { luma: 40, field: 'h' })
    };
    // 兼容 iter.ps1 / finalize.js 的历史字段读法（它们只做记录与打印，不进距离）
    d.covCore = +(100 * EXTRACTORS.cov.fn(px, { luma: 210 })).toFixed(2);
    d.ratioCore = d.cov40 > 0 ? +(d.covCore / (d.cov40 * 100)).toFixed(3) : 0;
    d.lapVar = d.lapVar40;
    if (ref) d.maskIoU = EXTRACTORS.maskIoU.fn(px, EXTRACTORS.maskIoU.defaults, ref);
    return d;
}

// ---------------------------------------------------------------- 配置 -> 计划
// v2 写法：{ id, extract, opts }；也接受 v1 的裸字符串（等价于 { id:s, extract:s, opts:{} }）。
function resolvePlan(adapter) {
    const raw = adapter && adapter.metrics;
    if (!Array.isArray(raw) || !raw.length) throw new Error('adapter 缺 metrics 数组');
    const plan = [];
    for (const it of raw) {
        const m = (typeof it === 'string') ? { id: it, extract: it, opts: {} } : it;
        if (!m || !m.id || !m.extract) throw new Error('metrics 项缺 id/extract: ' + JSON.stringify(it));
        if (!EXTRACTORS[m.extract]) throw new Error('未知提取器 extract=' + m.extract + '（可用: ' + Object.keys(EXTRACTORS).join('/') + '）');
        const opts = Object.assign({}, EXTRACTORS[m.extract].defaults, m.opts || {});
        plan.push({ id: String(m.id), extract: String(m.extract), opts });
    }
    return plan;
}

function planText(plan) {
    return plan.map((p) => p.id + '=' + p.extract + '(' + (Object.keys(p.opts).length ? JSON.stringify(p.opts) : '') + ')').join('  ');
}

// ---------------------------------------------------------------- 单图提取
function extractOne(file, plan, refPx, withDiag) {
    const px = makePx(decodePng(fs.readFileSync(file)));
    const out = { file: path.basename(file), w: px.w, h: px.h };
    const used = {};
    for (const p of plan) {
        out[p.id] = EXTRACTORS[p.extract].fn(px, p.opts, refPx);
        used[p.id] = p.extract;
    }
    if (withDiag) {
        const d = diagnostics(px, refPx);
        // 配置值优先：诊断只补"配置没占用"的键（iter.ps1 读 lapVar/warmFrac/mean/covCore 这些历史字段）
        for (const k of Object.keys(d)) if (!(k in out)) out[k] = d[k];
        out.diag = d;
    }
    out.plan = used;
    return out;
}

function main() {
    const argv = process.argv.slice(2);
    const pick = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
    let outJson = pick('--out');
    const adapterPath = pick('--adapter') || path.join(__dirname, 'adapter.json');
    const refPath = pick('--ref');
    const withDiag = !argv.includes('--no-diag');
    const printPlan = argv.includes('--print-plan');
    const files = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') { i++; continue; }
        if (a === '--adapter') { i++; continue; }
        if (a === '--ref') { i++; continue; }
        if (a === '--print-plan' || a === '--no-diag') continue;
        files.push(a);
    }
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf8'));
    const plan = resolvePlan(adapter);
    if (printPlan || !files.length) {
        console.log('PLAN adapter=' + (adapter.name || '?') + '  ' + planText(plan));
    }
    if (!files.length) { if (!printPlan) console.error('用法: node metrics2.js <png...> [--out bag.json] [--adapter a.json] [--ref t.png]'); return; }
    const refPx = refPath ? makePx(decodePng(fs.readFileSync(refPath))) : null;
    const bag = {};
    for (const f of files) {
        try {
            const m = extractOne(f, plan, refPx, withDiag);
            console.log('METRIC ' + JSON.stringify(m));
            bag[path.basename(f, '.png')] = m;
        } catch (e) { console.log('ERR ' + f + ' ' + e.message); }
    }
    if (outJson) { fs.writeFileSync(outJson, JSON.stringify(bag, null, 1), 'utf8'); console.log('WROTE ' + outJson + ' (' + Object.keys(bag).length + ')'); }
}

if (require.main === module) main();
module.exports = { EXTRACTORS, resolvePlan, planText, extractOne, decodePng, makePx, diagnostics };
