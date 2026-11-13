// T3 迭代器 · 改参：从纯净基线重写一份 vfx.json 到镜像，只改 effects.<Effect>.<Block> 的指定键
//
// 用法：
//   node apply.js <base.json> <out.json> <Effect> <Block> '<patchJSON>' [--del k1,k2] [--protect <dir>]...
//   例：node apply.js out\base\vfx.json runs\r1\mirror\vfx.json FireRay fireBeamG1M1 '{"widthPx":57.6}' --protect <本体 client 目录>
//
// 三条硬约束（都来自 E0/E2 的实测坑）：
//   ① 每次从基线重来，不做累加 —— 否则轨迹被污染，"参数 -> 距离"就不是单值函数了；
//   ② 写完必须回读自校验 —— writeFileSync 写坏/写 0 字节不会自己报错；
//   ③ 只改目标块，块外一个字节不动 —— 用整文档指纹校验（E2 §2.1 的教训：改错块 = 画面零变化）。
//
// 铁律：out 不许落在 `--protect` 声明的任何路径下（含子目录），也不许指向 base 本身。
// 写入禁区由 **adapter.guard.protectPaths** 声明、iter.ps1 负责传进来（可重复给）：
//   node apply.js ... --protect "%VFX_LOOP_BODY_CLIENT%" --protect "..\_本体\client"
// 直接调用这个脚本而不传 --protect，就等于放弃了"拒写本体"这道硬护栏（只保证 out≠base）。
// 判定逻辑全在 writeguard.js（与 apply_params.js 共用同一份，别再复制第二份正则）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normPath, hitProtect, splitProtectFlags } = require('./writeguard');

const [base, out, effect, block, patchRaw, ...flags] = process.argv.slice(2);
if (!base || !out || !effect || !block) {
    console.error('用法: node apply.js <base> <out> <Effect> <Block> <patchJSON> [--del k1,k2] [--protect <dir>]...');
    process.exit(2);
}
// --protect 必须出现在 patch 之后（与 --del 同一约定）：前面几个位置参数是固定的
const { protect, rest } = splitProtectFlags(flags);
const hit = hitProtect(out, protect);
if (hit) {
    console.error('拒写：out 落在保护路径 ' + hit + '（out=' + path.resolve(out) + '）—— 检查 adapter.guard.protectPaths 与 clientRoot/-Mirror');
    process.exit(3);
}
if (normPath(base) === normPath(out)) { console.error('拒写：out 不能等于 base（两者是同一个文件）'); process.exit(3); }

const patch = patchRaw ? JSON.parse(patchRaw) : {};
let dels = [];
const di = rest.indexOf('--del');
if (di >= 0 && rest[di + 1]) dels = rest[di + 1].split(',').filter(Boolean);

const src = fs.readFileSync(base, 'utf8');
const j = JSON.parse(src);
const blk = j.effects && j.effects[effect] && j.effects[effect][block];
if (!blk) { console.error('基线缺 effects.' + effect + '.' + block); process.exit(4); }

for (const [k, v] of Object.entries(patch)) blk[k] = v;
for (const k of dels) delete blk[k];

fs.writeFileSync(out, JSON.stringify(j, null, 2), 'utf8');

// ---- 回读自校验 ----
const backTxt = fs.readFileSync(out, 'utf8');
const back = JSON.parse(backTxt);
const bb = back.effects && back.effects[effect] && back.effects[effect][block];
if (!bb) { console.error('回读缺块'); process.exit(5); }

const bad = [];
for (const [k, v] of Object.entries(patch)) {
    if (JSON.stringify(bb[k]) !== JSON.stringify(v)) bad.push(k + ' want=' + JSON.stringify(v) + ' got=' + JSON.stringify(bb[k]));
}
for (const k of dels) if (k in bb) bad.push('del-fail ' + k);

// 块外零改动：拿基线原文重新解析一次，逐个块 stringify 对比（j 已被就地修改，不能拿它当基线）
(function checkOutside() {
    const j0 = JSON.parse(src);
    const e0 = j0.effects, e1 = back.effects;
    const k0 = Object.keys(e0), k1 = Object.keys(e1);
    if (k0.join() !== k1.join()) { bad.push('effects 键集变了'); return; }
    for (const ef of k0) {
        const b0 = Object.keys(e0[ef]), b1 = Object.keys(e1[ef]);
        if (b0.join() !== b1.join()) { bad.push('effects.' + ef + ' 块集变了'); continue; }
        for (const bk of b0) {
            if (ef === effect && bk === block) continue;
            if (JSON.stringify(e0[ef][bk]) !== JSON.stringify(e1[ef][bk])) bad.push('块外被改: ' + ef + '.' + bk);
        }
    }
})();

const sz = fs.statSync(out).size;
// 阈值是**自适应**的（原来写死 20000B = "某项目的 vfx.json 大概 30KB"这个项目事实）：
// 任何小配置都会被它判成"写坏"，几十字节的示例配置直接跑不起来。真写坏了有两道更硬的兜底：
// JSON 回读（写 0 字节/截断会抛）+ 块外零改动指纹。
if (sz < 0.5 * Buffer.byteLength(src, 'utf8')) bad.push('输出过小 ' + sz + 'B（基线 ' + Buffer.byteLength(src, 'utf8') + 'B，疑似写坏）');
if (bad.length) { console.error('回读不一致: ' + bad.join('; ')); process.exit(6); }

const md5 = crypto.createHash('md5').update(backTxt).digest('hex').toUpperCase().slice(0, 8);
console.log('OK patched=' + Object.keys(patch).length + ' del=' + dels.length + ' keys=' + Object.keys(bb).length + ' size=' + sz + ' md5=' + md5);
