---
name: selfloop
description: 通用闭环引擎——任意可测目标 + 可调参数 → 观测 → 判据 → 搜索 → 证据包（渲染/日志/接口/UI 都是目标）。只解决「形」：粗细、长短、面积、亮度、节奏；不判决色/质/味。
---

# Selfloop · 通用闭环引擎

> 一句话：**可测目标 + 可调参数 → 观测 → 判据 → 搜索 → 证据包**。它不做裁判，只做粗筛与报警。

## 角色分流（子代理只读得到开头，这节必须在）

- **主 Agent（2.1~2.5）**：跨轮闭环归你——扫活性、选轴、搜索、判定要不要下一轮。
- **执行员（2.2）**：只做**本轮**、做完就交；**有限**本地自迭代，**最多自调** `maxSelfIterations`（默认 3）轮。
  三条**停止条件**（任一即停）：① 达到判据　② 用满轮次预算　③ **无显著提升**（连续 2 轮主判据改善 <5%，或交付帧平均像素差 <2%）。
  停下必须**如实交**：**当前值** + **差多少** + **卡在**哪个约束（禁止「已优化」这种空话）；每轮留一行 `rounds/r<N>/iters.md`。

## 用 / 别用

- **用**：有可比的观测 + 有能调的参数（且知道哪几根活）+ 有明确验收（数值或人点头）。
- **别用**：想全自动交付（机器盲评 0/4、人 4/4）；要求美术级神似；目标本身是错的（先验目标）。

## 四个词

- **观测**：**任意能给出可比较数值的探针**（帧/日志/接口/UI）。标准只有一条——**同输入跑两次能给出可比的数**，否则是噪声。
- **判据**：**可配置的判据与距离**＝指标 + 目标 + **方向**（`dir: lower|upper|two-sided`）+ 权重/归一/罚项。目标**必须来自实测分布**，不许抄别的项目、不许把「参考近似区间」当硬门。
- **搜索**：**可配置的参数空间**（白名单在 adapter 里）。**先扫活性，再选轴**——没扫就搜 = 钱烧在死参数上。
- **台账**：`<run>/` 的 json（research/intent/plan/rounds/verify/review/decide/summary/deliver），给人复查，不参与计算。

## 五条硬规则

- **① 没做参数活性扫描，不许开始搜索**：参数表 ≠ 生效参数，改了逐字节相同的就是没通电。
  工具：`node harness/liveness.mjs --run <run> --probe probe.json` 出 `params-liveness.json`；
  `plan.json` 的 `variables` 必须是扫过的**活轴**，死轴进了 variables 会被 `2.1` 直接挡（`budget.probe:false` 可关）。
- **② 对比必须锁「绝对毫秒 + seed」**，不锁「第 N 帧」——同版本不同时刻的差常比版本间还大。
- **③ 判据只认数字**，图只用于给人看；冲突以数字为准，再查图为什么不对。
- **④ 闸门新增断言必须验「故意弄坏能红」**——只 log 不阻断等于没加。
- **⑤ 对抗样本**（噪声/模糊/降对比）不得被判为更优：best 先和这三张比，有一个更优就先修判据。

## 票面契约：执行员**只看票**，不必读本文件

票面自带全部上下文：`{ goal, files[], refs[], accept[{id,target,dir}], contextBudget:{docs,images}, mustProduce:{variants,abFrames} }`。
交活**自动校验**：`changes[]`、`shot`、`variants[]≥minVariants`、`abShots[]≥1`、快照三件套。
- `budget.exec = { minVariants: 3, requireAB: true, maxDocs: 2, maxImages: 1 }`（可改/可关）
- `budget.split = true` → 先拆窄票（`split.json`）再合并选优（`merge.json`）
- 依据：同一任务实测——窄而自包含的执行员 24 分钟误差 0.074；塞满文档的全能执行员 70 分钟 0.352。**宽度是要花钱的。**

## 跑一轮

```bash
node harness/preflight.mjs --run <run> --ref <参考图或帧目录>   # 参考是序列就指目录，别只量一张
node harness/pipeline.mjs step  --run <run>                     # exit 10 = 出票，11 = 等人
node harness/pipeline.mjs done  --stage <id> --run <run>        # 交活：不合格会卡住并说清缺什么
```

调研最低线：≥2 条带真实 URL 的 findings、≥1 条 `opensource`/`paper`、每条写 `used` + `usedFor`；
**tier≥2 还要交可落地配方**（`recipe{steps, params{range/unit/source}, discriminators, antiPatterns}`）。
先查现成配方：`node harness/recipe.mjs search <关键词>`（库里 $DSH_HOME/.dsh/refcode/<topic>/recipes.md）。

## 索引（按需查，别从头读）

`references/executor-brief.md` 执行员/自查/停止条件 · `references/intent.md` 写判据 ·
`references/intent-errors.md` 闸报错 · `references/reference-reading.md` 参考怎么读 ·
`references/invariants.md` 硬不变量 · `references/research-node.md` 调研节点 ·
`references/ledger-and-report.md` 读懂 report · `references/observe-command.md` 命令观测 ·
`references/observe-stability.md` 是否真的更好 · `references/workflow.md` 五步/活性扫描 ·
`references/metrics.md` 指标/换算/底噪 · `references/pitfalls.md` 按症状查坑 ·
`references/host-adaptation.md` 接别人的页面 · `references/run-recipes.md` 跑一轮的命令与产物 ·
`references/working-discipline.md` 主 Agent 纪律 · `references/domains-vfx.md` vfx 领域 ·
`references/chains-and-gaps.md` 链路差别与缺口
