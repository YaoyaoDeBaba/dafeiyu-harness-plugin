# dsh-selfloop（权臣）

> **通用闭环引擎**：任意**可测目标 + 可调参数**，都能用「观测 → 判定 → 搜索」把参数自动调到接近目标，并留下可复验的证据包。
> vfx 渲染只是它接上的**第一个领域**（`domains/vfx-render/`）——引擎本身不认识火柱，也不认识别的题材。

> **① 执行器 Windows 专用**｜`harness/` 基于 PowerShell + Edge/Chromium（`taskkill`、`Win32_Process`、`Get-NetTCPConnection`）。Mac/Linux 会在**入口直接报错退出**（`本适配器需要 Windows（harness 基于 PowerShell + Edge）；当前平台 <xxx> 不受支持。`），不会跑到一半才炸。上游已定案：**不把 .ps1 重写成 Node**。
> 两个**工具**本身是纯 Node、跨平台只读。
>
> **② Node ≥ 22.19**｜`engines.node` = `^22.19.0 || >=24.0.0`。
>
> **③ 首次运行要下载浏览器**｜Playwright Chromium 约 **740 MB**（只装 headless shell 约 **290 MB**）；用系统 Edge 则**零下载**。见「首装成本与失败处理」。

## 三个概念（引擎与题材的分界）

| 概念 | 是什么 | 谁配 |
|---|---|---|
| **观测** | 任意能给出可比较数值的探针（渲染图、日志、接口响应、UI 状态） | adapter 的 `page` / `freeze` / `tools.metricsJs` |
| **判定** | 可配置的判据与距离（不做裁判，只做粗筛与报警） | adapter 的 `metrics` / `score` |
| **搜索** | 可配置的参数空间（先扫活性，再选轴） | adapter 的 `params` + 执行器 `iter.ps1` |

引擎只解决**形**（粗细、长度、节奏、面积、亮度这类能算的量），不解决**色 / 质 / 味**，也不替人判断成品好不好看。

## 三层 + 执行器

| 层 | 目录 | 放什么 | 换题材要不要动 |
|---|---|---|---|
| 入口 | `lib/` | 两个工具的定义、参数与输出 schema、技能注册 | 不动 |
| 引擎 | `core/` | adapter 契约解析、硬错口径、清单与领域分组、harness 齐全性 | 不动 |
| 领域 | `domains/<domain>/` | 该题材的 `adapters/*.json` + 领域说明 | **只动这里** |
| 执行器 | `harness/` | `iter.ps1` / `capture.mjs` / `metrics2.js` / `score.js` / `finalize.js` / `apply*.js` / `writeguard.js` | 按需可改：**改了记 CHANGELOG，并回灌 fanren 侧原件** |

`harness/` 为什么没被搬进 `core/`：它是已经跑通的产品资产（PowerShell + Edge + 那套 Windows 进程卫生，都实测过）。为了目录好看去搬它、改里面的路径，等于拿跑通的东西换排版。所以三层体现在**谁引用谁**和**文档描述**上：`lib/` → `core/` → 引用 `harness/` 与 `domains/`，单向。

## 装上之后你得到

| 得到什么 | 在哪 |
|---|---|
| 两个只读工具 `selfloop_probe` / `selfloop_list_adapters` | 模型侧工具目录 |
| 跑一轮的必需件（`iter.ps1` + 8 个伴生脚本 + 字段模板 `adapter.json` + 适配层字段说明） | `harness/` |
| 自带静态服（替掉对项目根 `_tmp_static.js` 的依赖） | `static/server.mjs` |
| 首个领域的 3 份示例适配器（火焰射线 / 闪电链 / url-time demo） | `domains/vfx-render/adapters/` |
| 一份不绑任何项目的最小示例（自己写 adapter 就从它改） | `examples/minimal.json` |
| `selfloop` 技能（宿主有 `ctx.skills` 时自动注册） | `skills/selfloop/` |

**这个插件不跑产线**：工具只读文件，不起浏览器、不开端口、不花预算。真跑一轮是 `harness/iter.ps1` 的事。

## 工具

### `selfloop_probe { adapter? }`

解析一份 adapter.json 描述的现场，返回：`domain`（所属领域）/ `clientRoot` / 配置文件路径与是否存在 / 参数块 / 冻帧协议（`noloop-step` | `url-time`，含 clock、步长、冻结时刻、seed）/ 视口档位 / 端口 / **判据口径**（每条指标 = 提取器 + 权重 + 归一区间 + 是否启用）/ 距离公式与惩罚项 / 目标与白名单来源（`target` / `params`）/ `template`（是不是字段模板）/ `guard`（`protectPaths` + `enforced`）/ 包内 harness 是否齐全 / `warnings`。

- `adapter`：adapter.json 的**绝对路径**；省略时读包内 `domains/vfx-render/adapters/fire-ray.json`
- `clientRoot`：可选，**绝对路径**，直接盖掉 adapter 里的 `clientRoot` / `%VFX_LOOP_CLIENT%`。宿主进程常常继承不到那条环境变量（用户在自己 shell 里设的），这个参数就是为它准备的——省掉「设变量 + 重启宿主」；必须真实存在，相对路径和不存在都直接报错。
- 硬错（缺 `name`/`clientRoot`/`config`/`page`/`freeze`/`render`/`server`、`freeze.protocol` 不认、`config.format` 不认、`noloop-step` 缺 `stepMs`、`clock` 口径不对）**与 `iter.ps1` 的 `Import-Adapter` 同口径**，不多拦
- 能解析但开跑会炸的（配置文件不在、浏览器没装、脚本指不到、`score.type` 不是 `l1`）只进 `warnings`，不当错误
- `guard.protectPaths` 没写只 warn（`enforced:false`），不当错误——但这时改参脚本没有"拒写本体"的保护

### `selfloop_list_adapters {}`

列出包内适配器：**所属领域（按 `domain` 分组）**、题材、参数块、冻帧协议、档位、指标条数，以及**现在能不能跑**（`runnable` = `clientRoot` 指得到配置文件）。示例里的 `clientRoot` 是 `%VFX_LOOP_CLIENT%` 模板，没设那个环境变量时 `runnable=false` 且 reason 会说清是哪个变量没设。

`domain` 字段是**可选**的：写 `"domain": "vfx-render"` 就归到那一组；不写的旧配置照常解析、照常跑，只是落到「（未标注领域）」组。

## 首个领域：vfx-render

`domains/vfx-render/` 里放的是「技能特效渲染」这个领域的适配包：三份 adapter + 领域说明。领域差异（冻帧页、`vfx.json` 参数块、warmFrac/coldFrac、进程卫生）全在那里和 `skills/selfloop/references/domains-vfx.md`，引擎侧不出现这些词。

## 便携性：包内没有本机绝对路径

包要能搬走，所以 adapter 里的路径全是**模板**，运行时展开（`iter.ps1` 与 `core/adapter.js` 同一口径）：

| 模板 | 含义 |
|---|---|
| `%VFX_LOOP_CLIENT%` | **你自己的 client 根目录**（`_镜像\<分支>\client` 那种），示例 adapter 的 `clientRoot` 就是它 |
| `%VFX_LOOP_BODY_CLIENT%` | 可选：本体 client 目录。填了它 = ①「本体 vfx.json 前后哈希一致」的守卫 ②**同时进 `guard.protectPaths`**（改参脚本拒写这个目录），不用两边重复写 |
| `%VFX_LOOP_DEMO_HOST%` | 只给 `demo-url-time.json` 用：那个 demo 宿主页面所在目录 |
| `%ProgramFiles(x86)%` / `%ProgramFiles%` / `%LOCALAPPDATA%` | 浏览器候选路径 |

设一次环境变量就能跑，**不用改包里的文件**（包里也没有可改的本机路径了）：

```powershell
$env:VFX_LOOP_CLIENT = '<你的 client 根目录>'
# 或者不改环境变量，直接命令行给：
pwsh -NoProfile -File <包目录>\harness\iter.ps1 -Adapter <包目录>\domains\vfx-render\adapters\fire-ray.json -Mirror '<你的 client 根目录>' -Budget 20 -Out <输出目录>
```

`-Root`（旧语义「项目根」）**默认空**：运行时按 `命令行 > adapter.clientRoot 的上级 > $PSScriptRoot\..` 推导，推不出来就中文报错。

## 安装

产物是一个 npm 包（`npm pack` 出的 tgz）或一个目录。两条正路：

1. **界面**：DSH → **Plugins** → **Add plugin** → 选这个目录（或解压后的目录）
2. **有 `plugin_manager` 工具的会话**：`install_bundle`，`target` 传该包的绝对目录

`install_bundle` 会做包安装与 bundle 选中，别手动改 profile 的 `package.json` / `cordis.patch.yml`、别在 profile 目录里跑 pnpm。

**装完要不要重启？** 新装一个 bundle 一般靠 HMR 就生效，**但工具列表要开新会话才稳**（当前会话的 tool set 已经组装好了）。只有"替换掉一个已装的同版本包"才必须重启 DSH（要加载新的 JS 模块代）。

`dependencies.playwright` 是运行期依赖：`install_bundle` 会顺带 `npm install`（约 18.2 MB，需要能访问 npm registry）。浏览器二进制**不在**这一步。

### 装完必须验三条（裸 node 测试不算证据）

三个版本连起来演了一遍"怎么拿到服务"这件事：

| 版本 | 写法 | 实际结果 |
|---|---|---|
| 0.3.0 | `inject = ['tools']` + `ctx.tools.register(...)` | ✅ `active`（声明了 inject，宿主等 tools 激活才调 apply） |
| 0.3.1 | `inject = { required: [], optional: ['tools'] }` | ⏳ `pending` —— 本宿主把 `optional` 当成"等不到就永远等"，`apply()` 一次没跑，工具与技能静默消失 |
| 0.3.2 | 无 inject + `ctx.get('tools', true)`，拿不到退回 `ctx.tools` | ❌ `failed` —— `cannot get property "tools" without inject`：未声明 inject 时**直接属性访问**会被 Proxy 抛 |

三条硬规则（都吃过亏）：

1. **不导出插件级 `inject`**（含 `{required:[], optional:[...]}` 这种"看着软"的写法）；
2. **不在 `apply` 里直接读 `ctx.<服务>`** —— 未声明 inject 时那是抛异常；
3. **不在 `apply` 里用 `ctx.get` 同步取一次** —— 服务还没 ACTIVE 时它按设计返回 `undefined`，不是"不存在"。

正确姿势只有一个：`ctx.inject(deps, cb)` 订阅，框架在服务就绪时回调。服务永远没有时就只是这段不生效——这才是"软"。

装完/升级后按这三条验，**缺一条就算没装上**：

| # | 判据 | 怎么看 |
|---|---|---|
| 1 | `fiberPhase` = `active` | `plugin_manager` 的 `list_plugins` 里找 `include:selfloop` 那行；`pending` / `failed` 都算没上，`failed` 的 `diagnostic` 会点名是哪个属性 |
| 2 | 两个工具真在 | 新会话里 `selfloop_probe` / `selfloop_list_adapters` 能调用（工具列表要开新会话才刷新） |
| 3 | 技能真在 | 技能目录里出现 `selfloop` |

`node test/plugin.test.mjs` 全绿只证明"模块本身没崩"：它跑在裸 node 里、不经过宿主的 fiber 生命周期，**pending / failed 这类问题它看不见**。

## 首装成本与失败处理

这个包不带浏览器二进制，第一轮跑产线需要本机有一个浏览器，两条路：

| 路线 | 一次性成本 | 落到哪 |
|---|---|---|
| **Edge 引擎（默认）** | **0 MB**，用系统已装的 msedge | 已在 `%ProgramFiles(x86)%` / `%ProgramFiles%` 里 |
| Playwright 自带 Chromium | **约 740 MB**（只要无头版 **约 290 MB**），耗时数分钟 | 用户级缓存 `%LOCALAPPDATA%\ms-playwright`，可被多个 Playwright 工具共用 |

装 Chromium（只有想用 `--engine playwright` / `DSH_CAPTURE_ENGINE=playwright` 才需要）：

```powershell
cd <包目录>
npx playwright install chromium               # 约 740 MB
npx playwright install --only-shell chromium   # 只要无头版，约 290 MB
```

**下载失败了怎么办**（这几种都有明确报错，不会静默降级）：

| 症状 | 怎么办 |
|---|---|
| `npx playwright install` 卡在 0% / 超时 / `ECONNRESET` | 设镜像再重试：`$env:PLAYWRIGHT_DOWNLOAD_HOST='<你的镜像地址>'`，然后重跑上面那条 |
| 报 `Executable doesn't exist at ...` | 就是没装成：重跑 `npx playwright install chromium`；磁盘满了先清 `%LOCALAPPDATA%\ms-playwright` |
| 报 `playwright 加载失败` | 依赖没装上：在包目录 `npm install` 或交给 `install_bundle` |
| 公司网/代理拦 npm | 配 `npm config set proxy` / `https-proxy`，或直接走 Edge 引擎（零下载） |

**下载失败会在返回里说人话**：`selfloop_probe` 在没找到 Chromium 时会把「多大 / 怎么补 / 不装怎么办」写进 `warnings`；`harness/capture.mjs` 起浏览器失败时也会把同样的中文原因与补救提示直接回给调用方。

## 首次要做的三件事

1. **给 `clientRoot` 赋值**：包内 3 份示例都写 `%VFX_LOOP_CLIENT%`，设环境变量即可（见上面「便携性」），不用改包。
   其余字段已经是包内相对路径（`server.staticScript` → `../static/server.mjs`，`tools.metricsJs` → `metrics2.js`），也不用改。
2. **准备浏览器**（二选一）：Edge 引擎（默认，零下载）／`npx playwright install chromium`。
3. **跑一轮**：
   ```powershell
   pwsh -NoProfile -File <包目录>\harness\iter.ps1 `
     -Adapter <包目录>\domains\vfx-render\adapters\fire-ray.json -Budget 20 -Out <你自己的输出目录>
   ```
   三个输入就够：adapter + 预算 + 输出目录。目标是 png / 参数 / 默认帧都在 adapter 的 `target` 节里。
   **前提**：`target`（目标）和 `params`（白名单）两节——命令行没给、adapter 也没有，就是**直接报错**，不会替你兜底。`page.readbackExpr` 建议写上（回读自检是"参数真被吃到"的唯一证据）；不写不报错，但会跳过回读、打一条 warn，证据包里记 `selfCheck:false`。

## 浏览器进程卫生（宿主被强杀也不会留孤儿）

`harness/capture.mjs` 有三条守卫（评审 §4.1）：

1. **父进程死亡看门狗**：浏览器旁边挂一个独立 pwsh 小进程，**每 10 秒**查一次"父进程还在吗"，父没了就 `taskkill /T /F` 杀整棵树 + 按 `--user-data-dir` 补刀剩下的 renderer/gpu。
   实测注意：`spawn(pwsh, …, { detached: true })` 在 Windows 上会**立刻退出、一行都不执行**，所以这里用 `detached: false`；也不用 `cmd` 批处理（`stdio: 'ignore'` 时管道会挂死）。
2. **关闭时杀整棵树**：`browser.close()` 只是"请求"，带不走 renderer/gpu，所以再按 PID `taskkill /T /F`。
3. **启动时清孤儿**：只杀「`--user-data-dir` 指向**本包的 profile 根**」**且**「父进程已不存在」的进程。
   **判据是"父进程/连接没了"，不是"跑了多久"** —— 一次完整产线单步就可能 30~90 秒，按时间硬杀会误伤正在干活的会话。

profile 落在 `%TEMP%\dsh-vfx-loop\`（可用 `-ProfileRoot` 或 `server.profileRoot` 改），**不落在包目录里**（装成 node_modules 后可能只读，而且清孤儿需要一个只属于本包的临时目录来圈范围）。
> 这个目录名仍是旧的 `dsh-vfx-loop`：它是执行器内部写死的字符串，没跟着正名改。它与旧包同时安装时共用一个 profile 根——真同时跑两个包的产线时，用 `-ProfileRoot` 分开即可。

## 目录

```
lib/index.js                     两个工具 + 技能注册（入口，exports "."）
core/index.js                    引擎层出口（只 re-export，不搬执行器）
core/adapter.js                  adapter 契约解析与口径（硬错对齐 iter.ps1）
core/README.md                   三层怎么分、三个概念、引用方向
domains/vfx-render/adapters/     首个领域的 3 份示例适配器
domains/vfx-render/README.md     首个领域说明（观测/判定/搜索怎么落地）
harness/                         执行器：跑一轮的必需件（见下；改动要进 CHANGELOG 并回灌 fanren 侧）
examples/minimal.json            不绑任何项目的最小 adapter（自己写就从它改）
static/server.mjs                静态服：node server.mjs <root> <port> [host]
skills/selfloop/                 技能：SKILL.md + references/（通用方法 + domains-vfx.md）
locale/{zh,en}.json              插件清单里的标题与描述（权臣 / Selfloop）
test/plugin.test.mjs             53 个用例（不进包）
```

`harness/` 里逐件的作用：

| 文件 | 作用 |
|---|---|
| `iter.ps1` | 主循环：解析 adapter → 起静态服 → 冻帧 → 搜索 → 出证据包 |
| `capture.ps1` | 浏览器边界的 PowerShell 半边（NDJSON 管道，被 iter.ps1 dot-source） |
| `capture.mjs` | 浏览器边界的 Node 半边（edge / playwright 两个引擎，7 个命令） |
| `score.js` | 距离：`d = Σ(nd×w)/Σw + Σpenalty.add` |
| `metrics2.js` | 指标提取（png → cov/lapVar/warmFrac/coldFrac/covCore/ratioCore） |
| `finalize.js` | 收尾：`curve.csv` / `best.json` / `report.md` |
| `apply.js` | 改参：`vfx-block` 形态（vfx.json 的 `effects.<E>.<B>`），`--protect` 拒写本体 |
| `apply_params.js` | 改参：`flat-params` 形态（扁平 `{params:{...}}`），同样走 `--protect` |
| `writeguard.js` | 写护栏：判定 `out` 是否落在 `guard.protectPaths` 下（两个改参脚本共用） |
| `adapter.json` | **字段模板**（`template:true`）：只有字段和注释，**不能直接跑**；`iter.ps1` 不带 `-Adapter` 时会被拒绝 |
| `适配层-说明.md` | adapter 字段语义（v3 全部字段 + 优先级） |
| `package.json` | **只做一件事**：把这一层钉成 `"type": "commonjs"`（包根是 `"type": "module"`，而 `score/metrics2/finalize/apply/apply_params` 是从 fanren 移植来的 CommonJS 脚本） |

**`harness/` 现在按需可改**：本轮解耦动了 `iter.ps1`（白名单不再有内置默认、`template:true` 直接拒绝、两头接写护栏）、`apply.js` / `apply_params.js`（写护栏改由 adapter 的 `guard.protectPaths` 声明、统一走 `--protect`），并新增了 `harness/writeguard.js`。所以它已经不是 fanren 原件的副本了。

**改动规矩**（比冻结松，但别当成随便改）：

1. 每次改动都要留记录（写进仓库根的 `CHANGELOG.md`），写清改了哪个文件、为什么、行为变了什么；
2. `apply.js` / `apply_params.js` / `writeguard.js` 在 fanren 侧还有一份原件，**回灌时要按改动点手动改**，别整文件覆盖（两边已经分叉）；
3. 别为了"目录好看"搬文件、改相对引用——那等于拿跑通的东西换排版。

> 因此 `harness/适配层-说明.md` 里 §4.4 / §5.4 举例的 `adapters\xxx.json` 还是**旧位置**的写法。现在示例适配器在 `domains/vfx-render/adapters/`，字段语义完全一样，只是路径写法旧了。

## 与旧版的关系（正名说明）

| 项 | 旧 | 新 |
|---|---|---|
| 包名 | `dsh-vfx-loop` | **`dsh-selfloop`** |
| 显示名 | VFX 闭环 | **权臣** / `Selfloop — self-closing loop engine` |
| 工具 | `vfx_probe` / `vfx_list_adapters` | **`selfloop_probe`** / **`selfloop_list_adapters`** |
| 技能 | `vfx-closed-loop` | **`selfloop`** |
| 版本 | 0.2.0 | **0.3.0** |
| 适配器位置 | `adapters/` | `domains/vfx-render/adapters/` |

两者是**各自独立的包**：旧目录原样保留，已装旧版的 profile 不会断线。切换是发版动作（改 profile pin + 装新包 + 重启），跟换一个包没区别。

## 已知限制

1. **执行器 Windows 专用**：`iter.ps1` / `capture.ps1` 是 PowerShell；`iter.ps1` 用 `Get-NetTCPConnection`，`capture.mjs` 的进程收尾用 `Win32_Process` 扫描 + `taskkill`。三个入口各有一道平台守卫（`iter.ps1` 用 `$IsWindows` + `[Environment]::Exit(2)`；`capture.ps1` 被 dot-source 只能用 `throw`；`capture.mjs` 用 `process.platform`）。**不做跨平台重写**（上游已定案）。两个工具本身跨平台。
2. **Chromium 不在包里**：740 MB 在用户级缓存（可被多个 Playwright 工具共用），只要无头版约 290 MB。默认的 Edge 引擎零下载。
3. **只验到工具层**：`selfloop_probe` / `selfloop_list_adapters` 的返回结构、硬错口径、harness 齐全性都有测试；但"装进真 profile 后工具在会话目录里出现"**未验证**（本轮纪律不装 profile、不起浏览器）。
4. **技能注册依赖 `ctx.skills`**：宿主没挂 skills 服务时静默跳过（两个工具照常）。`skills/` 里的文件仍在包内，可手工拷到 `.dsh\skills\`。
5. **`demo-url-time.json` 只是格式示例**：包里**不带**那个 demo 宿主页面。设了 `%VFX_LOOP_DEMO_HOST%` 才 `runnable=true`。
6. **`icon.png` 是占位**（256×256，806 B），只保证能解析、不超 256 KiB。
7. **`engines.dsh` 只写下界** `>=0.2.1-rc.2`（本机实测 0.2.2-rc.2）。跨 0.3 未验证。
8. **没写 `meta.detail`**：插件详情页回退到本 README。
9. **包内零本机绝对路径**，有测试钉住（全文扫「盘符+冒号+反斜杠」）；日志文件也不许进包（`files` 里有 `!**/*.log`）。
10. **`package.json` 保留 `"private": true`**：本包的装机形态是「目录 / `git+https`」，不依赖 npm registry；`npm publish` 属于发版动作。
11. **执行器内部仍叫 `iter.ps1` / `capture.mjs`**：文件名没改（改了要动一堆 `$PSScriptRoot` 相对引用，收益为零）。它们内部日志里出现的 `dsh-vfx-loop` 字样属于历史字符串，没跟着正名改。

## 测试

```powershell
cd <包目录>
node test/plugin.test.mjs      # 53 个用例：schema/返回值互验、harness 齐全、三层目录、adapter 可解析、domain 向后兼容、环境变量模板、静态服穿越拒绝、技能注册、清单与 locale、零绝对路径、孤儿守卫结构、三个平台守卫、**不导出插件级 inject**（0.3.1 pending 事故的护栏）、写护栏（段边界/大小写/junction/端到端拒写）
```

测试不起宿主、不装 profile、不开端口、不跑产线。
