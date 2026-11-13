// 写护栏：**唯一真相**。apply.js / apply_params.js 都 require 它，iter.ps1 的 Test-PathUnder 与它同语义。
//
// 为什么单独一个文件：以前"拒写本体"这段逻辑被复制在 apply.js:23 与 apply_params.js:24 两份里，
// 正则还不一致（一份只拦某类工具目录、一份连资产目录一起拦），于是同一份镜像在两种宿主下结论相反。
// 再复制一次 --protect 的解析，第三次分叉只是时间问题。
//
// 口径（与 iter.ps1 的 Test-PathUnder 逐条对齐）：
//   ① 绝对化 → 父目录存在就先 realpath（防 junction 把 _镜像 指回本体）→ Windows 下小写 → 去尾分隔符；
//   ② subtree：等值 **或** 位于其下，按**路径段边界**比较（…\a\b 不匹配 …\a\bc）；
//   ③ Windows 下忽略大小写，其他平台区分（platform 可注入，测试才不用真跑在 Windows 上）。
'use strict';
const fs = require('fs');
const path = require('path');

const nativeSep = (platform) => (platform === 'win32' ? '\\' : '/');

// 归一：绝对化 → 父目录存在就 realpath（防 junction 把 _镜像 指回本体）→ win32 小写 → 去尾分隔符
function normPath(p, platform) {
    const plat = platform || process.platform;
    const abs = path.resolve(String(p));
    const dir = path.dirname(abs);
    let real = abs;
    try { real = path.join(fs.realpathSync(dir), path.basename(abs)); } catch { /* 父目录不在就用字面量 */ }
    const sep = nativeSep(plat);
    let out = plat === 'win32' ? real.replace(/\//g, '\\') : real;
    if (out.length > sep.length && out.endsWith(sep)) out = out.slice(0, -sep.length);
    return plat === 'win32' ? out.toLowerCase() : out;
}

// subtree：等值 或 位于其下（按路径段边界，…\a\b 不匹配 …\a\bc）
function isUnder(child, root, platform) {
    const plat = platform || process.platform;
    const c = normPath(child, plat);
    const r = normPath(root, plat);
    if (c === r) return true;
    return c.startsWith(r + nativeSep(plat));
}

// 返回命中的那条 protectPath（**声明里的原串**，不是归一化后的），没有命中回 null
function hitProtect(target, protectPaths, opts) {
    const platform = (opts && opts.platform) || process.platform;
    for (const p of protectPaths || []) {
        if (!p) continue;
        if (isUnder(target, p, platform)) return p;
    }
    return null;
}

// 从 argv 里摘 --protect（可重复），返回 { protect, rest }；rest 给 --del 之类用（否则 --protect 的值会被当兄弟扫到）
function splitProtectFlags(flags) {
    const protect = [];
    const rest = [];
    const list = flags || [];
    for (let i = 0; i < list.length; i += 1) {
        if (list[i] === '--protect') {
            if (list[i + 1]) protect.push(list[i + 1]);
            i += 1;
            continue;
        }
        rest.push(list[i]);
    }
    return { protect, rest };
}

module.exports = { normPath, isUnder, hitProtect, splitProtectFlags };
