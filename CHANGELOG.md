# CHANGELOG · dsh-selfloop（权臣）

> 规矩：**改了 `harness/` 里的执行器就要在这里记一笔**，并注明"要不要回灌上游原件（案例 A，见 README「案例与来源」）"。
> 这个文件是 0.3.4 起才有的；0.3.0~0.3.3 的条目是事后补的，按 git 提交信息还原。


## 0.39.0（未发布）· 补回放暴露的两条判据：高频噪点率 + 白沫连通性

> 回灌上游原件：否。起因：回放测试里「雪花噪点海」不是被噪点判据拦的，而是被亮度带顺手拦住的——
> 亮度正常的噪点帧会漏过去。参考图的沫是**连成一片**，我们的是**碎点**，但当时没有量它能量的东西。

### 新增量测（`composition.mjs` + `preflight` 自动量）
- `speckleRatio`：与 3×3 均值差 >0.12 的像素占比（只算亮度 0.02~0.85，避开正常高光边）。
  实测：参考海 **0.0004** / 干净 20° 海 0.056 / 未超采样的噪点海 **0.29~0.48**。
- `foamComponents`：亮部（>0.75）连通块统计 → `foamShare` / `foamMeanComp` / `foamMaxShare`。
  实测：参考海 **maxShare 0.991 / meanComp 982.9（整片连成一块）**；我方 20° **0.020 / 4.5（碎成点）**。

### 新增先验域 `ocean-surface`
`speckleRatio 0~0.06`、`foamMaxShare 0.5~1.0`、`foamMeanComp 50~5000`、`waveScale 0.5~4`（param）。

### 判据
`node --test` = **456 / 456**（新增 ⑬ 噪点率能分开噪点/平滑、⑭ 沫连通能分开整块/碎点）。

---

## 0.38.0（未发布）· A/B 之后的瘦身：一条命令做搜索 + 标量判据进闸

> 回灌上游原件：否。
> 依据：受控 A/B（同标准、同起点、同预算）。
> **armA（流水线）err 0.912 / 1-6 达标 / 95 分钟；armB（手搓）err 0.031 / 5-6 达标 / 14 分钟。**
> 差距的主因不是判据，是**流程开销吞掉了搜索预算**（A 只有 20 张真帧，B 47 张）。

### ① `harness/quick.mjs`：判据 → 抓帧 → 量测 → 算 err → 记 trace，一条命令
```
node harness/quick.mjs --run <run> --url <页面> --ref <参考目录> \
     --params '{"sigma":[0.04,0.06,0.08],"ambient":[0.02,0.04]}' --max 20
```
- 每抓一帧**立刻**打印 `err` + 六条判据实测（A 臂的失败模式是"第 27 帧才知道方向错了"）；
- 自动写 `trace.jsonl`（不靠 agent 记得去调记录器 —— A 臂就漏了 12 帧）；
- 收工时写 `quick/best.json`（最优参数）与 `verify.json`（可直接喂给 2.3）。

### ② 标量判据也进 2.3 闸（回放测试暴露的洞）
回放：r3 的灰雾云（`cloudDarkFrac 0.039`，靶 0.2532）在 2.3 被**放行**——因为 verify 只查了 profile 与崩坏，
标量判据写了却没人量。现在：只要判据写进 `intent.json`，2.3 会用与 preflight 同一套量法逐条复核，
出带即挡（`判据 C1 出带：cloudDarkFrac=0.0386（参考带 0.155 ~ 0.295）`）。

### 回放测试结果（`_ab2/replay.mjs`）
| 样本 | 结果 |
|---|---|
| 灰雾云（暗部 0.039） | 拦住（修完后） |
| 雪花噪点海 | 拦住，但是**被亮度带拦的**，不是噪点判据 → 仍缺 `speckleRatio` 判据 |
| 死参数进 variables | 拦住（2.1 活性闸） |
| 无快照三件套 | 拦住（2.3 快照闸） |
| A 臂那帧（rowCorr 0.540） | 拦住（profile 闸） |

### 判据
`node --test` = **454 / 454**（新增 ⑪ 标量出带被拦、⑫ 标量在带内放行）。

---

## 0.37.0（未发布）· 快照从"留痕"变成"硬拦" + 实验室级快照 + 拍帧 sidecar

> 回灌上游原件：否。
> 触发：用户指出——「昨晚 mimo 余额耗尽、成果没存下来、无法复原；今天又差点重演；存档的规矩不是加进 selfloop 了吗？」
> 查了：规矩在，但**三个洞**让它没生效。

### 洞 1：规矩只在 pipeline 里（探索期根本没有快照）
`交活即快照三件套` 挂在 2.2-exec 上，只有走 pipeline 才触发；而探索期在 `_exp/<lab>` 里直接改页面，不在任何 run 下。
→ 新增 `harness/lab-snapshot.mjs`：
```
node harness/lab-snapshot.mjs --lab <实验目录> --tag v1 [--frame <png>] [--params <probe.json>]
```
把整份源码拷进 `<lab>/_versions/<tag>-<时间>/`，写 `MANIFEST.json`（每个文件 sha256）+ `params.json` + `frame.png`，
并在 `<lab>/_versions/INDEX.md` 追加一行（tag / 时间 / 文件数 / 帧 / 怎么恢复）。

### 洞 2：缺快照只写 caveat，不拦人
`checks.verified`（2.3）以前把缺件写进 `verify.caveat` 就放行 —— 留痕不解决问题。
**现在硬拦**：只要 `rounds/NN.json` 存在而 `rounds/rN/snapshot/` 缺件，2.3 直接挡，并打印补救命令。
`budget.requireSnapshot: false` 给老 run 留退路。

### 洞 3：拍出来的帧不知道当时用了什么参数
`capture.mjs` 现在每张图旁边写 `<out>.json` sidecar：完整 URL、argv、耗时、sha256、页面报错。
没 sidecar 就只能靠肉眼回忆参数 —— 昨天就是这么丢的。

### 判据
`node --test` = **452 / 452**（新增 ⑨ 缺快照被拦、⑩ `requireSnapshot:false` 退路）。

---

## 0.36.1（未发布）· 修活性扫描自身的两个量具 bug

> 回灌上游原件：否。两个 bug 都是「在真实 run 里量出来的」，不是想出来的。

### ① 同名键被追加而不是替换
`baseline + '&' + name + '=' + value` 追加后，`URLSearchParams` 取**第一个**同名键 → 参数根本没改，
于是所有轴都被判成 `dead`。改成 `withParam()` 替换同名键（没有才追加）。**这一条会把活参数全判成死**，
是典型「量具坏了还以为世界是空的」。

### ② capture 走 shell 时查询串里的 `&` 被吞
字符串形式的 capture 经 `shell:true` 执行时，`a=1&b=2` 里的 `&` 会被 cmd/PowerShell 当成命令分隔符，
只有第一个参数生效 —— 同样让所有轴"没反应"。现在支持 **argv 数组**形式的 capture（首选），
字符串形式保留但会告警。

### 判据
`node --test` = **450 / 450**（新增 2 例：同名键替换、argv capture）。

---

## 0.36.0（未发布）· 活性扫描成为闸门（试刀当场踩到）

> 回灌上游原件：否。
> 试刀现场：按配方把 `lightSteps` 6→1，抓出来的帧**逐字节相同**（SHA 一致）——20 张候选里有一批在死参数上空转。
> SKILL 里早写着「没扫活性不许搜索」，但**pipeline 里没有任何程序闸**。这次把它变成节点。

### `harness/liveness.mjs`（观测通道无关）
```
node harness/liveness.mjs --run <run> --probe probe.json
# probe.json: { capture: "node shoot.mjs --out {out} --query '{params}'", baseline: "a=1&b=2",
#               params: { sigma: ["0.02","0.15"], lightSteps: ["1","8"] } }
```
对每根轴取「低 / 高」两端各拍一张，与 baseline 比：
- **两端都逐字节相同** → `dead`（exit 3）；
- 有差异但亮度均值差 < 0.004 → `weak`；
- 否则 `live`。
产出 `<run>/params-liveness.json`（含每根的 sha 与 lumaDiff 证据）。

### `checks.plan`（2.1）
`budget.probe` 默认开：
- 缺 `params-liveness.json` → 挡，并打印补救命令；
- `plan.variables` 里出现 **dead** 参数 → 挡（"这些变量是死参数，别放进 variables"）；
- 变量没扫过 → 挡；
- 一个活轴都没有 → 挡；
- `params-liveness.json` 没记 `capture` 命令（无法证明真跑过）→ 挡。
老 run 用 `budget.probe: false` 退。

### 判据
`node --test` = **448 / 448**（新增 `test/liveness.test.mjs` 6 例：活/死判定、缺文件被挡、死轴进 variables 被挡、
未扫变量被挡、全活放行、`probe:false` 退路）。

---

## 0.35.0（未发布）· 可落地配方 + 抄一遍基线 + 配方库检索（复盘 R1/R4/R5/S5）

> 回灌上游原件：否。承接 0.34.0 的「先验 + 卡片」，把复盘里剩下的四条也落完。

### R1 调研必须交「可落地配方」（tier≥2 强制）
findings 里 `used:true` 的条目要带 `recipe`：
`steps[]`（≥2）＋ `params{}`（≥3 个键，每个带 `range:[lo,hi]` / `unit` / `source`）＋ `antiPatterns[{symptom,cause}]`；
`discriminators` 里的键必须**可测**（在 priors 或 extracted 里存在）。
这一条治的是复盘里那句「理论都懂，一动手就露馅」——只写"用了什么算法"没用，要写"参数落在什么量级、什么症状对应什么病因"。

### R4 配方库 + 检索（`harness/recipe.mjs`）
`list` / `search <词>` / `show <topic>`，库根 `$DSH_HOME/.dsh/refcode/<topic>/recipes.md`。
已写入第一份真配方 `volumetric-cloud/recipes.md`：骨架 5 步 + 4 个参数区间 + 4 条判别量 + 5 条反例（含"云像均匀发亮的雾 = sigma 太小 + ambient 太高"）。

### R5 「抄一遍」基线变体
`checks.executed`（含窄票）要求 variants 里有一个 `isBaseline:true`——照参考实现的默认参数先跑一遍当锚点，
后面的变体才是"相对参考的偏移"，而不是在自己错误区间里漂。`budget.exec.requireBaseline:false` 可关。

### S5 拆票再收紧
`checks.split`：每张窄票 `accept` **≤2 条**；且每条必须是 `intent.criteria` 里已有的判据（id 或 metric），
不许在票面上另立目标。

### 判据
`node --test` = **442 / 442**（新增 `test/recipe.test.mjs` 7 例：无配方被挡 / 合格配方放行 / 判别量不可测被挡 /
低预算不强制 / 缺 baseline 被挡 / 有 baseline 放行 / 配方库 CLI 三命令）。

---

## 0.34.0（未发布）· 先验区间 + 执行员卡片 + 只许读票面文件（复盘 R2/S1/S2/S4）

> 回灌上游原件：否。
> 触发：用户肉眼结论「各种版本都不会画云，但这一轮电弧像模像样」。量化后确认：
> 云掩膜内暗部占比我们 3.9% / 参考 25.5%，亮部 16.3% / 参考 2.0% —— **整幅指标全绿，肉眼一眼假**。
> 复盘结论：理论没错、结构（参数与光学厚度）错了；而且判据里没有一条看「云内明暗结构」。

### R2 领域先验区间（`harness/priors.json` + `checks.intent`）
把「听到名字就知道大概怎么画」外置成表，先给 `volumetric-cloud` 一套：
`sigma_m 0.02~0.15`、`ambient_frac 0.005~0.06`、`lightSteps 4~8`、`powder 0.4~0.8`、
`cloudDarkFrac 0.20~0.34`、`cloudBrightFrac 0.005~0.06`（每条带 unit/why/source）。
intent 写 `domain` 后：
- 数值判据的 target **必须同时落在实测区间与先验区间**；破例要写 `priorException` 并说明理由；
- **先验里每条判别量都必须有对应判据**，不测就写 `priorWaived` 说明为什么 —— 这一条专门治「判据缺项」。
- 云内明暗两条判别量的量法已进 `composition.toneFractions` 与 `preflight`（`cloudDarkFrac/cloudBrightFrac/cloudMeanLuma`）。

### S1 执行员卡片（≤1.5KB，随票内联）
固定四段：**工作量契约**（variants/abFrames/上下文上限）· **允许读的文件**（读别的即越界）· **三条停止条件** ·
**交活字段**（changes/shot/variants/abShots/readFiles/tasks）。
有 `split.json` 时把窄票**逐条**写进卡片（id / goal / 验收 id / 只改哪些文件）。
同时把 `exec` 票模板从 ~1084 字符压到 ~400（契约搬进卡片，票面只写「做什么」）。

### S2 只许读票面声明的文件（可校验）
`checks.executed` 要求 `readFiles[]`；每一项必须落在「窄票的 files/refs → plan 的 orders/files → intent 的图锚」里，越界即打回。

### S4 验收实测进结果（治注意力摊薄）
窄票的 `accept` 每一项都要在结果里给 `acceptEvidence:[{id, measured, how}]`；缺项或 `measured` 非数值即打回。

### 判据
`node --test` = **435 / 435**（新增 `test/priors-card.test.mjs` 8 例：先验区间/破例/缺判据/豁免、卡片四段与长度、越界读文件、缺验收实测）。

---

## 0.33.1（未发布）· 掩膜锚到背景：结构指纹之前对「总量」完全免疫

> 回灌上游原件：否。
> 这是**在真实 run 里翻车后**修的（r3 实验：云团半径 1800→1400、coverage 0.34→0.30，
> `topCoverage` 只从 0.726 动到 0.717 —— 因为掩膜用的是「自身 55% 分位」，恒选出固定比例像素）。

### 修法
`composition.maskOf` 改成**相对背景**掩膜：四角 8×8 中位色作背景，
通道差之和 > 0.10 才算主体 —— 与 `ref-probe` 的 `topCoverage` 完全同口径（测试 ⑫ 断言差 <0.03）。

### 顺带纠正的旧数
修后参考 24 帧真实中位：`topCoverage 0.704`、`centroidY 0.467`、`skyExposure 0.162`、`subjectFrac 0.657`
（旧值是 0.335 / 0.520 / 0.324 / 0.438，全部作废）。留一法下限也随之从 0.95 掉到 **0.88**，hint = 0.83。

### 判据
`node --test` = **427 / 427**（新增 ⑪ 掩膜对总量敏感、⑫ 与 ref-probe 同口径）。

---

## 0.33.0（未发布）· L3：结构指纹的通用性证明（非渲染两例）+ 候选剖面与领域解耦

> 回灌上游原件：否。
> 触发：0.32.x 的 profile 基座虽然号称通用，但 `checks.verified` 里候选剖面是**写死从图片抽**的——
> 也就是说它其实还是"图像专用件"。L3 就是来拆这个台。

### ① 候选剖面与领域解耦（`harness/pipeline.mjs`）
`2.3-verify` 现在按这个顺序取候选剖面：
1. `verify.profiles[<metric>]` —— 任意领域自己写的提取器（日志/时延/UI/树形…）；
2. 没给且 `metric === 'rowProfile'` → 回退「量第一张帧」（图像实现）；
3. 两者都没有 → 报「既没在 verify.profiles 里给，也不是可自动抽取的 rowProfile」。
判据消息也从「结构与参考不像」改成「**排列**与参考不像」——它抓的是排列，不是结构这个词的歧义。

### ② 两个非渲染样例（`harness/signatures.mjs`）
- `logBurstProfile(events)`：日志按时间分桶 → 「错误扎堆在启动期」vs「均匀散布」；
- `latencyProfile(samples)`：调用耗时按序分桶 → 「冷启后平稳」vs「整段抖动」。
两者都刻意做成**总量完全相同、排列不同**，用来证明判据抓的不是数量。

### ③ 反证（写进测试，不许空口）
- 日志：两版都是 **40 条**错误（标量判据分不出），剖面相关 < 0.5；
- 时延：两版均值差 **< 30ms**（标量判据分不出），剖面相关 < 0.5；
- 端到端：同一道 `2.3-verify` 闸，第 4/5 例在非图像领域同样**能红能绿**，第 6 例说清"没给剖面"该怎么办。

### 判据
`node --test` = **425 / 425**（新增 `test/signatures.test.mjs` 6 例）。
`intent.md` §1.2b 补「非图像领域怎么给剖面」+ 两个反证数字。

---

## 0.32.1（未发布）· minCorr 不再拍脑袋：留一法自动给建议值

> 回灌上游原件：否。
> 触发：0.32.0 里 `minCorr` 必须手填，而「填多少」只能靠猜（0.5 太松、0.95 太紧）。

- `composition.calibrateMinCorr(profiles)`：对参考帧做**留一法**（每张 vs 其余帧的中位剖面），
  给出 `{min,p25,med,max,suggested}`；`suggested = 下限 − 0.05`，且不低于 0.5。
- `preflight` 在参考 ≥3 帧时把结果写进 `extracted.rowProfile`（`minCorrHint` + `loo`），并打印：
  `minCorr 建议 0.9（留一法：min 0.951 / med 0.990；阈值来自参考自身离散，别拍脑袋）`。
- `checks.intent` / `checks.verified` 同口径：**判据没写 `minCorr` 就自动用 hint**；一帧参考（算不出留一法）时才要求手填。
- `intent.md` 新增 §1.2b：profile 判据怎么写、阈值为什么必须来自分布、以及「像素误差低 ≠ 构图对」的实测。

### 判据
`node --test` = **419 / 419**（composition 10 例：留一法校准、hint 落盘、自动取默认值）。

---

## 0.32.0（未发布）· 结构指纹：给判据补上「排列」（L1 基座 + L2 图像实现）

> 回灌上游原件：否。
> 背景：一次干净 A/B 里，两条臂的**分布类**判据（mean/p50/p95/p99/glow）都落在参考带内，
> 但一条的云是「横贯画面的天花板」，另一条是「一团紧凑云体」。**判据测不出这件事**——
> 因为现有判据全是分布指纹（对排列不变）。本版补一类**对排列敏感**的判据。

### L1 基座（`harness/pipeline.mjs`）
- `research.extracted[]` 支持 `kind: 'profile'`（值是序列，不是标量）；
- `intent.criteria[]` 支持 `{ kind: 'profile', metric, minCorr }`：不比区间，比**剖面相关性**；
- `checks.verified` 自动量 `verify.shots[0]` 的剖面并与参考比，低于 `minCorr` 直接挡，并打印实际相关值。
- 标量判据行为一字未动（416 例全绿，含既有 402 例）。

### L2 图像实现（`harness/composition.mjs`）
- `rowProfile(img, 64)`：行覆盖率剖面（主体掩膜 = 亮度 > 自身 55% 分位，相对阈值不受曝光影响）；
- `structureScalars`：质心 y、上部覆盖率、两侧留白、bbox 宽高比、主体占比；
- `profileCorr`（皮尔逊）+ `medianProfile`（逐桶中位）；
- `preflight` 量参考时自动写进 `extracted`（一条 profile + 五个结构标量），并在终端打一行结构摘要。

### 实测（把这条线真跑一遍）
参考 24 帧留一法自相关：**min 0.951 / med 0.990** → 「同一构图族」的下限约 0.95。
四个候选帧对参考的相关：armA（流水线，像素误差 0.352）**0.108**、armB（手搓，0.074）**0.546**、
本机 r2 **0.355**、自由组 f2 **0.383**。
→ **四个都没达到参考的构图族**：armB 的优势主要来自亮度分布，构图也只对了一半；
这也说明「像素误差低」不等于「构图对」。`minCorr` 建议由留一法下限推（≈0.90~0.95），别拍脑袋。

### 判据
`node --test` = **416 / 416**（新增 `test/composition.test.mjs` 7 例：相关性纯函数、合成帧结构、
preflight 写 profile、verify 能红能绿、缺 minCorr 被挡）。

---

## 0.31.1（未发布）· 补 0.31.0 的两个结构漏洞（设计评审发现）

> 回灌上游原件：否。
> 来源：一次只读的独立设计评审（`_design/selfloop-split-translation.md`）指出——`budget.split` 只做了一半。

### ① `2.2a-split-rN` / `2.4m-merge-rN` 根本没有票模板
`tickets.mjs` 的节点 id 正则 `^2\.(\d)-(\w+)-rN# CHANGELOG · dsh-selfloop（权臣）

> 规矩：**改了 `harness/` 里的执行器就要在这里记一笔**，并注明"要不要回灌上游原件（案例 A，见 README「案例与来源」）"。
> 这个文件是 0.3.4 起才有的；0.3.0~0.3.3 的条目是事后补的，按 git 提交信息还原。


 只认单数字+连字符，`2.2a-split-r1` 这种「带字母后缀」的 id 落进兜底「（这个节点没有票模板）」。
现在正则改成 `^2\.(\d+)([a-z]?)-(\w+)-r(\d+)# CHANGELOG · dsh-selfloop（权臣）

> 规矩：**改了 `harness/` 里的执行器就要在这里记一笔**，并注明"要不要回灌上游原件（案例 A，见 README「案例与来源」）"。
> 这个文件是 0.3.4 起才有的；0.3.0~0.3.3 的条目是事后补的，按 git 提交信息还原。


，并补齐 `split` / `merge` 两张票模板；旧的 review 合并模板改名 `mergeReviews`，把 `merge` 这个 id 段让给窄票合并。

### ② 拆完窄票，执行员根本看不到
`exec` 票原来只读 `plan.json`；`split.json` 拆完就躺在目录里没人读。
现在 `exec` 票优先读 `split.json`，要求**每张窄票交一份结果**（`rounds/NN.json.tasks[]`，id 对上）；
`checks.executed` 相应改成**按窄票**校验工作量下限（每张票 variants ≥ minVariants、abShots ≥ 1），有 split 时不再重复要求整轮级 variants。

### 判据
`node --test` = **409 / 409**（新增 ㉗㉘ 两例：票模板不许落兜底、窄票结果必须覆盖每张票）。

---

## 0.31.0（未发布）· 窄票 + 反早停 + 靶必须来自分布（A/B 实测驱动）

> 回灌上游原件：**否**（引擎自身的执行契约与校验）。
> 背景：一次干净的双臂对照（同一任务、同一模型、同一抓帧器；一臂走全流水线，一臂纯手搓）——
> **流水线臂**：70 分钟、12/40 抓帧、89 个流程文件、11 次闸门打回、对参考的归一化误差 **0.352**；
> **手搓臂**：24 分钟、10 张、0 文件、0 打回、误差 **0.074**。
> 复盘出三条硬伤，全部落码：执行员的"多试几个"从来不是通过条件；参考是序列时只量 1 帧就把阈值锁死；技能包 184KB 让执行员动手前就烧掉 2~5 万 token。

### P1 票面契约（`harness/pipeline.mjs`）
出 `2.2-exec` 票时附带并写进票面文本：
`contextBudget: { docs: 2, images: 1 }`、`mustProduce: { variants: 3, abFrames: 1 }`。
票面即全部上下文——**执行员不必读技能包**。`budget.exec` 可改/可关。

### P2 反早停硬闸（`checks.executed`）
`done 2.2-exec-rN` 现在硬校验：`variants[] ≥ minVariants`（每个带抓帧）、`abShots[] ≥ 1`。
不满足直接打回，措辞直白：「预算没用完就别交活」。`budget.exec = {minVariants:0, requireAB:false}` 可退。

### P3 拆窄票 / 合并选优（`budget.split`）
新增节点 `2.2a-split-rN`（check `split`：`split.json.tasks[] ≥2`，每张写 goal/files/accept(dir)/contextBudget）
与 `2.4m-merge-rN`（check `mergedTickets`：`merge.json` 的 chosen/why/evidence）。
合并员只拿产物与验收表，不拿任何一方的代码。

### P4 判据靶必须来自分布（`preflight` + `checks.measured`）
- `preflight` 单帧量测会给 `extracted[].singleFrame = true`，并直接打印「若参考是序列就 --ref 目录」；
- `checks.measured`（1.1 处）硬拦：`refs/` 有多张帧、但 `extracted` 全来自 1 张 → 卡住并给出补救命令。
> 实测代价：上一单把阈值锁在单张参考帧上（g001 mean 0.327 vs 24 帧中位 0.280），整轮追错数。

### P5 技能包瘦身 + 术语收敛（`skills/selfloop/SKILL.md`）
9,838B → **4,798B**（-51%），术语统一成**观测 / 判据 / 搜索 / 台账**四个词；
`budget.exec`、`budget.split`、票面契约写进主文件；`executor-brief` 补「工作量下限」；
`workflow` 补拆窄票一节。新增判据 `test/skill-guard.test.mjs`：篇幅上限 + references 索引不许漏、不许点空。

### 判据
`node --test` = **407 tests / 407 pass / 0 fail**（新增 `pipeline-guards` 12 例 + `skill-guard` 3 例）。

---

## 0.30.0（未发布）· 判据方向与字段纪律落进程序（N4 四条 + 3 个顺带修的）

> 回灌上游原件：**否**（都是引擎自身的程序约束与校验，案例 A 侧不需要跟改）。
> 背景：上一单最大的自造坑是「判据方向写反」，其次是「字段形状错了要等交活才被告知」。本批把它们从文档层搬进代码。

### ① 判据必须带方向（`harness/pipeline.mjs` checks.intent）
带数值 `target` 的 `criteria` 现在必须有 `dir: lower | upper | two-sided`（也认别名 `direction`）：
`lower` 只要求 target ≥ 某条实测 min，`upper` 只要求 ≤ 某条实测 max，`two-sided` 保持旧的区间判定。
缺 `dir` / 写错值一律硬错，并在消息里点名「下限型 / 上限型」。判据：`test/pipeline-guards.test.mjs` ①~⑧。

### ② 出票先自查（`step`）
`2.2-exec-rN` 出票时先看本轮 `rounds/NN.json` 的字段形状（`changes` 要是数组、要有 `shot`/`preview`），`1.10-translate3` 出票时按判据文字做「本机位能不能测」预检（`capabilityPrecheck`，地平线/天空/背景亮度/剖面/自相关）。**只提示不拦**——错误不会等到交活才说。判据：⑨~⑪。

### ③ decide=next 之后作废 phase3 旧信号（`done` + `currentNode`）
以前要手删 `stages/3.1-summarize.json`、`3.2-deliver.json`，否则下一轮收尾直接跳过、总结还是上一轮的。
现在 `done 2.5-decide-rN`（action=next）自动删除；`currentNode` 另加时间兜底（本轮 `2.1-plan-rN` 晚于它们就当没写），管老 run。判据：⑫~⑭。

### ④ 轮次节点的表单从来没被校验（顺带修）
表单定义按基名（`2.5-decide`）、节点 id 带轮次（`2.5-decide-r2`），`hasForm/blankForm/checkForm` 直接拿带后缀的 id 查表 → 永远查不到，`step` 还会写出一个 `null` 表单。
新增 `formKey()` 归一；`2.1/2.3/2.5/2.7` 这些轮次节点的必办事项现在真的会卡人。`test/pipeline-rounds.test.mjs` ① 的夹具随之补填表单。

### ⑤ refcode 台账补上（标杆库每个主题目录下的 `NOTES.md`）
库里从没写过 NOTES（每天 13:00 的巡检任务却要求写）。本次补齐：volumetric-cloud 6 仓 12 条、raymarch-sdf 2 仓 4 条，每条写「做法 / 代码位置（打开核对过的行号）/ 怎么用」。

### ⑥ `skills/selfloop/references/` 同步
`intent.md` 加 `criteria[].dir` 字段与「方向别猜」说明；`pitfalls.md` 补三行（后处理污染剖面量测 / 轮次表单永不校验 / decide=next 旧信号）。

---

## 0.29.0（未发布）· selfloop 硬伤修复批（今夜实战暴露的七件事）

> 背景：2026-11-17 一整晚跑「雷暴第三版」，暴露出 7 个硬伤，全部落码并带判据。

### A1 自唤醒（`harness/watch-ticket.mjs`）
出票后 90s 无进展 → 写 `<run>/need-agent.json`；`/state.status.needAgent` 透出，节点交活后自动失效。
CLI：`--run --idle --once --now`（exit 0=该喊人／3=还不用）。

### A2 子代理吞吐（`/state.status`）
`returned/total/stale/silentForMs/failed/running`；stale = 有 running 且静默 >10min。
`active-agents.json` 支持 `status/lastSeenAt`（老条目不多塞键，保住既有 deepEqual）。

### A3 崩坏自检（`harness/crash-check.mjs`）
洋红 >0.1% / **高饱和**纯色块 >1% 屏 / 全黑 / 全白 → fail，**排在 checks.verified 问题列表最前**（优先于任何数值判据）。
> 实测修正：初版把灰色棋盘地板误报成「纯色大块 88%」，故纯色块判定加**饱和度下限 0.25**；中性灰地板/天空不再算崩坏。

### A4 自迭代有边界（`SKILL.md` + `references/executor-brief.md`）
角色分流：主 Agent（2.1~2.5）跨轮闭环；执行员（2.2）**有限**自迭代 + 三条停止条件
（达标／用满 maxSelfIterations=3／平台期：连续 2 轮无显著提升，主判据改善<5% 或帧平均像素差<2%）+ 如实交格式 + `iters.md` 留痕。

### A5 交活即快照（`harness/snapshot.mjs`）
`rounds/r<N>/snapshot/` 三件套：`code/`、`scene-params.json`、`params.md`；缺件写进 `verify.caveat`（2.3 再校验一次，防被重写冲掉）。**没有来源就报缺，不写占位文件。**

### ㉝ 意向确认归属
只从 `rounds/r<N>/intent.confirm.json` 读；无归档显示「本轮无意向确认」；老单（整单无 rounds）才允许合成一轮并标「（阶段 1 · 旧单，无归档）」。

### ⑲ 订单按会话隔离
`/state.orders` 只返回当前 session 的订单；同会话已有未结束订单 → `/start` 409 `session-busy`。

### P3 交互与视觉
㉛ 折叠体统一 `foldBodyHtml()`（折叠不再"不渲染"而是"隐藏"，修掉折叠后仍很厚）；⑱⑳ 努力程度上/下拉（`efforts: []` → 禁用并提示）；状态卡显示 `已返回 2/3` 与「⚠ 已静默 N 分钟」。

### 判据
新增 8 个测试文件 **43 条**（skill-executor 8 / snapshot 6 / crash-check 9 / watch-ticket 6 / status-agents 5 / round-confirm 4 / orders-session 4 / client-render +7）。
`npm test` 全绿；`dist/client.cjs` 67,991 B。

## 0.28.2（未发布）· 吐槽窗口延后到「第一版执行结果返回后」（待办 2）

> 用户指出：0.28 那批没覆盖这条——窗口一进 2.2 就开，用户还没看见任何效果，没得吐槽。

- `windowState()` 新增一条：当前是**第 1 轮的 `2.2-exec-r1`** 且 `rounds/r1/` 下还没有任何产物
  （也没有老的 `rounds/01.json`）→ 返回 `{ open: false, reason: 'waiting-first-result' }`。
- 判据：`test/ui-window-timing.test.mjs` 3 条（未产出→不开；产出落地→开；老订单 `rounds/01.json` 也算已出结果）。
- 说明：只在第 1 轮限制；后续轮次窗口照旧（那时用户已经看过至少一版）。

## 0.28.1（未发布）· 3.1 列出「你说过但没进工单」的吐槽 + 模型清单来源可见

- **待办 15 的第二个消费点**：`done --stage 3.1-summarize` 时，把 `user-interrupt.jsonl` 里
  **总结正文没提到**的吐槽逐条列进 `summary.unhandledInterrupts`（按 bigram 去重），
  让「你说过但没处理的」不会静悄悄消失。
- **模型清单来源可见**：接单模式的两个模型下拉旁显示 `🟢 实时`（宿主 llm 服务）或 `🟡 兜底`（插件内置清单），
  避免用户以为"我新装的模型不见了"。
- 判据：`test/pipeline-summary.test.mjs` 2 条（未提及 → 列出；已提及 → 不重复）。

## 0.28.0（未发布）· UI 大改：按轮分组、状态置顶、接单胶囊、模型下拉（用户 17 条待办的第一批）

> 用户的判词：selfloop 的界面"信息组织"和"交互打断"两头都不行。这一版按契约 v2 重做数据层与面板。

### 数据层（`/state` 契约 v2，见 docs/ui-contract-v2.md）
- **`rounds[]` 按轮分组**：每轮含 意向确认 / 吐槽 / 工单 / 验收 / 评审 / 决策；**pipeline 在 2.1/2.3/2.4/2.5/1.9 交活时把产物归档到 `rounds/r<N>/`**
  （此前 `plan/verify/review/decide` 每轮同名覆盖，历史是丢的）。
- **`status`**：节点 → 人话（"等待子代理执行"而不是 `2.2-exec-r2`）+ `active-agents.json` 子代理名册 + 窗口状态。
- **`title`**：`order.json` > 需求首句截 12 字 > 目录名；`orders[].title` 同源，下拉只显示标题。
- **`models`**：优先走宿主 `llm` 服务（`listProviders` × `listModels`，45s 缓存），拿不到才退回 `config/models.json`，
  用 `source: live|fallback` 标明来源。
- **`/start`** 新增 `title` / `researchModel` / `execModel`，落 `<run>/order.json`（并镜像进 `order-pending.json`）。

### 流程保证
- **吐槽多消费点**：`2.5-decide` 交活时把未消费的 `user-interrupt.jsonl` 条目并入 `decide.gapsForNextRound`；
  `checks.decided` 强制「jsonl 有条目但 decide 里没出现 → 不放行」；去重改成「前 8 字 + bigram 相似度 ≥0.72 + 包含关系」。

### 面板（客户端）
- 置顶**状态卡**（🚦 指示灯 + 🤖 子代理名册），下面 **按轮分组**：当前轮展开、历史轮折叠；
  需求常驻可折起；意向确认答完自动折起；吐槽默认折起。
- **胶囊**：无单=「＋ 肥鱼接单」；有单=状态胶囊；**跑单中点它只开面板**，不再弹下单框；有待确认时显示「等你确认」。
- **接单模式**：标题输入 + **调查模型 / 执行模型两个下拉**（默认"由主 Agent 分配"）。
- **吐槽框不再被轮询清空**：重绘前存 value+选区回填，输入中 2s 静默不重绘。
- **提交后不停住**：卡片切成「已提交，等 Agent 继续（每 3 秒看一次）」。
- 视觉：分类色卡片（蓝/黄/红/绿/灰）+ emoji + 三档字号；全部文案「肥鱼自治」→「肥鱼接单」。

### 判据
- 新增 `test/ui-state-v2.test.mjs`(7) / `test/ui-models.test.mjs`(8) / `test/pipeline-rounds.test.mjs`(6) / `test/client-render.test.mjs`(15)
- `npm test` 全绿；`dist/client.cjs` 62,009 B，外壳与两槽位校验通过。

### 已知未做
- 待办 15 的第二个消费点（`3.1-summarize` 列"你说过但没处理的"）未做，需改 summary 语义，另批。
- `3.1` 之后的收尾展示仍用旧字段。

## 0.27.1（未发布）· skill 里不替识图工具规定用法

> 用户定界：selfloop 只需要知道「有识图能力可用」，怎么用写在识图工具自己的 skill 里。

- `references/reference-reading.md` 第 2 节改成指针：需要判断参考内容时用大肥鱼的识图能力，
  配置与调用方式看识图工具的 skill，本文只留一条纪律「模型读图只当线索」。
- 保留 selfloop 自己的部分：preflight 只量 PNG、GIF 拆帧、视频下一期、静帧凑不出动效判据要降级。
- 版本 0.27.1（纯文档）。

## 0.27.0（未发布）· P0 三件一起补：GIF 拆帧、会话绑定、下单后「等接手」

> 用户要求：视频下一期，**GIF 必须做**（雷暴参考就是 GIF）；P0 三件一口气做完，尽快推进试运行。

- **GIF 拆帧（客户端）**：下单时用浏览器 `ImageDecoder` 逐帧解 GIF（上限 60 帧），导成
  `<名>-gNNN.png` 一起上传，落进 `run/refs/`；拿不到 ImageDecoder 时不阻塞下单，界面提示
  「GIF 未能拆帧，可能量不了」。视频仍不支持（下一期）。
- **会话 ↔ 订单绑定**：客户端探测会话键（`__DSH_BOOT__` → `[data-session-id]` → URL → global），
  所有请求带 `?session=`；宿主按会话写 `active-run-<会话>.json`，并同时维护全局指针兼容单会话。
  判据：`test/ui-session.test.mjs`（两会话各一单互不覆盖）。
- **下单后可被接手**：`/start` 多写一份 `<run>/order-pending.json`；没有 stage 的新单
  `orderState = wait-agent`（界面显示「等接手」，CTA 说明"接手后先量参考再出 1.1 的票"）。
- **skill 补一节**：GIF/视频与「双通道识图」（豆包网页免 key + mimo API，模型用 `mimo-v2.6-pro`，
  两者交叉比对；模型读图只当线索，用户文字优先），细节放 `references/reference-reading.md`，
  SKILL.md 只加一行索引（守住 6000 字符上限）。
- 判据：`ui-session.test.mjs` 2 条 + `ui-orders/ui-start/ui-extra/ui-consume` 全绿。

## 0.26.6（未发布）· 接单模式不再是「浮层假装切换」：按真实输入框矩形对齐并隐藏原框

> 用户一眼看穿：「你做了一个接单模式的聊天框覆盖在上面，假装是切换……别一看就穿帮（漏出原聊天框）」。

- **对齐**：从胶囊沿祖先链找「像输入框那条」的容器（含 textarea/contenteditable、高度 40~340px、宽度 >240px），
  把它当前的 `getBoundingClientRect()` 直接套到接单浮层上（left / width / bottom），**不再用固定宽度居中**。
- **不留底**：进入模式时把该容器 `visibility: hidden`，退出时恢复原值——不是盖住，是真让原框不可见。
- **窗口缩放**跟着重算（`resize` 监听；宿主无 addEventListener 时静默跳过）。
- 防呆：容器高度超 340px 就不认（否则会把整页藏掉——写代码时差点踩中）。
- 判据沿用 `test/client-bundle.test.mjs` 与 `test/client-smoke.test.cjs`（外壳/槽位/语法）。

## 0.26.5（未发布）· 肥鱼接单：胶囊两态开关、输入框接管、订单下拉（按用户定稿）

> 用户把入口与状态定稿了：**一颗胶囊两种态**（无单=发起 / 有单=状态），点它把会话输入框切到「接单模式」，
> 再点退出；每个会话只允许一单在跑；历史单从右侧栏下拉切换查看。

- **胶囊两态**：无订单 → 虚线 `＋ 肥鱼接单`；有订单 → `肥鱼接单 · <状态>`（等需求/等回复/来吐槽/请验收/运行中/已结束）；
  进入接单模式后变实心蓝并标 `（开启中）`，**再点即退出**（草稿保留）。
- **输入框接管**（`conversation.composer.dock` 那颗胶囊 + 自绘 `.sl-mode` 浮层）：多模态参考槽（图/视频/代码，
  逐张可删）、需求框、调研档位与轮数下拉、「下单」；下单走已有 `POST /start`，成功后自动退出模式。
- **订单列表与状态**：`/state` 新增 `orderState` 与 `orders[]`（含 `current`、`updatedAt`），
  状态推导：没需求→等需求；当前站 1.9→等回复；human 站→请验收；窗口开→来吐槽；全跑完→已结束；其余→运行中。
- **一单一跑**：有单在跑时面板底部「＋ 新订单」**直接置灰**（不是点了再检查），并写明原因。
- **历史订单**：右侧栏标题栏换成订单下拉，选中历史单以 `?run=` 只读回看。
- **去掉重复入口**：撤掉 0.26.4 那颗独立的「＋ 发起 selfloop」按钮（胶囊已负责发起）。
- 判据：`test/ui-orders.test.mjs` 5 条（四种状态推导、列表只允许一单 current、`?run=` 切换）。

## 0.26.4（未发布）· 「发起 selfloop」按钮 + 多模态参考输入（用户 ①：UI 驱动）

> 用户把界面与流程的关系拆成三种，指出第①种（需求输入=UI 驱动、Agent 还没开工）根本没有入口。
> 这一版补的就是它：**下单入口 + 多模态参考**，并把「普通任务 vs selfloop 订单」的区分落到目录上。

- **输入框下方多一颗「＋ 发起 selfloop」**（`conversation.composer.dock`，order 19，虚线边框以示区分）。
- **下单弹窗**：需求文本框 + 参考文件多选（图/视频/代码/文本）+ 调研档位 + 轮数。
  参考按 base64 上传，落进 `<run>/refs/`；白名单扩展名、单文件 ≤8MB、总量 ≤40MB。
- **订单的物证就是目录**：`<runsRoot>/sl-<名字>-<时间>/`，含 `requirement.md`、`budget.json`、`refs/`、
  `stages/`、`tickets/`，并立即把 `active-run.json` 指过去——普通任务不会有这个东西。
- **新增 `POST /plugins/dsh-selfloop/start`**：需求太短 → 400（不留空目录）；扩展名不在白名单 → 400；
  超限 → 413；写接口照旧要 `x-selfloop: 1`。
- **修：`/start` 不再被「必须先有活跃 run」挡住**（它本来就是用来创建 run 的）。
- **修：请求体上限 256KB → 48MB**，否则 9MB 参考会直接 ECONNRESET，而不是回一个说人话的 413。
- 判据：`test/ui-start.test.mjs` 4 条；`plugin.test.mjs` 路由断言 5→6。

## 0.26.3（未发布）· 让流程**真的消费**界面写下来的东西（这才是「能跑」）

> 0.26.2 交付后用户一句话点破：「这只是一个界面交互体验吧？还没有真的能跑吧？」
> 查证属实：面板填的答案与吐槽都落了盘，但 `pipeline.mjs` 里对它们的引用是 0 条。

- **意向答案并入流程**：`done --stage 1.9-confirm` 时，若存在 `intent.confirm.answers.json`，
  自动并入 `intent.confirm.json`（`answers` + `decisions.source = "user(ui)"` + 时间）。
  没填答案时仍是 `default(no-ui)`，两种来源可区分。
- **吐槽并入评审**：`done --stage 2.4b-userreview-rN` 时，把 `user-interrupt.jsonl` 的记录并入
  `user-review.json.comments`（带 `source: ui-interrupt` / `ui-interrupt(expired)`），按
  `at+text` 去重，重复交活不会并两次。
- **active.json 落地**：`step` 出票时写（`{stage, kind, openedAt}`），`done` 清理；
  乱入窗口的「主 Agent 处理中」分支从此有真实依据（之前只有 fixture 里有，真实流程从不写）。
- 判据：`test/ui-consume.test.mjs` 3 条（答案并入、吐槽并入且标 expired、去重）；
  该测试按真实 CLI 跑 `step`/`done`，并正确对待退出码 10/11。
- 版本 0.26.3。

## 0.26.2（未发布）· 从「看得见」做到「能用」：吐槽可发、意向可提交、参考可见

> 0.26.1 只做到「看得见」，用户点进去发现说不话、选不了、也没图。这一版补齐三块。

- **面板底部常驻吐槽区**：132px 输入框 + 字数计数 + Ctrl+Enter 发送；窗口开/关状态写在上面一行
  （关闭时仍可发，服务端会标 `expired` 顺延下一轮）。
- **意向确认可提交**：`/state` 现在返回 `intent.confirm.json` 的问题（含推荐项与理由），
  面板渲染成单选并 `POST /intent-answers`；已提交的会显示成「已提交」只读态。
- **参考与产物可见**：`/state` 返回 `shots[]` 与 `refs[]` 文件名，新增
  `GET /plugins/dsh-selfloop/shot?name=shots/xxx.png` 出图；只放行 `shots/` 与 `refs/` 两个前缀、
  拒绝 `..` 与非 png（穿越判据见 `test/ui-extra.test.mjs`）。
- 判据：`test/ui-extra.test.mjs` 4 条（state 三块、取图、穿越拒绝、缺文件 404）。
- 版本 0.26.2。

## 0.26.1（未发布）· 真机三处修正：指针被测试污染、分栏点不动、面板压住窗口按钮

> 装上 0.26.0 后第一次真机验收就撞到这三条，都是「看起来能用、其实不能用」的形状。

- **修：临时目录里的 run 不许写成「当前 run」**。`npm test` 里 `pipeline.test.mjs` 用 Temp 下的
  fixture 跑 CLI，把 `active-run.json` 写成了那个 fixture，界面于是显示一个根本不存在的实验
  （真实是 `runs/雷暴-r6`）。现在 `runDir` 落在系统临时目录内就跳过写指针，另留
  `DSH_SELFLOOP_NO_POINTER=1` 做显式关闭。判据：`test/ui-routes.test.mjs` 那条
  「临时目录里的 run 不许写成当前 run」。
- **修：面板分栏点击丢失**。面板每 3s 轮询重绘 `innerHTML`，元素在 mousedown→mouseup 之间被
  换掉时 `click` 永远不触发 —— 表现是「流转状态点不动」。改成 `pointerdown` 委托，
  且内容没变不重建 DOM（顺带不再把滚动位置顶回顶部），z-index 提到最上。
- **修：面板压住宿主窗口按钮**。面板原本 `top:0`，右上角正盖住最小化/关闭区，收起按钮与关闭
  按钮重合（真机差点误关窗口）。现在面板从 `top:40px` 起（标题栏下沿），收起按钮挪到左侧 `«`。
- 版本 0.26.1；其余接口与 0.26.0 相同。

## 0.26.0（未发布）· 会话内 UI 的宿主侧底座：四条同源路由 + 浏览器半边

> 用户在右侧栏里要能看见流程走到哪、能填意向、能在窗口期内吐槽。这一版只做**代码与判据**，
> 装机仍需改 profile pin + 重启宿主（另开一次发版）。

- **新增四条同源路由**（`lib/routes.js`，前缀 `/plugins/dsh-selfloop`）：
  `GET /state`（流程态 + 需求/调研/验收摘要）、`GET /window`（乱入窗口开合）、
  `POST /intent-answers`（`intent.confirm.answers.json`）、`POST /interrupt`（`user-interrupt.jsonl`，
  过期标 `expired` 并回 409）。
- **窗口语义**（按用户 2026-11-17 拍板）：调查员/观察员在跑 → 开；主 Agent 正在做本环节
  （存在 `active.json`）→ 也开；`done` 一写就关。过期不丢，只顺延。
- **安全姿态**照抄大肥鱼的七条路由：只读判 Host 环回；写要自定义头 `x-selfloop: 1`。
- **新增 `lib/active-run.js`**：pipeline 每次 `status/step/done` 写一个「当前在跑哪个 run」的指针
  （`~/.dsh/dsh-selfloop/active-run.json`），插件路由只读它，不在插件里猜路径。
- **新增浏览器半边** `lib/client.js` 与 `tools/build-client.mjs`（产出 `dist/client.cjs`，外壳逐字节校验）：
  挂 `conversation.composer.dock`（状态胶囊）与 `conversation.session.header.actions`（肥鱼自治按钮），
  面板由插件 docked 到右侧渲染，两分栏「肥鱼自治 / 流转状态」。
- **修 `harness/pipeline.mjs` 不能 import 的老毛病**：加了 `isMainModule()` 守卫，
  否则插件路由一 import 它，整个进程按「用法」退出。
- **修 `expired` 布尔化 bug**：`false || (undefined && x)` 得到 `undefined`，JSON 里整条字段消失。
- 判据：`test/ui-routes.test.mjs`（9 条）、`test/client-bundle.test.mjs`（5 条）；
  `plugin.test.mjs` 那条订阅断言按新契约改为 tools / skills / webServer 三份。

## 0.25.0（未发布）· 执行阶段重排：验收 → [观察员] → [用户评审] → 决策 → 补调研 → 吸收

> 用户定的新顺序，并补上漏掉的一环（补调研没人吸收等于白查）。

- **开关默认值调整**：`useCritic` 默认 **false**（观察员改成可选）、`userReview` 默认 false、
  新增 `resupply` 默认 **true**（只在 decide=next 时触发）。
- **取消 `2.4c-merge`**：合并并入 `2.5-decide`（它本来就要产出 nextRoundOrders），少一个节点。
- **新增 `2.6-knowledge-rN`（子代理）**：按 `decide.nextRoundOrders` 定向补调研，
  写 `research.supplement-rN.json`（targets + findings + gaps），要求 ≥1 条真 URL。
- **新增 `2.7-absorb-rN`（主Agent）**：把补调研转成下一轮需求 `nextRoundBrief.json`
  （goal / absorbed / criteriaDelta / orders / notDoing / budgetNote），表单 5 项必填。
  下一轮 `2.1-plan` 的票里固定要求先读它。
- **decide 加严**：`action: "next"` 却没给 `nextRoundOrders` → 硬错（不许空转）。
- **stop 时自动跳过本轮的 2.6/2.7**（status 里标 `[--]`）。
- `preflight` 写的默认 budget.json 同步新默认值。
- 测试 255 → 258（默认开关、stop 跳过、decide 加严、补调研缺文件）。

## 0.24.0（未发布）· 用户参与评审：执行阶段每轮可插入「用户评审 → 主Agent 合并」

> 用户要求：执行阶段的每轮评审+返修，可以加入「用户参与评审 → 主Agent 吸收合并」的开关。

- **新开关 `budget.json` 的 `userReview`**（默认 `false`）。打开后，每轮节点变成：
  `2.4-critique-rN（观察员）→ 2.4b-userreview-rN（用户）→ 2.4c-merge-rN（主Agent 合并）→ 2.5-decide-rN`
- **新增第四类节点 `human`**：`step` 到它时**返回退出码 11**（"等待用户"），不发子代理；驱动者把用户意见写进
  `user-review.json`（`by / shot / comments[] / verdict`）后调 `done` 才继续。
- **合并节点的硬要求**（checker + 表单双重）：`fromCritic` / `fromUser` / **`conflicts`（冲突时按谁、为什么，不许和稀泥）** /
  **`nextRoundOrders`（合并结果必须变成下一轮工单）**。
- 修一处显示缺陷：长节点 id（如 `2.4b-userreview-r1`）会把 owner 标签挤住。
- 测试 251 → 255（开关开/关、退出码 11、合并缺字段卡住）。

## 0.23.0（未发布）· 主Agent 表单：必办事项由程序发空表，填不完不放行

> 用户指出："主Agent 的节点没人核 —— 可以写表单，由程序来收。必办事项必须把表单填完，程序才放行。
> 虽然不能控质量，至少起到提醒作用，确保主Agent 不遗漏。"
> 背景：0.22.0 之前主Agent 节点裸奔，实测出过"引用了不存在的条目"没人发现。

- **新增 `harness/forms.mjs`**：9 个主Agent 节点各有一张表，字段就是它们的必办事项：
  · 1.2 初轮转译：复述 / ≥3 条调查问题 / 假设 / **本轮不做什么** / 预判哪些指标能当判据
  · 1.7 吸收：每条 takeaway 要 from-what-apply / **被否掉的结论及理由** / **调研互相矛盾处怎么取舍** / 是否改变做法
  · 1.8 二轮转译：判据条数 / 每个阈值的实测来源 / 每条映射到哪个旋钮 / 哪些量不了
  · 1.9 确认意向：要问用户的（每个必须给推荐答案）/ 自己拍的板及依据 / 打算怎么问
  · 1.10 定稿：数值判据 / noMetric 判据及理由 / 锚 / 明确不要的
  · 2.1 工单：任务-判据-文件 / 派谁 / **本轮只动哪几个变量** / 风险与退路
  · 2.3 验收：能跑的证据 / 能看的证据 / **看到但不在验收范围内的问题** / 没验的部分
  · 2.5 决策：动作 / 依据 / 下一轮缺口 / 预算状态
  · 3.1 总结：人话 / 改了什么 / 还没做到 / 下一步
- **程序侧**：`step` 出票时自动发空表；`done` 时逐项校验（非空、列表条数、枚举取值），
  任何一项空着就**列出未填项并拒绝放行**——不控质量，只保证不遗漏。
- 票里也写死了"交活前先填表"。
- 测试 249 → 251（空表不放行 / 填全放行）。

## 0.22.0（未发布）· 补三个"靠自觉"的漏洞：顺序闸 + manager 节点 checker

> 2026-11-16 实测（用户问"是不是每步都有程序信号灯转交"）：**不是**。
> · 1.1 还没跑，就能直接对 `1.2` 交活 —— 顺序没有校验；
> · 没写 `intent.draft2.json` 也能对 `1.8` 交活 —— 该节点没有 checker；
> · 有 checker 的节点（如 `2.1`）才真的被卡住。

- **顺序闸**：`done` 只能交「当前节点」，交别的一律拒绝并返回 **exit 3**（"上游信号没到，不许提前交活"）。
- **补 3 个 manager checker**：`1.2`（restate + openQuestions 非空）、`1.8`（criteria 非空且每条有 userWords/howMeasured）、
  `1.9`（questions/autoConfirmed 不能都空；每个问题必须给 recommend，不许把选择题原样丢回去）。
- **信号带来源标记** `by: "pipeline"`：手写信号一眼能看出来。
- 测试 246 → 249（顺序闸 / 空手交活 / openQuestions 为空）。

## 0.21.0（未发布）· 流水线 v2：三类节点 + 预算档位 + 轮循环

> 用户给了完整设计：需求建立 6 步（含三路调查与三轮转译）、执行阶段按轮循环，并补了两条开销控制。
> 之前那版是 6 个扁平节点、一次转译、单轮执行——**偏离很大**，这版按设计重写。

- **节点分三类**：`program`（程序算）/ `manager`（主Agent 做）/ `worker`（派子代理）。
  manager 节点的票写"你要做哪个判断、产出哪个文件"，不派子代理——这正是"系统 → 主Agent"。
- **需求建立 9 节点**：preflight(程序) → 初轮转译 → 需求建立三路调查 → **调研闸(程序)** →
  吸收 → 第二轮转译 → 确认意向 → 第三轮转译（定稿判据）。
- **调查强度四档（`budget.json` 的 `research`）**：
  `low` 跳过调查 / `mid` 只查环境·工具·指南 / `high`（默认）再加技术文献 / `max` 再加参考图·现实知识。
  调研闸按档位核：mid 要求 ≥1 条 `kind=environment`；high 起要求 ≥2 条带 URL 且 ≥1 条 opensource/paper。
- **执行阶段按轮循环**：`plan(主Agent) → exec(子代理) → verify(主Agent: 能跑/能看) → critique(观察员，可关) → decide(主Agent)`；
  `maxRounds` 限轮数，`useCritic=false` 则取消观察员节点、由主Agent 直接验收；`decide` 写 stop 时后续轮次自动标 `[--]` 跳过。
- **判据闸加严**：每条可测 criteria 必须有数值 `target`，且要落在 `research.extracted` 某个 `[min,max]` 内；
  量不了的必须显式 `noMetric: true` 并写理由。
- **新增 `harness/tickets.mjs`**：所有节点票模板集中一处（单职责 + 不许越界 + 交活命令）。
- 测试 239 → 246：pipeline 7 条（默认/低/中/四档、轮数、观察员开关、step 出票、调研闸卡住、decide stop 跳过后续轮）。

## 0.20.0（未发布）· 流程由程序控制：pipeline 节点表 + 单职责子任务

> 用户判断："不应该把流程写进 skill，约束太弱。**流程给程序控制，流程上每个节点的判断决策和执行才交给 agent**。"
> 两次受控实验的数据支持这条：第一次代理读完规范零产出，第二次读了摘要就跳过闸门直接改代码——
> **文档层面的约束挡不住人**。

- **新增 `harness/pipeline.mjs`（流程的程序载体）**：
  · 节点表：`preflight(程序) → research(agent) → intent(agent) → implement(agent) → review(agent) → deliver(程序)`；
  · `status` 看当前节点；`step` 一路推进程序节点，遇到 agent 节点**出票并 exit 10**；
    `done --stage <id>` 由 agent 交活后调用，**程序自己核对产物**（不看自述），不过就写 `failed` 信号卡住；
  · 每个 agent 节点的票（`tickets/<stage>.json`）里带**单职责 prompt**：只做一件事 + 不许越界（不许改上游产物）+ 完成标志；
  · 信号 `stages/<id>.json`：下游只认它，不认口头。
- **checker 全部可执行**：research 走 `checkResearchGate`；intent 检查 restate/criteria/anchors/confirmed；
  implement 检查 `rounds/NN.json` 有截图/入口和 changes；review 检查 `vsCriteria` 逐条；deliver 检查产物与建议。
- **文档定位改写**：`working-discipline.md` 顶部写明"流程归程序、skill 只讲节点内判断"。
- **测试 234 → 239**：`pipeline.test.mjs` 5 条（空目录拒绝 / 出票 / 调研不合格卡住 / 合格放行 / intent 未确认卡住）。

## 0.19.1（未发布）· 闸门与执行器解耦（`--check`）+ 开工三步提到 SKILL 顶部

> 第二次受控实验（R3）的真实原因，不是执行代理不守纪律：
> **引擎的 web 执行器接不上 Unity 宿主**（三个 adapter 都 `runnable:false`，缺 `%VFX_LOOP_CLIENT%`），
> 于是它自己用 MCP + Python 搓了一条替代链路——**而闸门原来只挂在引擎链路里，全被绕过**。

- **`preflight.mjs` 支持 `--check`**：只判定 run 目录现状（`extracted` / `findings` / `intent.confirmed`），
  **不建目录、不量图、不写文件**，退出码 0 / 3 / 4。给观察员与任何"自建链路"用——闸门与执行器无关。
- **SKILL.md 顶部新增「0. 开工三步」**：preflight → 派调查员 → 填 intent，并写明
  "preflight 没过就改代码 = 跳过流程"。执行代理只读摘要不读 references 时，也能撞见这条。
- **`working-discipline.md` 补「派单契约」与解耦说明**：规则写在派单那一刻；
  不论 `iter.ps1` / `cmdloop.mjs` / 自建链路，开工前都要过同一道 `--check`。
- 测试全绿（结构改动，行为不变）。

## 0.19.0（未发布）· 整理一轮：分卷、合并、抽出模块（不加功能）

> 用户判断："这么多轮下来 selfloop 会变得臃肿又混乱"。这版只做减法和归位，**不加任何能力**。
> 判据：每一处改动都必须让"找东西"变快，否则不做。

- **CHANGELOG 分卷**：0.13.x 及以前 → `CHANGELOG-archive.md`（657 行）；主文件只留 0.14.0 之后（123 行，从 771 行降下来）。
  两个文件都在 `files` 白名单里，历史不丢。
- **文档合并**：`autonomy.md`（什么时候可以停）+ `research-brief.md`（怎么派调查员）→
  `working-discipline.md`（144 行）。原来两篇互相引用，读者要在两个文件之间跳；现在按
  「开工跑道 → 派调查员 → 什么时候停」的顺序排成一篇。references 16 → 15 篇。
- **代码抽模块**：调研闸从 `intent.mjs` 里抽成 `harness/research-gate.mjs`（90 行，导出 `checkResearchGate`）。
  这条规矩在 0.16→0.17.2 打过三次补丁，内联进去把主流程淹没了；现在 intent.mjs 只留一句调用（920 → 844 行）。
- **README**：去掉硬编码版本号的标题（"作业台（0.15.0）"→"作业台"），避免每次发版都要改文档。
- 测试 234 全绿（行为零变化，纯结构整理）。

## 0.18.0（未发布）· 开工跑道：preflight + 复用登记

> 受控实验（2026-11-16）：派一个**上下文干净**的执行代理跑同一个需求，观察它是否按流程走。
> 结果反直觉——它读了全套规范（9 份 references）、读了三个源码文件、确认了 MCP 通道，
> **但 8 分钟零产出**，因为不知道该从哪一步"开始做"；同时它准备直接改 `ThunderStormVfx.cs`、
> 复用上一轮调研却不登记。两个缺口都补上了。

- **新增 `harness/preflight.mjs`（开工前检查，一条命令）**：
  · 建 `refs/ rounds/ shots/`；
  · 对参考图跑 `ref-probe`，把量测写进 `research.json.extracted[]`（已有文件就合并，不覆盖 findings）；
  · 生成 `intent.json` 空壳（不替人拍判据）；
  · 打印"还差哪几步"，条件不足时 **exit 3/4**；全齐才 exit 0 并说"可以开工"。
- **调研闸支持「复用登记」**：`research.reusedFrom` 指向上一轮的 research.json 即可复用，
  闸会核对被引用那份是否合格；指向不存在的文件 → 硬错（"复用要能被核对"）。
  —— 复用合理的，不该为了守规矩重复劳动；但"上一轮查过"不等于"这一轮调研过"。
- **`references/autonomy.md` 增加「六、开工跑道」**：第一个动作是 preflight 不是读代码；
  preflight 没过不许改工程文件；复用必须登记；"可以动手"的三个条件。
- **测试 228 → 234**：`preflight.test.mjs` 3 条（缺参 / 建骨架+量参考+exit 3 / 齐了 exit 0）、
  `research-gate.test.mjs` 增 2 条（复用放行 / 假复用硬错）。

## 0.17.2（未发布）· 证据等级：不接受全是二手博客

> 实测：两个调查员回来 22 条 findings（18 条带 URL）。其中二手博客确实会把关键事实说反——
> 这次就遇到「中点位移能生成分叉」的说法，而原始实现（krazydad / Stack Overflow）明确写的是**不分叉**。

- 调研闸追加：带 URL 的来源里，至少 **1 条 kind="opensource"（能读代码）或 "paper"（有正文）**，
  否则 exit 1（"二手博客容易抄错"）。检查顺序放在 findings/used 之后，错误信息不打架。
- 测试 8 条（新增 ②e：全是 article → 硬错）。

## 0.17.1（未发布）· `used` 不能是空宣称：必须写 usedFor

> 实测：派出去的调查员回来了 11 条带 URL 的来源、参数与失败清单，质量够用。
> 但闸只检查「有没有 used=true」，**不检查它改了什么** —— 那等于允许"我看过了"冒充"我用了"。

- 调研闸追加：每条 `used:true` 的 finding 必须有非空 `usedFor`（改了哪条判据 / 哪项做法），否则 exit 1。
- 测试 7 条（新增 ②d：used 但没 usedFor → 硬错）。

## 0.17.0（未发布）· 调研闸加严：没有外部来源的"调研"不算调研

> 触发：0.16.0 刚把"必须量参考"做成闸，第二轮就露了新破绽——**"调查员"这个角色根本没被派出去**：
> 主 agent 一边定判据一边写代码，调研被压成"随手搜一下"，搜完不留产出；
> 更糟的是我自己编了两条假设（"长直段""折角太多"），**两条都被自己的实验证伪**。
> 用户一句话点破：不该纠结需求，该问「为什么调查员没被派出去」。

- **调研闸加严（`harness/intent.mjs`）**：有图片锚点时，除了 `extracted[]` 非空，还必须
  · `findings[]` **≥2 条带 http(s) URL**（外部来源：开源实现 / 文章 / 论文）；
  · **≥1 条 `used:true`**（证明调研真的改变了做法，不是自言自语）；
  任一条不满足 → **exit 1**，错误信息直接写"派一个调查员子代理去查，别自己随手搜一下就算"。
- **新增 `references/research-brief.md`（派调查员简报）**：
  · 为什么必须独立角色：主 agent 边定判据边写代码时，调研必然退化成副产品；
  · 派单模板（用 `subagent`，一个调查员只查一个主题，模型与主 agent 错开）；
  · 验收表：extracted 非空 / findings ≥2 带 URL / ≥1 used / 被证伪的假设标 `falsified`；
  · 四条"常见退化"：只写结论不写来源、把主 agent 的猜测抄进 findings、搜了不用、用"看起来是…"代替量测。
- **测试 224 → 226**：`research-gate.test.mjs` 6 条（新增"只有实测没外部来源 → 硬错""有 URL 但没一条 used → 硬错"）。

## 0.16.0（未发布）· 把"调查员必须干活"和"自主推进"从自觉变成机制

> 触发：2026-11-16 第二轮实战（MonSlayer 雷暴）。用户点名的两个问题：
> ① **调查员没干活**——拿到参考 gif 没量就拍阈值（云占 45% vs 实测 65%、p99 0.97 vs 实测 0.91），
>    还是用户提醒才反应过来；② **执行过程中没有自主推进**——每一步都停下来等用户喊"继续"。

- **新增 `harness/ref-probe.mjs`：参考量测工具（零依赖，自带极简 PNG 解码）**
  · 一条命令把参考图/帧目录变成特征表：mean / p50 / p95 / p99 亮度、冷色与暖色占比、
    **光晕占比（中亮偏蓝）**、**亮部占比**、**上部区域覆盖率**（相对四角背景）、背景中位色、非黑占比；
  · `--json` 直接产出可并进 `research.json.extracted[]` 的结构（what / value / min / max / source）；
  · 为什么必须有：上次"调查员"这步是现写一段 python，每次都漏；现在是一条命令，漏就是没干活。
- **intent 闸新增「调研闸」（硬错）**：intent 里声明了 `kind:"image"` 的锚点，但
  `<out>/research.json` 不存在或 `extracted[]` 为空 → **exit 1**，错误里直接给补救命令
  （`node harness/ref-probe.mjs <参考> --json <out>/ref.extracted.json`）。
  确实要跳过就 `--no-research`（台帐留名）。纯数值目标（没有图片锚点）不拦。
- **新增 `skills/selfloop/references/autonomy.md`（自主推进规则）**：
  · 默认值 = **推进到可直接验收的产物**，不是汇报进度；
  · 只有三种情况允许停：A 需要人的主观判断 / B 需要人的操作 / C 不可逆或高风险；
  · **停下来之前必须已经产出东西**（图 + 差在哪 + 一个要人拍板的问题 + 建议答案），空手问 = 庸臣；
  · 每次回复前三句自查：有新产物吗？停的理由属于 A/B/C 吗？有没有把该自己拍的技术选择包装成"请你确认"？
  · SKILL.md 索引加一行，正文体量仍在 6,000 字符内（4,169）。
- **测试 214 → 224**：`ref-probe.test.mjs` 6 条（合成像素精确断言 / 真 PNG 解码 / summarize / 非法 PNG 必须抛错）、
  `research-gate.test.mjs` 4 条（没量参考硬错 / 量过放行 / `--no-research` 放行 / 纯数值不拦）。

## 0.15.0（未发布）· 阶段 0：页面变成真控制台（上传 / 日志 / 新建项目）

> 用户拍板"开干"，把 0.14.1 那版还只能"看"的三处补齐——不做这个，实战里每一步都要有人替他搬文件。

- **参考图上传**：① 段参考网格末尾加「＋ 添加参考」，**支持拖拽与点选、可多选**；
  `POST /api/refs`（原始字节，`x-filename` 头）→ 落 `<run>/refs/`、按扩展名判 `image/gif/video`、写进 `project.json.refs[]`；
  同名覆盖不叠加，空文件 400，>64MB 413。
- **执行日志可见**：③ 段底部新增日志卡，读 `<run>/log.jsonl`（agent 侧每步追加 `{at, stage, text}`），
  时间戳 + 阶段 + 正文，**自动跟随到底**（用户在往回翻时不打断）。state 里给末 300 条。
- **新建项目**：目录不存在时页面显示「这个目录还没有项目」+ 目录路径 + 【新建项目】；
  `POST /api/init` 建 `refs/ rounds/ shots/` 与 `project.json` 骨架（四角色默认值、轮数 3）。
  空目录时只保留 ① 段（新建入口在里面），②③④ 收起，技术细节不再自动展开。
- **测试 9 → 12 条**：新建项目骨架 / 参考上传（落盘+类型判定+同名覆盖+空文件拒）/ 执行日志截断。
- README 的「本地查看器」一节改成「作业台」四段说明。

## 0.14.1（未发布）· 界面重做成「作业台」：四段流程，人话优先

> 0.14.0 做完用户一句话打回：**"这些都是给 agent 看的参数，不是给人看的"**。
> 参考产品是**即梦**（输入→理解→过程可见→交付），但我们的产物是**代码**（逻辑+前端视觉），
> 所以交付必须带 diff 与检查结果，不能只是两张图对比。

- **界面重写（ui/ 三件）**：
  · ① 投入：需求原文 + 参考网格（图/gif/视频带用途标注）+ **最大迭代轮数**（圆点可视化）+ **四角色模型指派**
    （项目经理 / 观察员 / 调查员 / 执行者，各带下拉与职责说明）；
  · ② 理解：左边"我的理解"复述、右边判据表（要什么 / 你说的原话 / 怎么量 / 阈值）+ 反例 + 自由度 +
    调查员查到的参考（带链接与「用上了/没采用」）+ `据此改了` + 【确认开干】/【这里不对】；
  · ③ 过程：**逐轮卡片**（v1 初版 → 自审 → v2 → …），每轮 = 该版截图 + **可运行入口** + 观察员评审
    （结论/具体哪不对/跟参考比差在哪）+ 这轮改了什么 + 距离变化 + **【停在这里】**；
  · ④ 交付：终版大图 + 参数 + 跑过的检查（pass/warn/fail）+ 改动 diff + 编号建议 + 收下/打回；
  · 原来那套参数面板（曲线 / KPI / 胶片带 / 台帐 / report）整体降级成底部 **技术细节** 折叠区。
- **数据契约（新增）**：`project.json`（投入 + 角色 + 预算）、`rounds/NN.json`（一轮一版 + 自审 + 预览入口 +
  `interrupted`）、`deliver.json`（终版 + 检查 + diff + 建议）。`buildState` 一并聚合，旧字段全保留。
  打断语义：任意一轮停下 → 该轮标 `interrupted`，后面不再生成，直接拿当前最好一版交付，**不许假装跑完**。
- **修一个真 bug**：`.lightbox{display:flex}` 盖掉了 `[hidden]` 的 UA 规则，导致整页被 85% 黑罩蒙住
  （截图才发现）。补 `[hidden]{display:none !important}`。
- **现状**：界面**只读**——确认/开工/打断/接受都是真按钮但只弹 toast，后端还没有写接口；
  真实 run 里由 agent 侧写 `project.json / rounds/ / deliver.json` 三个文件即可点亮。