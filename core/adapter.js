// core/adapter.js —— 闭环契约的**领域无关**解析层（三层里的中间层）。
//
// 一份 adapter 描述的是任何"可测目标 + 可调参数"的现场：观测在哪、怎么冻、判据怎么配、搜索轴给谁。
// vfx 只是今天挂上来的第一个领域（domains/vfx-render/），所以这里不出现任何题材词。
// 判据口径与执行器 harness/iter.ps1 的 Import-Adapter 逐条对齐（见下面的注释），不自己发明更严的规则。
//
// 被谁引用：lib/index.js（工具入口）→ 本文件。本文件不引用 lib/，也不改 harness/。
//
// 唯一的纪律：**硬错只报 iter.ps1 自己会抛的那几种**（否则 probe 会拒绝 iter.ps1 明明接受的配置，
// 等于把工具做得比产线还严）；其余一律进 warnings —— 比如 score.type 不是 l1，是 score.js 才炸，
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
]

export const HARNESS_ROLES = {
  'iter.ps1': '主循环：解析 adapter → 起静态服 → 冻帧 → 搜索 → 出证据包',
  'capture.ps1': '浏览器边界的 PowerShell 半边（NDJSON 管道，iter.ps1 dot-source 它）',
  'capture.mjs': '浏览器边界的 Node 半边（edge / playwright 两个引擎，7 个命令）',
  'score.js': '距离：按 adapter.metrics + score 算 nd×w，命中 penalties 就加 add',
  'metrics2.js': '指标提取：从 png 算 cov/lapVar/warmFrac/coldFrac/covCore/ratioCore',
  'finalize.js': '收尾：curve.csv / best.json / report.md',
  'apply.js': '改参（vfx-block 形态：vfx.json 里 effects.<E>.<B>）',
  'apply_params.js': '改参（flat-params 形态：扁平 {params:{...}}）',
}

export const STATIC_SERVER = join(import.meta.dirname, '..', 'static', 'server.mjs')

const BLOCK_RE = /^(?:effects\.)?([^.]+)\.(.+)$/

function fail(msg) {
  throw new Error(msg)
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
  const base = 'd = Σ(nd_i × w_i) / Σw_i + Σpenalty.add；nd_i = |a_i − t_i| 按各指标 norm 归一（range/pctrel/abs/identity，clamp 可选）'
  if (scoreType === 'l1') return base
  return `${base}；但 adapter.score.type=${scoreType || '（缺）'} —— score.js 只实现 l1，跑起来会在打分那步报错`
}

// 解析一份 adapter；harnessDir 用来展开 server.staticScript / tools.* 这些"相对 harness 的"路径
export function parseAdapter(file, harnessDir) {
  const a = readJsonFile(file)
  const missing = []
  for (const k of ['name', 'clientRoot', 'config', 'page', 'freeze', 'render', 'server']) {
    if (a?.[k] === undefined || a[k] === null) missing.push(k)
  }
  if (missing.length) fail(`adapter 缺字段：${missing.join(' / ')}（${file}）`)
  if (typeof a.config?.path !== 'string' || !a.config.path) fail(`adapter 缺字段：config.path（${file}）`)
  if (typeof a.config?.block !== 'string' || !a.config.block) fail(`adapter 缺字段：config.block（${file}）`)
  if (typeof a.page?.file !== 'string' || !a.page.file) fail(`adapter 缺字段：page.file（${file}）`)

  const block = String(a.config.block)
  const m = BLOCK_RE.exec(block)
  if (!m) fail(`adapter.config.block 格式不对（要 effects.<Effect>.<Block>）：${block}`)
  const effect = m[1]
  const blockName = m[2]

  const freeze = a.freeze ?? {}
  const protocol = String(freeze.protocol ?? '')
  if (protocol !== 'noloop-step' && protocol !== 'url-time') {
    fail(`adapter.freeze.protocol=${protocol || '（缺）'} 未实现（iter.ps1 只支持 noloop-step | url-time）`)
  }
  if (freeze.targetTimeMs === undefined || freeze.targetTimeMs === null) fail(`adapter 缺字段：freeze.targetTimeMs（${file}）`)
  if (freeze.seed === undefined || freeze.seed === null) fail(`adapter 缺字段：freeze.seed（${file}）`)
  if (protocol === 'noloop-step' && !(Number(freeze.stepMs) > 0)) {
    fail(`adapter 缺字段：freeze.stepMs（noloop-step 必须有推进步长，${file}）`)
  }
  let clock = String(freeze.clock ?? '')
  if (clock === '' ) clock = protocol === 'url-time' ? 'n/a' : 'wall'
  if (protocol === 'url-time') {
    if (clock === 'virtual') fail(`adapter.freeze.clock=virtual 在 url-time 下没有意义（没有推进过程），写 "n/a"`)
    if (clock !== 'n/a' && clock !== 'wall') fail(`adapter.freeze.clock=${clock} 在 url-time 下只认 n/a|wall`)
  } else if (clock !== 'wall' && clock !== 'virtual') {
    fail(`adapter.freeze.clock=${clock} 只支持 wall|virtual（noloop-step）；url-time 下才是 n/a`)
  }

  for (const k of ['tier', 'width', 'height']) {
    if (a.render?.[k] === undefined || a.render[k] === null) fail(`adapter 缺字段：render.${k}（${file}）`)
  }
  for (const k of ['staticPort', 'cdpPort', 'browserProfilePrefix']) {
    if (a.server?.[k] === undefined || a.server[k] === null) fail(`adapter 缺字段：server.${k}（${file}）`)
  }

  let configFormat = String(a.config.format ?? 'vfx-block')
  if (configFormat !== 'vfx-block' && configFormat !== 'flat-params') {
    fail(`adapter.config.format=${configFormat} 只支持 vfx-block | flat-params`)
  }

  const warnings = []
  const adapterDir = resolve(file, '..')
  const clientRootRaw = String(a.clientRoot)
  const clientRoot = resolveWithWarn(adapterDir, clientRootRaw, 'clientRoot', warnings)
  if (clientRoot && !isAbsolute(clientRootRaw)) {
    warnings.push(`clientRoot 是相对路径（${clientRootRaw}）：按 adapter 所在目录展开成 ${clientRoot}（iter.ps1 同口径）`)
  }
  // clientRoot 没解析出来（通常是 %环境变量% 没设）时不要拿 cwd 去拼一个假路径骗人
  const configFile = clientRoot ? resolveFrom(clientRoot, String(a.config.path)) : ''
  const configFileExists = existsSync(configFile)
  if (!configFileExists) {
    warnings.push(
      `配置文件不在：${configFile || '（clientRoot 没解析出来）'} —— 一轮都跑不起来（iter.ps1 会抛"镜像配置文件不存在"）`,
    )
  }

  const staticScript = resolveWithWarn(harnessDir, String(a.server.staticScript ?? ''), 'server.staticScript', warnings)
  // 兜底顺序与 iter.ps1 一致：adapter 给的 → 包内自带 static/server.mjs → 旧项目根 _tmp_static.js
  let staticScriptUsed = staticScript
  if (!staticScriptUsed || !existsSync(staticScriptUsed)) {
    const packaged = join(harnessDir, '..', 'static', 'server.mjs')
    staticScriptUsed = existsSync(packaged) ? packaged : join(harnessDir, '..', '..', '_tmp_static.js')
  }
  if (!existsSync(staticScriptUsed)) {
    warnings.push(`静态服脚本找不到：${staticScriptUsed} —— adapter.server.staticScript 没给/指不到，包内自带那份也不在`)
  }

  const metricsJs = resolveWithWarn(harnessDir, String(a.tools?.metricsJs ?? ''), 'tools.metricsJs', warnings)
  const capture = resolveWithWarn(harnessDir, String(a.tools?.capture ?? 'capture.mjs'), 'tools.capture', warnings)
  const applyDefault = configFormat === 'flat-params' ? 'apply_params.js' : 'apply.js'
  const apply = resolveWithWarn(harnessDir, String(a.tools?.apply ?? applyDefault), 'tools.apply', warnings)
  const missingTools = []
  if (!metricsJs) missingTools.push('tools.metricsJs')
  else if (!existsSync(metricsJs)) missingTools.push(`tools.metricsJs → ${metricsJs}`)
  if (!capture) missingTools.push('tools.capture')
  else if (!existsSync(capture)) missingTools.push(`tools.capture → ${capture}`)
  if (!apply) missingTools.push('tools.apply')
  else if (!existsSync(apply)) missingTools.push(`tools.apply → ${apply}`)
  if (missingTools.length) warnings.push(`脚本找不到：${missingTools.join('；')}`)

  // 浏览器候选：%ProgramFiles(x86)% 这类模板在这里逐个展开（展开不了的那条跳过，不拦）
  const exeCandidates = [a.browser?.exe, ...(Array.isArray(a.browser?.exeCandidates) ? a.browser.exeCandidates : [])]
    .filter((x) => typeof x === 'string' && x.length > 0)
    .map((x) => {
      const { value } = expandEnvTpl(x)
      if (!value) return ''
      return isAbsolute(value) ? value : resolve(adapterDir, value)
    })
    .filter(Boolean)
  const exeFound = exeCandidates.find((p) => existsSync(p)) ?? ''
  if (!exeFound) warnings.push('adapter.browser 没命中任何浏览器（exe / exeCandidates 都不存在）：iter.ps1 会抛错')
  const browserArgs = Array.isArray(a.browser?.args) ? a.browser.args : []
  if (browserArgs.length === 0) warnings.push('adapter.browser.args 为空：iter.ps1 会抛错')

  const metrics = normalizeMetrics(a.metrics)
  if (metrics.length === 0) warnings.push('adapter.metrics 为空：score.js 会拒（P2.5 起必须是 v2 数组）')
  const penalties = normalizePenalties(a.score)
  const scoreType = String(a.score?.type ?? '')
  if (scoreType !== 'l1') warnings.push(`adapter.score.type=${scoreType || '（缺）'}：score.js 只实现 l1`)
  for (const it of metrics) {
    if (!Number.isFinite(it.weight)) warnings.push(`metric ${it.id} 的 weight 不是数`)
  }

  const targetMode = String(a.target?.mode ?? '')
  let targetPng = ''
  if (targetMode === 'png') {
    // target.path 按 adapter 所在目录展开（P2.6 口径）
    targetPng = resolveFrom(adapterDir, String(a.target?.path ?? ''))
    if (!targetPng || !existsSync(targetPng)) warnings.push(`target.mode=png 但目标帧不在：${targetPng || '（未给 path）'}`)
  }

  return {
    adapterResolved: resolve(file),
    adapterName: String(a.name),
    schemaVersion: String(a.schema ?? ''),
    // 领域标注（可选）：一眼看出这份 adapter 属于哪个题材包，如 vfx-render。缺字段 = 空串（照常跑）
    domain: String(a.domain ?? ''),
    clientRoot,
    clientRootExists: existsSync(clientRoot),
    configFile,
    configFileExists,
    configFormat,
    block,
    effect,
    blockName,
    page: { file: String(a.page.file), query: String(a.page.query ?? '') },
    freeze: {
      protocol,
      clock,
      stepMs: protocol === 'url-time' ? 0 : Number(freeze.stepMs),
      targetTimeMs: Number(freeze.targetTimeMs),
      seed: Number(freeze.seed),
    },
    render: { tier: String(a.render.tier), width: Number(a.render.width), height: Number(a.render.height) },
    server: {
      staticPort: Number(a.server.staticPort),
      cdpPort: Number(a.server.cdpPort),
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
    target: { mode: targetMode, png: targetPng },
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

