# CHANGELOG · dsh-selfloop（权臣）

> 规矩：**改了 `harness/` 里的执行器就要在这里记一笔**，并注明"要不要回灌上游原件（案例 A，见 README「案例与来源」）"。
> 这个文件是 0.3.4 起才有的；0.3.0~0.3.3 的条目是事后补的，按 git 提交信息还原。

## 0.3.6（未发布）· 去项目化 + 打包自查

- **示例 adapter 改名**：`fanren-lab-fire-ray` → `example-fire-ray`、`fanren-lab-chain-lightning` → `example-chain-lightning`、`trial-demo-url-time` → `example-flat-params`。示例代表的是「案例 A 的现场」，不是本包的产品叙事。
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
