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
    const contentCache = new Map();
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
    // 前景掩膜（见 buildContentMask）：同 px 上同参数的掩膜只算一次。
    function contentMask(o) {
        const key = JSON.stringify(o || {});
        // data/ch 也传进去：chroma 要按色度谓词取通道，diff 要读背景图（走模块级的 ref 缓存）。
        if (!contentCache.has(key)) contentCache.set(key, buildContentMask({ w, h, n, lum, data, ch }, o || {}));
        return contentCache.get(key);
    }
    return {
        w, h, n, ch, data, lum,
        mask, bbox, contentMask,
        rgbAt(i) {
            const p = i * ch;
            return [data[p], ch >= 3 ? data[p + 1] : data[p], ch >= 3 ? data[p + 2] : data[p]];
        }
    };
}

// ---------------------------------------------------------------- 掩膜（masked stats）
// 为什么要有它（两条实验的结论，不是拍脑袋）：
//   ① 全帧统计被背景稀释——主体只占画面 3.8~6.4%，指标几乎量不到主体；
//   ② 跨批次比较会因为"换题材 / 换占屏比"冒出假趋势（实测出现过 p=0.0034 的假相关）。
// 所以提取器统一支持 opts.mask，**所有统计都在掩膜内算**：
//
//   "metrics": [ { "id":"cov", "extract":"cov", "opts": {
//       "mask": { "mode":"content", "luma":40, "dilate":1, "minAreaPct":0.2 } } } ]
//
// 0.12.0 起四种圈法（上一版只有 content，被第二轮实验证伪为"看起来很专业地量错了"）：
//   content —— 按 luma>=luma 圈前景 → 取最大连通域 → 可选膨胀。
//              **只适合"亮主体 + 暗背景"**；白天/雪地/亮舞台会圈到背景上，见 maskSuspicious。
//   roi     —— rect:[x,y,w,h] 固定矩形，**完全不看像素内容**（跨帧/跨变体完全一致，跨帧比较唯一稳的口径）。
//   diff    —— ref:"<背景/空舞台 png>"，|luma 差| > delta 的像素为前景 → 最大连通域。
//              分不清"亮主体"与"亮背景"时的正解。
//   chroma  —— predicate:{channel,op,value} 按色度圈（暖主体 vs 冷背景）。
// minAreaPct 是**百分数**（0.2 = 0.2%）：掩膜面积低于它就退回全图，
// 但**必须**由调用方在返回值里标 maskFallback:true —— "以为在量主体、其实在量整帧"
// 正是这两条实验的原始病灶，不许静默。
// 同理 maskSuspicious：面积 <1% 或包围盒 <5%（content/diff/chroma）就不是"没圈到"，是"圈到了小亮点"，
// 那比没有掩膜更危险，所以也要标出来（0.12.0）。
// 不写 opts.mask → 走全图，行为与升级前完全一致（历史 162 条测试钉的就是这个契约）。
const MASK_DEFAULTS = { mode: 'content', luma: 40, dilate: 1, minAreaPct: 0.2 };
const MASK_MODES = ['content', 'roi', 'diff', 'chroma', 'none'];
// 「圈错」的自动拦截门槛（0.12.0）。数字来自实验：luma:200 在真实场景只剩枪口白芯，
// 占屏 < 1%，对主体 recall 只有 0.09~0.38——它不报错、不崩，只是**稳定地量错一块像素**。
const MASK_SUSPECT_MIN_AREA_PCT = 1;    // 掩膜面积 < 1% 就怀疑圈到了小块高光
const MASK_SUSPECT_MIN_BBOX_PCT = 5;    // 包围盒面积 < 5% 同理（面积大而 box 小的情形抓不到，两条都留）

// diff 模式的背景图按绝对路径缓存 luma：同一张 ref 只解码一次。
const DIFF_REF_CACHE = new Map();
function loadDiffRef(p) {
    if (p == null || p === '') throw new Error('opts.mask.mode="diff" 需要 ref:"<背景/空舞台 png 路径>"');
    const abs = path.resolve(String(p));
    if (!DIFF_REF_CACHE.has(abs)) {
        const px = makePx(decodePng(fs.readFileSync(abs)));
        DIFF_REF_CACHE.set(abs, { abs, w: px.w, h: px.h, lum: px.lum });
    }
    return DIFF_REF_CACHE.get(abs);
}

// 8 邻域最大连通域（迭代洪水填充，不递归——整幅白屏会爆栈）。返回 {m, size}。
function largestComponent(seed, w, h, n) {
    const lbl = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    const neigh = new Int32Array(8);
    let bestId = -1, bestSize = 0, id = 0;
    for (let s = 0; s < n; s++) {
        if (!seed[s] || lbl[s] >= 0) continue;
        let sp = 0;
        stack[sp++] = s; lbl[s] = id;
        let size = 0;
        while (sp > 0) {
            const i = stack[--sp];
            size++;
            const x = i % w, y = (i - x) / w;
            let k = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const xx = x + dx;
                    if (xx < 0 || xx >= w) continue;
                    neigh[k++] = yy * w + xx;
                }
            }
            for (let j = 0; j < k; j++) {
                const q = neigh[j];
                if (!seed[q] || lbl[q] >= 0) continue;
                lbl[q] = id; stack[sp++] = q;
            }
        }
        if (size > bestSize) { bestSize = size; bestId = id; }
        id++;
    }
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (bestId >= 0 && lbl[i] === bestId) m[i] = 1;
    return { m, size: bestSize };
}

// 可分离的方形（切比雪夫）膨胀，半径 = d 像素，原地改 m。
// 目的是把主体外沿那一圈"半亮/半透"的像素也纳进来（否则 lapVar 只量到主体内核）。
function dilateMask(m, w, h, d) {
    const n = w * h;
    const tmp = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        const pre = new Int32Array(w + 1);
        for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + m[row + x];
        for (let x = 0; x < w; x++) {
            const lo = x - d < 0 ? 0 : x - d;
            const hi = x + d > w - 1 ? w - 1 : x + d;
            tmp[row + x] = (pre[hi + 1] - pre[lo]) > 0 ? 1 : 0;
        }
    }
    for (let x = 0; x < w; x++) {
        const pre = new Int32Array(h + 1);
        for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
        for (let y = 0; y < h; y++) {
            const lo = y - d < 0 ? 0 : y - d;
            const hi = y + d > h - 1 ? h - 1 : y + d;
            m[y * w + x] = (pre[hi + 1] - pre[lo]) > 0 ? 1 : 0;
        }
    }
}

// roi 矩形：越界**夹紧并 warn**（不静默改用全图，也不静默裁掉一块）。
function normalizeRoiRect(rect, w, h, warn) {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((v) => Number.isFinite(Number(v)))) {
        throw new Error('opts.mask.mode="roi" 需要 rect:[x,y,w,h]（4 个数字），收到 ' + JSON.stringify(rect));
    }
    const req = rect.map(Number);
    const x = Math.round(req[0]), y = Math.round(req[1]), rw = Math.round(req[2]), rh = Math.round(req[3]);
    if (rw <= 0 || rh <= 0) throw new Error('opts.mask.mode="roi" 的 rect 宽高必须 > 0（收到 ' + JSON.stringify(req) + '）');
    const x0 = Math.max(0, Math.min(w - 1, x));
    const y0 = Math.max(0, Math.min(h - 1, y));
    const x1 = Math.max(x0 + 1, Math.min(w, x + rw));
    const y1 = Math.max(y0 + 1, Math.min(h, y + rh));
    const out = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (out.x !== x || out.y !== y || out.w !== rw || out.h !== rh) {
        out.clamped = true;
        out.requested = req;
        warn.push('rect 越界已夹紧：请求 [' + req.join(',') + '] → 实际 [' + [out.x, out.y, out.w, out.h].join(',') + ']（画面 ' + w + 'x' + h + '）');
    }
    return out;
}

// chroma 的色度谓词：只认这 7 个通道，别的一律硬错（静默当 0 会把掩膜悄悄挪到别处）。
const PRED_CHANNELS = ['r', 'g', 'b', 'luma', 'blue-minus-red', 'red-minus-blue', 'saturation'];
const PRED_OPS = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };

function channelOf(name, g) {
    const { data, ch, lum } = g;
    const r = (i) => data[i * ch];
    const gg = (i) => (ch >= 3 ? data[i * ch + 1] : data[i * ch]);
    const b = (i) => (ch >= 3 ? data[i * ch + 2] : data[i * ch]);
    switch (name) {
        case 'r': return r;
        case 'g': return gg;
        case 'b': return b;
        case 'luma': return (i) => lum[i];
        case 'blue-minus-red': return (i) => b(i) - r(i);
        case 'red-minus-blue': return (i) => r(i) - b(i);
        case 'saturation': return (i) => Math.max(r(i), gg(i), b(i)) - Math.min(r(i), gg(i), b(i));
        default:
            throw new Error('opts.mask.predicate.channel 只认 ' + PRED_CHANNELS.join(' / ') + '（收到 ' + name + '）');
    }
}

function normalizePredicate(p) {
    if (!p || typeof p !== 'object') throw new Error('opts.mask.mode="chroma" 需要 predicate:{channel,op,value}，收到 ' + JSON.stringify(p));
    const channel = String(p.channel == null ? '' : p.channel);
    const op = String(p.op == null ? '' : p.op);
    const value = Number(p.value);
    if (!PRED_CHANNELS.includes(channel)) throw new Error('opts.mask.predicate.channel 只认 ' + PRED_CHANNELS.join(' / ') + '（收到 ' + (channel || '(空)') + '）');
    if (!PRED_OPS[op]) throw new Error('opts.mask.predicate.op 只认 < <= > >=（收到 ' + (op || '(空)') + '）');
    if (!Number.isFinite(value)) throw new Error('opts.mask.predicate.value 必须是数字（收到 ' + JSON.stringify(p.value) + '）');
    return { channel, op, value };
}

// g = {w,h,n,lum,data,ch}。返回值里的 m=null 表示"统计走全图"（没掩膜 / 已回退）。
function buildContentMask(g, o) {
    const { w, h, n, lum } = g;
    const mode = String(o.mode == null ? MASK_DEFAULTS.mode : o.mode);
    if (mode === 'none') {
        return { m: null, count: n, areaPct: 100, largestPct: 100, bboxPct: 100, maskFallback: false, mode, luma: null, dilate: 0, minAreaPct: null, maskSuspicious: false, maskSuspectReasons: [], maskWarn: [] };
    }
    if (!MASK_MODES.includes(mode)) throw new Error('opts.mask.mode 只认 content / roi / diff / chroma / none（收到 ' + mode + '）');
    const dilate = Math.max(0, Math.floor(Number.isFinite(Number(o.dilate)) ? Number(o.dilate) : MASK_DEFAULTS.dilate));
    const minAreaPct = Number.isFinite(Number(o.minAreaPct)) ? Number(o.minAreaPct) : MASK_DEFAULTS.minAreaPct;
    const maskWarn = [];
    const suspect = [];
    const extra = {};                                   // 模式专属回执（进 maskInfo，人能看见用的是哪套口径）
    let m, largestSize = 0;
    if (mode === 'roi') {
        // 固定 ROI：**完全不看像素内容**，所以跨候选帧 / 跨变体完全一致——实验里证明这是唯一稳的口径。
        const rect = normalizeRoiRect(o.rect, w, h, maskWarn);
        m = new Uint8Array(n);
        for (let y = rect.y; y < rect.y + rect.h; y++) {
            const row = y * w;
            for (let x = rect.x; x < rect.x + rect.w; x++) m[row + x] = 1;
        }
        largestSize = rect.w * rect.h;
        extra.roi = rect;
    } else {
        // 三种模式共用的第一步：造前景种子
        const seed = new Uint8Array(n);
        if (mode === 'content') {
            const luma = Number.isFinite(Number(o.luma)) ? Number(o.luma) : MASK_DEFAULTS.luma;
            extra.luma = luma;
            // **>=**：圈区域要含边界那一圈，否则火焰最暗的边缘会被吃掉。
            for (let i = 0; i < n; i++) seed[i] = lum[i] >= luma ? 1 : 0;
        } else if (mode === 'diff') {
            // 与"空舞台/背景"图差分：分不清亮主体与亮背景时的正解（|luma 差| > delta 即为前景）
            const delta = Number.isFinite(Number(o.delta)) ? Number(o.delta) : 12;
            const ref = loadDiffRef(o.ref);
            if (ref.w !== w || ref.h !== h) {
                throw new Error('opts.mask.ref 与候选帧尺寸不一致（' + ref.w + 'x' + ref.h + ' vs ' + w + 'x' + h + '）：' + ref.abs);
            }
            extra.refPath = ref.abs;
            extra.delta = delta;
            for (let i = 0; i < n; i++) seed[i] = Math.abs(lum[i] - ref.lum[i]) > delta ? 1 : 0;
        } else {
            // 色度谓词：暖主体 vs 冷背景这类"亮度分不开、颜色分得开"的场合
            const pred = normalizePredicate(o.predicate);
            extra.predicate = pred;
            const pick = channelOf(pred.channel, g);
            const test = PRED_OPS[pred.op];
            for (let i = 0; i < n; i++) seed[i] = test(pick(i), pred.value) ? 1 : 0;
        }
        // 最大连通域。8 邻域：火焰/闪电这种细弱结构用 4 邻域会碎成几块，最大块就只剩芯。
        const cc = largestComponent(seed, w, h, n);
        m = cc.m;
        largestSize = cc.size;
    }
    if (dilate > 0 && largestSize > 0) dilateMask(m, w, h, dilate);
    let count = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (!m[row + x]) continue;
            count++;
            if (x < bx0) bx0 = x;
            if (x > bx1) bx1 = x;
            if (y < by0) by0 = y;
            if (y > by1) by1 = y;
        }
    }
    const areaPct = 100 * count / n;
    const bboxPct = bx1 >= 0 ? 100 * (bx1 - bx0 + 1) * (by1 - by0 + 1) / n : 0;
    // 掩膜指纹（0.13.0）：同一块像素 → 同一个 hash；圈到别处 → 换 hash。没有掩膜就没有指纹。
    const maskHash = m ? fnv1aMask(m) : null;
    // 「圈错」的自动拦截（0.12.0）：面积太小 = 大概率圈到小块高光/白芯，不是主体。
    // 这一条就是实验里那个病：luma:200 只剩枪口白芯，三个不同变体在三个时刻的掩膜内指标逐位相同
    // （7305.98|0.21296|0.11216）——最大连通域在"枪口团"和"射线"之间跳，等于把不同变体量成同一块像素。
    // 圈错的掩膜比没有掩膜更危险：它看起来很专业。
    if (mode !== 'roi') {
        if (areaPct < MASK_SUSPECT_MIN_AREA_PCT) {
            suspect.push('掩膜面积仅 ' + areaPct.toFixed(3) + '%（< ' + MASK_SUSPECT_MIN_AREA_PCT + '%）：大概率圈到的是小块高光/噪点，不是主体');
        }
        if (bboxPct < MASK_SUSPECT_MIN_BBOX_PCT) {
            suspect.push('掩膜包围盒只占画面 ' + bboxPct.toFixed(2) + '%（< ' + MASK_SUSPECT_MIN_BBOX_PCT + '%）：圈到的区域过于集中，像高光点/白芯而不是主体');
        }
    }
    const base = Object.assign({}, extra, {
        mode, dilate, minAreaPct, areaPct, largestPct: 100 * largestSize / n, bboxPct, maskHash,
        maskSuspicious: suspect.length > 0, maskSuspectReasons: suspect, maskWarn,
        luma: extra.luma === undefined ? null : extra.luma
    });
    if (areaPct < minAreaPct) {
        // 掩膜太小 = 圈不到主体。退回全图，但**把这件事带出去**（maskFallback），不静默。
        return Object.assign(base, { m: null, count: n, maskFallback: true });
    }
    return Object.assign(base, { m, count, maskFallback: false });
}

// 提取器拿统计范围的统一入口：返回 {m, count, maskFallback}，m=null 就是全图。
// ctx 是可选的回执收集器（extractOne 用它把 maskFallback / maskSuspicious 标到该图的返回对象上）。
function scopeOf(px, o, ctx) {
    const mk = o && o.mask;
    if (!mk || typeof mk !== 'object') return { m: null, count: px.n, maskFallback: false };
    const r = px.contentMask(mk);
    if (ctx) {
        ctx.maskSeen = true;
        ctx.maskInfo = {
            mode: r.mode, luma: r.luma, dilate: r.dilate, minAreaPct: r.minAreaPct,
            areaPct: +r.areaPct.toFixed(4), largestPct: +r.largestPct.toFixed(4),
            bboxPct: +(r.bboxPct == null ? 0 : r.bboxPct).toFixed(4),
            // 掩膜指纹（0.13.0）：跨候选比"是不是同一块像素"。回退全图时用的是整帧，掩膜位图已作废 → null。
            maskHash: r.maskFallback ? null : r.maskHash,
            maskFallback: r.maskFallback
        };
        // 模式专属口径原样回执：报告里必须能看出"这次用的是 roi 还是 content(luma:200)"
        if (r.roi) ctx.maskInfo.roi = r.roi;
        if (r.refPath) { ctx.maskInfo.ref = r.refPath; ctx.maskInfo.delta = r.delta; }
        if (r.predicate) ctx.maskInfo.predicate = r.predicate;
        if (r.maskFallback) ctx.maskFallback = true;
        if (r.maskSuspicious) { ctx.maskSuspicious = true; ctx.maskSuspectReasons = r.maskSuspectReasons; }
        if (r.maskWarn && r.maskWarn.length) ctx.maskWarn = (ctx.maskWarn || []).concat(r.maskWarn);
    }
    return { m: r.m, count: r.count, maskFallback: r.maskFallback };
}

// 掩膜指纹（0.13.0 的哨兵用）：对掩膜位图做 FNV-1a 32 位，输出 8 位十六进制。
// 为什么需要它：areaPct/bboxPct 只能说明"圈了多大"，说明不了"圈的是不是同一块像素"——
// 第二轮实验里三个不同变体圈出的都是那块枪口白芯（面积/包围盒一样），指标逐位相同，量出来的却是"稳定的一比"。
// 65k 像素 <1ms，放进 maskInfo 不心疼；只对**真实掩膜**给值（mode:none / 回退全图 → null）。
function fnv1aMask(m) {
    let h = 0x811c9dc5;
    for (let i = 0; i < m.length; i++) {
        h ^= m[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

// 掩膜内的像素占比（分母 = 掩膜内像素数；全图时等于「占全图比例」）
function fracOf(px, o, ctx, pred) {
    const s = scopeOf(px, o, ctx);
    let c = 0;
    if (!s.m) { for (let i = 0; i < px.n; i++) if (pred(i)) c++; }
    else { for (let i = 0; i < px.n; i++) if (s.m[i] && pred(i)) c++; }
    return s.count ? c / s.count : 0;
}

// ---------------------------------------------------------------- 色相（HSB）
// 色相是**环形**量：0° 与 340° 是邻居，不是两端。这里只做两件事：
//   ① 把像素转成 HSB，按「饱和度 × 亮度」加权投进 18 个 20° 等宽桶（灰/黑/白权重趋 0，不进直方图）；
//   ② 直方图之间的比较走 circularL1（可跨 0°/360° 的 L1 运输距离），别用朴素 |a-b| 求和。
const HUE_BINS = 18;                       // 每桶 20°：0~20, 20~40, …, 340~360
const HUE_BIN_DEG = 360 / HUE_BINS;

// HSB 的 H（0~360）。灰（max==min）色相无定义，回 0 兜底——调用方用 sat 权重把它挡在外面。
function hueDeg(r, g, b, mx, mn) {
    if (mx === mn) return 0;
    const d = mx - mn;
    let h;
    if (mx === r) h = (g - b) / d;
    else if (mx === g) h = 2 + (b - r) / d;
    else h = 4 + (r - g) / d;
    h *= 60;
    if (h < 0) h += 360;
    if (h >= 360) h -= 360;
    return h;
}

// 一遍扫像素，同时攒三样东西：18 桶权重、总权重、圆均值用的 (Σw·cos, Σw·sin)。
// 口径（与 warmFrac 对齐）：luma **>=** luma 才算数（暗部不进）；饱和度 < minSat 直接跳过；
// 权重 = sat × val —— 这一条同时是"低饱和不计入"和"权重"的实现，删了它灰图就会开始计数。
// opts.mask 给了就只扫掩膜内（见 buildContentMask）。
function hueAcc(px, o, ctx) {
    const lumaMin = Number.isFinite(Number(o.luma)) ? Number(o.luma) : 40;
    const minSat = Number.isFinite(Number(o.minSat)) ? Number(o.minSat) : 0.15;
    const acc = new Float64Array(HUE_BINS);
    const { data, ch, lum, n } = px;
    const s = scopeOf(px, o, ctx);
    let sumW = 0, cosSum = 0, sinSum = 0;
    for (let i = 0; i < n; i++) {
        if (s.m && !s.m[i]) continue;
        if (lum[i] < lumaMin) continue;
        const p = i * ch;
        const r = data[p], g = ch >= 3 ? data[p + 1] : data[p], b = ch >= 3 ? data[p + 2] : data[p];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        if (!mx) continue;
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const sat = (mx - mn) / mx;
        const val = mx / 255;
        const wgt = (sat >= minSat) ? sat * val : 0;
        if (!(wgt > 0)) continue;
        const h = hueDeg(r, g, b, mx, mn);
        let k = Math.floor(h / HUE_BIN_DEG);
        if (k >= HUE_BINS) k = HUE_BINS - 1;
        acc[k] += wgt;
        sumW += wgt;
        const rad = h * Math.PI / 180;
        cosSum += wgt * Math.cos(rad);
        sinSum += wgt * Math.sin(rad);
    }
    return { acc, sumW, cosSum, sinSum };
}

// 环形 L1（直方图之间的 L1 运输距离，允许跨 0°/360° 边界）：
//   把候选的质量沿色相环搬到目标上，搬过 1 个桶记 1；最后一桶与第一桶相邻。
//   在"从哪个桶切开圆环"里取最省的那种：d = min_cut Σ_{j=1..n-1} |Σ_{i<cut+j}(a_i − b_i)|。
//   单位是**桶**：18 桶时 0~9（半圈）。350°→10° 只花 1，350°→180° 要 8。
// 退化：两边都空（整张灰）→ 0；只有一边空 → 满距离 n/2（不假装"差不多"）。
function circularL1(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) throw new Error('circularL1: 两边都必须是直方图数组');
    const n = a.length;
    if (!n || b.length !== n) throw new Error('circularL1: 直方图长度不一致或为空（' + n + ' vs ' + b.length + '）');
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) {
        const x = Number(a[i]), y = Number(b[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
            throw new Error('circularL1: 第 ' + i + ' 桶不是非负数（' + a[i] + ' / ' + b[i] + '）');
        }
        sa += x; sb += y;
    }
    const half = n / 2;
    if (!(sa > 0) && !(sb > 0)) return 0;
    if (!(sa > 0) || !(sb > 0)) return half;
    let best = Infinity;
    for (let cut = 0; cut < n; cut++) {
        let run = 0, d = 0;
        for (let j = 1; j < n; j++) {
            const i = (cut + j) % n;
            run += a[i] / sa - b[i] / sb;
            d += Math.abs(run);
        }
        if (d < best) best = d;
    }
    return best;
}

// ---------------------------------------------------------------- 提取器注册表
// 约定：fn(px, opts, ref) -> number | null
//   px  候选帧（当前图）的像素视图
//   opts 该提取器自己的参数（来自配置；缺省用 defaults）
//   ref 参考帧的像素视图（只有 needsRef 的提取器用得上；没给 → 返回 null）
// 所有"占比"一律输出 **0~1 的小数**（不是百分数），这样 range 归一化能写成 [0,1]/[0,0.3] 这种直觉区间。
const EXTRACTORS = {
    mean: {
        desc: '平均亮度（Rec709 luma，0~255；给了 opts.mask 就只算掩膜内）',
        defaults: {},
        fn(px, o, ref, ctx) {
            const s = scopeOf(px, o, ctx);
            let sum = 0;
            for (let i = 0; i < px.n; i++) if (!s.m || s.m[i]) sum += px.lum[i];
            return s.count ? +(sum / s.count).toFixed(4) : 0;
        }
    },
    p160: {
        desc: '高光面积：luma > thr 的像素占比（分母 = 掩膜内像素数；0~1）',
        defaults: { thr: 160 },
        fn(px, o, ref, ctx) {
            const thr = o.thr;
            return +fracOf(px, o, ctx, (i) => px.lum[i] > thr).toFixed(5);
        }
    },
    lapVar: {
        desc: '细节能量：Laplacian 方差（只在 luma > luma 的内点上统计；给了 mask 就只算掩膜内内点）',
        defaults: { luma: 40 },
        fn(px, o, ref, ctx) {
            const L = px.lum, { w, h } = px;
            const s = scopeOf(px, o, ctx);
            let sum = 0, sum2 = 0, cnt = 0;
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (s.m && !s.m[i]) continue;
                    if (L[i] <= o.luma) continue;
                    const lap = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w];
                    sum += lap; sum2 += lap * lap; cnt++;
                }
            }
            if (!cnt) return 0;
            const m = sum / cnt;
            return +(sum2 / cnt - m * m).toFixed(2);
        }
    },
    warmFrac: {
        desc: '暖色占比：掩膜内亮像素中 r>rMin 且 r>g*rg 且 g>=b*gb 的比例（0~1）',
        defaults: { luma: 80, rMin: 140, rg: 1.15, gb: 0.9 },
        fn(px, o, ref, ctx) {
            const L = px.lum;
            const { rMin, rg, gb, luma } = o;
            // 分母是"掩膜内的亮像素"，与升级前同口径（升级前 = 全图亮像素）
            const s = scopeOf(px, o, ctx);
            let bright = 0, warm = 0;
            for (let i = 0; i < px.n; i++) {
                if (s.m && !s.m[i]) continue;
                if (L[i] < luma) continue;
                bright++;
                const [r, g, b] = px.rgbAt(i);
                if (r > rMin && r > g * rg && g >= b * gb) warm++;
            }
            return bright ? +(warm / bright).toFixed(4) : 0;
        }
    },
    coldFrac: {
        desc: '冷色占比：luma>luma 且 b>r+delta 的像素比例（分母 = 掩膜内像素数；0~1）',
        defaults: { luma: 20, delta: 8 },
        fn(px, o, ref, ctx) {
            const delta = o.delta;
            return +fracOf(px, o, ctx, (i) => {
                if (px.lum[i] <= o.luma) return false;
                const [r, , b] = px.rgbAt(i);
                return b > r + delta;
            }).toFixed(5);
        }
    },
    hueHist: {
        desc: '色相直方图：18 桶×20°，权重=饱和度×亮度（灰/黑/白不计入），输出和为 1 的数组；整张无彩色 → 18 个 0',
        defaults: { luma: 40, minSat: 0.15 },
        fn(px, o, ref, ctx) {
            const s = hueAcc(px, o, ctx);
            const out = new Array(HUE_BINS).fill(0);
            if (!(s.sumW > 0)) return out;                 // 明确的空直方图（不是 NaN）
            let sum = 0;
            for (let i = 0; i < HUE_BINS; i++) {
                out[i] = +(s.acc[i] / s.sumW).toFixed(6);
                sum += out[i];
            }
            // 四舍五入的残差补回最大的桶：保证和恰为 1，下游 norm/权重才对得上
            let k = 0;
            for (let i = 1; i < HUE_BINS; i++) if (out[i] > out[k]) k = i;
            out[k] = out[k] + (1 - sum);
            return out;
        }
    },
    hueMean: {
        desc: '色相圆均值（0~360；同样按饱和度×亮度加权；整张无彩色 → 0）——给人看报告用的标量',
        defaults: { luma: 40, minSat: 0.15 },
        fn(px, o, ref, ctx) {
            const s = hueAcc(px, o, ctx);
            if (!(s.sumW > 0)) return 0;
            let m = Math.atan2(s.sinSum, s.cosSum) * 180 / Math.PI;
            m = ((m % 360) + 360) % 360;
            const r = +m.toFixed(2);
            return r >= 360 ? 0 : r;                       // 359.999° 四舍五入成 360 会破坏 0~360 口径
        }
    },
    cov: {
        desc: '亮区面积：luma > luma 的像素占比（0~1；掩膜内分母 = 掩膜内像素数）',
        defaults: { luma: 40 },
        fn(px, o, ref, ctx) {
            const luma = o.luma;
            return +fracOf(px, o, ctx, (i) => px.lum[i] > luma).toFixed(5);
        }
    },
    maskIoU: {
        desc: '亮区掩码重叠率：|A∩B|/|A∪B|（luma>luma；A=候选，B=参考帧；给了 mask 时 ROI = 两帧掩膜的并集）',
        defaults: { luma: 40 },
        needsRef: true,
        fn(px, o, ref, ctx) {
            if (!ref) return null;
            if (ref.w !== px.w || ref.h !== px.h) throw new Error('maskIoU: 参考帧尺寸不一致 ' + px.w + 'x' + px.h + ' vs ' + ref.w + 'x' + ref.h);
            const a = px.mask(o.luma), b = ref.mask(o.luma);
            const sa = scopeOf(px, o, ctx), sb = scopeOf(ref, o, ctx);
            let inter = 0, uni = 0;
            for (let i = 0; i < px.n; i++) {
                // ROI 取两帧掩膜的并集：任一边认为"是内容"的像素都要进分母，
                // 否则主体在候选帧里整块塌掉时 IoU 会被 ROI 自己漂白。
                const inRoi = (sa.m ? sa.m[i] : 1) || (sb.m ? sb.m[i] : 1);
                if (!inRoi) continue;
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
        fn(px, o, ref, ctx) {
            const s = scopeOf(px, o, ctx);
            let bb;
            if (!s.m) bb = px.bbox(o.luma);
            else {
                // 掩膜内重算（px.bbox 的缓存是"全图 + luma"口径，不能复用）
                let x0 = px.w, y0 = px.h, x1 = -1, y1 = -1, cnt = 0;
                for (let y = 0; y < px.h; y++) {
                    for (let x = 0; x < px.w; x++) {
                        const i = y * px.w + x;
                        if (!s.m[i] || !(px.lum[i] > o.luma)) continue;
                        cnt++;
                        if (x < x0) x0 = x; if (x > x1) x1 = x;
                        if (y < y0) y0 = y; if (y > y1) y1 = y;
                    }
                }
                bb = { x0, y0, x1, y1, w: x1 >= 0 ? x1 - x0 + 1 : 0, h: y1 >= 0 ? y1 - y0 + 1 : 0, cnt };
            }
            const f = o.field || 'w';
            if (f === 'w') return bb.w;
            if (f === 'h') return bb.h;
            if (f === 'area') return bb.w * bb.h;
            if (f === 'aspect') return bb.h ? +(bb.w / bb.h).toFixed(4) : 0;
            if (f === 'fill') return (bb.w * bb.h) ? +(bb.cnt / (bb.w * bb.h)).toFixed(4) : 0;
            throw new Error('bbox: 不认识的 field=' + f + '（w/h/area/aspect/fill）');
        }
    },
    // ------------------------------------------------------------ 0.11.0 新增：专测「剁档 / 噪点」
    // 这两条是两条实验逼出来的：老的 posterize 类指标（posterizeRatio/hueBands/flatNoise）
    // 对肉眼可见的硬切档只有噪声级反应，其中 flatNoise 甚至是零响应——它的"3×3 极差 <8"
    // 门限把噪点／台阶边自己的像素排除掉了（结构性盲区）。下面两条各自换个打法：
    //   stepRatio   → 看**亮度直方图的断崖**（台阶是直方图上的空档，跟像素位置无关）；
    //   speckleFrac → 看**像素与自己 8 邻域中位数的差**（没有 3×3 门限，孤立点自己就是证据）。
    //
    // ⚠ 0.12.0 口径降级（有实验证据，别让下一个人再把它当细节指标）：
    //   第二轮正对照失败——高斯模糊 lapVar −99.7% / 锐化 +169%（剂量单调、方向正确），
    //   而 stepRatio 在**模糊和锐化两个相反方向上同向下降**（−49~−80% 与 −51~−81%）。
    //   一个在"变平"和"变细"时都下降的量，量的不是"细节量"，而是"直方图断崖"（量化/剁档）。
    //   所以：**只许当量化代理，不得用于"更平/更细"的判断**。细节用 lapVar（须过双向正对照）。
    stepRatio: {
        desc: '量化/剁档代理（**不测细节**）：256 桶 luma 直方图里「断崖」数 / 非空 bin 数（越高越像硬切档；0=连续渐变）',
        // minBinPct 是**占比**（0.0005 = 0.05% 的像素数），dropRatio 是「下一桶掉到上一桶的这个比例以下」。
        // 断崖判据 bin[i] > 0.05% 且 bin[i+1] < bin[i]×0.1 是实验里 P/R 正对照标定出来的量级。
        defaults: { minBinPct: 0.0005, dropRatio: 0.1 },
        fn(px, o, ref, ctx) {
            const s = scopeOf(px, o, ctx);
            const bins = new Float64Array(256);
            let total = 0;
            const L = px.lum;
            if (!s.m) {
                for (let i = 0; i < px.n; i++) { let v = Math.round(L[i]); if (v < 0) v = 0; else if (v > 255) v = 255; bins[v]++; total++; }
            } else {
                for (let i = 0; i < px.n; i++) { if (!s.m[i]) continue; let v = Math.round(L[i]); if (v < 0) v = 0; else if (v > 255) v = 255; bins[v]++; total++; }
            }
            if (!total) return 0;
            const drop = Number.isFinite(Number(o.dropRatio)) ? Number(o.dropRatio) : 0.1;
            const minCnt = (Number.isFinite(Number(o.minBinPct)) ? Number(o.minBinPct) : 0.0005) * total;
            let nonEmpty = 0, cliffs = 0;
            for (let i = 0; i < 256; i++) if (bins[i] > 0) nonEmpty++;
            for (let i = 0; i < 255; i++) {
                if (bins[i] > minCnt && bins[i + 1] < bins[i] * drop) cliffs++;
            }
            return nonEmpty ? +(cliffs / nonEmpty).toFixed(5) : 0;
        }
    },
    levelCount: {
        desc: '量化代理（**不测细节**）：掩膜内**唯一 luma 取值数**（取整后去重；量化越重越少）。注意它是"取值个数"，dither 会把它填向满值（与 stepRatio 填断崖同向）',
        defaults: {},
        fn(px, o, ref, ctx) {
            const s = scopeOf(px, o, ctx);
            const seen = new Uint8Array(256);
            const L = px.lum;
            let cnt = 0, distinct = 0;
            for (let i = 0; i < px.n; i++) {
                if (s.m && !s.m[i]) continue;
                let v = Math.round(L[i]);
                if (v < 0) v = 0; else if (v > 255) v = 255;
                cnt++;
                if (!seen[v]) { seen[v] = 1; distinct++; }
            }
            return cnt ? distinct : 0;
        }
    },
    speckleFrac: {
        desc: '孤立点占比：掩膜内像素与其 8 邻域 luma 中位数之差 > speckleDelta 的比例（越高越像噪点）',
        defaults: { speckleDelta: 24 },
        fn(px, o, ref, ctx) {
            const s = scopeOf(px, o, ctx);
            const L = px.lum, { w, h } = px;
            const d = Number.isFinite(Number(o.speckleDelta)) ? Number(o.speckleDelta) : 24;
            const nb = new Float64Array(8);
            let isol = 0, cnt = 0;
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (s.m && !s.m[i]) continue;
                    cnt++;
                    let k = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            if (!dx && !dy) continue;
                            nb[k++] = L[i + dy * w + dx];
                        }
                    }
                    // 8 个邻居的中位数（偶数个 → 第 4、5 小取均值）：中位数对"自己是尖点"免疫，
                    // 所以孤立点一定被推出来，而平坦区/连续渐变里差值恒≈0。
                    for (let a = 1; a < 8; a++) {
                        const v = nb[a];
                        let b = a - 1;
                        while (b >= 0 && nb[b] > v) { nb[b + 1] = nb[b]; b--; }
                        nb[b + 1] = v;
                    }
                    const med = (nb[3] + nb[4]) / 2;
                    if (Math.abs(L[i] - med) > d) isol++;
                }
            }
            return cnt ? +(isol / cnt).toFixed(5) : 0;
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
        hueMean: EXTRACTORS.hueMean.fn(px, EXTRACTORS.hueMean.defaults),
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
    const ctx = {};                                   // 掩膜回执：哪个提取器退回了全图
    for (const p of plan) {
        out[p.id] = EXTRACTORS[p.extract].fn(px, p.opts, refPx, ctx);
        used[p.id] = p.extract;
    }
    // 掩膜相关回执（0.11.0 / 0.12.0）：一旦某个带 mask 的提取器退回全图，就在**这张图的返回对象**上标出来。
    // 不许静默——"以为在量主体、其实在量整帧"就是这两条实验最初的病灶。
    // 0.12.0 追加 maskSuspicious：圈到了小块高光（面积 <1% 或 bbox <5%）也是一等公民的回执，不许只看数字。
    if (ctx.maskSeen) {
        out.maskInfo = ctx.maskInfo;
        if (ctx.maskFallback) out.maskFallback = true;
        if (ctx.maskSuspicious) {
            out.maskSuspicious = true;
            out.maskSuspectReasons = ctx.maskSuspectReasons;
        }
        if (ctx.maskWarn && ctx.maskWarn.length) out.maskWarn = ctx.maskWarn;
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
module.exports = { EXTRACTORS, resolvePlan, planText, extractOne, decodePng, makePx, diagnostics, circularL1, hueAcc, buildContentMask, scopeOf, MASK_DEFAULTS, HUE_BINS, HUE_BIN_DEG };
