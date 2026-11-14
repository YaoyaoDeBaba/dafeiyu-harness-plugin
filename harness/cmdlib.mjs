// harness/cmdlib.mjs —— 「命令观测」执行器的零件层（cmdloop.mjs 的 half）
//
// 这一步要解决的事：把闭环的**观测来源**从「浏览器截图」放宽到「一条命令的 stdout」。
// 引擎那三件事一个都没变：改参数 → 出可比较的观测 → 算判据 → 搜索。
// 变的只有「观测」的来源，所以本文件只做三件与来源有关的事：
//   ① 解析 adapter.observe（命令怎么写、输出怎么读、哪几个字段是指标）；
//   ② 跑命令（超时 / 非零退出 / 输出解析 / 指标缺失 —— 全部中文硬错，绝不静默当 0）；
//   ③ 把「命令输出 → 一行指标」这一步与「参数怎么改」接起来（flat-params：写参数文件）。
//
// **判据不另写一套**：距离直接 require 同目录的 score.js（plan / dist / planText），
// 所以 warm/pctrel/range/clamp/penalty/直方图环形 L1 的语义与浏览器闭环逐条一致。
//
// 与 iter.ps1 的关系（为什么有复制）：
//   搜索主流程**没有**复用 iter.ps1 —— 它是 PowerShell，且绑着静态服/浏览器/截图那一整套，
//   为了"共用搜索"去动它，等于拿已经跑通的产品资产换抽象。所以 cmdloop.mjs 自己实现一个
//   最小可用的坐标下降，但**口径逐条照抄** iter.ps1，改动点只有一处（random 策略的随机源）。
//   下面 Get-Step / New-Vector / Key-Of 就是照抄件，函数注释里写明"照抄自 iter.ps1 哪一行"，
//   改任何一边都要同步另一边。
'use strict';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// score.js 是 CommonJS（harness/package.json 把这一层钉成 commonjs），这里用 createRequire 拉进来。
const require = createRequire(import.meta.url);
const score = require('./score.js');

// ---------------------------------------------------------------- 常量 / 变异开关
export const DEFAULT_TIMEOUT_MS = 30000;
export const PARSE_MODES = ['json', 'number', 'line:k=v'];
// 观测稳定性闸的默认值：**不写也要生效**（默认值就应该是安全的那一档）。
// repeat=3 是"能看出抖动、又不至于把预算吃光"的最小可行样数（2 次只能比出一对差，3 次看得出趋势）。
// maxSpread=2% 来自实测口径：命令链路的指标多是耗时/计数/残差，2% 以内的抖动通常来自调度与计时，
// 超过 2% 就很难说清"这点改进是参数带来的还是噪声"。
export const DEFAULT_STABILITY = { repeat: 3, maxSpread: 0.02 };
// 变异开关：**只给测试用**，不设时行为完全正常。用它是为了证明断言"弄坏能红"（skill 硬规则 ④）：
//   flatZero     —— 距离恒 0（把"能收敛"这条断言弄成恒真），收敛断言必须变红；
//   noTimeout    —— 超时当正常（把硬错降级成"静默的 0"），超时断言必须变红；
//   stableAlways —— 稳定性判定恒真（阈值形同虚设），"不稳定必须硬错"那条断言必须变红；
//   noStability  —— 整段稳定性闸删掉（不跑、不记账、证据包里没有 stability），
//                    "best.json 里有 stability 且 ok:true"那条断言必须变红。
export const MUTANT = String(process.env.CMDLOOP_MUTANT || '');

const HARD = '[命令观测] ';

function die(msg) {
  throw new Error(HARD + msg);
}

// ---------------------------------------------------------------- adapter → 运行期计划
// %ENV% 展开：与 iter.ps1 的 Expand-PathTpl 同口径 —— 展开不出来就中文硬错，不静默拼错路径。
export function expandTpl(raw, label) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (!text.includes('%')) return text;
  const missing = [];
  const out = text.replace(/%([^%]+)%/g, (whole, name) => {
    const v = process.env[name];
    if (v === undefined) {
      missing.push(name);
      return whole;
    }
    return v;
  });
  if (missing.length) {
    die(
      `${label} 里的环境变量没设置：${missing.map((n) => `%${n}%`).join('、')}（原文 ${text}）—— 先在当前 shell 里设置它，或用绝对路径`,
    );
  }
  return out;
}

function resolveFrom(base, p, label) {
  const v = expandTpl(p, label);
  if (!v) return '';
  return isAbsolute(v) ? resolve(v) : resolve(base, v);
}

export function readJson(file, label) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    die(`${label} 读不到：${file}（${e?.code ?? e?.message ?? e}）`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${label} 不是合法 JSON：${file}（${e?.message ?? e}）`);
  }
}

// 基线参数对象：兼容 {"params":{...}} 与顶层扁平两种形状（与 apply_params.js 的口径一致）
function pickParamsRoot(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const root = j.params && typeof j.params === 'object' && !Array.isArray(j.params) ? j.params : j;
  return root && typeof root === 'object' && !Array.isArray(root) ? root : null;
}

// 白名单：`name` 取基线现值、`name=初值` 显式给（照抄 iter.ps1 §2 的白名单解析语义）
export function readWhitelist(items, baseParams) {
  const wl = [];
  const startParams = {};
  for (const rawItem of items) {
    const item = String(rawItem ?? '').trim();
    if (!item) continue;
    let name = item;
    let val = null;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d*\.?\d+(?:[eE][-+]?\d+)?)$/.exec(item);
    if (m) {
      name = m[1];
      val = Number(m[2]);
    } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) {
      die(`白名单项看不懂：${JSON.stringify(item)}（只认 name 或 name=数值）`);
    }
    if (val === null) {
      const v = baseParams?.[name];
      if (!Number.isFinite(Number(v))) {
        const nums = Object.keys(baseParams ?? {}).filter((k) => Number.isFinite(Number(baseParams[k])));
        die(
          `白名单参数 \`${name}\` 不在基线参数文件里，且没给初值。用 \`${name}=<数值>\` 指定。基线里可用的数值键：${nums.join(', ') || '（一个都没有）'}`,
        );
      }
      val = Number(v);
    }
    if (wl.includes(name)) continue;
    wl.push(name);
    startParams[name] = round6(val);
  }
  if (!wl.length) die('白名单解析为空（adapter.params.list / --params 都是空）');
  return { wl, startParams };
}

export function round6(v) {
  // 照抄 iter.ps1 的 Round6（[math]::Round(v,6) 在正数上等价；PowerShell 用银行家舍入、这里用四舍五入，
  // 差别只在 x.xxxxxx5 这种边界，对参数取值没有实际影响 —— 但**轨迹是确定的**，同输入同输出）
  const n = Number(v);
  if (!Number.isFinite(n)) die(`不是数：${JSON.stringify(v)}`);
  return Number(n.toFixed(6));
}

// ---------------------------------------------------------------- iter.ps1 口径的照抄件
// 照抄自 iter.ps1 第 640-653 行（Get-Step / New-Vector）：
//   ±10%（StepRatio，默认 0.1）；**零基参数用绝对步长 0.05**（否则 0 永远动不了，E2 §3.1）。
export function stepOf(v, stepRatio) {
  if (Math.abs(v) < 1e-9) return 0.05;
  return round6(Math.abs(v) * stepRatio);
}

export function newVector(baseParams, name, sign, stepRatio) {
  const p = {};
  for (const [k, v] of Object.entries(baseParams)) p[k] = v;
  if (name) {
    const s = stepOf(Number(baseParams[name]), stepRatio);
    p[name] = round6(Number(baseParams[name]) + sign * s);
  }
  return p;
}

// 照抄自 iter.ps1 第 636-639 行（Key-Of）：缓存键 = 白名单顺序 + 六位小数字符串。
// 顺序本身是身份的一部分（同一组数换个顺序不该命中同一条缓存，否则证据包的列会错位）。
export function keyOf(params, wl) {
  return wl.map((k) => k + '=' + Number(params[k]).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')).join('|');
}

// 命令行的极小分词器：只认空白分隔与 ' " 引号，**不走 shell**（Windows 上 shell:true 会把引号再解释一遍，
// 而且给了注入面）。占位符在分词**之后**替换，参数文件路径带空格也不会被拆开。
export function tokenizeCmd(cmd) {
  const text = String(cmd ?? '');
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quote) die(`observe.cmd 里的引号没闭合：${JSON.stringify(text)}`);
  if (has) out.push(cur);
  if (!out.length) die('observe.cmd 是空串：命令观测至少要有一条命令可跑');
  return out;
}

// 占位符：{params} = 本次评估的参数文件绝对路径。文档里写死**只认这一个**（多一个就多一份猜）。
export const CMD_PLACEHOLDER = '{params}';

export function argvFor(plan, paramsPath) {
  const argv = plan.observe.argvTemplate.map((tok) => tok.split(CMD_PLACEHOLDER).join(paramsPath));
  return argv;
}

// ---------------------------------------------------------------- 输出取数
function pickPath(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  const key = String(path);
  // 先按**整键**取：line:k=v 的字段表是扁平的，而 json 里也允许直接写一个带点的键
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  let cur = obj;
  for (const seg of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function parseNumberList(text, metricIds) {
  // parse=number：整个 stdout 就是一个数。指标只能有一个 —— 多于一个就没有"哪条指标拿这个数"的答案了。
  if (metricIds.length !== 1) {
    die(`observe.parse=number 只能配 1 条指标（现在 ${metricIds.length} 条：${metricIds.join('、')}）—— 要多个数就用 parse=json 或 line:k=v`);
  }
  const n = Number(String(text ?? '').trim());
  if (!Number.isFinite(n)) {
    die(`observe.parse=number 但 stdout 不是数：${JSON.stringify(String(text ?? '').slice(0, 200))}`);
  }
  return { __number: n };
}

function parseKvList(text) {
  const map = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*[=:]\s*(-?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*$/.exec(line);
    if (m) map[m[1]] = Number(m[2]);
  }
  return map;
}

// 把 stdout 按 observe.parse 读成「字段表」；读不出来就是硬错（没有"返回空对象"这条路）
export function parseOutput(stdout, mode, metricIds) {
  const text = String(stdout ?? '');
  if (mode === 'json') {
    const t = text.trim();
    if (!t) die('observe.parse=json 但 stdout 是空的');
    let j;
    try {
      j = JSON.parse(t);
    } catch (e) {
      die(`observe.parse=json 但 stdout 不是合法 JSON：${e.message}（前 200 字：${JSON.stringify(t.slice(0, 200))}）`);
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      die(`observe.parse=json 要求 stdout 是一个 JSON 对象，收到 ${Array.isArray(j) ? '数组' : typeof j}（前 200 字：${JSON.stringify(t.slice(0, 200))}）`);
    }
    return j;
  }
  if (mode === 'number') return parseNumberList(text, metricIds);
  if (mode === 'line:k=v') return parseKvList(text);
  die(`看不懂的 observe.parse=${mode}（只认 ${PARSE_MODES.join(' | ')}）`);
}

// 指标抽取：field 是输出里的字段名（可写 a.b 走嵌套），缺省等于 id。
// parse=number 时整条 stdout 就是一个数，此时只有一条指标（多条的答案已在上一步被拒）。
export function rowFromFields(fields, metrics) {
  const row = {};
  const whole = fields && typeof fields === 'object' && Object.prototype.hasOwnProperty.call(fields, '__number');
  for (const m of metrics) {
    let v;
    if (whole) v = fields.__number;
    else v = pickPath(fields, m.field || m.id);
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
    if (!Number.isFinite(Number(v))) {
      const where = whole ? 'stdout' : m.field || m.id;
      die(`指标缺失：输出里取不到数字字段 \`${where}\`（metric ${m.id}）—— 不许当 0 静默通过`);
    }
    row[m.id] = Number(v);
  }
  return row;
}

// ---------------------------------------------------------------- 观测稳定性闸（0.4.1）
// 截图链路的等价物是 freeze.verify=strict（同一个 URL 连拍两张、逐字节比，比不过就报错）。
// 命令链路原来什么都没有：命令一旦有随机性（时间戳、并发、浮点不确定性、真实接口抖动），
// 搜索会学会**在噪声里挑"看起来更好"的点**，最后交付一个假的最优。这一节就是补那个洞。
//
// 三件事分开写，是为了每件都能被单独测：
//   resolveStability —— 配置怎么读（默认值 / 非法值硬错）；
//   measureStability —— 怎么算离散度（纯函数，给一组数就出结论）；
//   assertStability  —— 判不稳定就中文硬错（报指标 / spread / 阈值 / repeat 次原始值）。
export function resolveStability(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_STABILITY };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    die(`adapter.observe.stability 要是一个对象（例：{"repeat":3,"maxSpread":0.02}），收到 ${JSON.stringify(raw)}`);
  }
  const repeat = raw.repeat === undefined || raw.repeat === null ? DEFAULT_STABILITY.repeat : raw.repeat;
  // repeat=0 会被读成"关掉检查"这种含糊状态 —— 想关就显式写 1（那条会 warn），别用 0 表达"不要"。
  if (!Number.isInteger(repeat) || repeat < 1) {
    die(
      `adapter.observe.stability.repeat 必须是 ≥1 的整数（收到 ${JSON.stringify(raw.repeat)}）—— ` +
        `要关掉稳定性检查只能显式写 1（会打一条 warn 说明"本次不验证观测稳定性"）`,
    );
  }
  const maxSpread = raw.maxSpread === undefined || raw.maxSpread === null ? DEFAULT_STABILITY.maxSpread : Number(raw.maxSpread);
  if (!Number.isFinite(maxSpread) || !(maxSpread > 0) || maxSpread > 1) {
    die(
      `adapter.observe.stability.maxSpread 必须是 (0, 1] 的数（收到 ${JSON.stringify(raw.maxSpread)}）—— ` +
        `它是相对离散度 (max-min)/max(|mean|,1e-9) 的上限，1 = 100%`,
    );
  }
  return { repeat, maxSpread };
}

// spread = (max - min) / max(|mean|, 1e-9)；分母兜底 1e-9 是刻意的：
// 指标在 0 附近时，绝对抖动再小、相对也是爆炸的 —— 那种情况本来就该报"不稳定"，
// 而不是因为"除以 0 算不出来"就悄悄放过。
// 返回 { repeat, maxSpread, ok, spreads:{id:spread}, values:{id:[...]} }；
// ok 是**总判定**，spreads/ok 都按指标给，方便 report 逐条列。
export function measureStability(values, cfg) {
  const spreads = {};
  const okById = {};
  const kept = {};
  for (const [id, rawArr] of Object.entries(values)) {
    const v = (Array.isArray(rawArr) ? rawArr : []).map(Number);
    kept[id] = v.map((x) => round6(x));
    if (!v.length || v.some((x) => !Number.isFinite(x))) {
      spreads[id] = null;
      okById[id] = false;
      continue;
    }
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const spread = (Math.max(...v) - Math.min(...v)) / Math.max(Math.abs(mean), 1e-9);
    spreads[id] = spread;
    okById[id] = spread <= cfg.maxSpread;
  }
  if (MUTANT === 'stableAlways') {
    // 变异体：阈值恒真（判据形同虚设）—— 用来看"不稳定必须硬错"那条断言是不是真的接着实现
    for (const id of Object.keys(okById)) okById[id] = true;
  }
  const ok = Object.values(okById).every(Boolean);
  return { repeat: cfg.repeat, maxSpread: cfg.maxSpread, ok, okById, spreads, values: kept };
}

// 判不稳定 → 中文硬错。要求：点名哪个指标 / spread 多少 / 阈值多少 / repeat 次的原始值。
// 不许静默降级（把不稳的那条指标剔掉继续跑），也不许自动取平均继续跑 —— 平均一下噪声就"不见了"，
// 那正好是最危险的那种"看起来可信"。
export function assertStability(st, metricIds) {
  const bad = metricIds.filter((id) => st.okById[id] !== true);
  if (!bad.length) return st;
  const id = bad[0];
  const sp = st.spreads[id];
  const vals = st.values[id] ?? [];
  die(
    `观测不稳定：指标 \`${id}\` 的相对离散度 ${sp === null || sp === undefined ? '（取不到数）' : Number(sp).toFixed(6)}` +
      ` 超过上限 maxSpread=${st.maxSpread}（repeat=${st.repeat} 次的原始值：${vals.map((v) => String(v)).join('、')}）\n` +
      `  spread=(max-min)/max(|mean|,1e-9)。命令只要有随机性（时间戳 / 并发 / 浮点不确定性 / 真实接口抖动），` +
      `搜索学到的就是"在噪声里挑好看的点"，交付的最优是假的 —— 拒绝继续（不静默降级、不自动取平均）。\n` +
      `  先让观测确定下来（固定 seed、去掉时间戳、关并发、别读真实接口），或显式放宽 observe.stability.maxSpread 并自担风险` +
      (bad.length > 1 ? `；另有 ${bad.length - 1} 条指标也不稳：${bad.slice(1).join('、')}` : ''),
  );
  return st;
}

// ---------------------------------------------------------------- 解析 adapter.observe
// 与 core/adapter.js 的 command 分支**各有一份**（和 iter.ps1 的 Import-Adapter 与 core 的分工同构：
// 执行器要能独立搬走，不 import 包内其它层的源码）。两边口径对齐点：
//   observe.type / cmd / cwd / timeoutMs / parse / metrics[].{id,field,norm,weight}、config.path/flat-params。
// 这里做执行期能验的硬错（cmd 空、parse 不认识、metrics 空、目标缺），core 那边只做"能解析、说得出来"。
export function resolveCommandPlan(adapter, adapterFile, opts = {}) {
  const adapterDir = dirname(resolve(adapterFile));
  const adapterName = String(adapter?.name ?? '');
  const o = adapter?.observe ?? {};
  const type = String(o.type ?? '');
  if (type !== 'command') {
    die(
      `这份 adapter 的 observe.type=${type || '（缺）'}，cmdloop.mjs 只跑 type=command（命令观测）。浏览器截图那一套走 harness/iter.ps1`,
    );
  }
  const cmdRaw = String(o.cmd ?? '').trim();
  if (!cmdRaw) die('adapter.observe.cmd 是空串：命令观测必须有可跑的命令');
  const timeoutMs = o.timeoutMs === undefined || o.timeoutMs === null ? DEFAULT_TIMEOUT_MS : Number(o.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) die(`adapter.observe.timeoutMs 必须是正数（收到 ${JSON.stringify(o.timeoutMs)}）`);
  const parseMode = String(o.parse ?? 'json');
  if (!PARSE_MODES.includes(parseMode)) die(`adapter.observe.parse=${parseMode} 不认识（只认 ${PARSE_MODES.join(' | ')}）`);
  // 观测稳定性闸（0.4.1）：不写也有默认值（repeat 3 / maxSpread 0.02）—— 默认就该是安全的那一档。
  const stability = resolveStability(o.stability);

  const rawMetrics = Array.isArray(o.metrics) ? o.metrics : [];
  if (!rawMetrics.length) die('adapter.observe.metrics 是空数组：没有指标就没有判据，跑不了');
  const metrics = rawMetrics.map((it) => {
    const id = String(it?.id ?? '');
    if (!id) die('observe.metrics 有一项缺 id：' + JSON.stringify(it));
    const weight = it?.weight === undefined ? 1 : Number(it.weight);
    if (!Number.isFinite(weight)) die(`observe.metrics.${id}.weight 不是数：${JSON.stringify(it?.weight)}`);
    return {
      id,
      field: String(it?.field ?? id),
      weight,
      norm: it?.norm ?? { mode: 'identity' },
      enabled: it?.enabled !== false,
    };
  });
  const activeMetrics = metrics.filter((m) => m.enabled);
  if (!activeMetrics.length) die('observe.metrics 全部 enabled:false：没有参与打分的指标');

  // 参数文件：沿用现有 flat-params 语义（一份扁平 {params:{...}}），但**只读基线、写 run 目录**：
  // 命令观测不碰 adapter / clientRoot，杜绝"跑一轮把源码目录改了"。
  const configFormat = String(adapter?.config?.format ?? 'flat-params');
  if (configFormat !== 'flat-params') {
    die(`命令观测只支持 config.format=flat-params（收到 ${configFormat}）—— 参数就是一份扁平 {params}，vfx-block 形态没有浏览器去读它`);
  }
  const clientRootRaw = String(adapter?.clientRoot ?? '');
  const clientRoot = clientRootRaw ? resolveFrom(adapterDir, clientRootRaw, 'clientRoot') : adapterDir;
  const configPath = String(adapter?.config?.path ?? '').trim();
  const baseFile = configPath ? resolveFrom(clientRoot, configPath, 'config.path') : '';
  let baseJson = null;
  let baseParams = {};
  if (baseFile) {
    if (existsSync(baseFile)) {
      baseJson = readJson(baseFile, '基线参数文件');
      baseParams = pickParamsRoot(baseJson) ?? {};
      if (!baseParams || typeof baseParams !== 'object') die(`基线参数文件里没有可用的参数对象：${baseFile}`);
    }
  }
  const baseSha256 = baseFile && existsSync(baseFile) ? sha256File(baseFile) : '';
  if (!baseFile) {
    die('adapter 缺 config.path：命令观测需要一份基线参数文件（哪怕只有 {}），否则白名单的初值无处可取');
  }

  // 白名单：adapter.params.list（mode=list），可用 --params 覆盖
  const pm = String(adapter?.params?.mode ?? '');
  let wlItems = [];
  if (opts.params) wlItems = String(opts.params).split(',');
  else if (pm === 'list') wlItems = Array.isArray(adapter?.params?.list) ? adapter.params.list.map(String) : [];
  else die(`adapter.params.mode=${pm || '（缺）'}：命令观测只支持 mode=list（或命令行 --params 显式给）—— activity/auto 是浏览器领域那套活性表，这里没有`);
  const { wl, startParams } = readWhitelist(wlItems, baseParams);

  // cwd：默认 adapter 目录（所以 `node ./probe.mjs` 按 adapter 目录展开）
  const cwd = o.cwd ? resolveFrom(adapterDir, o.cwd, 'observe.cwd') : adapterDir;
  if (!existsSync(cwd)) die(`observe.cwd 不存在：${cwd}`);

  // 判据：直接喂给 score.js 的 plan()。extract 在这里没有意义（那是 metrics2.js 的提取器 id），
  // 但 plan() 要求它存在 —— 填 field，报告里读起来正好是"哪条指标的哪个字段"。
  const scoreCfg = adapter?.score && typeof adapter.score === 'object' ? adapter.score : { type: 'l1', penalties: [] };
  let P;
  try {
    P = score.plan({ metrics: activeMetrics.map((m) => ({ id: m.id, extract: m.field, weight: m.weight, norm: m.norm })), score: scoreCfg });
  } catch (e) {
    die(`判据配置不可用（score.js 拒绝）：${e?.message ?? e}`);
  }

  // 目标
  const targetMode = String(adapter?.target?.mode ?? '');
  let target = null;
  if (targetMode === 'params') {
    const raw = adapter?.target?.params;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      die('adapter.target.mode=params 但 target.params 不是对象（拒绝静默用默认目标）');
    }
    target = { mode: 'params', params: { ...raw } };
  } else if (targetMode === 'metrics') {
    const raw = adapter?.target?.metrics;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      die('adapter.target.mode=metrics 但 target.metrics 不是对象（例：{"loss":0,"size":28}）');
    }
    const row = {};
    for (const m of activeMetrics) {
      const v = Number(raw[m.id]);
      if (!Number.isFinite(v)) die(`target.metrics 缺指标 ${m.id}（或不是数：${JSON.stringify(raw[m.id])}）`);
      row[m.id] = v;
    }
    target = { mode: 'metrics', metrics: row };
  } else {
    die(`adapter.target.mode=${targetMode || '（缺）'}：命令观测只支持 params（按一组目标参数跑一次命令取指标）或 metrics（直接给目标数值）`);
  }

  return {
    adapterName,
    adapterFile: resolve(adapterFile),
    adapterDir,
    clientRoot,
    baseFile,
    baseJson,
    baseParams,
    baseSha256,
    wl,
    startParams,
    observe: {
      type,
      cmdRaw,
      argvTemplate: tokenizeCmd(cmdRaw),
      cwd,
      timeoutMs,
      parse: parseMode,
      stability,
      metrics: activeMetrics.map((m) => ({ id: m.id, field: m.field, weight: m.weight, norm: m.norm })),
      metricIds: activeMetrics.map((m) => m.id),
    },
    metrics: activeMetrics,
    scoreCfg,
    scorePlan: P,
    scoreText: safePlanText(P),
    target,
  };
}

function safePlanText(P) {
  try {
    return score.planText(P);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- 判据覆盖（intent 插槽，0.5.0）
// 需求转译的 criteria 要能改"哪条指标算数、各多少权重"—— 这一层就是那个落点。
// 纪律：
//   · id 必须在 plan 里真实存在，否则**硬错**（写错一个 id 就悄悄按原判据跑完，是最坏的一种"看起来做了"）；
//   · 只改 weight，不动 extract / norm（换归一化就不只是"更看重它"，是换了一把尺）；
//   · 改完必须**重新 plan()** —— 距离是 plan 算好的，改了 weight 不重算等于没改；
//   · 目标值（target）不在这儿改：那是"观测出来的目标"，由调用方在拿到 trow 之后覆盖（见 cmdloop.mjs）。
export function applyMetricOverrides(plan, overrides = {}) {
  const weights = overrides.weights || {};
  const ids = plan.observe.metricIds;
  const unknown = Object.keys(weights).filter((id) => !ids.includes(id));
  if (unknown.length) {
    die(`判据覆盖里有 adapter 不认识的指标 id：${unknown.join('、')}（这份 adapter 的指标：${ids.join(' / ')}）`);
  }
  for (const m of plan.metrics) if (Object.prototype.hasOwnProperty.call(weights, m.id)) m.weight = Number(weights[m.id]);
  for (const m of plan.observe.metrics) if (Object.prototype.hasOwnProperty.call(weights, m.id)) m.weight = Number(weights[m.id]);
  let P;
  try {
    P = score.plan({
      metrics: plan.metrics.map((m) => ({ id: m.id, extract: m.field, weight: m.weight, norm: m.norm })),
      score: plan.scoreCfg,
    });
  } catch (e) {
    die(`intent 覆盖判据之后判据配置不可用（score.js 拒绝）：${e?.message ?? e}`);
  }
  plan.scorePlan = P;
  plan.scoreText = safePlanText(P);
  return plan;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ---------------------------------------------------------------- 一次评估 = 写参数 + 跑命令 + 取数 + 算距离
// 参数文件落 run 目录（<out>/params/eNNN.json），**不写 adapter / clientRoot**：
// 命令要读它，有两条路（文档里写死）：① cmd 里写 {params} 占位；② 读环境变量 SELFLOOP_PARAMS。
function writeParamsFile(plan, outDir, seq, params) {
  const dir = join(outDir, 'params');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e' + String(seq).padStart(3, '0') + '.json');
  const doc = plan.baseJson && typeof plan.baseJson === 'object' && !Array.isArray(plan.baseJson) ? JSON.parse(JSON.stringify(plan.baseJson)) : { params: {} };
  const root = doc.params && typeof doc.params === 'object' && !Array.isArray(doc.params) ? doc.params : doc;
  for (const [k, v] of Object.entries(params)) root[k] = v;
  const text = JSON.stringify(doc, null, 2);
  writeFileSync(file, text, 'utf8');
  // 回读自校验（照抄 apply_params.js 的纪律③：writeFileSync 写坏/写 0 字节不会自己报错）
  const back = readJson(file, '参数文件回读');
  const backRoot = back.params && typeof back.params === 'object' ? back.params : back;
  const bad = [];
  for (const [k, v] of Object.entries(params)) if (backRoot[k] !== v) bad.push(`${k} want=${v} got=${backRoot[k]}`);
  if (bad.length) die(`参数文件回读不一致：${bad.join('; ')}（文件 ${file}）`);
  return file;
}

export function computeDist(plan, row, trow) {
  const r = score.dist(row, trow, plan.scorePlan);
  if (MUTANT === 'flatZero') {
    // 变异体：距离恒 0 —— 用来看"收敛断言"是不是真的在断言
    r.d = 0;
    r.base = 0;
    for (const k of Object.keys(r.parts)) r.parts[k] = 0;
    for (const k of Object.keys(r.wparts)) r.wparts[k] = 0;
    r.penSum = 0;
  }
  return r;
}

// 跑一次命令。返回 { row, dist, stdout, stderr, ms, timedOut, stdoutSha, paramsFile, argv }
// 四类失败都是**中文硬错**：超时 / 非零退出 / 输出解析不出来 / 指标缺失。
export function evaluate(plan, opts) {
  const { params, outDir, seq } = opts;
  const paramsFile = writeParamsFile(plan, outDir, seq, params);
  const argv = argvFor(plan, paramsFile);
  const t0 = Date.now();
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: plan.observe.cwd,
    timeout: plan.observe.timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, SELFLOOP_PARAMS: paramsFile },
  });
  const ms = Date.now() - t0;
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  const timedOut = res.error?.code === 'ETIMEDOUT' || Boolean(res.signal) || res.status === null;

  if (timedOut) {
    if (MUTANT === 'noTimeout') {
      // 变异体：超时当正常，指标全 0（正是"静默当 0"这个坑）—— 超时断言必须变红
      const row = {};
      for (const m of plan.metrics) row[m.id] = 0;
      return { row, dist: opts.trow ? computeDist(plan, row, opts.trow) : null, stdout, stderr, ms, timedOut: true, stdoutSha: sha256Text(stdout), paramsFile, argv };
    }
    die(
      `命令超时（>${plan.observe.timeoutMs}ms）：${plan.observe.cmdRaw}（argv=${JSON.stringify(argv)}）\n` +
        `  命令超时不等于"观测是 0"——拒绝继续。stderr 前 200 字：${JSON.stringify(stderr.slice(0, 200))}`,
    );
  }
  if (res.error) {
    die(`命令起不来：${plan.observe.cmdRaw}（argv=${JSON.stringify(argv)}）：${res.error.code ?? ''} ${res.error.message}`);
  }
  if (Number(res.status) !== 0) {
    die(
      `命令非零退出（exit=${res.status}）：${plan.observe.cmdRaw}（argv=${JSON.stringify(argv)}）\n` +
        `  stdout 前 200 字：${JSON.stringify(stdout.slice(0, 200))}  stderr 前 200 字：${JSON.stringify(stderr.slice(0, 200))}`,
    );
  }
  const fields = parseOutput(stdout, plan.observe.parse, plan.observe.metricIds);
  const row = rowFromFields(fields, plan.metrics);
  // 目标自己那一次评估没有"目标行"可比 —— 不算距离（不是"距离 0"，是没有距离）
  const d = opts.trow ? computeDist(plan, row, opts.trow) : null;
  return { row, dist: d, stdout, stderr, ms, timedOut: false, stdoutSha: sha256Text(stdout), paramsFile, argv };
}

// 证据包里的 outputs/：每次评估的原始命令输出，**截断到 4KB**（超了标 truncated:true，方便一眼看出不是全文）
export const OUTPUT_CAP_BYTES = 4096;
export function capOutputDoc(doc) {
  let text = JSON.stringify(doc, null, 2);
  if (Buffer.byteLength(text, 'utf8') <= OUTPUT_CAP_BYTES) return { text, truncated: false };
  const trimmed = { ...doc };
  trimmed.truncated = true;
  for (const key of ['stdout', 'stderr']) {
    let body = String(trimmed[key] ?? '');
    trimmed[key] = body.slice(0, 1200);
    text = JSON.stringify(trimmed, null, 2);
    // 逐次收缩，直到整份文件落进 4KB（指标/参数这些短字段不裁，只裁原始输出）
    while (Buffer.byteLength(text, 'utf8') > OUTPUT_CAP_BYTES && body.length > 0) {
      body = body.slice(0, Math.max(0, Math.floor(body.length * 0.7)));
      trimmed[key] = body;
      text = JSON.stringify(trimmed, null, 2);
    }
  }
  // 兜底：两个原始输出都裁空了还超（参数表本身就很大）→ 直接清空它们。
  // 宁可少留原文，也不交出一份"其实截断了但没标"的文件。
  if (Buffer.byteLength(text, 'utf8') > OUTPUT_CAP_BYTES) {
    trimmed.stdout = '';
    trimmed.stderr = '';
    text = JSON.stringify(trimmed, null, 2);
  }
  return { text, truncated: true };
}

export function ensureOutDir(outDir) {
  const abs = resolve(outDir);
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  if (!statSync(abs).isDirectory()) die(`--out 不是目录：${abs}`);
  return abs;
}

export { score };
export const CMDLIB_DIR = dirname(fileURLToPath(import.meta.url));
