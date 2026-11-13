# CHANGELOG · dsh-selfloop（权臣）

> 规矩：**改了 `harness/` 里的执行器就要在这里记一笔**，并注明"要不要回灌上游原件（案例 A，见 README「案例与来源」）"。
> 这个文件是 0.3.4 起才有的；0.3.0~0.3.3 的条目是事后补的，按 git 提交信息还原。

## 0.3.8（未发布）· 第三方台试刀沉淀成包里自带的能力

> 上一轮是在**别人的**页面上把闭环跑通的（起点 0.2124 → 最好 0.0804，降 62.1% / 60 次评估）。这一版把那次试刀里**能带走的**部分变成包里的资产：一份中性化后的示例 + 一份宿主改造清单。执行器一行没改。

- **新增 `examples/third-party-3d.json`**：把一个第三方轻量 3D 特效台（Ember Lance）改造成文件驱动宿主之后的 adapter 形态，中性化到可随包分发——`clientRoot` 走 `%VFX_LOOP_3D_CLIENT%`，其余路径全部相对，**零盘符**。保留的是真正值钱的三样：`freeze.protocol: url-time` + `verify: strict` 的选择理由（宿主没有 `window.step`/`playFx`）、三条判据的**实测阈值**（`cov`/`bboxW` 的 `luma:200`、`warmFrac` 放松的 `rMin:120`）、两条惩罚（`noEmber` / `flatFrame`）。`packageNote` 写清「不是开箱即用」+ 宿主侧三件事，`guard.protectPaths` 留空但注明了接真实第三方素材时该填什么。
- **新增 `skills/selfloop/references/host-adaptation.md`**：把「怎么把一个不是自己的页面改造成可驱动宿主」写成清单——五步改造（参数在 init 前注入 / `readyExpr` 双标记 / 隐藏会变的 DOM / 冻完就退 rAF / 扁平回读接口）、判据阈值必须实测（`luma=40` 时 `cov` 恒 0.98、`luma=150` 时 `bbox` 恒 640 两条反例）、冻帧协议怎么选（`noloop-step` vs `url-time`，选错 `iter.ps1` 直接拒）、**反证要求**（必须有一条「故意不冻」的对照，否则「两张相同」可能只是页面没画东西）、完工自检五条与症状速查。
- **`skills/selfloop/SKILL.md`**：新宿主入口指到上面那份文件（「第一次接不是自己的页面」的一句指路 + references 一览加一行）。
- **新增测试 T22（`test/plugin.test.mjs`，现在 55 + 12）**：断言这份示例能被 `parseAdapter` 解析、`freeze.protocol === 'url-time'`、`config.format === 'flat-params'`、三条 `extract` 还是 `cov`/`bbox`/`warmFrac`、实测阈值没被抄回默认值、`readyExpr` 双标记还在、**文件里没有盘符**；并内置四个变异体（协议改 `noloop-step` / `extract` 改 `p160` / 塞盘符 / `cov` 的 `luma` 抄回 40）证明「弄坏能红」。
- **README**：`examples/` 那一段补了这份示例的定位（改造后的形态，要跑先改造宿主）。
- **回灌提醒**：本次没有改 `harness/`，无上游回灌。

## 0.3.7（未发布）· 色相判据（补死区）

> 补的是 `01-结论与反哺.md` 里记的「更暖（色相）→ 无解」：六轴全开暖色只动 0.043。现在色相第一次进搜索空间。

- **新增提取器 `hueHist` / `hueMean`（`harness/metrics2.js`）**：像素转 HSB，按「饱和度 × 亮度」加权投进 18 个 20° 等宽桶，输出和为 1 的直方图；低饱和（灰/黑/白）权重为 0，另有 `minSat`（默认 0.15）硬下限。`hueMean` 是同一权重的色相圆均值（0~360，给人看报告）。整张无彩色 → 18 个 0（不是 NaN）。
- **`harness/score.js` 支持直方图类指标**：值是数组时 `nd = norm(环形 L1, 0)`，`norm` / `weight` / clamp 语义不变（`hueHist` 18 桶用 `abs:9` 或 `range:[0,9]` 压到 0~1）。环形 L1 见 `metrics2.circularL1`：跨 0°/360° 边界算 1 格（350°→10° = 1 桶，350°→180° = 8 桶）。偏移梯度实测：每 20° 给 0.111，旧口径在同场景只动 0.043。
- **新增示例 adapter `domains/vfx-render/example-fire-ray-hue.json`**：第 4 条 `hueHist` 权重 0.2，其余三条按 0.8 等比例让位（`.28/.28/.24`，相对重要性不变）。放在 `adapters/` 之外是有意的：那三份清单被测试逐项点名，加新判据不该顺手改掉别人的口径。
- **新增测试 `test/hue.test.mjs`（12 条）**，并接进 `npm test`（现在跑两份：54 + 12）。合成 PNG 钉住分桶、归一化、环形边界、灰图退化、坏输入硬错；三条「弄坏能红」自检（环形→线性、去掉饱和度权重、全塞一个桶）。`HUE_MUTANT=linear|noSatWeight|oneBin` 走变异版跑同一份文件。
- **`harness/finalize.js` 认得数组型指标**：`m_<id>` 原样落盘（直方图不再被 `Number()` 压成 null），`report.md` 显示 `[18桶]`。
- **已知失效场景**（写进 `适配层-说明.md`）：<20° 的偏移看不见（桶分辨率）；低饱和/暗场直方图由个别像素决定；同色相不同明度看不出"更艳"（要靠 `cov`/`warmFrac` 兜）；绝对色相不自适应白平衡，跨场景不可比。
- **回灌提醒**：`harness/metrics2.js` / `score.js` / `finalize.js` 已与上游原件（案例 A）分叉，回灌时按改动点手动改。

## 0.3.6 · 去项目化 + 打包自查：`fanren-lab-fire-ray` → `example-fire-ray`、`fanren-lab-chain-lightning` → `example-chain-lightning`、`trial-demo-url-time` → `example-flat-params`。示例代表的是「案例 A 的现场」，不是本包的产品叙事。
- **文档口径统一**：「闭环产线」→「闭环引擎」（4 处标题）；`fanren 侧原件`→「上游原件（案例 A）」；README 顶部加定位段、文末加「案例与来源」；删掉 `_资产`/`_临时`/`T4\hosts` 这类项目内路径示例，改成中性占位。
- **产物文案去项目化**：`report.md` 里那句"本机没有场景/角色/RTS"改成中性描述；两条面向用户的报错去掉项目语汇。
- **CHANGELOG.md 进 `files`**：0.3.4 把它写成规矩却没随包分发，装机后看不到，等于白写。
- **新增 T21**：跑 `npm pack --dry-run` 与 `files` 正名单对账，白名单写了但产物里没有 → 红（把"发不出去"变成可测判据）。

## 0.3.5 · probe 可用绝对路径覆盖 clientRoot

- `selfloop_probe` 收可选 `clientRoot`（绝对路径），盖掉 adapter 里的 `%VFX_LOOP_CLIENT%`——宿主进程常常继承不到用户 shell 里那条变量。相对路径与不存在的路径都硬错。

## 0.3.4 · 解耦

- **`harness/adapter.json` 降级为字段模板**（`template:true`）：删掉上游现场的目标（`widthPx 30 / distM 8.0`）、白名单（`widthPx,distM`）、判据（`metrics`/`score`）等私货；不带 `-Adapter` 直接跑会被拒绝。BREAKING。
- **`iter.ps1` 三处内置默认下线**：白名单不再默认 `widthPx,distM`（命令行 > adapter > 报错）；`readyExpr` 走中性默认（只等 `document.readyState`）+ warn；`readbackExpr` 缺失不再用上游专属表达式，改成跳过回读 + warn + 证据包 `selfCheck:false`。
- **新增 `harness/writeguard.js`**：写护栏唯一实现。`apply.js` / `apply_params.js` 改为收 `--protect <dir>`，拒写落在 `adapter.guard.protectPaths` 下的路径（含子目录、Windows 不分大小写、相对 adapter 目录展开、`%ENV%` 展开失败硬错）。`guard.bodyClient` 非空自动并入，老配置不用改。**回灌提醒**：两个 applier 已与上游原件（案例 A）分叉。
- **`iter.ps1` 新增两个强制点**：启动时检查镜像配置文件是否落在保护路径（早失败，不浪费预算）；证据包 `meta` 记录 `protectPaths` / `guardEnforced` / `guardBodyClient`（`report.md` 里暂不透传，那要动 `finalize.js`）。
- **路径判定只有一份实现**：`iter.ps1` 的 `Test-PathUnder` 直接调 `harness/writeguard.js` 的 `isUnder`（多起一个 node 进程，换来"两边口径绝不分叉"）。顺带补上了 junction 的洞——`-Mirror` 指到"指向本体的 junction"时，早期检查也能抓（原先只有 applier 拦得住，而那时 `Copy-Item` 快照已经写过本体一次）。node 起不来则直接 throw，不许静默放行。
- 判据口径：`apply*.js` 的"输出过小"从固定阈值改成"≥ 基线 50%"（原来 20 KB / 200 B 是上游现场的配置体量，小配置会被误判成写坏）。
- 新增 `examples/minimal.json`（能解析、能 probe 的字段模板；不承诺能跑）。
- 修 `domains/vfx-render/adapters/chain-lightning.json`：补 `target` / `params`，它此前用最少命令行跑不起来。
- 文档：删掉三处"执行器逐字节冻结"的过期承诺，改成本 CHANGELOG 的规则。
- **去项目化（只动字符串/文案，逻辑零改动）**：示例 adapter 的 `name` 改成中性名（`example-fire-ray` / `example-chain-lightning` / `example-flat-params`）；README / 适配层说明 / skill 里的项目内路径换成中性占位或删除；旧名「闭环产线」统一改成「闭环引擎」；`finalize.js` 生成的 `report.md` 里那句"只在本机 client 单页跑、不含场景/角色/RTS"改成中性表述。执行器来源统一写作「上游原件（案例 A）」，README 新增「案例与来源」。**回灌提醒**：`finalize.js` 这句产物文案要同步回上游。

## 0.3.3 · 装不上（第三次）

- 服务接入改成 `ctx.inject(deps, cb)` 订阅：`tools` 与 `skills` 都等宿主就绪时回调注册，不再在 `apply` 里同步读服务。
- 老宿主（无 `ctx.inject`）才退化成 `ctx.get(..., true)` 同步探测，全程 try、**绝不碰 `ctx.tools` 属性**。
- 新增两条红线断言：不许直接读 `ctx.<服务>`；服务就绪必须走注入回调。

## 0.3.2 · 装不上（第二次）

- 删掉插件级 `inject` 导出（0.3.1 的 `{required:[], optional:['tools']}` 在本宿主会让 fiber 永远 `pending`）。
- 补 README「装完必须验三条」：`fiberPhase=active` / 两个工具能调用 / 技能目录出现 `selfloop`。

## 0.3.1 · 装不上（第一次）

- 把 `inject = ['tools']` 改成可选注入，想让"宿主缺 tools 时整行不激活"这件事变得不那么静默。
- **结果相反**：本宿主把 `optional` 当成"等不到就永远等"，插件 `pending` 到永不激活。已由 0.3.2 回退、0.3.3 根治。

## 0.3.0 · 正名

- `dsh-vfx-loop` → `dsh-selfloop`（中文名「权臣」）；三层结构 `lib/` → `core/` → `harness/` + `domains/<领域>/`；技能描述改成领域无关。

## 0.2.0 · 第一次装成插件

- 闭环调参 harness（配置驱动）：活性扫描 → 搜索 → 证据包。
