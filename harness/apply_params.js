// P2.6 · 改参（扁平 params 形态，对应 apply.js 的 vfx-block 形态）
//
// 有些宿主的配置不是 vfx.json 里 effects.<Effect>.<Block> 那套，而是"一份扁平 {params:{...}} json"
// （例如任何把自己的旋钮摊在 params 下的页面自建宿主）。这个文件补上那种形态，
// 让 iter.ps1 只靠 adapter.config.format 就能吃两种宿主，脚本本身不分辨。
//
// 用法：node apply_params.js <base.json> <out.json> '<patchJSON>' [--protect <dir>]...
//
// 三条硬约束与 apply.js 相同（E0/E2 的坑）：
//   ① 每次从纯净基线重写，不累加 —— 否则轨迹被污染；
//   ② 写完回读自校验 —— writeFileSync 写坏/写 0 字节不会自己报错；
//   ③ 只改 params.*，顶层元数据（name/source/note）一个字节不动。
// 另一条：patch 里的键必须已存在于基线 params 里 —— 打错一个字母会静默加死键，画面零变化却无报错。
// 铁律（与 apply.js 同一份实现，见 writeguard.js）：out 不许落在 `--protect` 声明的任何路径下，也不许等于 base。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normPath, hitProtect, splitProtectFlags } = require('./writeguard');

const [base, out, patchRaw, ...flags] = process.argv.slice(2);
if (!base || !out) {
    console.error('用法: node apply_params.js <base> <out> <patchJSON> [--protect <dir>]...');
    process.exit(2);
}
const { protect } = splitProtectFlags(flags);
const hit = hitProtect(out, protect);
if (hit) {
    console.error('拒写：out 落在保护路径 ' + hit + '（out=' + path.resolve(out) + '）—— 检查 adapter.guard.protectPaths 与 clientRoot/-Mirror');
    process.exit(3);
}
if (normPath(base) === normPath(out)) { console.error('拒写：out 不能等于 base（两者是同一个文件）'); process.exit(3); }

const patch = patchRaw ? JSON.parse(patchRaw) : {};
const src = fs.readFileSync(base, 'utf8');
const j = JSON.parse(src);
const root = (j && j.params) ? j.params : j;
if (!root || typeof root !== 'object') { console.error('基线缺 params 对象'); process.exit(4); }

const bad = [];
for (const k of Object.keys(patch)) {
    if (!(k in root)) bad.push('未知键 ' + k);
    else if (typeof root[k] !== 'number') bad.push('非数值键 ' + k);
}
if (bad.length) { console.error('patch 不合法: ' + bad.join('; ')); process.exit(4); }
for (const [k, v] of Object.entries(patch)) root[k] = v;

fs.writeFileSync(out, JSON.stringify(j, null, 2), 'utf8');

// ---- 回读自校验 ----
const backTxt = fs.readFileSync(out, 'utf8');
const back = JSON.parse(backTxt);
const backRoot = (back && back.params) ? back.params : back;
const errs = [];
for (const [k, v] of Object.entries(patch)) {
    if (backRoot[k] !== v) errs.push(k + ' want=' + v + ' got=' + backRoot[k]);
}
if (j && j.params) {
    for (const k of ['name', 'source', 'note']) {
        if (k in j && JSON.stringify(back[k]) !== JSON.stringify(j[k])) errs.push('元数据被改: ' + k);
    }
    if (Object.keys(backRoot).length !== Object.keys(root).length) errs.push('键数变了');
}
const sz = fs.statSync(out).size;
// 与 apply.js 同口径的自适应阈值（原来写死 200B）：拿基线自身大小当尺子，小配置不会被"写坏"判死
if (sz < 0.5 * Buffer.byteLength(src, 'utf8')) errs.push('输出过小 ' + sz + 'B（基线 ' + Buffer.byteLength(src, 'utf8') + 'B，疑似写坏）');
if (errs.length) { console.error('回读不一致: ' + errs.join('; ')); process.exit(6); }

const md5 = crypto.createHash('md5').update(backTxt).digest('hex').toUpperCase().slice(0, 8);
console.log('OK patched=' + Object.keys(patch).length + ' keys=' + Object.keys(backRoot).length + ' size=' + sz + ' md5=' + md5);
