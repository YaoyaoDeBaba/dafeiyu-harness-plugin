#!/usr/bin/env node
// capture.mjs —— 「浏览器 + 页面 + 截图」边界（P1 适配层第二步：为插件版铺路）
//
// ============================================================================
// 这是全流程里**唯一**碰浏览器/CDP 的地方。项目语义（改哪份 vfx.json、播哪个特效、
// 冻到第几毫秒、画质档怎么打补丁）都不在这里，只在 iter.ps1 里。
//
// 引擎（P3）：同一份协议下有两个内部实现，默认 edge（老调用一行不用改）。
//   --engine edge         Edge + CDP（原实现，默认）
//   --engine playwright   Playwright 自带 Chromium（本文件内部替换，协议逐字段不变）
//
//   直接调用边界：node capture.mjs --engine playwright
//   整条产线跑：  $env:DSH_CAPTURE_ENGINE='playwright'   （capture.ps1 按纪律冻结，只 node <path>，
//                 所以用它把引擎选择透传进来；两者是同一个变量，优先级 --engine > 环境变量 > edge）
//
// 两个引擎的对外协议完全一致：
//   start    -> edge: spawn + 等 CDP；playwright: chromium.launchPersistentContext(headless)
//   viewport -> page.setViewportSize()
//   goto     -> page.goto(url) + 轮询 readyExpr
//   eval     -> page.evaluate(expr)
//   waitfor  -> 轮询 page.evaluate(expr) 直到等于 want
//   shot     -> page.screenshot({ path })
//   stop     -> browser.close()
//
// ---------------------------------------------------------------------------
// 协议：stdin 每行一个 JSON（NDJSON），stdout 每行一个 JSON 响应，id 一一对应。
//   请求                         响应
//   {id,cmd:"start",              {id,ok:true,pid,wsUrl}
//    exe,args:[...],w,h,          args 里的占位符由调用方替换好再传：
//    cdpPort,profile,}            {width} {height} {cdpPort} {profile}
//    profileRoot}                 profileRoot = 本包的临时 profile 根（启动清孤儿的范围）
//   {id,cmd:"viewport",w,h}       {id,ok:true}
//   {id,cmd:"goto",url,           {id,ok:true,ready:bool,waitedMs,val}
//    readyExpr,timeoutMs}
//   {id,cmd:"waitfor",expr,       {id,ok:true,hit:bool,ms,val}
//    want,timeoutMs}
//   {id,cmd:"eval",expr}          {id,ok:true,status:"ok"|"exc"|"noresp",value}
//   {id,cmd:"shot",path}          {id,ok:true,bytes}
//   {id,cmd:"stop"}               {id,ok:true,leftover,pids:[]}
// 出错一律 {id,ok:false,err:"..."}，进程不退出（调用方自己决定要不要 abort）。
// 进程级纪律：stderr 不接管诊断输出（一律走协议行），stdin 关闭即自动收尾退出。
//
// 浏览器生命周期（孤儿三件套，评审 §4.1）：
//   ① 父进程死亡看门狗：每 10s 查一次 capture.mjs 还在不在，父没了就杀整棵树（宿主被强杀时唯一的兜底）；
//   ② 关闭时杀整棵树：browser.close() 只是"请求"，taskkill /T /F 才带得走 renderer/gpu；
//   ③ 启动时清孤儿：只杀「--user-data-dir 指向我们自己的 profile 根」且「父进程已不存在」的进程。
// 判据是"父进程/连接没了"，不是"跑了多久"；绝不 Get-Process msedge | Stop-Process -Force。
// ============================================================================
'use strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 引擎选择
// 优先级：--engine <name> / --engine=<name> > 环境变量 DSH_CAPTURE_ENGINE > 默认 edge。
// 环境变量这条是为了不破坏被冻结的调用方（capture.ps1 执行 `node capture.mjs`，不带参数）。
function resolveEngine(argv) {
    let v = '';
    for (let i = 0; i < argv.length; i++) {
        const a = String(argv[i]);
        if (a === '--engine') { v = String(argv[i + 1] || ''); break; }
        if (a.startsWith('--engine=')) { v = a.slice('--engine='.length); break; }
    }
    if (!v) v = String(process.env.DSH_CAPTURE_ENGINE || '');
    v = v.trim().toLowerCase();
    if (!v) return { engine: 'edge', err: '' };
    if (v === 'edge' || v === 'playwright') return { engine: v, err: '' };
    return { engine: 'edge', err: '未知引擎 --engine ' + v + '（只有 edge | playwright）' };
}

const enginePick = resolveEngine(process.argv.slice(2));
const engine = enginePick.engine;
if (enginePick.err) process.stderr.write('[capture] ' + enginePick.err + '\n');
else process.stderr.write('[capture] engine=' + engine + '\n');

// 平台守卫（Windows 专用，与 iter.ps1 / capture.ps1 同一句话）：这里 spawn pwsh、跑 taskkill、
// 读 Win32_Process —— 非 Windows 上全都不存在。start 时立刻回一条中文错误，不拖着等超时。
const PLATFORM_ERR =
  '本适配器需要 Windows（harness 基于 PowerShell + Edge）；当前平台 ' + process.platform + ' 不受支持。';
if (process.platform !== 'win32') process.stderr.write('[capture] ' + PLATFORM_ERR + '\n');

let child = null;          // 自己起的浏览器进程（edge）
let pid = 0;
let ws = null;             // CDP 连接（edge）
let profileDir = '';       // 本 run 独占的 profile（收尾按它精确扫）
let profileRoot = '';      // 本包的 profile 根（启动清孤儿只在这个目录下动手）
let sweptOrphans = false;  // 一次 run 只清一次孤儿
let msgId = 0;
const pending = new Map();

// 看门狗（父进程死亡守卫）状态
let watchdogProc = null;
let watchdogFile = '';
const WATCHDOG_INTERVAL_SEC = 10;   // 评审 §4.1 给的口径：每 10 秒问一次父进程还在不在
const WATCHDOG_MAX_MINUTES = 720;   // 上限 12h：看门狗自己也不许变成"永不退出的孤儿"

// Playwright 侧状态（懒加载：默认 edge 路径完全不 require playwright）
let pw = null;             // playwright 模块
let pwContext = null;      // BrowserContext（launchPersistentContext 的返回值）
let pwPage = null;         // 当前 page
let pwBrowserPid = 0;

// ---------------------------------------------------------------- 输出
// 协议行一律 ASCII（非 ASCII 转成 \uXXXX）：调用方（PowerShell 管道）用哪种代码页读都不会乱码。
function send(obj) {
  try {
    const line = JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    process.stdout.write(line + '\n');
  } catch { /* 调用方已走 */ }
}

// ---------------------------------------------------------------- CDP（edge 引擎）
function onMessage(ev) {
  let m;
  try {
    m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
  } catch { return; }
  if (m && m.id != null && pending.has(m.id)) {
    const cb = pending.get(m.id);
    pending.delete(m.id);
    cb(m);
  }
}

function cdp(method, params, timeoutMs = 60000) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve(null);
    const id = ++msgId;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      pending.delete(id);
      resolve(null);          // 超时 = 原 PS 版 Req 返回 $null
    }, timeoutMs);
    pending.set(id, (m) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(m);
    });
    const payload = { id, method };
    if (params !== undefined && params !== null) payload.params = params;
    try { ws.send(JSON.stringify(payload)); }
    catch { clearTimeout(timer); pending.delete(id); resolve(null); }
  });
}

// 与旧 EvalJs 逐字对齐：ok -> 原值；抛异常 -> 'EXC:'+text；无响应 -> null
async function evalExpr(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
  if (r === null) return { status: 'noresp', value: null };
  if (r.result && r.result.exceptionDetails) return { status: 'exc', value: 'EXC:' + r.result.exceptionDetails.text };
  return { status: 'ok', value: r.result && r.result.result ? r.result.result.value : null };
}

// ---------------------------------------------------------------- Playwright（playwright 引擎）
// Playwright 装在插件原型目录（P3 纪律：只在 _临时\插件原型\ 里装依赖）。
// 解析顺序：DSH_PLAYWRIGHT_MODULE > 插件原型目录 > capture.mjs 上级 > capture.mjs 同目录 > 裸名。
function playwrightBases() {
  return [
    String(process.env.DSH_PLAYWRIGHT_MODULE || ''),
    path.resolve(here, '..', '..', '插件原型', 'vfx-loop-plugin'),
    path.resolve(here, '..'),
    here
  ].filter(Boolean);
}

async function getPlaywright() {
  if (pw) return pw;
  const errs = [];
  for (const base of playwrightBases()) {
    try {
      const req = createRequire(path.join(base, '__capture_resolve__.cjs'));
      const m = req('playwright');
      if (m && m.chromium) { pw = m; return pw; }
      errs.push(base + ': 模块里没有 chromium');
    } catch (e) {
      errs.push(base + ': ' + String((e && e.message) || e).split('\n')[0]);
    }
  }
  try {
    const m = await import('playwright');
    if (m && m.chromium) { pw = m; return pw; }
  } catch (e) {
    errs.push('bare: ' + String((e && e.message) || e).split('\n')[0]);
  }
  throw new Error('playwright 加载失败（--engine playwright 需要先 npm i playwright + npx playwright install chromium）: ' + errs.join(' | '));
}

// 首装成本要显形（评审 §4.2）：Chromium 不在包里，第一次要联网下载。
// 失败时必须把「为什么 + 怎么办」直接写在返回的错误里，不能只留在某个 _install-chromium.log 里。
function chromiumMissingMessage(detail) {
  return [
    'Chromium 没装（playwright 引擎要它，Edge 引擎不需要）。',
    '首装成本：Chromium 约 740 MB（只要无头版约 290 MB），一次性下载到用户级缓存，不进包。',
    '失败原因：' + (detail || '找不到可执行文件'),
    '怎么补：在包目录下执行  npx playwright install chromium',
    '         只要无头（省约 450 MB）  npx playwright install --only-shell chromium',
    '         下载慢/被墙先设  PLAYWRIGHT_DOWNLOAD_HOST=<镜像地址>  再执行上面那条',
    '         不想装也行：用 Edge 引擎（默认就是它），别传 --engine playwright / 别设 DSH_CAPTURE_ENGINE=playwright',
  ].join('\n');
}

// Chromium 是否缺：Playwright 的 executablePath() 在"没下载"时也给路径，所以必须 existsSync 判。
function chromiumExecutableMissing(chromium) {
  let exe = '';
  try { exe = String(chromium.executablePath() || ''); } catch { return { missing: false, exe: '' }; }
  if (!exe) return { missing: false, exe: '' };
  return { missing: !fs.existsSync(exe), exe };
}

// adapter 里的 args 是给 Edge 的整条命令行。交给 Playwright 时只保留"渲染相关"的 flag：
//   - --user-data-dir 由 launchPersistentContext(profile) 接管
//   - --remote-debugging-port 由 Playwright 自己的 pipe 接管（也不该再占端口）
//   - --window-size / --headless / about:blank 由 Playwright 接管
function playwrightArgs(args) {
  return (args || []).map(String).filter((a) => {
    if (!a) return false;
    if (/^about:blank$/i.test(a)) return false;
    if (/^--user-data-dir=/i.test(a)) return false;
    if (/^--remote-debugging-/i.test(a)) return false;
    if (/^--window-size=/i.test(a)) return false;
    if (/^--headless(=|$)/i.test(a)) return false;
    return true;
  });
}

// Playwright 的 evaluate：字符串按页面内 eval 执行（多语句 / IIFE 都行，与 CDP Runtime.evaluate 同一语义）。
// 导航瞬间可能 "Execution context was destroyed" —— 按"无响应"返回，让上层轮询继续，不直接判失败。
async function evalPw(expr) {
  if (!pwPage) return { status: 'noresp', value: null };
  try {
    const v = await pwPage.evaluate(String(expr));
    return { status: 'ok', value: v === undefined ? null : v };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/Execution context was destroyed|navigat|Target (page|closed)|frame was detached|Cannot find context|browser has been closed/i.test(msg)) {
      return { status: 'noresp', value: null };
    }
    return { status: 'exc', value: 'EXC:' + msg.split('\n')[0] };
  }
}

async function startPlaywright(o) {
  const { chromium } = await getPlaywright();
  profileDir = String(o.profile || '');
  if (!profileDir) return { ok: false, err: 'start 缺 profile' };
  // 先自己查一遍有没有 Chromium：直接让 launch 抛的原话是 "Executable doesn't exist at ..."，
  // 对用户没有任何补救信息。这里换成中文的「多大 / 怎么装 / 不装怎么办」。
  const ck = chromiumExecutableMissing(chromium);
  if (ck.missing) return { ok: false, err: chromiumMissingMessage('缺可执行文件：' + ck.exe) };
  fs.mkdirSync(profileDir, { recursive: true });
  const w = Number(o.w) || 640;
  const h = Number(o.h) || 360;
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: playwrightArgs(o.args),
      viewport: { width: w, height: h },
      deviceScaleFactor: 1
    });
  } catch (e) {
    const first = String((e && e.message) || e).split('\n')[0];
    if (/Executable doesn'?t exist|playwright install|browserType\.launch|is not found at/i.test(first)) {
      return { ok: false, err: chromiumMissingMessage(first) };
    }
    return { ok: false, err: 'playwright 起浏览器失败: ' + first };
  }
  pwContext = ctx;
  // Playwright 1.65 的 browser.process() 已不可用（持久上下文返回的 Browser 上没有该方法），
  // 所以按 profile 精确扫自己的浏览器进程拿 PID（进程名可能是 chrome.exe / chrome-headless-shell.exe）。
  try {
    const b = ctx.browser();
    pwBrowserPid = (b && typeof b.process === 'function' && b.process() && b.process().pid) || 0;
  } catch { pwBrowserPid = 0; }
  for (let i = 0; i < 20 && !pwBrowserPid; i++) {
    const ps = edgePidsByProfile();
    if (ps.length) pwBrowserPid = ps[0];
    else await sleep(100);
  }
  if (!pwBrowserPid) process.stderr.write('[capture] 没扫到 Playwright 浏览器 PID（profile=' + profileDir + '）\n');
  pwPage = ctx.pages()[0] || await ctx.newPage();
  await pwPage.setViewportSize({ width: w, height: h });
  pid = pwBrowserPid;               // 与 edge 共用同一套收尾（taskkill /T /F）
  startWatchdog(pwBrowserPid);      // 父进程没了就把这棵树带走（宿主被强杀时 finally 不会跑）
  return { ok: true, pid: pwBrowserPid, wsUrl: 'playwright://' + (pwBrowserPid || 'local') };
}

// ---------------------------------------------------------------- 进程扫尾
// 只认 CommandLine 里带本 run profile 绝对路径的进程；用临时文件取 PID，避免管道 stdio。
// 浏览器进程名覆盖 msedge / chrome / chromium / headless_shell（Playwright 的 Chromium 也叫 chrome.exe）。
function edgePidsByProfile() {
  if (!profileDir) return [];
  const tmp = path.join(os.tmpdir(), `dsh-cap-sweep-${process.pid}-${Date.now()}.txt`);
  const ps = [
    'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\' OR Name=\'chrome.exe\' OR Name=\'chrome-headless-shell.exe\' OR Name=\'chromium.exe\' OR Name=\'headless_shell.exe\'" -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:DSH_CAP_PROFILE) } |',
    '  ForEach-Object { $_.ProcessId } |',
    '  Out-File -FilePath $env:DSH_CAP_OUT -Encoding utf8'
  ].join('\n');
  try {
    spawnSync('pwsh', ['-NoProfile', '-Command', ps], {
      stdio: 'ignore',
      env: Object.assign({}, process.env, { DSH_CAP_PROFILE: profileDir, DSH_CAP_OUT: tmp })
    });
    if (!fs.existsSync(tmp)) return [];
    const txt = fs.readFileSync(tmp, 'utf8');
    return txt.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
  } catch {
    return [];
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function killTree(p) {
  if (!p) return;
  try { spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 父进程死亡看门狗（评审 §4.1 第 1 条）
// 为什么需要：`finally` / stdin 关闭 / `browser.close()` 这三条覆盖的是"正常退出"和"自己出错"。
// 宿主被 taskkill 强杀时它们**一条都不执行**，浏览器就变成孤儿（大肥鱼那边踩过：残留 msedge 占端口，
// 一次 sprite_cleanup 卡 240 秒）。
//
// 做法：浏览器旁边挂一个**独立** powershell 小进程，每 10 秒问一次"capture.mjs（父）还在吗"；
// 父没了 → taskkill /T /F 整棵树 + 按 --user-data-dir 补刀剩下的 renderer/gpu，然后自己退出。
//
// 两条实测坑（评审给的原话，照抄）：
//   1. `spawn(pwsh, …, { detached: true })` 在 Windows 上会**立刻退出、一行都不执行** → 必须 detached:false。
//      父进程被 /F 杀掉时并不会连带杀子进程（没有 Job Object），所以 detached:false 的看门狗能活下来干活。
//   2. 别用 cmd 批处理：stdout/stderr 被 ignore 时管道会挂死 → 这里用 pwsh -File + stdio:'ignore'。
function startWatchdog(targetPid) {
  if (process.platform !== 'win32') return;
  if (!targetPid) return;
  if (String(process.env.DSH_CAP_WATCHDOG || '') === '0') {
    process.stderr.write('[capture] 看门狗被 DSH_CAP_WATCHDOG=0 关掉（只用于调试，正常别关）\n');
    return;
  }
  stopWatchdog();
  watchdogFile = path.join(os.tmpdir(), `dsh-cap-watchdog-${process.pid}-${Date.now()}.ps1`);
  const body = String.raw`param(
  [int]$P = 0,
  [int]$T = 0,
  [string]$Profile = '',
  [string]$ProfRoot = '',
  [int]$IntervalSec = 10,
  [int]$MaxMinutes = 720
)
$ErrorActionPreference = 'SilentlyContinue'
$deadline = (Get-Date).AddMinutes($MaxMinutes)
$profRootFull = ''
if ($ProfRoot) {
  $profRootFull = $(if ($ProfRoot.EndsWith('\')) { $ProfRoot } else { $ProfRoot + '\' })
}
function Kill-Tree {
  if ($T -gt 0 -and (Get-Process -Id $T -ErrorAction SilentlyContinue)) {
    & taskkill.exe /PID $T /T /F 2>$null | Out-Null
    Start-Sleep -Milliseconds 600
  }
  # 主进程没了但 renderer/gpu 还在：按 --user-data-dir 精确扫，绝不泛杀浏览器
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  foreach ($p in $procs) {
    if (-not $p.CommandLine) { continue }
    if ($p.Name -notmatch '^(msedge|chrome|chromium|chrome-headless-shell|headless_shell)\.exe$') { continue }
    if ($p.CommandLine -notmatch '--user-data-dir=(?:"([^"]+)"|(\S+))') { continue }
    $udd = $(if ($Matches[1]) { $Matches[1] } else { $Matches[2] })
    $hit = $false
    if ($Profile -and $udd.Equals($Profile, [StringComparison]::OrdinalIgnoreCase)) { $hit = $true }
    elseif ($profRootFull -and $udd.StartsWith($profRootFull, [StringComparison]::OrdinalIgnoreCase)) { $hit = $true }
    if (-not $hit) { continue }
    & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null
  }
  exit 0
}
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds $IntervalSec
  if (-not (Get-Process -Id $P -ErrorAction SilentlyContinue)) { Kill-Tree }
  if (-not (Get-Process -Id $T -ErrorAction SilentlyContinue)) { exit 0 }
}
exit 0
`;
  try { fs.writeFileSync(watchdogFile, body, 'utf8'); } catch (e) {
    process.stderr.write('[capture] 看门狗脚本写不出来: ' + String((e && e.message) || e) + '\n');
    watchdogFile = '';
    return;
  }
  try {
    // ⚠ detached 必须 false（见上面第 1 条坑）；stdio 必须 ignore（第 2 条坑）
    watchdogProc = spawn(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', watchdogFile,
        '-P', String(process.pid), '-T', String(targetPid),
        '-Profile', profileDir || '', '-ProfRoot', profileRoot || '',
        '-IntervalSec', String(WATCHDOG_INTERVAL_SEC), '-MaxMinutes', String(WATCHDOG_MAX_MINUTES)],
      { stdio: 'ignore', windowsHide: true, detached: false }
    );
    watchdogProc.on('error', (e) => process.stderr.write('[capture] 看门狗起不来: ' + String((e && e.message) || e) + '\n'));
    watchdogProc.unref();
    process.stderr.write(`[capture] 看门狗已挂：每 ${WATCHDOG_INTERVAL_SEC}s 查父进程 ${process.pid}，父没了就杀 ${targetPid} 整棵树（profile=${profileDir || '-'}）\n`);
  } catch (e) {
    process.stderr.write('[capture] 看门狗 spawn 失败: ' + String((e && e.message) || e) + '\n');
  }
}

function stopWatchdog() {
  if (watchdogProc) {
    try { watchdogProc.kill(); } catch { /* ignore */ }
    watchdogProc = null;
  }
  if (watchdogFile) {
    try { fs.unlinkSync(watchdogFile); } catch { /* ignore */ }
    watchdogFile = '';
  }
}

// ---------------------------------------------------------------- 启动清孤儿（评审 §4.1 第 3 条）
// 红线：判据是「父进程已不存在」，**不是**「跑了多久」——一次完整产线单步就可能 30~90 秒，
// 按时间硬杀会误伤正在干活的会话。范围也只认「--user-data-dir 指向我们自己的 profile 根」，
// 别人的 DSH 实例 / 用户自己的浏览器一个都不碰。
function sweepOrphans() {
  const result = { root: profileRoot, killed: [], kept: [] };
  if (process.platform !== 'win32') return result;
  if (!profileRoot) return result;
  const out = path.join(os.tmpdir(), `dsh-cap-orphans-${process.pid}-${Date.now()}.txt`);
  // 加尾部分隔符再比前缀：否则 dsh-vfx-loop 会误吞 dsh-vfx-loop2 这种兄弟目录
  const rootPrefix = profileRoot.endsWith(path.sep) ? profileRoot : profileRoot + path.sep;
  const ps = [
    '$root = $env:DSH_CAP_ROOT',
    '$out = $env:DSH_CAP_OUT',
    '$killed = New-Object System.Collections.ArrayList',
    '$kept = New-Object System.Collections.ArrayList',
    '# 两轮：第一轮杀掉"父进程已不在"的主进程（/T 会带走子进程）；第二轮确认没有漏网',
    'for ($pass = 1; $pass -le 2; $pass++) {',
    '  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)',
    '  $byPid = @{}',
    '  foreach ($p in $procs) { $byPid[[int]$p.ProcessId] = $p }',
    '  $kept = New-Object System.Collections.ArrayList',
    '  $any = $false',
    '  foreach ($p in $procs) {',
    '    if (-not $p.Name) { continue }',
    "    if ($p.Name -notmatch '^(msedge|chrome|chromium|chrome-headless-shell|headless_shell)\\.exe$') { continue }",
    '    if (-not $p.CommandLine) { continue }',
    "    if ($p.CommandLine -notmatch '--user-data-dir=(?:\"([^\"]+)\"|(\\S+))') { continue }",
    '    $udd = $(if ($Matches[1]) { $Matches[1] } else { $Matches[2] })',
    '    if (-not $udd.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { continue }',
    '    $ppid = [int]$p.ParentProcessId',
    '    if ($ppid -gt 0 -and $byPid.ContainsKey($ppid)) { [void]$kept.Add($p.ProcessId); continue }',
    '    & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null',
    '    [void]$killed.Add($p.ProcessId)',
    '    $any = $true',
    '  }',
    '  if (-not $any) { break }',
    '  Start-Sleep -Milliseconds 300',
    '}',
    '$lines = New-Object System.Collections.ArrayList',
    'foreach ($k in $killed) { [void]$lines.Add("kill " + $k) }',
    'foreach ($k in $kept) { [void]$lines.Add("keep " + $k) }',
    '($lines -join [Environment]::NewLine) | Out-File -FilePath $out -Encoding utf8'
  ].join('\n');
  try {
    spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      timeout: 30000,
      env: Object.assign({}, process.env, { DSH_CAP_ROOT: rootPrefix, DSH_CAP_OUT: out })
    });
    const txt = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    for (const line of txt.split(/\r?\n/)) {
      const m = /^(kill|keep)\s+(\d+)$/.exec(line.trim());
      if (!m) continue;
      result[m[1] === 'kill' ? 'killed' : 'kept'].push(Number(m[2]));
    }
  } catch { /* 清孤儿失败不拦主流程 */ }
  finally { try { fs.unlinkSync(out); } catch { /* ignore */ } }
  return result;
}

// ---------------------------------------------------------------- 引擎实现：start / stop
async function startEdge(o) {
  if (child) return { ok: false, err: 'already started (先 stop)' };
  if (!o.exe || !o.args) return { ok: false, err: 'start 缺 exe/args' };
  profileDir = String(o.profile || '');
  if (!profileDir) return { ok: false, err: 'start 缺 profile' };
  fs.mkdirSync(profileDir, { recursive: true });

  child = spawn(String(o.exe), o.args.map(String), { stdio: 'ignore', windowsHide: true });
  pid = child.pid || 0;
  child.on('error', (e) => process.stderr.write('[capture] spawn 失败: ' + String((e && e.message) || e) + '\n'));
  if (!pid) process.stderr.write('[capture] spawn 没拿到 pid\n');

  // 等 CDP 端口起来（原 PS 版：25s 上限，100ms 轮询，取第一个 page 目标）
  let wsUrl = null;
  const deadline = Date.now() + 25000;
  let tries = 0;
  while (Date.now() < deadline) {
    await sleep(100);
    tries++;
    try {
      const r = await fetch(`http://127.0.0.1:${o.cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
      const list = await r.json();
      const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) {
      if (tries === 1) process.stderr.write(`[capture] CDP 还连不上（${e.name}/${e.message}），继续等…\n`);
    }
  }
  if (!wsUrl) { killTree(pid); child = null; return { ok: false, err: 'CDP 连不上（25s）' }; }

  let sock;
  try {
    sock = await new Promise((resolve, reject) => {
      const w = new WebSocket(wsUrl);
      const t = setTimeout(() => reject(new Error('ws 连接超时（10s）')), 10000);
      w.addEventListener('open', () => { clearTimeout(t); resolve(w); });
      w.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws 连接出错')); });
    });
  } catch (e) {
    killTree(pid); child = null;
    return { ok: false, err: String(e && e.message || e) };
  }
  ws = sock;
  ws.addEventListener('message', onMessage);

  await cdp('Page.enable');
  // 视口钉死：--window-size 在 headless=new 里会小一圈（640x360 -> 616x268）
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: Number(o.w), height: Number(o.h), deviceScaleFactor: 1, mobile: false
  });
  startWatchdog(pid);
  return { ok: true, pid, wsUrl };
}

async function stopEdge() {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  ws = null;
  await sleep(250);
  killTree(pid);                    // 先按 PID 收自己那棵树（/T 才带得走 renderer/gpu）
  child = null;
  await sleep(600);
  let pids = edgePidsByProfile();   // 再按 profile 精确扫（绝不泛杀 msedge）
  for (const p of pids) killTree(p);
  if (pids.length) { await sleep(300); pids = edgePidsByProfile(); }
  // 残留归零才关看门狗；还有残留就把它留着——本进程一退出，它会在 10s 内补刀
  if (!pids.length) stopWatchdog();
  return { ok: true, leftover: pids.length, pids };
}

async function stopPlaywright() {
  try { if (pwContext) await pwContext.close(); } catch { /* ignore */ }
  pwContext = null;
  pwPage = null;
  await sleep(300);
  // browser.close() 只是"礼貌地要求"，Playwright 的 renderer/gpu 子进程不保证跟着走；
  // 评审 §4.1 第 2 条：关闭时按 PID 杀整棵树。
  if (pid) killTree(pid);
  await sleep(400);
  let pids = edgePidsByProfile();   // 再按 profile 精确扫一遍兜底
  for (const p of pids) killTree(p);
  if (pids.length) { await sleep(300); pids = edgePidsByProfile(); }
  pid = 0;
  if (!pids.length) stopWatchdog();
  return { ok: true, leftover: pids.length, pids };
}

// ---------------------------------------------------------------- 命令
const handlers = {
  async start(o) {
    if (process.platform !== 'win32') return { ok: false, err: PLATFORM_ERR };
    // profile 根：本包自己的临时目录。启动清孤儿只在这个目录下动手（判据：父进程已不存在）。
    profileDir = String(o.profile || '');
    profileRoot = String(o.profileRoot || '') || (profileDir ? path.dirname(profileDir) : '');
    if (!sweptOrphans) {
      sweptOrphans = true;
      const s = sweepOrphans();
      if (s.killed.length || s.kept.length) {
        process.stderr.write(
          `[capture] 启动清孤儿：profile 根 ${s.root || '-'} ｜ 父进程已消失→杀 ${s.killed.length} 个` +
          `${s.killed.length ? '(' + s.killed.join(',') + ')' : ''} ｜ 父进程还在→保留 ${s.kept.length} 个` +
          `${s.kept.length ? '(' + s.kept.join(',') + ')' : ''}\n`
        );
      } else {
        process.stderr.write(`[capture] 启动清孤儿：profile 根 ${s.root || '-'} 下没有残留\n`);
      }
    }
    if (engine === 'playwright') {
      if (enginePick.err) return { ok: false, err: enginePick.err };
      if (pwContext || child) return { ok: false, err: 'already started (先 stop)' };
      return await startPlaywright(o);
    }
    return await startEdge(o);
  },

  async viewport(o) {
    if (engine === 'playwright') {
      if (!pwPage) return { ok: false, err: 'viewport 前没 start' };
      try {
        await pwPage.setViewportSize({ width: Number(o.w), height: Number(o.h) });
        return { ok: true };
      } catch (e) {
        return { ok: false, err: 'viewport 失败: ' + String((e && e.message) || e).split('\n')[0] };
      }
    }
    const r = await cdp('Emulation.setDeviceMetricsOverride', {
      width: Number(o.w), height: Number(o.h), deviceScaleFactor: 1, mobile: false
    });
    return r === null ? { ok: false, err: 'viewport 无响应' } : { ok: true };
  },

  async goto(o) {
    if (!o.url) return { ok: false, err: 'goto 缺 url' };
    const want = o.want === undefined ? 'true' : String(o.want);
    const expr = o.readyExpr || 'String(document.readyState === "complete")';
    const timeoutMs = Number(o.timeoutMs || 30000);
    const t0 = Date.now();
    let val = '<never>';
    if (engine === 'playwright') {
      if (!pwPage) return { ok: false, err: 'goto 前没 start' };
      // 与 CDP 版对齐：Page.navigate 一发出就轮询 readyExpr，不等 load。
      // waitUntil:'commit' = 收到响应、文档开始加载就返回；后续轮询负责等 readyExpr。
      try { await pwPage.goto(String(o.url), { waitUntil: 'commit', timeout: Math.max(1000, timeoutMs) }); }
      catch (e) {
        process.stderr.write('[capture] goto(commit) 未完成: ' + String((e && e.message) || e).split('\n')[0] + '\n');
      }
      while (Date.now() - t0 < timeoutMs) {
        const r = await evalPw(expr);
        val = r.value === null || r.value === undefined ? '' : String(r.value);
        if (val === want) break;
        await sleep(40);
      }
      return { ok: true, ready: val === want, waitedMs: Date.now() - t0, val };
    }
    await cdp('Page.navigate', { url: String(o.url) });
    while (Date.now() - t0 < timeoutMs) {
      const r = await evalExpr(expr);
      val = r.value === null || r.value === undefined ? '' : String(r.value);
      if (val === want) break;
      await sleep(40);
    }
    return { ok: true, ready: val === want, waitedMs: Date.now() - t0, val };
  },

  async waitfor(o) {
    const want = o.want === undefined ? 'true' : String(o.want);
    const timeoutMs = Number(o.timeoutMs || 30000);
    const t0 = Date.now();
    let val = '<never>';
    if (engine === 'playwright') {
      if (!pwPage) return { ok: false, err: 'waitfor 前没 start' };
      while (Date.now() - t0 < timeoutMs) {
        const r = await evalPw(String(o.expr));
        val = r.value === null || r.value === undefined ? '' : String(r.value);
        if (val === want) break;
        await sleep(40);
      }
      return { ok: true, hit: val === want, ms: Date.now() - t0, val };
    }
    while (Date.now() - t0 < timeoutMs) {
      const r = await evalExpr(String(o.expr));
      val = r.value === null || r.value === undefined ? '' : String(r.value);
      if (val === want) break;
      await sleep(40);
    }
    return { ok: true, hit: val === want, ms: Date.now() - t0, val };
  },

  async eval(o) {
    if (engine === 'playwright') {
      const r = await evalPw(String(o.expr));
      return { ok: true, status: r.status, value: r.value };
    }
    const r = await evalExpr(String(o.expr));
    return { ok: true, status: r.status, value: r.value };
  },

  async shot(o) {
    if (!o.path) return { ok: false, err: 'shot 缺 path' };
    if (engine === 'playwright') {
      if (!pwPage) return { ok: false, err: 'shot 前没 start' };
      try { fs.mkdirSync(path.dirname(String(o.path)), { recursive: true }); } catch { /* ignore */ }
      try {
        const buf = await pwPage.screenshot({ path: String(o.path), type: 'png' });
        return { ok: true, bytes: buf.length };
      } catch (e) {
        return { ok: false, err: '截图失败 ' + o.path + ': ' + String((e && e.message) || e).split('\n')[0] };
      }
    }
    const cap = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (!cap || !cap.result || !cap.result.data) return { ok: false, err: '截图失败 ' + o.path };
    const buf = Buffer.from(cap.result.data, 'base64');
    fs.writeFileSync(String(o.path), buf);
    return { ok: true, bytes: buf.length };
  },

  async stop() {
    if (engine === 'playwright') return await stopPlaywright();
    return await stopEdge();
  }
};

// ---------------------------------------------------------------- 主循环
const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  chain = chain.then(async () => {
    let m;
    try { m = JSON.parse(line); } catch { send({ id: null, ok: false, err: 'bad json' }); return; }
    const h = handlers[m && m.cmd];
    if (!h) { send({ id: m && m.id, ok: false, err: 'unknown cmd ' + (m && m.cmd) }); return; }
    try {
      const r = await h(m);
      send(Object.assign({ id: m.id }, r));
    } catch (e) {
      send({ id: m.id, ok: false, err: String((e && e.message) || e) });
    }
  });
});

// stdin 关闭 = 调用方结束：兜底收尾，绝不把浏览器留在后台空转
rl.on('close', () => {
  chain.then(async () => {
    try { await handlers.stop(); } catch { /* ignore */ }
    process.exit(0);
  });
});

process.on('uncaughtException', (e) => {
  send({ id: null, ok: false, err: 'uncaught: ' + String((e && e.message) || e) });
  try { killTree(pid); } catch { /* ignore */ }
  process.exit(1);
});
