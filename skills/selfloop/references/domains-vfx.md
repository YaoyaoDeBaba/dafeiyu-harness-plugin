# 领域：vfx-render（技能特效渲染）

> 这份文件放的是**只对 vfx 领域成立**的东西。通用方法（五步、五分法、底噪、对抗门槛）在 `workflow.md` / `metrics.md` / `pitfalls.md`，别混着看。

## 这个领域的现场长什么样

| 项 | 值 |
|---|---|
| 观测 | 冻帧后的 PNG（同 seed + 同绝对毫秒 + 同档位 + 同分辨率） |
| 探针 | `harness/metrics2.js` → `cov / lapVar / warmFrac / coldFrac / hueHist / hueMean / covCore / ratioCore` |
| 判据 | `harness/score.js` 的 `d = Σ(nd_i × w_i) / Σw_i + Σpenalty.add` |
| 参数空间 | adapter 的 `params` 白名单（`mode: list`），如 `["widthPx","distM"]` |
| 配置 | client 里的 `resource/lab/vfx/vfx.json`，参数块 `effects.<Effect>.<Block>` |
| 冻帧协议 | `noloop-step`（页面暴露 `window.step`，虚拟钟）或 `url-time`（页面按 `?time=<秒>` 自冻） |

比「像不像」它比的是**形**：火柱的粗细长短、亮面积、细节能量、暖色占比。

## 本领域的示例 adapter

都在插件的 `domains/vfx-render/adapters/` 下，三份都标了 `"domain": "vfx-render"`：

| 文件 | 题材 | 参数块 | 冻帧 | 档位 |
|---|---|---|---|---|
| `fire-ray.json` | 火焰射线 / 火柱（暖色体积型），本领域基准 | `effects.FireRay.fireBeamG1M1` | `noloop-step` + `virtual` 320ms · seed 12345 | low 640×360 |
| `chain-lightning.json` | 闪电链 / 雷光球（冷色分叉型） | `effects.ChainLightning.bolt` | `noloop-step` + `virtual` 80ms | ultra |
| `demo-url-time.json` | `url-time` + 扁平参数（`flat-params`）的格式示例 | `flat {params:{...}}` | `url-time` | — |

`score.type` 目前**只实现 `l1`**；`config.format` 只认 `vfx-block | flat-params`。

火柱这支的指标口径（权重 × 归一区间）：

- `cov`（亮区面积，管体积/粗细/长度）`0.35` · `range[0,0.3]`
- `lapVar`（细节能量，管结构/毛刺）`0.35` · `range[200,4000]`
- `tone = warmFrac`（色温，火柱最强的一维）`0.30` · `range[0,0.55]`
- 惩罚 `coreGone`：`ratioCore <= 0 || covCore < 0.5 * T.covCore` → `+0.5`（核心塌陷闸门）

闪电链把 `warmFrac` 换成 `coldFrac`（火柱的暖色在雷光上恒为 0，不换就是拿常量算距离）。

**想量「色相」时**：`warmFrac` 只回答「够不够暖」，答不了「暖到哪个色相」（更暖 → 无解就是这么来的）。用 `example-fire-ray-hue.json`（在 `domains/vfx-render/` 根，不在 `adapters/`）：第 4 条 `hue = hueHist`（权重 `0.20`，`abs:9`），老三条等比例让位 `.28/.28/.24`。它的距离是环形 L1（跨 0°/360°），是 18 桶 × 20° 分辨率——**20° 以内的偏移看不见**，那种情况看 `diag.hueMean` 或换更细的桶。

## 现场怎么接（包内零绝对路径）

| 模板 | 含义 |
|---|---|
| `%VFX_LOOP_CLIENT%` | **你自己的 client 根目录**（如 `<你的镜像目录>\<分支>\client`），示例 adapter 的 `clientRoot` 就是它 |
| `%VFX_LOOP_BODY_CLIENT%` | 可选：本体 client 目录，填了才做「本体 vfx.json 前后哈希一致」的守卫 |
| `%VFX_LOOP_DEMO_HOST%` | 只给 `demo-url-time.json` 用：那个 demo 宿主页面所在目录 |
| `%ProgramFiles(x86)%` / `%ProgramFiles%` / `%LOCALAPPDATA%` | 浏览器候选路径 |

设一次环境变量就能跑，**不用改包里的文件**：

```powershell
$env:VFX_LOOP_CLIENT = '<你的 client 根目录>'
# 或者不改环境变量，直接命令行给：
pwsh -NoProfile -File <包目录>\harness\iter.ps1 -Adapter <包目录>\domains\vfx-render\adapters\fire-ray.json -Mirror '<你的 client 根目录>' -Budget 20 -Out <输出目录>
```

`-Root`（旧语义「项目根」）**默认空**：运行时按 `命令行 > adapter.clientRoot 的上级 > 包根` 推导，推不出来就中文报错。
`-Adapter` 缺省时读 `harness/adapter.json`（同一支火柱的默认适配层）。

## 进程与端口卫生（这个领域的坑）

- 浏览器用独立 `--user-data-dir`；profile 落在 `%TEMP%\dsh-vfx-loop\`（可用 `-ProfileRoot` 或 `server.profileRoot` 改），**不落在包目录里**（装成 node_modules 后可能只读，而且清孤儿需要一个只属于本包的临时目录来圈范围）。目录名仍是旧的 `dsh-vfx-loop`——它是执行器内部写死的字符串，没跟着正名改；与旧包同时跑闭环时用 `-ProfileRoot` 分开。
- `capture.mjs` 三条守卫：父进程死亡看门狗（每 10s 查一次，父没了就 `taskkill /T /F` 整棵树）、关闭时杀整棵树、启动时只清「父进程已不存在」的自家孤儿。**判据是父进程没了，不是跑了多久**——一次完整闭环单步就可能 30~90 秒，按时间硬杀会误伤正在干活的会话。
- 静态服端口和 CDP 端口各 run 独占（示例用 8290 / 9490），别抢别人的。
- 执行器是 **Windows 专用**：`iter.ps1` 用 `Get-NetTCPConnection`，`capture.mjs` 用 `Win32_Process` + `taskkill`。三个入口都有平台守卫，非 Windows 直接一行中文报错，不会跑到一半才炸。

## 这个领域的天花板（实测，别自己再踩一遍）

1. **机器不配当裁判**：盲评实测机器 0/4、人 4/4。它每次选的都更糊 / 更噪 / 更细更暗，因为它把「变细变暗」当成「更近」。
2. **只在火柱这一种题材上验过**：换题材必须重跑活性扫描，并重新标定 `norm.range` 与惩罚阈值。
3. **目标帧错了就全错**：目标若是旧画面或错档位，闭环会非常认真地收敛到一个错的东西。
4. **底噪要各自标定**：同参重跑 2~3 次取中位数，别把「≈3」当全局常数。

## 三份示例 adapter 说的事

三份示例描述的都是同一套示例现场（**案例 A**：一个 2D 游戏项目的渲染管线，见包根 README「案例与来源」）。它们的作用是演示"换项目只换 adapter"——本包不依赖任何具体项目。

## 领域资产：需求翻译与施工配方

写需求书 / 派单 / 评审施工前，先看 `domains/vfx-render/references/`：

| 文件 | 什么时候读 |
|---|---|
| `demand-translator.md` | 要把「想要的感觉」写成可施工需求书时（九节骨架、三条信条、风格锚点、形态自由度 + 正确性锚点、F2 案例） |
| `pitfalls.md` | 需求书或成品出现症状，要查「症状 → 写法修正」时 |
| `glsl-guardrails.md` | 派单前附护栏、写 GLSL 自查、排查编译/NaN 问题时 |
| `no-bloom.md` | 规划发光层次、色阶档数、banding 处理时 |
| `construction-contracts.md` | 交付前逐条自查的舞台事实与 11 条硬契约 |
| `tooling.md` | 要用评测页契约、带状网格、粒子框架与验收量具时 |
| `runtime-libs.md` | 用粒子/带子前看用法要点与验收方式（只吸收方法论） |

可直接借用的着色片段在 `domains/vfx-render/recipes/glsl/`（哈希、FBM、抖动、消散、假辉光、描边、卡渲）。每份都带来源/许可/适用宿主，**引用前先读文件头**；`hash-pcg.glsl` 只能在原生 300 页面用，贴进 WebGL1 兼容层会编译失败。

这些全部是**领域资产**：只在 vfx-render 里用，`core/` 与 `lib/` 不认识其中任何术语。要迁移到别的领域，先按 `21-吸收协议` 的三问自检，别把领域词带进骨架。

## 进一步阅读（都在本包内）

- `references/workflow.md` / `metrics.md` / `pitfalls.md` —— 通用方法（五步、五分法、底噪、对抗门槛）
- `domains/vfx-render/references/` —— 本领域的写法、坑与配方（见上表）
- `domains/vfx-render/recipes/glsl/` —— 可借用的着色片段
- `harness/适配层-说明.md` —— adapter 每个字段的语义（v3 全部字段 + 优先级）
- `examples/minimal.json` —— 不绑任何项目的最小 adapter（自己写就从它改）
