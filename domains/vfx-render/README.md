# domains/vfx-render —— 首个领域：技能特效渲染

Selfloop 引擎的第一个领域适配包。**引擎不认识这里的任何词**：`harness/`、`core/` 都只用 `core/README.md` 里那三个概念（观测 / 判定 / 搜索）说话，领域差异全部落在本目录的 adapter 里。

## 这个领域的三个概念怎么落地

| 概念 | 在 vfx-render 里是什么 |
|---|---|
| **观测** | 冻帧后截一张 PNG：同一 `seed` + 同一绝对毫秒 + 同档位 + 同分辨率。探针是 `harness/metrics2.js`，把 PNG 变成 `cov / lapVar / warmFrac / coldFrac / covCore / ratioCore` 这几个可比的数 |
| **判定** | `harness/score.js` 的 `d = Σ(nd_i × w_i) / Σw_i + Σpenalty.add`；指标条数、权重、归一区间、惩罚项全由 adapter 的 `metrics` / `score` 节配 |
| **搜索** | adapter 的 `params` 白名单（`mode: list`）+ `freeze` 的可比条件；执行器 `harness/iter.ps1` 先扫活性再选轴再搜 |

比「像不像」它比的是**形**：粗细、长短、节奏、面积、亮度这类能算的物理量。色/质/味不归它管。

## 本目录的 adapter

| 文件 | 题材 | 参数块 | 冻帧协议 | 档位 |
|---|---|---|---|---|
| `adapters/fire-ray.json` | 火焰射线 / 火柱（暖色体积型），本领域基准 | `effects.FireRay.fireBeamG1M1` | `noloop-step` + `virtual` 320ms | low 640×360 |
| `adapters/chain-lightning.json` | 闪电链 / 雷光球（冷色分叉型） | `effects.ChainLightning.bolt` | `noloop-step` + `virtual` 80ms | ultra |
| `adapters/demo-url-time.json` | `url-time` 冻结 + 扁平参数（`flat-params`）宿主示例 | `flat {params:{...}}` | `url-time`（页面按 `?time=<秒>` 自冻） | — |

三份都带 `"domain": "vfx-render"`，所以 `selfloop_list_adapters` 会把它们归到同一组。（`domain` 是可选字段，缺了照样能跑。）

> 三份示例 adapter 里的 `page.file` / `readbackExpr` 是案例 A 宿主的现场写法（保留原值以保证示例可跑）；承接你自己的宿主时，换成你的冻帧页与回读表达式即可。

三份示例描述的都是同一套示例现场（**案例 A**：一个 2D 游戏项目的渲染管线，见包根 README「案例与来源」）。它们用来演示"换项目只换 adapter"——本包不依赖任何具体项目，你把自己的现场写成 adapter 就行。

> 注意：`harness/适配层-说明.md` 里 §4.4 / §5.4 举例的 `adapters\xxx.json` 是**旧位置**的写法。字段语义完全一样，示例现在都在 `domains/vfx-render/adapters/`。

## 领域资产索引

这里放两类东西：**怎么写需求**（references）和**可直接借用的着色片段**（recipes）。它们只属于本领域，引擎与 `core/` 不认识其中任何术语。

| 文件 | 一句话 |
|---|---|
| `references/demand-translator.md` | 需求翻译器：九节骨架、三条信条、风格锚点、形态自由度 + 正确性锚点、F2 案例（技能文档与模板、案例合并） |
| `references/pitfalls.md` | 坑表：真机翻车症状 → 病根 → 需求书写法修正 |
| `references/glsl-guardrails.md` | GLSL 八雷、两种宿主的确定性哈希、uDebug 六档、NaN 与预算口径 |
| `references/no-bloom.md` | 没有 tone mapping/bloom 时，用四层构造法自己造发光感 |
| `references/construction-contracts.md` | 施工前置约束：案例 A 的舞台事实 + 11 条硬契约（混合、色阶描边、形状噪声、GLSL 雷区…） |
| `references/tooling.md` | 工具索引：评测页契约、带状网格、粒子框架、验收量具 |
| `references/runtime-libs.md` | 粒子/带子的用法要点与验收方式（只吸收方法论，代码未吸收） |
| `recipes/glsl/hash-nosin.glsl` | 无 sin 浮点哈希（hash11/12/22/33），跨驱动稳定 |
| `recipes/glsl/hash-pcg.glsl` | 整数 PCG 哈希，仅原生 300 页面可用 |
| `recipes/glsl/fbm.glsl` | FBM 叠法、域扭曲、Voronoi（F1/F2 裂纹） |
| `recipes/glsl/dither.glsl` | 抖动消 banding：三角分布 / 蓝噪声 / 8x8 Bayer |
| `recipes/glsl/dissolve.glsl` | 消散四式：一条式子、有符号距离、alpha 侵蚀、反向生长 |
| `recipes/glsl/fake-bloom.glsl` | 无后处理的自发光四层（内核 / 色阶 / 外晕 / 抖动挂点） |
| `recipes/glsl/outline.glsl` | 描边三式 + 2D alpha 膨胀描边 |
| `recipes/glsl/toon-shade.glsl` | 两档硬阴影 + rim 三开关 + fwidth 抗锯齿阶梯 |

## 来源 / 许可

| 资产 | 来源 | 许可 |
|---|---|---|
| `references/demand-translator.md`、`pitfalls.md`、`glsl-guardrails.md`、`no-bloom.md`、`tooling.md`、`construction-contracts.md` | 案例 A 的需求翻译技能、施工前置约束等文档，2026-11-14 随案例移交 | 自研（未单独声明开源许可证） |
| `references/runtime-libs.md` | 案例 A 的 vfx-kit 用法速查（代码本体未吸收） | 未确认（代码未吸收） |
| `recipes/glsl/hash-nosin.glsl`、`fbm.glsl` | godot-shaders / pixijs-filters（逐文件头标注了具体出处） | MIT |
| `recipes/glsl/hash-pcg.glsl` | 来源方自研（算法为公开 PCG 变体） | 自研 |
| `recipes/glsl/dither.glsl` | WebGL-Fluid-Simulation（MIT）+ Ronja 教程（CC-BY 4.0，须署名）+ 来源方自研的 Bayer 构造 | MIT + CC-BY 4.0 + 自研 |
| `recipes/glsl/dissolve.glsl` | godot-shaders、Ronja 教程（CC-BY 4.0，须署名）+ 来源方自研的三平面入口 | MIT + CC-BY 4.0 + 自研 |
| `recipes/glsl/fake-bloom.glsl` | pixijs-filters / WebGL-Fluid-Simulation（MIT）+ 来源方自研的色阶与挂点 | MIT + 自研 |
| `recipes/glsl/outline.glsl` | godot-shaders / URP_Toon（MIT）、postprocessing（Zlib）、pixijs-filters（MIT）、Ronja（CC-BY 4.0） | MIT + Zlib + CC-BY 4.0 |
| `recipes/glsl/toon-shade.glsl` | URP_Toon / shader-school | MIT |

> 每份文件开头都有「来源 / 许可 / 适用宿主 / 吸收说明」四行元信息；着色片段另保留「配方名 / 用途 / 来源 / 许可 / 适用管线 / 依赖」六行头。CC-BY 4.0 的条目（Ronja 教程）再分发时须保留署名链接。

## 换题材只改这里

新加一支特效 = 复制一份 adapter 改字段，**不碰 `core/`、`lib/`、`harness/`**。
adapter 每个字段的语义见 `harness/适配层-说明.md`（v3 全部字段 + 优先级）；那两份文件是冻结资产，本目录不改它们。

## 这个领域的现场要求

- **client 位置不由包决定**：三份 adapter 的 `clientRoot` 都是 `%VFX_LOOP_CLIENT%` 模板（= 你自己的 client 根目录），浏览器候选是 `%ProgramFiles(x86)%` / `%ProgramFiles%` / `%LOCALAPPDATA%` 模板。设好环境变量就能跑，包内零本机绝对路径。
- **宿主页面**：`page.file` 指向 client 里的冻帧页（示例文件里那一个只是占位，按你的宿主改），那不是本包的东西。
- **Windows 专用**：执行器是 PowerShell + Edge/Chromium，非 Windows 会在入口直接中文报错。

## 这个领域已知的天花板

- 只会调「形」。机器盲评实测 0/4、人 4/4——它会把「变细变暗」当成「更近」。
- 只在火柱这一种题材上验过；换题材必须**重跑活性扫描**并重新标定阈值。
- 目标帧本身错了，它会非常认真地收敛到一个错的东西。先验目标。

方法细节（活性扫描五分法、底噪、对抗门槛）见 `skills/selfloop/references/`，其中 vfx 特有的坑集中在 `references/domains-vfx.md`。
