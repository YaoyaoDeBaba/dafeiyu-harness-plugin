// core/adapter.js —— 闭环契约的**领域无关**解析层（三层里的中间层）。
//
// 一份 adapter 描述的是任何"可测目标 + 可调参数"的现场：观测在哪、怎么冻、判据怎么配、搜索轴给谁。
// vfx 只是今天挂上来的第一个领域（domains/vfx-render/），所以这里不出现任何题材词。
// 判据口径与执行器 harness/iter.ps1 的 Import-Adapter 逐条对齐（见下面的注释），不自己发明更严的规则。
//
// 被谁引用：lib/index.js（工具入口）→ 本文件。本文件不引用 lib/，也不改 harness/。
//
// 唯一的纪律：**硬错只报 iter.ps1 自己会抛的那几种**（否则 probe 会拒绝 iter.ps1 明明接受的配置，
// 等于把工具做得比执行器还严）；其余一律进 warnings —— 比如 score.type 不是 l1，是 score.js 才炸，
// 不是 iter.ps1 炸，那就记账不拦。
//
// 向后兼容：adapter 的 `domain` 字段**可选**。缺了照样解析、照样能跑，只是在清单里归到"未标注领域"。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

// 跑一轮**必须**有的件（相对 harness/）。缺哪个，哪一步会死，见 HARNESS_ROLES。
export const HARNESS_REQUIRED = [
  'iter.ps1',
  'capture.ps1',
  'capture.mjs',
  'score.js',
  'metrics2.js',
  'finalize.js',
  'apply.js',
  'apply_params.js',
  'writeguard.js',
]

export const HARNESS_ROLES = {
  'iter.ps1': '主循环：解析 adapter → 起静态服 → 冻帧 → 搜索 → 出证据包',
  'capture.ps1': '浏览器边界的 PowerShell 半边（NDJSON 管道，iter.ps1 dot-source 它）',
  'capture.mjs': '浏览器边界的 Node 半边（edge / playwright 两个引擎，7 个命令）',
  'score.js': '距离：按 adapter.metrics + score 算 nd×w，命中 penalties 就加 add',
  'metrics2.js': '指标提取：从 png 算 cov/lapVar/warmFrac/coldFrac/hueHist/hueMean/covCore/ratioCore',
  'finalize.js': '收尾：curve.csv / best.json / report.md',
  'apply.js': '改参（vfx-block 形态：vfx.json 里 effects.<E>.<B>）',
  'apply_params.js': '改参（flat-params 形态：扁平 {params:{...}}）',
  'writeguard.js': '写护栏：判定 out 是否落在 adapter.guard.protectPaths 下（apply.js / apply_params.js 共用这一份）',
}

export const STATIC_SERVER = join(import.meta.dirname, '..', 'static', 'server.mjs')

const BLOCK_RE = /^(?:effects\.)?([^.]+)\.(.+)$/

function fail(msg) {
  throw new Error(msg)
}

// 数字字段统一走这里：非数字（字段缺失/模板留空）给 0，别把 NaN 透到 probe 返回值里
// （NaN 序列化成 null，宿主按 output.schema 校验会直接报"期望 integer，实际 null"）。
function num(x) {
  const n = Number(x)
  return Number.isFinite(n) ? n : 0
}

export function readJsonFile(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    fail(`读不到文件：${file}（${e?.code ?? e?.message ?? e}）`)
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    fail(`不是合法 JSON：${file}（${e?.message ?? e}）`)
  }
}

// 相对路径一律按给的基准目录展开（与 iter.ps1 各处的口径逐条对齐，见函数注释）
// 包内零绝对路径：clientRoot / 浏览器候选路径写成 %VFX_LOOP_CLIENT% / %ProgramFiles% 这类模板，
// 这里与 iter.ps1 的 Expand-PathTpl 同口径展开（**容错**：probe 只记账不拦，run 时才中文报错）。
export function expandEnvTpl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { value: '', missing: [] }
  if (!text.includes('%')) return { value: text, missing: [] }
  const missing = []
  const value = text.replace(/%([^%]+)%/g, (whole, name) => {
    const v = process.env[name]
    if (v === undefined) {
      missing.push(name)
      return whole
    }
    return v
  })
  return { value: missing.length ? '' : value, missing }
}

function resolveWithWarn(base, raw, label, warnings) {
  const { value, missing } = expandEnvTpl(raw)
  if (missing.length) {
    warnings.push(
      `${label} 里的环境变量没设置：${missing.map((n) => `%${n}%`).join('、')}（原文 ${String(raw)}）—— 设好它就能跑；run 时 iter.ps1 会直接中文报错`,
    )
    return ''
  }
  if (!value) return ''
  return isAbsolute(value) ? value : resolve(base, value)
}

// 两个绝对路径是不是同一个目录/文件（Windows 大小写不敏感 + 尾分隔符不算差异）
function samePath(x, y) {
  const norm = (p) => {
    const s = resolve(String(p))
    return process.platform === 'win32' ? s.toLowerCase().replace(/[/\\]+$/, '') : s.replace(/\/+$/, '')
  }
  return norm(x) === norm(y)
}

function resolveFrom(base, p) {
  if (!p) return ''
  const { value } = expandEnvTpl(p)
  if (!value) return ''
  return isAbsolute(value) ? value : resolve(base, value)
}

// Playwright 的 Chromium 在不在（首装成本要显形：740 MB / 无头版 290 MB）。
// 只看缓存目录名，不启动浏览器、不 import playwright（插件加载要快）。
export function chromiumStatus() {
  if (process.platform !== 'win32' && !process.env.HOME && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return { found: false, base: '', full: false, headlessShell: false }
  }
  const custom = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '')
  const base =
    custom && custom !== '0'
      ? custom
      : join(String(process.env.LOCALAPPDATA || process.env.HOME || ''), 'ms-playwright')
  let names = []
  try {
    names = readdirSync(base)
  } catch {
    names = []
  }
  const full = names.some((n) => /^chromium-\d/.test(n))
  const headlessShell = names.some((n) => /headless-shell/i.test(n))
  return { found: full || headlessShell, base, full, headlessShell }
}

export function harnessStatus(harnessDir) {
  const present = []
  const missing = []
  for (const name of HARNESS_REQUIRED) {
    const file = join(harnessDir, name)
    let ok = false
    try {
      ok = statSync(file).isFile() && statSync(file).size > 0
    } catch {
      ok = false
    }
    ;(ok ? present : missing).push(name)
  }
  return { dir: harnessDir, required: HARNESS_REQUIRED.length, present, missing, complete: missing.length === 0 }
}

function metricNorm(norm) {
  if (!norm || typeof norm !== 'object') return 'identity'
  const mode = norm.mode ?? 'identity'
  if (mode === 'range') {
    const r = Array.isArray(norm.range) ? norm.range : []
    return `range[${r.join(',')}]`
  }
  if (mode === 'pctrel') return `pctrel(floor=${norm.floor ?? 0})`
  if (mode === 'abs') return `abs(scale=${norm.scale})`
  return mode
}

// 与 score.js 的 plan() 同口径：字符串项 = {id, extract:id, weight:1, norm:identity}
function normalizeMetrics(raw) {
  return (raw ?? []).map((it) => {
    const m = typeof it === 'string' ? { id: it, extract: it } : it
    return {
      id: String(m?.id ?? ''),
      extract: String(m?.extract ?? m?.id ?? ''),
      weight: m?.weight === undefined ? 1 : Number(m.weight),
      norm: metricNorm(m?.norm),
      enabled: m?.enabled !== false,
    }
  })
}

function normalizePenalties(score) {
  return (score?.penalties ?? []).map((p) => ({
    id: String(p?.id ?? ''),
    when: typeof p?.when === 'string' ? p.when : JSON.stringify(p?.when ?? null),
    add: Number(p?.add),
  }))
}

export function distanceRule(scoreType) {
  const base = 'd = Σ(nd_i × w_i) / Σw_i + Σpenalty.add；nd_i = |a_i − t_i| 按各指标 norm 归一（range/pctrel/abs/identity，clamp 可选）；'
    + '直方图类指标（如 hueHist）改算环形 L1 距离再按 norm 归一（目标值当 0，跨 0°/360° 边界算 1 格）'
  if (scoreType === 'l1') return base
  return `${base}；但 adapter.score.type=${scoreType || '（缺）'} —— score.js 只实现 l1，跑起来会在打分那步报错`
}

// 解析一份 adapter；harnessDir 用来展开 server.staticScript / tools.* 这些"相对 harness 的"路径
export function parseAdapter(file, harnessDir, opts = {}) {
  const a = readJsonFile(file)
  // template 例外（template:true）：包内 harness/adapter.json 是**字段模板**，name / clientRoot / config.path /
  // config.block / page.file 都是有意留空的。拿"缺字段（空串）"硬错去拦它，用户看到的只会是
  // "缺字段：clientRoot（空串）"，根本看不出这是模板；所以模板不做字段校验，只记一条人话 warning
  // （真正拒跑在 iter.ps1 的 Import-Adapter 与调用方）。与批次一的"空串=硬错"并存：模板标记优先。
  const isTemplate = a?.template === true
  // 观测来源（0.4.0 新增）：`observe.type=command` = 观测是一条命令的 stdout，不是浏览器截图。
  // 缺这一节（或 type 为空）= 老 adapter，行为与以前完全一样 —— 这条兼容是硬要求：
  // 包里三份 vfx 示例、用户手上的旧配置，一个字都不该因为引入新能力而改。
  const observeRaw = a?.observe ?? {}
  const observeType = String(observeRaw.type ?? '')
  if (observeType && observeType !== 'command') {
    fail(`adapter.observe.type=${observeType} 未实现（本版只支持 command —— 命令输出当观测；浏览器截图那条走 harness/iter.ps1）`)
  }
  const isCommandObserve = observeType === 'command'
  // 命令观测不碰浏览器：page / freeze / render / server / clientRoot 都不该成为必填项（它们描述的是截图链路）。
  // 反过来，命令观测**多**两个必填：observe.cmd 与 observe.metrics。
  const requiredTop = isCommandObserve
    ? ['name', 'config', 'observe', 'target', 'params']
    : ['name', 'clientRoot', 'config', 'page', 'freeze', 'render', 'server']
  const missing = []
  for (const k of requiredTop) {
    if (a?.[k] === undefined || a[k] === null) missing.push(k)
  }
  if (missing.length && !isTemplate) fail(`adapter 缺字段：${missing.join(' / ')}（${file}）`)
  if (!isTemplate && (typeof a.config?.path !== 'string' || !a.config.path)) fail(`adapter 缺字段：config.path（${file}）`)
  if (!isTemplate && !isCommandObserve && (typeof a.config?.block !== 'string' || !a.config.block)) {
    fail(`adapter 缺字段：config.block（${file}）`)
  }
  if (!isTemplate && !isCommandObserve && (typeof a.page?.file !== 'string' || !a.page.file)) {
    fail(`adapter 缺字段：page.file（${file}）`)
  }
  if (!isTemplate && isCommandObserve && (typeof observeRaw.cmd !== 'string' || !observeRaw.cmd.trim())) {
    fail(`adapter.observe.cmd 是空串：命令观测必须有可跑的命令（${file}）`)
  }
  if (!isTemplate && isCommandObserve && !Array.isArray(observeRaw.metrics)) {
    fail(`adapter.observe.metrics 不是数组：命令观测要靠它说明"输出里哪几个字段是指标"（${file}）`)
  }

  const block = String(a.config?.block ?? '')
  const m = BLOCK_RE.exec(block)
  if (!m && !isTemplate && !isCommandObserve) fail(`adapter.config.block 格式不对（要 effects.<Effect>.<Block>）：${block}`)
  const effect = m ? m[1] : ''
  const blockName = m ? m[2] : ''

  const freeze = a.freeze ?? {}
  const protocol = String(freeze.protocol ?? '')
  if (!isTemplate && !isCommandObserve && protocol !== 'noloop-step' && protocol !== 'url-time') {
    fail(`adapter.freeze.protocol=${protocol || '（缺）'} 未实现（iter.ps1 只支持 noloop-step | url-time）`)
  }
  if (!isTemplate && !isCommandObserve && (freeze.targetTimeMs === undefined || freeze.targetTimeMs === null)) {
    fail(`adapter 缺字段：freeze.targetTimeMs（${file}）`)
  }
  if (!isTemplate && !isCommandObserve && (freeze.seed === undefined || freeze.seed === null)) fail(`adapter 缺字段：freeze.seed（${file}）`)
  if (!isTemplate && !isCommandObserve && protocol === 'noloop-step' && !(Number(freeze.stepMs) > 0)) {
    fail(`adapter 缺字段：freeze.stepMs（noloop-step 必须有推进步长，${file}）`)
  }
  let clock = String(freeze.clock ?? '')
  if (clock === '') clock = protocol === 'url-time' ? 'n/a' : 'wall'
  if (!isTemplate && !isCommandObserve) {
    if (protocol === 'url-time') {
      if (clock === 'virtual') fail(`adapter.freeze.clock=virtual 在 url-time 下没有意义（没有推进过程），写 "n/a"`)
      if (clock !== 'n/a' && clock !== 'wall') fail(`adapter.freeze.clock=${clock} 在 url-time 下只认 n/a|wall`)
    } else if (clock !== 'wall' && clock !== 'virtual') {
      fail(`adapter.freeze.clock=${clock} 只支持 wall|virtual（noloop-step）；url-time 下才是 n/a`)
    }
  }

  if (!isTemplate && !isCommandObserve) {
    for (const k of ['tier', 'width', 'height']) {
      if (a.render?.[k] === undefined || a.render[k] === null) fail(`adapter 缺字段：render.${k}（${file}）`)
    }
    for (const k of ['staticPort', 'cdpPort', 'browserProfilePrefix']) {
      if (a.server?.[k] === undefined || a.server[k] === null) fail(`adapter 缺字段：server.${k}（${file}）`)
    }
  }

  // 命令观测只认 flat-params（参数 = 一份扁平 {params}，写进 run 目录给命令读）；
  // 老 adapter 缺省仍是 vfx-block，行为不变。
  let configFormat = String(a.config?.format ?? (isCommandObserve ? 'flat-params' : 'vfx-block'))
  if (!isTemplate && isCommandObserve && configFormat !== 'flat-params') {
    fail(`命令观测只支持 config.format=flat-params（收到 ${configFormat}）—— vfx-block 形态要靠浏览器去读，命令观测没有浏览器`)
  }
  if (!isTemplate && !isCommandObserve && configFormat !== 'vfx-block' && configFormat !== 'flat-params') {
    fail(`adapter.config.format=${configFormat} 只支持 vfx-block | flat-params`)
  }

  const warnings = []
  // 模板：把"还缺哪些必填项"合成**一条**人话（模板不硬错，但也不能一声不响地返回一个空壳）
  if (isTemplate) {
    const gaps = [
      ['name', !String(a.name ?? '').trim()],
      ['clientRoot', !String(a.clientRoot ?? '').trim()],
      ['config.path', !String(a.config?.path ?? '')],
      ['config.block', !String(a.config?.block ?? '')],
      ['page.file', !String(a.page?.file ?? '')],
      ['freeze.targetTimeMs', freeze.targetTimeMs === undefined || freeze.targetTimeMs === null],
      ['freeze.seed', freeze.seed === undefined || freeze.seed === null],
    ]
      .filter(([, blank]) => blank)
      .map(([k]) => k)
    warnings.push(
      `这是字段模板（template:true），不能直接跑${gaps.length ? `：${gaps.join(' / ')} 还空着` : ''} —— 复制一份填必填字段，或 -Adapter 指定一份真 adapter（如 domains/vfx-render/adapters/fire-ray.json）`,
    )
  }
  const adapterDir = resolve(file, '..')
  const clientRootRaw = String(a.clientRoot ?? '')
  // 显式覆盖（probe 的 clientRoot 参数）：宿主进程常常看不到 %VFX_LOOP_CLIENT% —— 那条环境变量是
  // 用户在自己的 shell 里设的，插件进程不一定继承。这时允许直接给绝对路径，省掉"设变量/重启宿主"这一步。
  const override = String(opts?.clientRoot ?? '').trim()
  if (override && !isAbsolute(override)) fail(`clientRoot 覆盖值必须是绝对路径（收到 ${override}）—— 相对路径没有可靠的基准，不如不给`)
  if (override && !existsSync(override)) fail(`clientRoot 覆盖值不存在：${override}`)
  // 空串 ≠ %环境变量% 没展开：
  //   空串 = 这份 adapter 少写了一个必填项 → 硬错（与 iter.ps1 Import-Adapter 同口径）；
  //   "%NOPE_X%" = 机器上还没设变量 → 只记账（老测试钉住了这条：probe 不该因为没设变量就拒绝解析）。
  // 命令观测例外：路径基准是 adapter 所在目录（没有"client 根目录"这回事），所以 clientRoot 可省。
  if (!isTemplate && !isCommandObserve && !clientRootRaw.trim()) fail(`adapter 缺字段：clientRoot（空串，${file}）—— 写 client 根目录，或 %ENV% 模板`)
  const commandRoot = adapterDir
  let clientRoot = override || resolveWithWarn(adapterDir, clientRootRaw, 'clientRoot', warnings)
  if (!clientRoot && isCommandObserve && !override) clientRoot = commandRoot
  if (override) {
    warnings.push(`clientRoot 用了显式覆盖：${override}（adapter 里写的是 ${clientRootRaw || '（空）'}；环境变量那条不再检查）`)
  }
  if (clientRoot && !override && !isCommandObserve && !isAbsolute(clientRootRaw)) {
    warnings.push(`clientRoot 是相对路径（${clientRootRaw}）：按 adapter 所在目录展开成 ${clientRoot}（iter.ps1 同口径）`)
  }
  // clientRoot 没解析出来（通常是 %环境变量% 没设）时不要拿 cwd 去拼一个假路径骗人
  const configFile = clientRoot ? resolveFrom(clientRoot, String(a.config?.path ?? '')) : ''
  const configFileExists = existsSync(configFile)
  if (!configFileExists) {
    warnings.push(
      isCommandObserve
        ? `基线参数文件不在：${configFile || '（config.path 没给）'} —— 命令观测的白名单只能用 name=<数值> 形式给初值，否则起跑不了`
        : `配置文件不在：${configFile || '（clientRoot 没解析出来）'} —— 一轮都跑不起来（iter.ps1 会抛"镜像配置文件不存在"）`,
    )
  }

  // 静态服 / 指标脚本 / 浏览器 —— 这三样全是**截图链路**的件。命令观测根本不经过它们，
  // 所以到这一层就不再解析、也不再报"找不到"（否则一份纯粹的命令 adapter 会背一堆无关警告）。
  const staticScript = isCommandObserve
    ? ''
    : resolveWithWarn(harnessDir, String(a.server?.staticScript ?? ''), 'server.staticScript', warnings)
  // 兜底顺序与 iter.ps1 一致：adapter 给的 → 包内自带 static/server.mjs → 旧项目根 _tmp_static.js
  let staticScriptUsed = staticScript
  if (!isCommandObserve) {
    if (!staticScriptUsed || !existsSync(staticScriptUsed)) {
      const packaged = join(harnessDir, '..', 'static', 'server.mjs')
      staticScriptUsed = existsSync(packaged) ? packaged : join(harnessDir, '..', '..', '_tmp_static.js')
    }
    if (!existsSync(staticScriptUsed)) {
      warnings.push(`静态服脚本找不到：${staticScriptUsed} —— adapter.server.staticScript 没给/指不到，包内自带那份也不在`)
    }
  }

  const metricsJs = isCommandObserve ? '' : resolveWithWarn(harnessDir, String(a.tools?.metricsJs ?? ''), 'tools.metricsJs', warnings)
  const capture = isCommandObserve ? '' : resolveWithWarn(harnessDir, String(a.tools?.capture ?? 'capture.mjs'), 'tools.capture', warnings)
  const applyDefault = configFormat === 'flat-params' ? 'apply_params.js' : 'apply.js'
  const apply = isCommandObserve ? '' : resolveWithWarn(harnessDir, String(a.tools?.apply ?? applyDefault), 'tools.apply', warnings)
  const missingTools = []
  if (!isCommandObserve) {
    if (!metricsJs) missingTools.push('tools.metricsJs')
    else if (!existsSync(metricsJs)) missingTools.push(`tools.metricsJs → ${metricsJs}`)
    if (!capture) missingTools.push('tools.capture')
    else if (!existsSync(capture)) missingTools.push(`tools.capture → ${capture}`)
    if (!apply) missingTools.push('tools.apply')
    else if (!existsSync(apply)) missingTools.push(`tools.apply → ${apply}`)
    if (missingTools.length) warnings.push(`脚本找不到：${missingTools.join('；')}`)
  }

  // 浏览器候选：%ProgramFiles(x86)% 这类模板在这里逐个展开（展开不了的那条跳过，不拦）
  const exeCandidates = isCommandObserve
    ? []
    : [a.browser?.exe, ...(Array.isArray(a.browser?.exeCandidates) ? a.browser.exeCandidates : [])]
        .filter((x) => typeof x === 'string' && x.length > 0)
        .map((x) => {
          const { value } = expandEnvTpl(x)
          if (!value) return ''
          return isAbsolute(value) ? value : resolve(adapterDir, value)
        })
        .filter(Boolean)
  const exeFound = exeCandidates.find((p) => existsSync(p)) ?? ''
  if (!isCommandObserve) {
    if (!exeFound) warnings.push('adapter.browser 没命中任何浏览器（exe / exeCandidates 都不存在）：iter.ps1 会抛错')
    const browserArgs = Array.isArray(a.browser?.args) ? a.browser.args : []
    if (browserArgs.length === 0) warnings.push('adapter.browser.args 为空：iter.ps1 会抛错')
  }

  // 指标：命令观测的"指标"在 observe.metrics（field = 输出里的字段名），这里映射成同一套形状，
  // 让 probe 的返回、清单的 metricsCount、距离口径的描述在两种观测下长得一样。
  const metrics = normalizeMetrics(
    isCommandObserve
      ? (Array.isArray(observeRaw.metrics) ? observeRaw.metrics : []).map((it) => ({
          id: it?.id,
          extract: it?.field ?? it?.id,
          weight: it?.weight,
          norm: it?.norm,
          enabled: it?.enabled,
        }))
      : a.metrics,
  )
  if (metrics.length === 0) {
    warnings.push(
      isCommandObserve
        ? 'adapter.observe.metrics 为空：score.js 会拒（没有指标就没有判据）'
        : 'adapter.metrics 为空：score.js 会拒（P2.5 起必须是 v2 数组）',
    )
  }
  const penalties = normalizePenalties(a.score)
  // 命令观测允许整节 score 缺省（判据就是"l1 + 无惩罚"），所以缺省时按 l1 记，不报"只实现 l1"那条噪音
  const scoreType = String(a.score?.type ?? (isCommandObserve ? 'l1' : ''))
  if (scoreType !== 'l1') warnings.push(`adapter.score.type=${scoreType || '（缺）'}：score.js 只实现 l1`)
  for (const it of metrics) {
    if (!Number.isFinite(it.weight)) warnings.push(`metric ${it.id} 的 weight 不是数`)
  }

  // observe 节（0.4.0）：命令观测的"现场"。cmd / cwd 相对路径按 **adapter 所在目录**展开
  // （与 examples 里 `node ./command-demo/probe.mjs` 的写法一致 —— 没有 client 根目录这回事）。
  const observeCmdRaw = String(observeRaw.cmd ?? '')
  // 第一段是"跑什么"：带路径分隔符才按 adapter 目录展开（`node ./x.mjs` 的 node 是 PATH 里的东西，
  // 硬拼成 <adapter目录>\node 只会骗人）；不带分隔符就原样保留，起不起得来由 cmdloop.mjs 中文硬错报。
  const observeFirstTok = observeCmdRaw.trim().split(/\s+/)[0] ?? ''
  const observeCmd = observeCmdRaw
    ? /[\\/]/.test(observeFirstTok)
      ? resolveFrom(adapterDir, observeFirstTok, 'observe.cmd')
      : observeFirstTok
    : ''
  const observeCwd = observeRaw.cwd ? resolveFrom(adapterDir, String(observeRaw.cwd), 'observe.cwd') : adapterDir
  const observeTimeout = observeRaw.timeoutMs === undefined || observeRaw.timeoutMs === null ? 30000 : num(observeRaw.timeoutMs)
  const observeParse = String(observeRaw.parse ?? (isCommandObserve ? 'json' : ''))
  // 观测稳定性闸（0.4.1）：命令链路在搜索前用起点参数连跑 repeat 次，任一指标相对离散度
  // (max-min)/max(|mean|,1e-9) 超过 maxSpread 就硬错。默认 repeat=3 / maxSpread=0.02 —— **不写也生效**。
  // 这里只做"说得出来 + 不合法先吼一声"（体检口），真正拒跑在 harness/cmdlib.mjs 的 resolveStability。
  const stabilityRaw = observeRaw.stability
  const stabRepeatRaw = stabilityRaw?.repeat === undefined || stabilityRaw?.repeat === null ? 3 : stabilityRaw.repeat
  const stabRepeat = Number.isInteger(stabRepeatRaw) ? stabRepeatRaw : 0
  const stabSpreadRaw =
    stabilityRaw?.maxSpread === undefined || stabilityRaw?.maxSpread === null ? 0.02 : Number(stabilityRaw.maxSpread)
  const stabSpread = Number.isFinite(stabSpreadRaw) ? stabSpreadRaw : 0
  // 截图链路没有这道闸（它的等价物是 freeze.verify=strict），这里恒为 0 = 不适用
  const observeStability = { repeat: isCommandObserve ? stabRepeat : 0, maxSpread: isCommandObserve ? stabSpread : 0 }
  if (isCommandObserve) {
    if (stabRepeat < 1) {
      warnings.push(
        `adapter.observe.stability.repeat=${JSON.stringify(stabRepeatRaw)} 不是 ≥1 的整数：cmdloop.mjs 会硬错（要关掉检查只能显式写 1，会 warn）`,
      )
    } else if (stabRepeat === 1) {
      warnings.push('adapter.observe.stability.repeat=1：显式关闭观测稳定性检查（命令有随机性时，收敛结果不可信）')
    }
    if (!(stabSpread > 0) || stabSpread > 1) {
      warnings.push(`adapter.observe.stability.maxSpread=${JSON.stringify(stabSpreadRaw)} 不在 (0,1] 里：cmdloop.mjs 会硬错（1 = 100%）`)
    }
  }

  if (isCommandObserve) {
    if (!['json', 'number', 'line:k=v'].includes(observeParse)) {
      warnings.push(`adapter.observe.parse=${observeParse} 不认识（只认 json | number | line:k=v）：cmdloop.mjs 会硬错`)
    }
    if (!(observeTimeout > 0)) warnings.push('adapter.observe.timeoutMs 不是正数：cmdloop.mjs 会硬错')
    if (observeCmd && /[\\/]/.test(observeFirstTok) && !existsSync(observeCmd)) {
      warnings.push(`observe.cmd 的第一段指不到：${observeCmd} —— cmdloop.mjs 会中文硬错（命令起不来）`)
    }
    if (observeCwd && !existsSync(observeCwd)) warnings.push(`observe.cwd 不存在：${observeCwd} —— cmdloop.mjs 会硬错`)
  }

  // 写守卫（guard）：**保护路径由 adapter 声明**，core 只负责把它解析出来、说得出来。
  // 这里是"体检口"不是"执行点"：缺失/环境变量没设只 warning（证据包会记 enforced:false），
  // 真正拒写在 iter.ps1 启动时与改参脚本里（两个执行点都必须有，见方案 §2.4）。
  const guardRaw = a.guard ?? {}
  const protectPaths = []
  const protectPathsRaw = Array.isArray(guardRaw.protectPaths) ? guardRaw.protectPaths : []
  for (const p of protectPathsRaw) {
    if (typeof p !== 'string' || !p.trim()) continue
    const { value, missing } = expandEnvTpl(p)
    if (missing.length) {
      warnings.push(
        `guard.protectPaths 里的环境变量没设置：${missing.map((n) => `%${n}%`).join('、')}（原文 ${p}）—— 设好它，否则 iter.ps1 会在启动时硬错`,
      )
      continue
    }
    const abs = isAbsolute(value) ? value : resolve(adapterDir, value)
    if (abs) protectPaths.push(abs)
  }
  const bodyClient = resolveWithWarn(adapterDir, String(guardRaw.bodyClient ?? ''), 'guard.bodyClient', warnings)
  // bodyClient 非空 → 自动并入 protectPaths（并集）：老 adapter 一个字不改就获得写保护
  if (bodyClient && !protectPaths.some((p) => samePath(p, bodyClient))) protectPaths.push(bodyClient)
  if (protectPaths.length === 0 && !isCommandObserve) {
    // 命令观测不写 client 目录（参数文件只落 run 目录），所以这里不该出现"会写回本体"的警告噪音
    warnings.push('adapter 没声明 guard.protectPaths：改参脚本不会拦"写回本体"（只保证 out≠base）')
  }

  const readbackExpr = String(a.page?.readbackExpr ?? '')
  if (!readbackExpr && !isCommandObserve) {
    warnings.push('adapter 没给 page.readbackExpr：iter.ps1 不做浏览器侧回读，证据包会标 selfCheck:false（没法证明参数真被吃到）')
  }

  const targetMode = String(a.target?.mode ?? '')
  let targetPng = ''
  let targetParams = {}
  let targetMetrics = {}
  if (targetMode === 'png') {
    if (isCommandObserve) {
      warnings.push('target.mode=png 对命令观测没有意义（没有帧可比）：cmdloop.mjs 只认 params | metrics')
    } else {
      // target.path 按 adapter 所在目录展开（P2.6 口径）
      targetPng = resolveFrom(adapterDir, String(a.target?.path ?? ''))
      if (!targetPng || !existsSync(targetPng)) warnings.push(`target.mode=png 但目标帧不在：${targetPng || '（未给 path）'}`)
    }
  } else if (targetMode === 'params') {
    const raw = a.target?.params
    targetParams = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
    if (Object.keys(targetParams).length === 0) {
      warnings.push('adapter.target.mode=params 但 target.params 为空：iter.ps1 §1 会报错（拒绝静默用默认目标）')
    }
  } else if (targetMode === 'metrics') {
    // 命令观测专用：直接给"目标数值"，不跑命令（浏览器链路没有这个模式）
    const raw = a.target?.metrics
    if (!isCommandObserve) {
      warnings.push('target.mode=metrics 只对命令观测（observe.type=command）有意义：浏览器链路要用 png 或 params')
    } else {
      const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      for (const [k, v] of Object.entries(obj)) if (Number.isFinite(Number(v))) targetMetrics[k] = Number(v)
      if (Object.keys(targetMetrics).length === 0) warnings.push('adapter.target.mode=metrics 但 target.metrics 里没有数值：cmdloop.mjs 会硬错')
      for (const it of metrics) {
        if (!(it.id in targetMetrics)) warnings.push(`target.metrics 缺指标 ${it.id}：cmdloop.mjs 会硬错（拒绝静默用 0 当目标）`)
      }
    }
  }

  return {
    adapterResolved: resolve(file),
    adapterName: String(a.name),
    schemaVersion: String(a.schema ?? ''),
    // 领域标注（可选）：一眼看出这份 adapter 属于哪个题材包，如 vfx-render。缺字段 = 空串（照常跑）
    domain: String(a.domain ?? ''),
    // template:true = 字段模板（包内 harness/adapter.json），没有可跑的目标/白名单，iter.ps1 会拒跑
    template: a.template === true,
    clientRoot,
    clientRootExists: existsSync(clientRoot),
    configFile,
    configFileExists,
    configFormat,
    block,
    effect,
    blockName,
    page: {
      file: String(a.page?.file ?? ''),
      query: String(a.page?.query ?? ''),
      readyExpr: String(a.page?.readyExpr ?? ''),
      readbackExpr,
    },
    freeze: {
      protocol,
      clock,
      stepMs: protocol === 'url-time' ? 0 : num(freeze.stepMs),
      targetTimeMs: num(freeze.targetTimeMs),
      seed: num(freeze.seed),
    },
    render: { tier: String(a.render?.tier ?? ''), width: num(a.render?.width), height: num(a.render?.height) },
    server: {
      staticPort: num(a.server?.staticPort),
      cdpPort: num(a.server?.cdpPort),
      staticScript: staticScriptUsed,
      staticScriptExists: existsSync(staticScriptUsed),
    },
    browser: { exeCandidates: exeCandidates.length, exeFound },
    metricsCount: metrics.length,
    metrics,
    scoreType,
    penalties,
    distanceRule: distanceRule(scoreType),
    tools: { metricsJs, capture, apply, missing: missingTools },
    // 写守卫：protectPaths 是**已展开的绝对路径**；enforced = 有没有真的声明出保护路径
    guard: { bodyClient, protectPaths, enforced: protectPaths.length > 0 },
    target: { mode: targetMode, png: targetPng, params: targetParams, metrics: targetMetrics },
    // 观测来源（0.4.0）：type 为空串 = 老的截图链路（浏览器 + 冻帧 + metrics2.js）；
    // type=command = 跑一条命令、从 stdout 取数。cmd 是"第一段"的绝对路径（方便一眼看出跑的是什么），
    // cmdRaw 是原文（带参数与占位符），cwd 是工作目录，parse/metrics 决定怎么取数。
    observe: {
      type: observeType,
      cmdRaw: observeCmdRaw,
      cmd: observeCmd,
      cwd: observeCwd,
      timeoutMs: observeTimeout,
      parse: observeParse,
      stability: observeStability,
      metricsCount: isCommandObserve ? metrics.length : 0,
      metrics: isCommandObserve
        ? metrics.map((it) => ({
            id: it.id,
            field: String(it.extract),
            weight: Number.isFinite(it.weight) ? it.weight : 1,
            norm: it.norm,
          }))
        : [],
    },
    params: {
      mode: String(a.params?.mode ?? ''),
      list: (Array.isArray(a.params?.list) ? a.params.list : []).map(String),
    },
    topic: String(a.topic ?? ''),
    warnings,
  }
}

// 适配器目录可能不再贴着包根（三层之后在 domains/<domain>/adapters/），
// 所以 harness/ 要找：先看调用方给的，再向上逐级找"同级有 harness/iter.ps1"的那层。
function guessHarnessDir(adapterDir) {
  let d = resolve(adapterDir)
  for (let i = 0; i < 4; i += 1) {
    const cand = resolve(d, '..', 'harness')
    if (existsSync(join(cand, 'iter.ps1'))) return cand
    d = resolve(d, '..')
  }
  return ''
}

// 包内适配器清单：名字 + 适用题材 + 现在能不能跑
// harnessDir 省略时按上面的规则向上找（给旧调用方式留活路）
export function listAdapters(dir, harnessDir) {
  const out = []
  const toolsDir = harnessDir || guessHarnessDir(dir)
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')).sort()
  } catch (e) {
    fail(`读不到适配器目录：${dir}（${e?.code ?? e?.message ?? e}）`)
  }
  for (const name of names) {
    const file = join(dir, name)
    try {
      const a = parseAdapter(file, toolsDir)
      out.push({
        file,
        name: a.adapterName,
        domain: a.domain,
        topic: a.topic || `${a.block}（${a.freeze.protocol} · ${a.render.tier} ${a.render.width}x${a.render.height}）`,
        schemaVersion: a.schemaVersion,
        block: a.block,
        freezeProtocol: a.freeze.protocol,
        tier: a.render.tier,
        metricsCount: a.metricsCount,
        runnable: a.configFileExists,
        reason: a.configFileExists
          ? ''
          : a.configFile
            ? `clientRoot 指不到配置：${a.configFile}`
            : 'clientRoot 没解析出来（多半是 adapter 里的 %环境变量% 还没设置）',
      })
    } catch (e) {
      out.push({
        file,
        name: '',
        domain: '',
        topic: '',
        schemaVersion: '',
        block: '',
        freezeProtocol: '',
        tier: '',
        metricsCount: 0,
        runnable: false,
        reason: `解析失败：${e?.message ?? e}`,
      })
    }
  }
  return out
}

// 按领域分组（清单输出用）。缺 domain 的旧配置归到空串那一组，不丢、不报错。
export function groupByDomain(adapters) {
  const order = []
  const map = new Map()
  for (const a of adapters) {
    const key = String(a.domain ?? '')
    if (!map.has(key)) {
      map.set(key, [])
      order.push(key)
    }
    map.get(key).push(a)
  }
  // 有标注的领域排前面（按名字），未标注的垫底
  order.sort((x, y) => (x === y ? 0 : x === '' ? 1 : y === '' ? -1 : x.localeCompare(y)))
  return order.map((domain) => ({
    domain,
    count: map.get(domain).length,
    files: map.get(domain).map((a) => a.file),
  }))
}

