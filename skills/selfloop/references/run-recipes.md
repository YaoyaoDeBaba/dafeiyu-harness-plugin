# 跑一轮：命令、产物、报告要素、选哪个执行器

**这份答案一个问题**：这一轮具体怎么敲、跑完在哪看东西、报告里必须有什么。

**什么时候读**：准备真的跑一轮的时候（不是读概念，是动手）。填 intent 见 `intent.md`，判断结果可信不可信见 `observe-stability.md`。

**结论先说**：

1. 三样输入就够：**adapter + 预算 + 输出目录**；换目标（图还是数值）就换 adapter，命令形状不变。
2. 跑之前先过需求转译闸——没有 `<Out>\intent.json` 会**直接拒跑**并写出模板。
3. 报告里缺 `seed` / 绝对时刻 / 画质档 / 白名单这些，结论不可复验，等于没跑。

---

## 1. 选哪个执行器

| 目标是什么 | 用哪个 | 观测长什么样 |
|---|---|---|
| 画面 / 特效 / 任何"要渲染出来才能看"的东西 | `harness/iter.ps1`（Windows：PowerShell + Edge） | 浏览器冻帧截图 → `metrics2.js` 量像素 |
| 一串数：构建耗时、接口延迟、日志里的错误数、求解残差、内存占用 | `harness/cmdloop.mjs`（纯 node，跨平台） | 跑一条命令 → 从 stdout 取数（`json` / `number` / `line:k=v`） |

```bash
# 命令观测：三样输入就够（adapter + 预算 + 输出目录）
node harness/cmdloop.mjs --adapter examples/command-echo.json --out runs/cmd1 --budget 40
```

判据在两条链路里是**同一份** `harness/score.js`；搜索口径也一致（活性预检 + 坐标下降），所以「哪个参数是活的」「这轮算不算变好」的读法不变。

## 2. 画面链路怎么跑

入口是插件包里的执行器（`harness/iter.ps1`）。三样输入就够：**adapter + 预算 + 输出目录**。

```powershell
# 三输入就够（目标 / 白名单都写在 adapter 的 target / params 节里）
pwsh -File <包目录>\harness\iter.ps1 -Adapter <你的 adapter.json> -Budget 60 -Out .\runs\r1
```

`widthPx` / `distM` 只是 vfx 领域那份示例 adapter 自己的参数名（现场位置用 `%VFX_LOOP_CLIENT%` 给），别的领域按自己 adapter 的 `params.list` 写，引擎不内置任何参数名：

```powershell
# vfx 领域的一份示例
$env:VFX_LOOP_CLIENT = '<你的现场根目录>'
pwsh -File <包目录>\harness\iter.ps1 -Adapter <包目录>\domains\vfx-render\adapters\fire-ray.json `
     -Budget 60 -Out .\runs\r1
```

换目标（图还是数值）就换 adapter，命令形状不变。`target` / `params` 命令行没给、adapter 也没有就直接报错；`page.readbackExpr` 不给则跳过回读自检（打 warn，证据包里记 `selfCheck:false`）。

一次 run 产出（都在 `-Out` 下）：`curve.csv`（每轮距离）、`best.json`（最优参数）、`report.md`（顶部有「本次运行：N done / N skipped / N degraded」汇总行）、`shots\`（target / best / 逐轮缩略）、`logs\`（每次评估的指标包）、`base\`（基线配置副本）、`nodes\`（**节点台帐**：每节点一条 `NN-<node>.json`）。

## 3. 需求转译闸（跑之前必过）

**跑之前要先过需求转译闸（0.5.0；intent v2 在 0.5.1）**：默认读 `<Out>\intent.json`，没有就拒跑并写出 `intent.template.json`；确认后 `criteria` 会按 id 覆盖判据（权重 / 目标值）。
**v2 要锚**：`anchors` 至少 1 条具体参照物（参考图 / 具体游戏名 / 前作，`kind:"image"` 的 `ref` 必须真实存在），另有 `restate` / `notWanted` / `freeVsFixed` / `howWeVerify`；
只有"指标+权重+目标"的 v1 写法仍能跑，但会 warn 且台帐记 `degraded`。这些只进台帐与 `report.md` 顶部摘要，**不参与距离**。
确实要跳过就显式 `-NoIntent`（台帐会记一条 `skipped intent`，跳过有名字）。怎么填见 `references/intent.md`，硬闸错误原文见 `references/intent-errors.md`，台帐与报告见 `references/ledger-and-report.md`。

## 4. 纪律

**纪律**：只改自己范围内的配置（**本体拒写由 adapter 的 `guard.protectPaths` 声明**，改参脚本会拒绝写进这些目录；前后交哈希）；浏览器用独立 `--user-data-dir`、按 PID 收尾；端口各 run 独占，别抢别人的；`capture.mjs` 自带父进程死亡看门狗，**判据是父进程没了，不是跑了多久**，别自己再加"超时杀"。

## 5. 报告里必须写清的东西

不写这些，结论不可复验，等于没跑：

`seed` ｜ 绝对时刻（ms）｜ 画质档（`-Tier`）｜ 分辨率 ｜ 端口 / CDP ｜ 命令原文 ｜ 目标来源（图还是 json）｜ 白名单（哪几根轴）｜ 预算用掉几次。
