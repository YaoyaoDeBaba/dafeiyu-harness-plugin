// lib/index.js —— Selfloop（权臣）工具入口（三层里的最外层）
//
// 这个插件做两件事：
//   1) 注册两个只读工具（selfloop_probe / selfloop_list_adapters），把"这份 adapter 指向什么现场、
//      指标按什么口径算、缺哪个件"在开跑之前说清楚；
//   2) 挂在 ctx.skills 上，把包内 skills/selfloop 注册成技能（宿主没有 skills 服务就跳过）。
//
// 它不跑闭环：一轮要起浏览器、开端口、花预算，那是 harness/iter.ps1 的事。
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
import { routeHandlers, ROUTES } from './routes.js'

export const name = 'selfloop'
// 不导出插件级 inject —— 0.3.2 的实测教训（0.3.1 装上去 fiberPhase 永远是 pending）：
// 本宿主把 optional 依赖当成"等不到就永远等"，fiber 从不激活 → apply() 一次都没跑 →
// 两个工具和技能全消失，而且不报错，只有 plugin_manager 里的 fiberPhase 看得出来。
// 所以：不声明插件级依赖，运行期用 ctx.get('tools', true) 软探测 + 一行中文 warn（失败要响）。
// 运行期的 ctx.inject(['skills'], cb) 是另一件事（等某个晚到的服务），照用不误。

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
    'template',
    'page',
    'freeze',
    'render',
    'server',
    'browser',
    'metricsCount',
    'metrics',
    'observe',
    'distanceRule',
    'penalties',
    'tools',
    'guard',
    'target',
    'params',
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
    template: {
      type: 'boolean',
      description: 'true = 这是字段模板（包内 harness/adapter.json），没有可跑的目标/白名单，iter.ps1 会拒跑',
    },
    page: {
      type: 'object',
      additionalProperties: false,
      required: ['file', 'query', 'readyExpr', 'readbackExpr'],
      properties: {
        file: { type: 'string', description: '冻帧页面（clientRoot 下的相对路径）' },
        query: { type: 'string', description: '页面 query 模板（含 {seed} / {sec} 等占位）' },
        readyExpr: {
          type: 'string',
          description: '页面就绪判据；空串 = adapter 没给，iter.ps1 用中性默认（只等 document 就绪）',
        },
        readbackExpr: {
          type: 'string',
          description: '参数回读 JS；空串 = 不做浏览器侧回读，证据包 meta.selfCheck=false',
        },
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
    observe: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'cmdRaw', 'cmd', 'cwd', 'timeoutMs', 'parse', 'stability', 'metricsCount', 'metrics'],
      properties: {
        type: {
          type: 'string',
          description:
            '观测来源：空串 = 浏览器截图（iter.ps1：起浏览器、冻帧、metrics2.js 量像素）；command = 跑一条命令、从 stdout 取数（cmdloop.mjs）',
        },
        cmdRaw: { type: 'string', description: 'observe.cmd 原文（含参数与 {params} 占位）；空串 = adapter 没给 observe 节' },
        cmd: { type: 'string', description: '命令的第一段（跑什么）按 adapter 目录展开后的绝对路径；PATH 里的东西展开不了就是原文' },
        cwd: { type: 'string', description: '命令的工作目录（默认 adapter 所在目录）' },
        timeoutMs: { type: 'integer', description: '单次命令超时；超了直接中文硬错（不当 0）' },
        parse: { type: 'string', description: '输出取数方式：json / number / line:k=v / image（命令打印 PNG 路径，指标由 metrics2.js 提取器算）；空串 = 不是命令观测' },
        stability: {
          type: 'object',
          additionalProperties: false,
          required: ['repeat', 'maxSpread'],
          properties: {
            repeat: {
              type: 'integer',
              description:
                '观测稳定性闸的重复次数：搜索前用起点参数把命令连跑几次（默认 3，不写也生效）；1 = 显式关闭检查并打 warn；截图链路恒为 0 = 不适用',
            },
            maxSpread: {
              type: 'number',
              description:
                '允许的相对离散度上限 (max-min)/max(|mean|,1e-9)（默认 0.02，不写也生效）；超了中文硬错；截图链路恒为 0',
            },
          },
        },
        metricsCount: { type: 'integer', description: '命令观测参与打分的指标条数（截图链路这里恒为 0）' },
        metrics: {
          type: 'array',
          description: '命令观测的指标口径：field = stdout 里取哪个字段',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'field', 'weight', 'norm'],
            properties: {
              id: { type: 'string', description: '证据包里的列名（也是内部距离使用的键）' },
              field: { type: 'string', description: '输出里的字段名（可写 a.b 走嵌套）' },
              weight: { type: 'number', description: '权重' },
              norm: { type: 'string', description: '归一口径，如 abs(scale=1)' },
            },
          },
        },
      },
    },
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
    guard: {
      type: 'object',
      additionalProperties: false,
      required: ['bodyClient', 'protectPaths', 'enforced'],
      properties: {
        bodyClient: { type: 'string', description: 'adapter.guard.bodyClient 展开后的本体 client 目录；空串 = 不做本体前后哈希对比' },
        protectPaths: {
          type: 'array',
          items: { type: 'string' },
          description: '写入禁区（已展开的绝对路径）：改参脚本拒绝把文件写进这些目录；bodyClient 非空时已并入',
        },
        enforced: { type: 'boolean', description: '是否真的声明出了保护路径；false = 只保证 out≠base，不做本体写保护' },
      },
    },
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'png', 'params', 'metrics'],
      properties: {
        mode: {
          type: 'string',
          description: 'png / params / metrics / default；空串 = adapter 没给 target 节（最少命令行会报错）。metrics 只对命令观测有意义',
        },
        png: { type: 'string', description: 'target.mode=png 时目标帧的绝对路径；其他模式是空串' },
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'target.mode=params 时的目标参数（{参数名: 数值}）；其他模式是空对象',
        },
        metrics: {
          type: 'object',
          additionalProperties: true,
          description: 'target.mode=metrics 时的目标数值（{指标 id: 数值}，只对命令观测有意义）；其他模式是空对象',
        },
      },
    },
    params: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'list'],
      properties: {
        mode: { type: 'string', description: '白名单来源：list / activity / auto；空串 = adapter 没给 params 节（必须 -Params 显式给）' },
        list: { type: 'array', items: { type: 'string' }, description: 'mode=list 时的参数白名单（可含 name=初值）' },
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
    clientRoot: {
      type: 'string',
      description:
        '可选：直接给 client 根目录的绝对路径，盖掉 adapter 里的 clientRoot / %VFX_LOOP_CLIENT%。宿主进程常常继承不到那条环境变量，这个参数就是为它准备的——省掉"设变量 + 重启宿主"。必须存在。',
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
      const obs =
        v.observe.type === 'command'
          ? `观测：命令（parse=${v.observe.parse}，timeout=${v.observe.timeoutMs}ms，cwd=${v.observe.cwd}）\n  命令：${v.observe.cmdRaw || '（空）'}\n  取数：${v.observe.metrics.map((m) => `${m.id}←${m.field}×${m.weight}[${m.norm}]`).join(' ') || '（无）'}\n  稳定性：repeat=${v.observe.stability.repeat} · maxSpread=${v.observe.stability.maxSpread}${v.observe.stability.repeat === 1 ? '（repeat=1：检查已显式关闭，命令有随机性时收敛结果不可信）' : '（搜索前用起点参数连跑，抖超上限就硬错）'}`
          : `观测：浏览器截图（${v.freeze.protocol} · 冻帧 + metrics2.js）`
      const lines = [
        `adapter：${v.adapterName}（${v.schemaVersion}）→ ${v.adapterResolved}`,
        `领域：${v.domain || '（未标注）'}`,
        `参数块：${v.block || '（命令观测无参数块）'}（${v.configFormat}）  配置文件${v.configFileExists ? '在' : '不在'}：${v.configFile}`,
        obs,
      ]
      // 冻帧 / 视口 / 端口 只属于截图链路（浏览器 + 冻帧协议那一套），命令观测没有这些概念 —— 不打印空壳。
      if (v.observe.type !== 'command') {
        lines.push(`冻帧：${v.freeze.protocol || 'n/a'} · clock=${v.freeze.clock} · t=${v.freeze.targetTimeMs}ms · seed=${v.freeze.seed}`)
        lines.push(`视口：${v.render.tier || 'n/a'} ${v.render.width}x${v.render.height}  端口：静态 ${v.server.staticPort} / CDP ${v.server.cdpPort}`)
      }
      lines.push(
        `指标 ${v.metricsCount} 项：${metrics || '（空）'}`,
        `距离：${v.distanceRule}`,
        v.penalties.length ? `惩罚：${v.penalties.map((p) => `${p.id}(${p.when}) +${p.add}`).join('；')}` : '惩罚：无',
        `harness：${v.harness.dir}（${v.harness.required} 件，缺 ${v.harness.missing.length}）`,
        v.warnings.length ? `警告 ${v.warnings.length} 条：\n- ${v.warnings.join('\n- ')}` : '警告：无',
        v.note,
      )
      return text(lines.join('\n'))
    },
  },
  async execute(args) {
    check(args, PROBE_PARAMS)
    const given = args?.adapter
    if (given && !isAbsolute(given)) throw new Error('adapter 要用绝对路径；省略则读包内示例')
    const file = given ?? DEFAULT_ADAPTER
    if (!existsSync(file)) throw new Error(`读不到 adapter：${file}`)
    const a = parseAdapter(file, HARNESS_DIR, { clientRoot: args?.clientRoot })
    // 首装成本只属于截图链路（playwright 引擎）；命令观测不需要浏览器，别对它报一条无关警告
    if (a.observe.type !== 'command') {
      const chromiumWarn = chromiumWarning()
      if (chromiumWarn) a.warnings.push(chromiumWarn)
    }
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
      template: a.template,
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
      observe: {
        type: a.observe.type,
        cmdRaw: a.observe.cmdRaw,
        cmd: a.observe.cmd,
        cwd: a.observe.cwd,
        timeoutMs: Number.isFinite(a.observe.timeoutMs) ? a.observe.timeoutMs : 0,
        parse: a.observe.parse,
        stability: {
          repeat: Number.isInteger(a.observe.stability?.repeat) ? a.observe.stability.repeat : 0,
          maxSpread: Number.isFinite(a.observe.stability?.maxSpread) ? a.observe.stability.maxSpread : 0,
        },
        metricsCount: a.observe.metricsCount,
        metrics: a.observe.metrics.map((m) => ({
          id: m.id,
          field: m.field,
          weight: Number.isFinite(m.weight) ? m.weight : 0,
          norm: m.norm,
        })),
      },
      distanceRule: a.distanceRule,
      penalties: a.penalties.map((p) => ({ id: p.id, when: p.when, add: Number.isFinite(p.add) ? p.add : 0 })),
      tools: a.tools,
      guard: a.guard,
      target: a.target,
      params: a.params,
      harness: (({ dir, required, missing }) => ({ dir, required, missing }))(harnessStatus(HARNESS_DIR)),
      warnings: a.warnings,
      note:
        a.observe.type === 'command'
          ? '只解析现场，不起进程、不开端口、不花预算。要真跑一轮用包内 harness/cmdloop.mjs（纯 node，跨平台）：node harness/cmdloop.mjs --adapter <这份 adapter 的绝对路径> --out <run 目录> --budget 40。它跑命令、取指标、搜索、出证据包（curve.csv / best.json / report.md / outputs/）。'
          : NOTE,
    }
  },
}

// ---------------------------------------------------------------- selfloop_list_adapters
export const selfloopListAdaptersTool = {
  name: 'selfloop_list_adapters',
  description:
    '列出插件自带的适配器（所属领域、题材、参数块、冻帧协议、档位、指标条数），按 domain 分组，并说明每份现在能不能跑（clientRoot 是否指得到配置文件）。只读目录，不执行任何闭环。',
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
// 有 skills 服务就把包内技能注册进去（宿主没挂 skills 服务时只是这一节不生效）。
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

// ---------------------------------------------------------------- 服务接入
// 三次踩坑换来的姿势（0.3.0 active / 0.3.1 pending / 0.3.2 failed 三连）：
//   ① 不导出插件级 inject —— 本宿主把 optional 依赖当成"等不到就永远等"，fiberPhase 卡 pending；
//   ② 不在 apply 里直接读 ctx.<服务> —— cordis 的 Proxy 对未声明 inject 的属性访问直接抛
//      （`cannot get property "tools" without inject`），异常冒到 fiber 就是 failed；
//   ③ 不在 apply 里用 ctx.get 同步取一次 —— 服务还没 ACTIVE 时它按设计返回 undefined
//      （cordis `_getImpl`：fiber.state !== ACTIVE 就返回空），不是"服务不存在"。
// 正确姿势只有一个：ctx.inject(deps, cb) 订阅，框架在服务就绪时回调（大肥鱼同款）。
// 只有宿主没有 ctx.inject 的老实现，才退化成同步探测：全程 try，只碰 ctx.get，绝不碰属性。
function warn(ctx, msg) {
  if (ctx?.logger?.warn) ctx.logger.warn(msg)
  else console.warn(msg)
}

const LABEL = { tools: '两个工具', skills: '技能', webServer: 'UI 路由' }

function withService(ctx, names, label, cb) {
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(names, (scoped) => cb(scoped ?? ctx))
      return 'injected'
    } catch (e) {
      warn(ctx, `selfloop：订阅 ${label} 失败（${e?.message ?? e}），改用同步探测`)
    }
  }
  const scoped = {}
  let any = false
  for (const n of names) {
    let got
    try {
      got = typeof ctx?.get === 'function' ? ctx.get(n, true) : undefined
    } catch {
      got = undefined
    }
    scoped[n] = got
    if (got) any = true
  }
  if (!any) {
    warn(ctx, `selfloop：宿主没有 ${label} 服务，${LABEL[label] ?? label}未注册（插件其余部分照常）`)
    return 'missing'
  }
  cb(scoped)
  return 'sync'
}

function registerTools(ctx) {
  withService(ctx, ['tools'], 'tools', (c) => {
    const tools = c?.tools
    if (tools?.register) {
      tools.register(selfloopProbeTool)
      tools.register(selfloopListAdaptersTool)
      return
    }
    warn(ctx, 'selfloop：tools 服务在，但没有 register 方法，两个工具未注册')
  })
}

function registerSkill(ctx) {
  const skill = readSkill()
  withService(ctx, ['skills'], 'skills', (c) => {
    if (c?.skills?.register) c.skills.register(skill)
    else warn(ctx, 'selfloop：skills 服务在，但没有 register 方法，技能未注册')
  })
}

// 右侧栏 UI 用的四条同源路由（2026-11-17）。与工具/技能同一套软探测姿势：
// webServer 晚到就 ctx.inject 等它；宿主没有这一面就只 warn，插件其余部分照常。
function registerRoutes(ctx) {
  withService(ctx, ['webServer'], 'webServer', (c) => {
    const web = c?.webServer
    if (!web?.register) {
      warn(ctx, 'selfloop：webServer 服务在，但没有 register 方法，UI 路由未注册')
      return
    }
    // 模型清单的唯一事实源是宿主的 llm 服务（与 DSH 模型选择器同源）。
    // 这里只把「怎么取」传下去，不在这里读属性：llm 可能比 webServer 晚到，必须调用时再取。
    const getLlm = () => {
      try {
        return typeof c?.get === 'function' ? c.get('llm', true) : undefined
      } catch {
        return undefined
      }
    }
    for (const { path, handler } of routeHandlers({ prefix: '/plugins/dsh-selfloop', getLlm })) {
      try {
        web.register({ kind: 'exact', path, handler })
      } catch (e) {
        warn(ctx, 'selfloop：路由 ' + path + ' 注册失败（' + (e?.message ?? e) + '）')
      }
    }
  })
}

export function apply(ctx) {
  try {
    registerTools(ctx)
  } catch (e) {
    warn(ctx, `selfloop：工具注册失败（${e?.message ?? e}）`)
  }
  try {
    registerSkill(ctx)
  } catch (e) {
    warn(ctx, `selfloop：技能注册失败（${e?.message ?? e}）`)
  }
  try {
    registerRoutes(ctx)
  } catch (e) {
    warn(ctx, `selfloop：UI 路由注册失败（${e?.message ?? e}）`)
  }
}

export { ROUTES }

export { STATIC_SERVER }
