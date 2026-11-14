# CHANGELOG · dsh-selfloop（权臣）

> 规矩：**改了 `harness/` 里的执行器就要在这里记一笔**，并注明"要不要回灌上游原件（案例 A，见 README「案例与来源」）"。
> 这个文件是 0.3.4 起才有的；0.3.0~0.3.3 的条目是事后补的，按 git 提交信息还原。

## 0.5.2（未发布）· 边跑边看：`live.jsonl` + `watch.mjs`

> 0.5.0/0.5.1 解决的是"**事后可读**"：`report.md` 顶部有 `N done / N skipped / N degraded`，`nodes/NN-*.json` 每个节点一条。
> 但用户现在常常在手机远程，**跑的时候看不见过程**：不知道跑到第几轮、哪个节点在跑、哪些被绕过、产物在哪。
> 这一版只补"看"，**不动搜索逻辑、不动判据、不碰 `iter.ps1`**：执行器多写一条流水，另加一个只读文件的视图。

- **`cmdloop.mjs` 写 `<out>/live.jsonl`**：每做一次真实评估追加一行
  `{seq, round, t(本地 ISO 带时区), d, best(当前最优), params, evalMs, note(target|start|stability|precheck|search), budget}`。
  `appendFileSync` 每次 open/write/close（立刻 flush，不攒到最后）；开跑清空旧流（一个 `--out` = 一次 run），
  失败/中止**不删已有行**。改动只在 `runEval` 落点加一行，搜索/缓存/预算语义一个字节没动。
- **新增 `harness/watch.mjs`**（纯 node、跨平台、只读磁盘、不连引擎）：
  `node harness/watch.mjs <out目录> [--once] [--interval 500] [--timeout 60] [--json]`。
  按间隔清屏重画一屏五段（顺序固定）：① 状态行 `run … · 第 N 轮 / 预算 N（已评 N）· best …（降幅）· 单次 …ms`；
  ② 6 个节点各一行（`✔` done / `⏝` running / `–` skipped（原因截 40 字）/ `!` degraded / `✗` failed / `·` pending）+ 计数；
  ③ `live.jsonl` 末尾最近 3 个评估点；④ 产物**绝对路径**（`shots/best.png`、`shots/target.png`、`report.md`、
  `best.json`、`curve.csv`、`nodes/`，存在才列）；⑤ `Ctrl+C 退出 · 跑完自动显示 summary`。
  读到 `nodes/` 里有 `finalize`（done/failed）→ 画最后一屏自动退（exit 0）；`--timeout` 防挂死；
  `--json` 输出同一份一屏数据（`round/budget/evaluated/best/nodes[]/recent/artifacts…`）给以后的面板读。
  **没有 `live.jsonl` 也能跑**（截图链路）：第 3 段写"（没有实时评估流：这条链路只写节点台帐）"，其余照常。
- **报告可复制**：命令链路的 `report.md` 末尾新增一行 `实时视图：node harness/watch.mjs "<本目录>"`。
- **新增 6 条测试（`test/watch.test.mjs`，现在 55 + 12 + 21 + 19 + 6 = 113）**：① 一屏含轮次/best/`d=`/产物绝对路径/`6 done`；
  ② skipped 原因片段可见；③ `finalize` 已存在 → 正常模式 3 秒内自动退（不等 `--timeout 5`）；
  ④ 没有 `live.jsonl` 不崩且说明可见；⑤ `--json` 可 `JSON.parse` 且含 `round/budget/evaluated/best/nodes[]`；
  ⑥ 真链路 `--budget 8 --no-intent`：`live.jsonl` ≥6 行、逐行可 parse、`seq` 递增，**且子进程运行期间就数到 ≥3 行**
  （把 append 改成攒到最后写 → ⑥ 红）。`npm test` 已把 `watch.test.mjs` 挂进来。
- **文档**：`skills/selfloop/references/intent-and-ledger.md` 新增 §6.2「跑的时候怎么看」（用法 + 一屏各段含义 +
  截图链路差异）；`README.md` 命令观测用法段加一行。
- **硬约束**：不 commit、不 push、**不改版本号**（`package.json` 仍是 `0.5.1`，bump 留给发布）；
  不改 `iter.ps1`；不装依赖（只用 node 内置模块，Windows 清屏用 ANSI 不用 `cls`）。

## 0.5.1（未发布）· 需求转译升到 v2：锚 / 反例 / 自由度 / 验收方式

> 为什么升：三份真实实验复盘（多模型视效产线）的结论是「**提示词写法是第一杠杆，模型只抬上限不抬下限**」，
> 而最大的坑是「**指标替代审美**」—— 每轮都在追可数指标，单步都有"改进证据"，累积却把观感磨平。
> 0.5.0 的 intent 只有"指标 + 权重 + 目标"，等于把这个坑**制度化**。v2 补的四样全部来自那轮实验的实证：
> 锚（具体参照物）、反例（明确不要什么）、自由度 vs 定死项（别把形态全锁死）、验收方式（谁点头算过）。
> 一句话：**锚不住东西的锚等于空话；没写反例/自由度，等于把审美全权交给搜索。**

- **intent v2 契约**：结构 `{version:2, restate, anchors[], criteria[]{id,weight,target,anchor,why}, notWanted[], freeVsFixed{fixed,free}, howWeVerify{human,metrics,note}, uncertain[], confirm[], confirmed, confirmedBy, confirmedAt}`。
  硬错（全部中文 + 非零退出）：① `restate` 必填非空且 ≤200 字；② `anchors` 至少 1 条，`kind:"image"` 的 `ref` **必须真实存在**
  （相对 intent 文件所在目录或绝对路径，错误里点名 ref + 解析出的绝对路径）；③ `criteria` **≤5 条**（错误信息写明
  "轻合规：写越厚，花在做到上的预算越少"），每条必须有 `anchor`（指向 `anchors[i]` 或一句具体参照，下标越界也是硬错）；
  ④ `confirm` **≤3 条**；⑤ `criteria[].id` 在 adapter 里不存在仍然硬错（v1 已有，未退化）。
- **缺失 ≠ 空数组**：`notWanted` / `freeVsFixed` 可以显式给空数组；**字段缺失**则 warn 并把台帐 `01-intent.json` 记 `degraded`
  （reason 写清缺 notWanted / 缺 freeVsFixed）。`howWeVerify` 缺失只 warn（"谁点头算过"没写进契约）。
  `confirm[]` 非空但 `confirmed:true` → 允许通过，warn 一句"还有 N 条待确认问题没答，已按当前判据开跑"。
- **v1 向后兼容**：没有 `version`、`criteria` 没有 `anchor` 的老 intent **仍然能跑**，但必须打一条中文 warn
  （`这是 v1 intent（没有锚/反例/自由度），等于把审美全交给指标——建议升级到 v2`），台帐 `01-intent.json` 的 `status` 记
  **`degraded`**（不是 `done`），`reason` 写清缺什么；`report.md` 顶部标 `intent v1 · degraded`。
- **台帐与报告**：`restate` / `anchors` / `notWanted` / `freeVsFixed` / `howWeVerify` 全部写进 `01-intent.json`
  （`artifacts` 指向新增的 `<out>/intent.summary.json`，`decision.basis` 里留人读的逐条摘要 + 一句
  "**以上不参与距离计算，只做记录与呈现**"）；`report.md` 在「本次运行」汇总行下面新增一段 **intent 摘要**
  （restate 一行 + 锚几条 + 反例/自由度 + 谁验收 + 是否 v1 degraded）。**这些不参与距离计算** —— 锚一旦进距离就又变成指标。
- **两个入口口径一致**：新增 `harness/intent-summary.js`（CommonJS）作为摘要的**唯一实现**，`cmdloop.mjs` 通过
  `intent.mjs` 复用、`finalize.js` 直接 `require`（截图链路读同一个 `intent.summary.json`），防止两份实现漂。
- **改动的执行器**：`harness/intent.mjs`（v2 校验 + v1 降级 + 摘要落盘 + 回执加 `version/restate/anchorCount/summaryFile`；
  `gate` 子命令的派生 adapter 现在对 `degraded` 也生效）、`harness/cmdloop.mjs`（写摘要 + 报告摘要段；v1 degraded 也会照常开跑并打 warn）、
  `harness/finalize.js`（截图链路报告补 intent 摘要段）。**`iter.ps1` 的转发逻辑一个字节没动**（它只调 `intent.mjs gate`，闸内部升级）。
  新增文件 `harness/intent-summary.js`。
- **新增 8 条测试（`test/intent.test.mjs`，现在 55 + 12 + 21 + 19 = 107）**：
  ⑪ 完整 v2 → 通过 + `status=done` + 报告含 restate 片段与锚条数（并断言 `participatesInDistance:false`）；
  ⑫ `anchors[0].kind=image` 指向不存在的文件 → 硬错；⑬ `criteria` 6 条 → 硬错且信息含"轻合规"；⑭ `confirm` 4 条 → 硬错；
  ⑮ v1 → 能跑但 `01-intent.json` 是 `degraded` 且 reason 含 `v1`；⑯ `restate` 空 → 硬错；
  ⑰ 弄坏能红 ×2：新增变异开关 `anchorAlwaysTrue`（锚存在性检查恒真）让 ⑫ 塌、`v1AsDone`（v1 记 done）让 ⑮ 塌。
  原有 ①~⑩ 全绿（fixture 升级成 v2，③/⑥ 的 `status=done` 断言不变）。
- **文档**：`skills/selfloop/references/intent-and-ledger.md` 重写 §1（v2 字段表 + 一个填好的小例子）、§1.5
  「为什么要锚/反例/自由度」（四样各自的实验依据与不写的后果）、§2 增加 v2 六条硬错表、§5 补 `01-intent.json` 的 artifacts/basis、
  §6 补 intent 摘要段怎么读、§7 把「**锚还没进搜索**」列为最大缺口（三条候选路）；`README.md` 的 intent 用法段补"v2 要锚"；
  `CHANGELOG.md` 本条。
- **硬约束**：不 commit、不 push、**不改版本号**（`package.json` 仍是 `0.5.0`，bump 留给发布）；`npm test` 全绿（107）。

## 0.5.0（未发布）· 看得见的过程：需求转译硬闸 + 节点台帐

> 前六版一直在补"中段"（观测 → 判据 → 搜索）。这一版补的是**头**：需求输入之后必须先被消化、且必须被人确认，才允许开跑；
> 同时把流水线每一步落成一条能机器读的台帐 —— 以前"哪些节点被绕过"只散在日志里，等于没有答案。
> 两条都来自用户的原话："需求输入之后有没有真被消化理解""哪些在起效、哪些被绕过，每个节点看得清楚"。

- **新增需求转译（intent）契约与硬闸**：运行目录 `<out>/intent.json`（或命令链路 `--intent <file>`、截图链路 `-Intent <file>` 指定）。
  结构 `{understood, criteria[{id,weight,target,why}], uncertain[], confirm[], confirmed, confirmedBy, confirmedAt}`。
  三条硬错（全部中文 + 非零退出）：① 没有文件 → 拒跑 + **写出 `intent.template.json`**（错误里说清填什么/填完怎么确认/显式跳过的开关）；
  ② `confirmed !== true` → 拒跑并把 `confirm[]` **原样逐条列出**；③ `criteria[].id` 在 adapter 里不存在 → 拒跑（**绝不静默忽略**）。
  `confirmed: true` 时 `criteria` 按 id 覆盖判据（`weight` 改权重、`target` 改目标值），覆盖了哪几条写进台帐。
  **位置**：所有评估之前（比目标帧/目标指标、比活性预检、比稳定性闸都早），因为它会改判据。
- **显式跳过是一等公民**：命令链路 `--no-intent`、截图链路 `-NoIntent` → 放行，但台帐必须记一条 `intent` = `skipped`，
  reason 写"显式 --no-intent 跳过需求转译"。默认路径**没有**、也不会改成放行。
- **新增节点台帐**：每节点一条 `<out>/nodes/NN-<node>.json`，字段固定
  `{node, seq, status(done|skipped|degraded|failed), producer(agent|engine|host), ms, inputs[], decision{why,basis[]}, artifacts[], cost, reason}`；
  `skipped`/`degraded`/`failed` **必须带 reason**（跳过要有名字）。初版覆盖 `intent` / `target` / `stability` / `precheck` / `search` / `finalize`。
- **`report.md` 顶部汇总行**：`本次运行：N done / N skipped / N degraded`，下面逐条列 skipped/degraded 的 node 与原因（最多 8 行，多了写"还有 N 条见 nodes/"）。
  计数与 `nodes/` 里实际条数**必须相等**（测试钉住了）。
- **新增文件**：`harness/intent.mjs`（闸 + 模板 + `criteria` 覆盖；也是截图链路 `-Intent` 的实现，`gate` 子命令，**逻辑只有这一份**）、
  `harness/ledger.js`（台帐字段校验/写入 + 汇总行，`cmdloop.mjs` 与 `finalize.js` 共用，CommonJS）。
- **改动的执行器**：`cmdloop.mjs`（闸 + 六个节点 + 报告汇总 + 硬错补 `failed` 节点）、`cmdlib.mjs`（新增 `applyMetricOverrides`：改权重后**重新 plan()**）、
  `iter.ps1`（只加 `-Intent`/`-NoIntent` 两个参数 + 在"解析完 adapter、任何评估之前"转调 `intent.mjs gate`，**浏览器/冻帧/清理逻辑一个字节没动**）、
  `finalize.js`（截图链路缺的节点由它从 `_run.json` 补齐；`best.json` 增 `nodes` 索引）。
- **截图链路的两处诚实降级**：① 没有"同参数重复采样"的稳定性闸 → `stability` 节点记 `skipped` 并写明等价物是 `freeze.verify`；
  ② `criteria[].target` 在截图链路没有落点（锚点来自目标帧实测）→ `intent` 节点记 `degraded`，**不假装生效、也不硬错**。
  另外 `iter.ps1` 的 `ms` 一律 `null`（没逐节点计时，不编 0）。
- **新增 11 条测试（`test/intent.test.mjs`，现在 55 + 12 + 21 + 11 = 99）**：①无 intent 硬错 + 模板；②未确认硬错且列 `confirm[]`；
  ③过闸 + 汇总行 + `01-intent` 是 `done` + **权重/目标真的落到判据上**；④未知 id 硬错且不产出 `best.json`；⑤`--no-intent` 走通且 `skipped` 留痕；
  ⑥台帐一致性（字段/枚举/seq 连续/汇总行计数 == 文件条数）；⑦弄坏能红 ×2（`SELFLOOP_INTENT_MUTANT=alwaysPass` → ① 塌；`dropSkipRecord` → ⑤ 塌）；
  ⑧截图链路的闸（权重进派生 adapter、`criteria[].target` 只记账、未知 id 同样硬错）；⑨`finalize.js` 补齐截图链路台帐；⑩两个入口都接了闸（含 iter.ps1 语法解析）。
- **`test/command.test.mjs` 的 `runCli` 统一加 `--no-intent`**（不是把默认改回放行）：那些用例测的是命令观测/稳定性闸，
  跳过被显式记录下来 —— 台帐里多一条 `skipped intent`，并且 ①/⑬ 等断言照旧。示例 adapter 跑一轮不受硬闸影响。
- **文档**：新增 `skills/selfloop/references/intent-and-ledger.md`（怎么填 intent / 硬闸语义 / `--no-intent` 的代价 / 台帐字段表 / 两个入口各写哪些节点 / 初版已知缺口）；
  `README.md` 用法段加 `--intent` / `--no-intent` 两个开关与"跑之前要先过闸"的三步示例；`SKILL.md` 的产出清单与 references 一览各加一条。
- **硬约束**：不 commit、不 push、`package.json` 的 `version` 仍是 `0.4.2`（清单测试钉着它，bump 留给发布）；`npm test` 全绿。
- **回灌提醒**：`harness/intent.mjs` / `harness/ledger.js` 是包内新增文件（上游原件没有对应物）；`cmdloop.mjs` / `cmdlib.mjs` 同样是包内新增文件；
  `iter.ps1` / `finalize.js` 与上游原件（案例 A）已分叉，回灌时按改动点手动改。

## 0.4.2（未发布）· 真实非图形目标试刀：包体积预算

> 0.4.0/0.4.1 把观测来源放宽到命令、又给它装了稳定性闸，但**到这一版为止，命令链路只跑过一个手算示例**（`command-echo`：两个指标是两个公式，没人会拿它做工程）。
> 这一版拿一个真的、非图形的工程目标去试刀：**把一份语料压到目标体积比例（37%），且必须无损解压**。
> 结论写在 `skills/selfloop/references/command-observe.md` §8：**这套引擎能用**（89.4% 的降幅、确定性、同 seed 可复现），**但整数档位参数上会漏档**（见下）。

- **新增能跑的示例 `examples/command-compress.json` + `examples/command-compress/`**：`probe.mjs` 当场用固定 seed 生成约 256KB 类 JSON 日志（不读外部文件），按 `level / strategy / windowBits / memLevel` 做 `deflateSync` → `inflateSync` → 逐字节比对，打印 `{ratio, roundtrip, ms}`；`base-params.json` 是基线（`6/0/12/8`）。全程只用 node 内置模块，无依赖、无随机、跨平台。
- **判据示范了一种"闸门指标"写法**：`ratio` 权重 0.8（`abs` scale 1）+ `roundtrip` **权重 0**（只给 penalty 用）→ `roundtrip <= 0` 时 `+0.5`。实测有牙：同 ratio 的两行，`roundtrip=1` 是 `d=0.0012`，`roundtrip=0` 是 `d=0.5012`。
- **实测结论（写进文档，不是口号）**：起点 `ratio=0.390232` → 最佳 `0.372145`（目标 0.37），`drop=89.4%`，`used=28/60`，2.5s，单次评估 85~91ms，同 seed 两次 `best.json` hash 一致，稳定性闸 spread=0。
  四个参数里 **`strategy` 是假轴**（零基参数走绝对步长 0.05，`round(0.05)=0`，+10% 一档永远回原地 → 活性预检 Δd=0 判 dead；可它物理上是最大的单根杠杆：`strategy=2` 把 ratio 从 0.390 拉到 0.619）；`memLevel` 是弱轴（Δd 0.00088，约 1/18 于 `windowBits`）；`windowBits` 是主轴（Δd 0.0158）。
- **暴露了相对步长遇上离散参数的边界**：`curve.csv` 里 `windowBits` 的取值只有 `12 / 13.2 / 14.52 / 11.88`，四舍五入后是 `12 / 13 / 15 / 12` —— **14 这一档整轮没被评估过**，而 14 恰好是这份语料的最优（`(9,0,14,8)` 的 ratio 0.369890，离目标只剩 0.00011）。所以最后 0.21 个点没贴住，是**数字档位和 10% 步长不共格**，不是观测做不到。文档 §8.2 写清了怎么消掉（参数改成档位索引，或用 `--step-ratio` 对齐）。
- **反证（目标够不到）**：把目标改成 0.05（语料熵地板 0.3696），它不崩、不硬错，收敛到 `0.372145`（与 0.37 那轮同一个局部最小），`bestDist=0.322` 白纸黑字写在证据包里 —— 不会给你"已命中"的假象。
- **新增 3 条测试（`test/command.test.mjs`，现在 55 + 12 + 21）**：⑬ 压缩示例跑一轮 `drop > 30%`（实测 89.4%，门槛没虚高）+ 每一轮 `roundtrip` 必须是 1 + penalty 一次没触发；⑭ 同 seed 两次 `best.json` hash 一致（轨迹逐点一致）；⑮ **弄坏能红**：把目标改成"起点参数就命中"的值 → 起点距离 0、降幅 `null`，⑬ 的降幅断言必红（照 ⑨/⑫ 的惯例单独成条）。
- **文档**：`skills/selfloop/references/command-observe.md` 新增 §8「真实非图形示例：压缩体积预算」（场景三行 / 判据表 / 假轴实测表 / 两个真实陷阱 / 反证）与 §9「这个示例不能证明什么」；`README.md` 的 examples 表与目录清单各加一行。
- **硬约束**：`harness/iter.ps1` 一个字节没动；`harness/cmdloop.mjs` / `cmdlib.mjs` / `score.js` 都没改（这一版只加示例、测试与文档）；`package.json` 的版本号留给发布时 bump（改动时它还是 0.4.1，清单测试钉着它）。

## 0.4.1（未发布）· 观测稳定性闸：命令链路补上最大的一处没有检查的环节

> 0.4.0 把观测来源放宽到"一条命令的 stdout"，但**一张闸都没装**。截图链路一直有 `freeze.verify=strict`（同 URL 连拍两张逐字节比，比不过就报错）；命令链路什么都没有。
> 后果不是"偶尔难看"，而是**假最优**：命令一旦有随机性（时间戳 / 并发 / 浮点不确定性 / 真实接口抖动），搜索会学会在噪声里挑"看起来更好"的点，而证据包长得跟真的一样 —— 曲线在降、hash 也对。

- **adapter 新增 `observe.stability`**：`{ "repeat": 3, "maxSpread": 0.02 }`。**不写也生效**（默认值就该是安全的那一档）。语义写死：**起点已评估、活性预检之前、花预算的搜索之前**，用起点参数把命令连跑 `repeat` 次，对每条指标算 `spread = (max - min) / max(|mean|, 1e-9)`；任一 `spread > maxSpread` → **中文硬错**（点名指标 / spread 值 / 阈值 / `repeat` 次原始值），**不静默降级、不自动取平均**。`repeat: 1` 是唯一的"关掉"姿势，且必须打一条中文 warn（`本次不验证观测稳定性…收敛结果不可信`）；`repeat < 1` 或非整数、`maxSpread ∉ (0,1]` 一律中文硬错（不给"0 = 关掉"这种含糊状态）。
- **成本记账诚实**：起点那一次算第 1 次采样，于是默认只多花 `repeat-1 = 2` 次评估，且**记进预算**（`evaluations.stability` 计数，原始输出照样落 `outputs/`）；预算不够时硬错并给出两条出路（提高 `--budget` / 显式 `repeat: 1`），**绝不"这次就不验了"**。
- **证据包**：`best.json` 增 `stability: {repeat, maxSpread, ok, spreads, values, checked, spend}`；`report.md` 增"观测稳定性闸（搜索前必过）"一节（逐次采样 × 指标的小表 + 一句结论），摘要表与评估次数行也带上闸的结论与花费。指纹里只放闸的**配置**（`repeat`/`maxSpread`/`checked`），**不放采样数值** —— 换阈值该换 hash，同 seed 同参数的重跑仍必须同 hash。
- **`core/adapter.js` / `lib/index.js`**：`parseAdapter` 解析 `observe.stability`（默认值补齐、非法值只 warning"cmdloop.mjs 会硬错"，保持"体检口不执行"的分工）；probe 的 `observe` 块新增 `stability.{repeat,maxSpread}`（**新键进 `required`**），渲染文本对命令观测多打一行"稳定性：repeat=N · maxSpread=…"。截图链路恒为 `0/0`（那套的等价物是 `freeze.verify`）。
- **新增 7 条测试（`test/command.test.mjs`，现在 55 + 12 + 18）**：⑪-1 稳定命令 + 不写 stability → 默认生效、过闸、`best.stability.ok === true`、report 有表、`evaluations.stability === 2`；⑪-2 不稳定命令（确定性 ±5% 抖动的 demo 脚本）→ 硬错且点名指标/spread/阈值/原始值、且不产出 `best.json`；⑪-3 `repeat: 1` → 有 warn + `checked:false`（report 写"未验证"）；⑪-4 非法配置三连（`repeat:0` / `maxSpread:0` / `maxSpread:1.5`）各自中文硬错；⑪-5 预算不够跑闸 → 硬错；⑫-1/⑫-2 两条**弄坏能红**（`CMDLOOP_MUTANT=stableAlways` 判定恒真 → ⑪-2 的硬错断言必塌；`CMDLOOP_MUTANT=noStability` 整段删掉 → ⑪-1 的 stability 字段断言必塌）。
- **`test/command.test.mjs` ⑩ 的预算 1 → 4（不是放宽）**：闸要 2 次额外评估，`--budget 1` 连起点都只能跑一次，那条用例测的是"取数方式"而不是预算边界；预算不够的表现由新增的 ⑪-5 单独钉住。
- **文档**：`skills/selfloop/references/command-observe.md` 新增 §6「稳定性闸」（为什么 / 默认值 / 跑在哪花多少 / 判定口径与硬错原文 / 证据包长什么样 / **怎么造一个确定性抖动 demo 自测** / 这道闸不管什么），原 §6 常见坑顺延为 §7 并补两行；`harness/适配层-说明.md` §6.2 字段表与 §6.3 硬错表补 `stability`，§6.4/§6.5 补证据包与预算提示。
- **硬约束**：`harness/iter.ps1` 一个字节没动；截图链路行为不变；`--strategy random` 的随机源、判据 `score.js` 也都没动。
- **回灌提醒**：改的是 `harness/cmdloop.mjs` / `harness/cmdlib.mjs` / `core/adapter.js` / `lib/index.js` —— 前两者是包内新增文件（上游原件没有对应物），后两者与上游原件（案例 A）已分叉，回灌时按改动点手动改。

## 0.4.0（未发布）· 观测来源可以是一条命令的输出

> 前三版证明的是「渲染类目标可调」。这一版补的是**「任何可测目标可调」里最难的那半步**：观测不必是截图。
> 新增入口 `harness/cmdloop.mjs`（纯 node、跨平台）跑「改参数 → 跑一条命令 → 从 stdout 取数 → 算判据 → 搜索 → 证据包」；
> `harness/iter.ps1` 的浏览器闭环**一行没动**（动它要重验进程卫生与冻帧自检，不划算，所以做成并列入口而不是分支）。

- **新增 `harness/cmdloop.mjs` + `harness/cmdlib.mjs`**：命令观测执行器。`cmdlib.mjs` 管"观测这一侧"（`observe` 解析、跑命令、取数、写参数文件），`cmdloop.mjs` 管"搜索 + 证据包"。只用 node 内置模块，Windows/macOS/Linux 都能跑。
- **adapter 新增 `observe` 节**（缺省 = 老行为，旧 adapter 一个字不用改）：
  `type: command` + `cmd`（`{params}` 占位、相对路径按 adapter 目录展开、**不走 shell**）+ `cwd` + `timeoutMs` + `parse`（`json` / `number` / `line:k=v`）+ `metrics[{id, field, weight, norm}]`。
  `config` 沿用 `flat-params` 语义但**只读**：每次评估把候选值写成 `<run>/params/eNNN.json`，路径通过 `{params}` 占位或环境变量 `SELFLOOP_PARAMS` 交给命令（文档里写死只认这一种）；**绝不写 adapter / clientRoot**。
  新目标模式 `target.mode=metrics`：直接给目标数值，不跑命令（命令链路才有意义）。
- **判据一行代码没另写**：`cmdlib.mjs` 直接 `require` 同一份 `harness/score.js`（`plan` / `dist` / `planText`），所以 `norm`（range/pctrel/abs/identity + clamp）、权重、`penalty` 的 `when` 极小解析器、直方图环形 L1 在两条链路里语义逐条一致。
- **搜索策略是"复制语义"而不是"复用代码"**：`iter.ps1` 是 PowerShell 且绑着静态服/浏览器/截图，为了共用去动它 = 拿跑通的产品资产换抽象。所以 `cmdloop.mjs` 自己实现坐标下降，但**逐条照抄** `iter.ps1` 的口径：`Get-Step`（±10%，零基参数走绝对步长 0.05）/ `New-Vector`（六位小数）/ `Key-Of`（白名单顺序 + 六位小数字符串，缓存命中不算评估）/ 预算闸 / 活性预检（+1 步，`Δd<=1e-9` 记 dead，全 dead 直接停）/ 每轮候选 `none + 每轴±1` / `pick < best-1e-9` 才算改进 / 连续 `maxStagnant` 轮不改进就停。差别的**唯一**一处：`random` 策略的随机源（`.NET Random` vs mulberry32），所以同 seed 的 random 轨迹**不跨执行器可比**，`coordinate`（默认）两边一致。
- **失败要响（四类全硬错）**：命令超时（`命令超时（>Nms）`）/ 非零退出（带 `exit=` 与 stderr 前 200 字）/ 输出解析不出来（带前 200 字原文）/ 指标缺失（点名哪个字段）。**绝不当 0 静默通过**；硬错时也不留一份"看起来跑完了"的证据包。
- **证据包与截图链路同构**：`curve.csv` / `best.json` / `report.md` 字段命名沿用（`round` / `eval_seq` / 参数列 / `dist` / `pen` / `m:<指标>` / `nd:<指标>`），末尾那列从 `png` 换成 `output`；额外 `outputs/`（每次评估的原始命令输出，**单份截断 4KB**）与 `params/`（每次评估交给命令的参数文件）。`best.json.hash` 口径照抄 `finalize.js`：只放决定"搜到哪"的东西，不放时间/路径/原始输出 → 换 `--out` 目录同 seed 重跑，hash 必须一致。
- **`core/adapter.js` 解析 `observe` 节**（可选）：命令 adapter 的必填项换成 `name`/`config`/`observe`/`target`/`params`，并且**不再**对 `clientRoot`/`page`/`freeze`/`render`/`server`/浏览器候选/静态服/`metrics2.js` 逐条报"缺"（它们描述的是截图链路，报了只是噪音）；`config.format` 只认 `flat-params`。
- **`lib/index.js` 的 probe 说得出 `observe`**：新增 `observe` 输出块（`type` / `cmdRaw` / `cmd` / `cwd` / `timeoutMs` / `parse` / `metricsCount` / `metrics`），`target` 增加 `metrics` 字段，**新键全部进 `required`**；命令 adapter 的 `note` 改指向 `cmdloop.mjs`（不再是"harness 是 Windows 专用"那句），渲染文本对命令观测**不再打印视口/端口/冻帧**这些不存在的字段。
- **新增能跑的示例**：`examples/command-echo.json` + `examples/command-demo/`（`probe.mjs` 读参数、按 `loss=|α-1|+0.5|β-1|`、`size=20+5α+3β` 算两个指标并打印 JSON，**无随机**；`base-params.json` 是基线参数）。其中一个参数 `ghost` 是**故意无效**的：它让 stdout 变、但两个指标一动不动 → 活性扫描判 dead（证据包里 `Δd=0 / 输出同=否 / dead`，比"像素同"更严的那条口径）。
- **新增 `test/command.test.mjs`（11 条，接进 `npm test`，现在 55 + 12 + 11）**：① 一轮收敛（drop > 50%）+ 证据包齐全（含 `outputs/` 每份 ≤4KB）；② 无效参数判 dead 且不进搜索轴；③ 超时硬错；④ 非零退出硬错；⑤ 输出解析失败硬错（json 与 number 两种）；⑥ 指标缺失硬错；⑦ 同 seed 换 `--out` 目录 `best.json` hash 一致（且轨迹逐点一致）；⑧ core/probe 层说得清 `observe` 且输出过 schema；⑨ 两条**弄坏能红**（`CMDLOOP_MUTANT=flatZero` 时 ① 的收敛断言必须塌、`=noTimeout` 时 ③ 的硬错断言必须塌，两条都写成可复跑的用例）。
- **文档**：新增 `skills/selfloop/references/command-observe.md`（怎么给非图形目标写 adapter、三行示例、字段表、四条"参数怎么交给命令"的写死约定、活性扫描口径、**哪些是复用哪些是复制**、常见坑 + "命令必须确定性"那条纪律）；`harness/适配层-说明.md` 加第六节 `observe`（双执行器对照、字段表、四类硬错、证据包、实例）；`README.md` 顶部定位段补"观测可以是命令输出"、三个概念表与 `harness/` 逐件表补 `cmdloop.mjs` / `cmdlib.mjs`、新增"命令观测"用法段。
- **`test/plugin.test.mjs` 的一处收窄（不是放宽）**：`包内没有本机绝对路径` 那条原来只跳过 `node_modules`/`.git`，于是**谁在仓库里跑过一轮闭环**（证据包默认落 `runs/`，`.gitignore` 里本来就排除了）就会假红——它该管的是随包分发的源码/配置，不是 run 产物。现在把 `runs`/`prof_*` 一起跳过。
- **回灌提醒**：`harness/cmdloop.mjs` / `cmdlib.mjs` 是**新增**文件，上游原件（案例 A）里没有对应物，不需要回灌；`iter.ps1` 本轮零改动。

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


