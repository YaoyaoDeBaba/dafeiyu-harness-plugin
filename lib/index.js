// lib/index.js —— Selfloop（权臣）工具入口（三层里的最外层）
//
// 这个插件做两件事：
//   1) 注册两个只读工具（selfloop_probe / selfloop_list_adapters），把"这份 adapter 指向什么现场、
//      指标按什么口径算、缺哪个件"在开跑之前说清楚；
//   2) 挂在 ctx.skills 上，把包内 skills/selfloop 注册成技能（宿主没有 skills 服务就跳过）。
//
// 它不跑产线：一轮要起浏览器、开端口、花预算，那是 harness/iter.ps1 的事。
// 领域无关的部分全在 core/，题材差异全在 domains/<domain>/，本文件不认识任何具体领域。
// 硬错口径与 iter.ps1 的 Import-Adapter 对齐（见 core/adapter.js），不自己发明更严的规则。
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chromiumStatus,
  groupByDomain,
  harnessStatus,
  listAdapters,
  parseAdapter,
  STATIC_SERVER,
} from '../core/index.js'

export const name = 'selfloop'
// 可选注入：宿主没暴露 tools 时，本插件仍然加载（技能照常注册），只在日志里喊一声。
// 用 required:[] 而不是裸数组，是为了避免"某一代宿主缺 tools 就整行不激活"的静默不加载。
export const inject = { required: [], optional: ['tools'] }

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HARNESS_DIR = join(ROOT, 'harness')
// 今天的领域：vfx 渲染。新领域加目录即可，本文件只认这一个常量（工具默认读它）。
const DOMAIN = 'vfx-render'
const ADAPTER_DIR = join(ROOT, 'domains', DOMAIN, 'adapters')
const SKILL_DIR = join(ROOT, 'skills', 'selfloop')
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')
export const DEFAULT_ADAPTER = join(ADAPTER_DIR, 'fire-ray.json')
export const DEFAULT_DOMAIN = DOMAIN

const NOTE =
  '只解析现场，不起浏览器、不开端口、不花预算。要真跑一轮用包内 harness/iter.ps1（见 README）。这个工具本身只读、跨平台；harness 是 Windows 专用（基于 PowerShell + Edge），非 Windows 会在入口直接报错。'

const text = (value) => [{ type: 'text', text: value }]

// 首装成本要显形（评审 §4.2）：Chromium 不在包里，playwright 引擎第一次要联网拉约 740 MB。
// 这条只在"没找到缓存"时出现，且明确写了"用 Edge 引擎不受影响"——不制造假警报。
function chromiumWarning() {
  const ck = chromiumStatus()
  if (ck.found) return null
  return (
    `没在 ${ck.base || '（未定位到缓存目录）'} 找到 Playwright 的 Chromium：` +
    '只有 playwright 引擎需要它（首装约 740 MB，只要无头版约 290 MB，不进包）。' +
    '补法：在包目录执行 npx playwright install chromium（省空间：npx playwright install --only-shell chromium）；' +
    '下载慢先设 PLAYWRIGHT_DOWNLOAD_HOST=<镜像>；下载失败会在 capture 返回里带中文原因与补救提示。' +
    '用 Edge 引擎（默认）不受影响。'
  )
}

// 注册的是原始 JSON Schema，没有 defineTool 帮忙校验参数，这里自己挡
function check(args, schema) {
  const errs = []
  for (const [k, v] of Object.entries(args ?? {})) {
    const p = schema.properties[k]
    if (!p) errs.push(`未知参数 ${k}`)
    else if (typeof v !== 'string') errs.push(`${k} 应该是字符串`)
    else if (v === '') errs.push(`${k} 不能是空字符串`)
  }
  if (errs.length) throw new Error(errs.join('；'))
}

// ---------------------------------------------------------------- 输出 schema
// 每个 object 都显式 additionalProperties: false，返回值和 schema 必须逐键对得上
// （宿主会用 output.schema 校验返回值；test/plugin.test.mjs 里也照样验一遍）
const PROBE_OUT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'ok',
    'adapterResolved',
    'adapterName',
    'schemaVersion',
    'domain',
    'clientRoot',
    'configFile',
    'configFileExists',
    'configFormat',
    'block',
    'page',
    'freeze',
    'render',
    'server',
    'browser',
    'metricsCount',
    'metrics',
    'distanceRule',
    'penalties',
    'tools',
    'harness',
    'warnings',
    'note',
  ],
  properties: {
    ok: { type: 'boolean', description: 'adapter 是否解析成功' },
    adapterResolved: { type: 'string', description: '实际读的 adapter.json 绝对路径' },
    adapterName: { type: 'string', description: 'adapter.name' },
    schemaVersion: { type: 'string', description: 'adapter.schema（如 closed-loop-adapter/3）' },
    domain: { type: 'string', description: 'adapter.domain（领域标注，可选）；缺字段时是空串，不影响能否跑' },
    clientRoot: { type: 'string', description: '要调参的 client 根目录' },
    configFile: { type: 'string', description: 'clientRoot + config.path 展开后的配置文件绝对路径' },
    configFileExists: { type: 'boolean', description: '那份配置文件现在在不在' },
    configFormat: { type: 'string', description: 'vfx-block（vfx.json 嵌套块）或 flat-params（扁平 {params}）' },
    block: { type: 'string', description: '参数块，形如 effects.<Effect>.<Block>' },
    page: {
      type: 'object',
      additionalProperties: false,
      required: ['file', 'query'],
      properties: {
        file: { type: 'string', description: '冻帧页面（clientRoot 下的相对路径）' },
        query: { type: 'string', description: '页面 query 模板（含 {seed} / {sec} 等占位）' },
      },
    },
    freeze: {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'clock', 'stepMs', 'targetTimeMs', 'seed'],
      properties: {
        protocol: { type: 'string', description: 'noloop-step 或 url-time' },
        clock: { type: 'string', description: 'wall / virtual / n/a' },
        stepMs: { type: 'integer', description: '推进步长（url-time 恒 0，表示没有推进过程）' },
        targetTimeMs: { type: 'integer', description: '冻结的绝对时刻' },
        seed: { type: 'integer', description: '随机种子' },
      },
    },
    render: {
      type: 'object',
      additionalProperties: false,
      required: ['tier', 'width', 'height'],
      properties: {
        tier: { type: 'string', description: '画质档' },
        width: { type: 'integer', description: '视口宽' },
        height: { type: 'integer', description: '视口高' },
      },
    },
    server: {
      type: 'object',
      additionalProperties: false,
      required: ['staticPort', 'cdpPort', 'staticScript', 'staticScriptExists'],
      properties: {
        staticPort: { type: 'integer', description: '静态服端口' },
        cdpPort: { type: 'integer', description: 'CDP 端口（playwright 引擎不用它）' },
        staticScript: { type: 'string', description: '静态服脚本绝对路径' },
        staticScriptExists: { type: 'boolean', description: '那个脚本现在在不在' },
      },
    },
    browser: {
      type: 'object',
      additionalProperties: false,
      required: ['exeCandidates', 'exeFound'],
      properties: {
        exeCandidates: { type: 'integer', description: 'adapter.browser 声明了几个候选可执行文件' },
        exeFound: { type: 'string', description: '本机命中的第一个浏览器路径；没命中是空串' },
      },
    },
    metricsCount: { type: 'integer', description: '参与打分的指标条数' },
    metrics: {
      type: 'array',
      description: '指标口径：每条 = 从哪个提取器取、权重、归一方式',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'extract', 'weight', 'norm', 'enabled'],
        properties: {
          id: { type: 'string', description: '证据包里的列名' },
          extract: { type: 'string', description: 'metrics2.js 的提取器 id' },
          weight: { type: 'number', description: '权重（距离里分子分母都乘它）' },
          norm: { type: 'string', description: '归一口径，如 range[0,0.3]' },
          enabled: { type: 'boolean', description: 'false 时不参与距离' },
        },
      },
    },
    distanceRule: { type: 'string', description: '距离公式（含 penalty 语义）与 score.type 支持情况' },
    penalties: {
      type: 'array',
      description: '惩罚项：when 命中就给 d 加 add',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'when', 'add'],
        properties: {
          id: { type: 'string', description: '惩罚项 id' },
          when: { type: 'string', description: '命中条件（|| 分隔的 anyOf）' },
          add: { type: 'number', description: '命中时加到距离上的量' },
        },
      },
    },
    tools: {
      type: 'object',
      additionalProperties: false,
      required: ['metricsJs', 'capture', 'apply', 'missing'],
      properties: {
        metricsJs: { type: 'string', description: '指标脚本绝对路径；空串表示 adapter 没给' },
        capture: { type: 'string', description: '浏览器边界脚本绝对路径' },
        apply: { type: 'string', description: '改参脚本绝对路径' },
        missing: { type: 'array', items: { type: 'string' }, description: '找不到的脚本（空数组=齐全）' },
      },
    },
    harness: {
      type: 'object',
      additionalProperties: false,
      required: ['dir', 'required', 'missing'],
      properties: {
        dir: { type: 'string', description: '包内 harness 目录' },
        required: { type: 'integer', description: '跑一轮所需的件数' },
        missing: { type: 'array', items: { type: 'string' }, description: '缺的件（空数组=齐全）' },
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: '能解析但开跑会出问题的地方；空数组=没发现问题',
    },
    note: { type: 'string', description: '本工具的边界' },
  },
}

const LIST_OUT = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'dir', 'count', 'domains', 'groups', 'adapters', 'note'],
  properties: {
    ok: { type: 'boolean', description: '目录是否读成功' },
    dir: { type: 'string', description: '包内适配器目录绝对路径' },
    count: { type: 'integer', description: '适配器份数' },
    domains: {
      type: 'array',
      items: { type: 'string' },
      description: '出现的领域标注（去重、有标注的在前；空串表示有配置没写 domain）',
    },
    groups: {
      type: 'array',
      description: '按 domain 分组：domain + 份数 + 文件列表',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['domain', 'count', 'files'],
        properties: {
          domain: { type: 'string', description: '领域标注；空串 = 未标注（旧配置）' },
          count: { type: 'integer', description: '该领域几份' },
          files: { type: 'array', items: { type: 'string' }, description: '该领域下每份 adapter 的绝对路径' },
        },
      },
    },
    adapters: {
      type: 'array',
      description: '每份适配器：适用题材 + 所属领域 + 现在能不能跑',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'file',
          'name',
          'domain',
          'topic',
          'schemaVersion',
          'block',
          'freezeProtocol',
          'tier',
          'metricsCount',
          'runnable',
          'reason',
        ],
        properties: {
          file: { type: 'string', description: '该 adapter 的绝对路径' },
          name: { type: 'string', description: 'adapter.name；解析失败时为空串' },
          domain: { type: 'string', description: 'adapter.domain；缺字段时是空串（旧配置照常能跑）' },
          topic: { type: 'string', description: '适用题材' },
          schemaVersion: { type: 'string', description: 'adapter.schema' },
          block: { type: 'string', description: '参数块' },
          freezeProtocol: { type: 'string', description: '冻帧协议' },
          tier: { type: 'string', description: '画质档' },
          metricsCount: { type: 'integer', description: '指标条数' },
          runnable: { type: 'boolean', description: 'clientRoot 现在指得到配置文件吗' },
          reason: { type: 'string', description: '不能跑的原因；能跑是空串' },
        },
      },
    },
    note: { type: 'string', description: 'runnable 的口径' },
  },
}

const PROBE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    adapter: {
      type: 'string',
      description: 'adapter.json 的绝对路径；省略时读包内 domains/vfx-render/adapters/fire-ray.json',
    },
  },
}

const LIST_PARAMS = { type: 'object', additionalProperties: false, properties: {} }

// ---------------------------------------------------------------- selfloop_probe
export const selfloopProbeTool = {
  name: 'selfloop_probe',
  description:
    '解析一份闭环 adapter.json：要调参的目标与参数块、观测怎么冻结、视口档位、端口、判据口径（提取器/权重/归一/惩罚）、所属领域（domain）以及包内执行器 harness 是否齐全。只读文件并返回解析结果，不起浏览器、不截图、不改配置。',
  parameters: PROBE_PARAMS,
  output: {
    schema: PROBE_OUT,
    render: (_args, v) => {
      const metrics = v.metrics.map((m) => `${m.id}=${m.extract}×${m.weight}[${m.norm}]`).join(' ')
      const lines = [
        `adapter：${v.adapterName}（${v.schemaVersion}）→ ${v.adapterResolved}`,
        `领域：${v.domain || '（未标注）'}`,
        `参数块：${v.block}（${v.configFormat}）  配置文件${v.configFileExists ? '在' : '不在'}：${v.configFile}`,
        `冻帧：${v.freeze.protocol} · clock=${v.freeze.clock} · t=${v.freeze.targetTimeMs}ms · seed=${v.freeze.seed}`,
        `视口：${v.render.tier} ${v.render.width}x${v.render.height}  端口：静态 ${v.server.staticPort} / CDP ${v.server.cdpPort}`,
        `指标 ${v.metricsCount} 项：${metrics || '（空）'}`,
        `距离：${v.distanceRule}`,
        v.penalties.length ? `惩罚：${v.penalties.map((p) => `${p.id}(${p.when}) +${p.add}`).join('；')}` : '惩罚：无',
        `harness：${v.harness.dir}（${v.harness.required} 件，缺 ${v.harness.missing.length}）`,
        v.warnings.length ? `警告 ${v.warnings.length} 条：\n- ${v.warnings.join('\n- ')}` : '警告：无',
        v.note,
      ]
      return text(lines.join('\n'))
    },
  },
  async execute(args) {
    check(args, PROBE_PARAMS)
    const given = args?.adapter
    if (given && !isAbsolute(given)) throw new Error('adapter 要用绝对路径；省略则读包内示例')
    const file = given ?? DEFAULT_ADAPTER
    if (!existsSync(file)) throw new Error(`读不到 adapter：${file}`)
    const a = parseAdapter(file, HARNESS_DIR)
    const chromiumWarn = chromiumWarning()
    if (chromiumWarn) a.warnings.push(chromiumWarn)
    return {
      ok: true,
      adapterResolved: a.adapterResolved,
      adapterName: a.adapterName,
      schemaVersion: a.schemaVersion,
      domain: a.domain,
      clientRoot: a.clientRoot,
      configFile: a.configFile,
      configFileExists: a.configFileExists,
      configFormat: a.configFormat,
      block: a.block,
      page: a.page,
      freeze: a.freeze,
      render: a.render,
      server: a.server,
      browser: a.browser,
      metricsCount: a.metricsCount,
      metrics: a.metrics.map((m) => ({
        id: m.id,
        extract: m.extract,
        weight: Number.isFinite(m.weight) ? m.weight : 0,
        norm: m.norm,
        enabled: m.enabled,
      })),
      distanceRule: a.distanceRule,
      penalties: a.penalties.map((p) => ({ id: p.id, when: p.when, add: Number.isFinite(p.add) ? p.add : 0 })),
      tools: a.tools,
      harness: (({ dir, required, missing }) => ({ dir, required, missing }))(harnessStatus(HARNESS_DIR)),
      warnings: a.warnings,
      note: NOTE,
    }
  },
}

// ---------------------------------------------------------------- selfloop_list_adapters
export const selfloopListAdaptersTool = {
  name: 'selfloop_list_adapters',
  description:
    '列出插件自带的适配器（所属领域、题材、参数块、冻帧协议、档位、指标条数），按 domain 分组，并说明每份现在能不能跑（clientRoot 是否指得到配置文件）。只读目录，不执行任何产线。',
  parameters: LIST_PARAMS,
  output: {
    schema: LIST_OUT,
    render: (_args, v) => {
      const line = (a) =>
        `  - ${a.name || '(解析失败)'}｜${a.topic}｜${a.freezeProtocol}·${a.tier}·${a.metricsCount} 指标｜${a.runnable ? '能跑' : `跑不了：${a.reason}`}`
      const rows = []
      for (const g of v.groups) {
        rows.push(`[${g.domain || '（未标注领域）'}] ${g.count} 份`)
        for (const a of v.adapters.filter((x) => x.domain === g.domain)) rows.push(line(a))
      }
      return text([`包内适配器 ${v.count} 份（${v.dir}）`, ...rows, v.note].join('\n'))
    },
  },
  async execute() {
    const adapters = listAdapters(ADAPTER_DIR, HARNESS_DIR)
    const groups = groupByDomain(adapters)
    return {
      ok: true,
      dir: ADAPTER_DIR,
      count: adapters.length,
      domains: groups.map((g) => g.domain),
      groups,
      adapters,
      note: 'runnable = adapter.clientRoot 指向的配置文件现在存在。示例的 clientRoot 是 %VFX_LOOP_CLIENT% / %VFX_LOOP_DEMO_HOST% 模板：设好那个环境变量就能跑，不用改包里的文件。',
    }
  },
}

// ---------------------------------------------------------------- 技能（可选服务）
// 有 ctx.skills 就把包内技能注册进去（宿主没挂 skills 服务时静默跳过，不影响两个工具）。
function readSkill() {
  const src = readFileSync(SKILL_FILE, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  const meta = {}
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
      if (kv) meta[kv[1]] = kv[2].trim()
    }
  }
  return {
    name: meta.name ?? 'selfloop',
    description: meta.description ?? '',
    whenToUse: meta.whenToUse,
    content: m ? src.slice(m[0].length) : src,
    path: SKILL_FILE,
    source: 'runtime',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  }
}

function registerSkill(ctx) {
  const skill = readSkill()
  const register = (c) => {
    if (c?.skills?.register) c.skills.register(skill)
  }
  if (typeof ctx.inject === 'function') {
    // 可选依赖：宿主没挂 skills 服务时这段整体不跑，插件其余部分照常
    ctx.inject(['skills'], (c) => {
      register(c)
    })
    return
  }
  register(ctx)
}

function resolveTools(ctx) {
  // 软探测：第二个参数必须是 true（可选），否则宿主没登记这一面时会抛
  if (typeof ctx?.get === 'function') {
    try {
      return ctx.get('tools', true)
    } catch {
      return null
    }
  }
  return ctx?.tools ?? null
}

export function apply(ctx) {
  const tools = resolveTools(ctx)
  if (tools?.register) {
    tools.register(selfloopProbeTool)
    tools.register(selfloopListAdaptersTool)
  } else {
    const msg = 'selfloop：宿主没有暴露 tools 服务，两个工具未注册（技能与文档能力照常）'
    if (ctx?.logger?.warn) ctx.logger.warn(msg)
    else console.warn(msg)
  }
  try {
    registerSkill(ctx)
  } catch (e) {
    const msg = `selfloop：技能注册失败，两个工具照常可用（${e?.message ?? e}）`
    if (ctx?.logger?.warn) ctx.logger.warn(msg)
    else console.warn(msg)
  }
}

export { STATIC_SERVER }
