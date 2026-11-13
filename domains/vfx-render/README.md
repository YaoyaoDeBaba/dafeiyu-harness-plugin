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

> 注意：`harness/适配层-说明.md` 里写的是 `adapters\xxx.json`（旧位置）。那份文档在 `harness/` 冻结清单里，本轮不动；字段语义一致，只是路径写法旧了。

## 换题材只改这里

新加一支特效 = 复制一份 adapter 改字段，**不碰 `core/`、`lib/`、`harness/`**。
adapter 每个字段的语义见 `harness/适配层-说明.md`（v3 全部字段 + 优先级）；那两份文件是冻结资产，本目录不改它们。

## 这个领域的现场要求

- **client 位置不由包决定**：三份 adapter 的 `clientRoot` 都是 `%VFX_LOOP_CLIENT%` 模板（= 你自己的 client 根目录），浏览器候选是 `%ProgramFiles(x86)%` / `%ProgramFiles%` / `%LOCALAPPDATA%` 模板。设好环境变量就能跑，包内零本机绝对路径。
- **宿主页面**：`page.file` 指向 client 里的冻帧页（如 `_dev/mergeProbe.html`），那不是本包的东西。
- **Windows 专用**：执行器是 PowerShell + Edge/Chromium，非 Windows 会在入口直接中文报错。

## 这个领域已知的天花板

- 只会调「形」。机器盲评实测 0/4、人 4/4——它会把「变细变暗」当成「更近」。
- 只在火柱这一种题材上验过；换题材必须**重跑活性扫描**并重新标定阈值。
- 目标帧本身错了，它会非常认真地收敛到一个错的东西。先验目标。

方法细节（活性扫描五分法、底噪、对抗门槛）见 `skills/selfloop/references/`，其中 vfx 特有的坑集中在 `references/domains-vfx.md`。
