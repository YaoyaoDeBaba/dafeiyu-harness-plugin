# 需求转译闸（intent）与节点台帐（ledger）

> 两件东西解决的是同一个病：**这套引擎原来只有中段**。
> 需求转译、调研参考这两段根本没有节点，直接从中段（活性扫描 → 搜索）开始 —— 所以它"虚"不是缺界面，
> 是头两段不存在；而"被绕过"一直在发生（缺回读、参数判 dead、缓存命中、`repeat=1` 关掉稳定性闸），
> 只是散在日志里，没有一处汇总，于是"被绕过"这件事连名字都没有。
>
> 0.5.0 做的是：**跑之前必须有一份经过确认的需求转译**（否则拒跑）、**每一步都落一条能机器读的台帐**。
> 0.5.1 做的是：把 intent 从 v1 升到 **v2**，补上 **锚 / 反例 / 自由度 / 验收方式** 四样（见 §1.5）。
> 调研（research）插槽还没做，见 §7 已知缺口。

---

## 1. 需求转译（intent）怎么填

**放哪**：

| 链路 | 默认位置 | 能不能指别处 |
|---|---|---|
| 命令（`harness/cmdloop.mjs`） | `<out>/intent.json` | `--intent <file>` |
| 截图（`harness/iter.ps1`） | `<Out>\intent.json` | `-Intent <file>` |

### 1.1 v2 结构（照抄下面这份，改内容）

```json
{
  "version": 2,
  "restate": "火柱要更粗更硬，但别变成一根直线光",
  "anchors": [
    { "kind": "image", "ref": "refs/ref-a.png", "why": "同类高评分火焰特效" },
    { "kind": "text",  "ref": "崩坏：星穹铁道（具体游戏名，不是抽象风格）", "why": "配色与勾线参照" }
  ],
  "criteria": [
    { "id": "cov", "weight": 0.6, "target": 0.02, "anchor": "anchors[0]：参考图里的亮核占比", "why": "你说的'更粗'" },
    { "id": "lapVar", "weight": 0.2, "anchor": "anchors[1]：参考游戏里的边缘锐利度", "why": "细节次要" }
  ],
  "notWanted": ["不要写实/PBR 连续渐变", "不要像素噪点式的硬过渡"],
  "freeVsFixed": {
    "fixed": ["命中点的位置", "整体配色链（白芯→黄→橙→暗红）"],
    "free":  ["光束长度", "弯曲与摆动幅度", "火星密度"]
  },
  "howWeVerify": { "human": true, "metrics": true, "note": "指标过闸 + 人眼确认一次" },
  "uncertain": ["'更硬'是指边缘锐利还是对比度更高？"],
  "confirm": ["粗细优先还是亮度优先？"],
  "confirmed": true,
  "confirmedBy": "user",
  "confirmedAt": "2026-11-14T10:46:00+08:00"
}
```

### 1.2 v2 字段表

| 字段 | 是什么 | 硬要求 |
|---|---|---|
| `version` | intent 版本；**没有这个字段 = v1** | v2 写 `2`。不写 → 按 v1 跑、打 warn、台帐记 `degraded` |
| `restate` | 一句话复述"你要什么"（≤200 字，得让人**三秒判对错**） | v2 **必填非空**；空/超长 = 硬错。v1 的 `understood` 仍认、空着只提醒 |
| `anchors[]` | 具体参照物。`kind:"image"` = 参考图/帧；`kind:"text"` = 具体游戏名 / 前作 / 一句话观感 | v2 **至少 1 条**；`kind` 只认 image/text；`ref` 非空；**`kind:"image"` 的 ref 必须真实存在**（相对 intent 文件所在目录或绝对路径） |
| `anchors[].why` | 这条锚在给什么做参照 | 建议写；进台帐与报告 |
| `criteria[]` | 要对哪些指标下手：`{id, weight, target, anchor, why}` | **≤5 条**（超了硬错："轻合规"）；`id` 必须是 adapter 里真实存在的指标 id（写错硬错，绝不静默忽略） |
| `criteria[].anchor` | 这条判据指向参照物的哪个部位/哪个数 | v2 **每条必填**；写 `anchors[0]` 这种会校验下标（越界 = 硬错）；也可以是一句具体参照 |
| `notWanted[]` | 明确**不要**什么 | 可以是空数组；**字段缺失 = 降级** |
| `freeVsFixed.fixed` | 哪些必须对（定死项） | 同上：可以是空数组，整个字段缺失 = 降级 |
| `freeVsFixed.free` | 哪些可以自由（别锁死） | 同上 |
| `howWeVerify` | 怎么算过：`{human:bool, metrics:bool, note}` | 两个 `false` 是硬错；字段缺失只 warn（"谁点头算过"没写进契约） |
| `uncertain[]` | 还没说清的地方 | 数组 |
| `confirm[]` | 要用户拍板的问题 | **≤3 条**（超了硬错）；`confirmed:true` 时仍有未答的 → 允许通过，warn"还有 N 条待确认问题没答，已按当前判据开跑" |
| `confirmed` | 用户点头了没有 | 必须是 `true`，否则拒跑 |
| `confirmedBy` / `confirmedAt` | 谁、什么时候确认的 | 进台帐（`confirmedBy @ confirmedAt`） |

### 1.3 一条填好的小例子（命令链路、`examples/command-echo.json` 的指标）

```json
{
  "version": 2,
  "restate": "把包体积从 12 压回 10，同时别把 loss 推到 0（那是压过头）",
  "anchors": [
    { "kind": "image", "ref": "refs/ref-a.png", "why": "同类高评分的压缩曲线图" }
  ],
  "criteria": [
    { "id": "size", "weight": 2, "target": 10, "anchor": "anchors[0]：参考图里的体积刻度", "why": "体积是你说的重点" },
    { "id": "loss", "weight": 1, "anchor": "anchors[0]：参考图里的画质下限", "why": "别归零" }
  ],
  "notWanted": ["不要为了压体积把 loss 推到 0"],
  "freeVsFixed": { "fixed": ["体积上限 10"], "free": ["用哪条压缩通道压"] },
  "howWeVerify": { "human": true, "metrics": true, "note": "指标过闸后看一眼" },
  "confirm": [],
  "confirmed": true,
  "confirmedBy": "user",
  "confirmedAt": "2026-11-14T10:46:00+08:00"
}
```

过闸之后 `report.md` 顶部会长出这一段（`restate` 一行 + 锚几条 + 谁验收 + 是否 v1 degraded）：

```
**需求转译（intent v2 · done）**

- **复述**：把包体积从 12 压回 10，同时别把 loss 推到 0（那是压过头）
- **锚**：1 条（image 1 / text 0） —— `refs/ref-a.png`
- **反例**：1 条：不要为了压体积把 loss 推到 0
- **自由度**：定死 1 条 / 自由 1 条；定死：体积上限 10；自由：用哪条压缩通道压
- **验收**：人眼 + 指标（两者都要）；指标过闸后看一眼
- **确认**：`confirmed=true`（user @ 2026-11-14T10:46:00+08:00）
```

同样的内容也落成机器可读的 `<out>/intent.summary.json`（台帐 `01-intent.json` 的 `artifacts` 指向它）。

### 1.4 v1 仍然能跑，但记 `degraded`

v1 = 没有 `version`、`criteria` 没有 `anchor` 的写法。它**照样能跑**（向后兼容），但：

- 打一条中文 warn：`这是 v1 intent（没有锚/反例/自由度），等于把审美全交给指标——建议升级到 v2`；
- 台帐 `01-intent.json` 的 `status` 记 **`degraded`**（不是 `done`），`reason` 写明缺什么；
- `report.md` 顶部标 `**需求转译（intent v1 · degraded）**`。

升级只需要三件事：加 `version:2`、加 `restate`（把 `understood` 挪过来）、给每条 `criteria` 补 `anchor` 与一条 `anchors`。

### 1.5 为什么要这四样（它们不是装饰）

三份真实实验复盘的结论是「**提示词写法是第一杠杆，模型只抬上限不抬下限**」，而最大的坑是
**「指标替代审美」**：每轮都在追可数指标，单步都有"改进证据"，累积却把观感磨平。
只有"指标 + 权重 + 目标"的 intent 等于把这个坑**制度化** —— 所以 v2 补的四样全部来自那轮实验的实证：

| 补的东西 | 实证 | 不写会怎样 |
|---|---|---|
| **锚**（`anchors`） | "照着这张图调"比"要 3A 次世代"可执行得多；锚是唯一能把"像不像"钉住的参照物 | 只剩指标：它会把画面推向指标极值（更粗→糊成一片、更亮→烧白） |
| **反例**（`notWanted`） | 写"拒绝写实/PBR 连续渐变"比只写"要二次元"有效得多 | 搜索不知道边界，会往"指标最好看"的方向漂，正是要避免的那一侧 |
| **自由度 vs 定死项**（`freeVsFixed`） | 需求书把形态全锁成"严格直线"，锁出了僵直激光 | 该自由的地方定死 = 把搜索的手绑住，只能在一根线上做微小妥协 |
| **验收方式**（`howWeVerify`） | "谁来点头"不写进契约，指标过闸就被当成"成了" | 没人负责最后那一眼；指标更好看、人眼更难看，且没人有权说"不算" |

**一个纪律**：这四样**不参与距离计算**（`intent.summary.json` 里 `participatesInDistance: false`）。
锚一旦进距离就又变成指标 —— 那就绕回原点了。它们只做**记录与呈现**：写进台帐、写进 `report.md` 顶部。

### 1.6 v2 的硬上限（为什么是 5 条判据 / 3 条 confirm）

`criteria ≤ 5`、`confirm ≤ 3` 是"**轻合规**：写越厚，花在做到上的预算越少"。
判据越多，每条分到的搜索预算越薄；confirm 越多，越可能一条都答不上来。次要诉求写进
`anchors` / `notWanted` / `freeVsFixed`，别都塞进距离里。


**不同链路怎么知道有哪些 id**：`node harness/intent.mjs gate` 的报错和模板里都会列出来；
也可以看 `adapter.metrics[].id`（截图链路）或 `adapter.observe.metrics[].id`（命令链路）。
最省事的办法：**先不带 intent 跑一次** —— 引擎会写出 `intent.template.json`，模板的 `_说明` 里就写着这份 adapter 的指标 id。

**确认这一步不能省**：`confirmed: true` 是"用户看过并点头"，不是"agent 觉得自己懂了"。
引擎只认这一个布尔值 —— 它不判断你的转译写得好不好，只保证"没被点头的转译不会开跑"。

### 1.7 硬不变量（0.7.0）：不合格直接判废，不进距离

**为什么要有这一层（一句话）**：引擎原来只有"距离"一层，penalty 也是加进同一个 `d` 里 ——
**等于允许搜索拿底线换分数**。

- 压缩到 37% 是**指标**；解压后逐字节相等、不越界是**不变量**。
- 接口 p95 延迟是**指标**；HTTP 200 + schema 合法是**不变量**。

**指标负责"像不像"，不变量负责"是不是"。** 不追求"更接近"，只判"合格/不合格"。

#### 文法（核心只实现这些，别发明 DSL）

```json
"invariants": [
  { "id": "roundtrip", "check": { "field": "roundtrip", "op": "==", "value": 1 },
    "why": "解压回不去就是废方案，分数再高也不要" },
  { "id": "no_overexpose", "check": { "all": [ { "field": "cov", "op": "<=", "value": 0.05 } ] },
    "why": "超过这个亮核面积就是过曝" },
  { "id": "in_band", "check": { "any": [ { "field": "loss", "op": "<=", "value": 0.45 },
                                         { "field": "loss", "op": ">=", "value": 1.05 } ] },
    "why": "中间那段是死区：更近但不合格" },
  { "id": "not_broken", "check": { "not": { "field": "broken", "op": "==", "value": 1 } },
    "why": "broken=1 说明命令自己报坏了" }
]
```

| 部分 | 形状 | 说明 |
|---|---|---|
| `id` | 非空字符串，**唯一** | 拒绝与硬错都靠它点名；重复 = 硬错 |
| `check` | 见下 | 必填 |
| `why` | 非空字符串 | **必填**：不写为什么，将来没人敢删（也不会有人敢信） |
| 比较 | `{ field, op, value }` | `op` 只认 `== != < <= > >=`；`value` 必须是数字 |
| 组合 | `{ all:[check…] }` / `{ any:[check…] }` / `{ not:check }` | `all`/`any` 至少 1 条（空组合 = 恒真/恒假的假门 = 硬错） |
| `field` | 指标 id，或命令输出 JSON 里的字段 | 指标 id 优先；输出字段允许 `a.b` 点路径（`observe.parse=json` / `line:k=v` 的字段表） |

> 组合是**短路求值**（`all` 遇到第一条 false 就停、`any` 遇到第一条 true 就停）：被短路跳过的分支里如果写了
> 不存在的字段，那一条不会被摸到，也就不会硬错。这是短路的正常语义，不是"静默判过"；要严格就把关键字段
> 放在会先被求值的位置，或干脆写成 `all`。

#### 行为（关键语义）

1. **候选级门禁**：每次评估拿到观测后先过所有 invariants；任一 fail → 该候选**判废**：
   不进距离比较、不能成为 best、也不会被缓存成"更优"。
2. **目标与起点也要过**：目标/起点本身违规 → **硬错**（判据/目标自相矛盾，比如"必须无损"但目标参数本身就坏）。
3. **取不到就是硬错**：`field` 在观测里不存在、或取到的不是数字 → 运行时硬错，**不许静默判过**。
   文法不认识（`op:"~="`、空 `all`、重复 id、缺 `why`）同理 —— 写错的不变量等于没装门，必须在开跑前说清。
4. **没写 = 不拦，但要吭声**：intent 里没有 `invariants`（或写 `[]`）→ 维持现状，但默认 warn
   `没写硬不变量：搜索会拿底线换分数`；不想看这条提醒用 `--no-invariants-warn` 关掉终端 warn
   （报告里仍然如实写"门禁没装"—— warn 开关不改事实）。
5. **截图链路（`iter.ps1`）暂不支持**：它的观测是页面指标、判定在 PowerShell 里，没有测试守着 PS 侧实现。
   写了 invariants 会**硬错**（fail-closed）—— 宁可拒跑，也不假装装了门禁。

#### 和 metrics 的区别（一句话对照）

| | metrics（指标） | invariants（不变量） |
|---|---|---|
| 回答的问题 | "离目标有多近？" | "这个候选合格吗？" |
| 数值形态 | 连续、可归一、可比大小 | 布尔：过 / 不过 |
| 参与搜索的方式 | 算进 `d`，参与排序 | **不进 `d`**：不过就直接出局 |
| 写错了会怎样 | 权重/目标写歪 → 调不到你想要的样子 | 文法错 = 硬错；写对了但没人看见 = 门禁没牙（见 §7） |
| 典型例子 | 压缩率 37%、p95 延迟、亮核面积 | 解压逐字节相等、HTTP 200 + schema 合法、不越界 |

#### 证据包里怎么看

- `report.md` 多一节 **「硬不变量」**：每条 id + 判据 + 通过/拒绝次数 + **本次**（`⚠ 本次未拦任何候选`）+ 最近一次拒绝的原始观测片段；
- `best.json` 多一块 `invariants: { declared, rejected, items:[…], fakeGate, nearThreshold, gateBlock }`；
- `curve.csv` 多一列 `inv`（1 = 过门禁，0 = 被判废）；
- 台帐 `nodes/05-search.json` 的 `decision.basis` 有一句 **"门禁拒绝 N 个候选"**；预检点被拒单列 `rejected`
  （不算活轴、也不算 `dead` —— 轴可能是好的，只是这一点不合格）。

**验收门禁有没有牙**：光看"rejected 次数 > 0"不够。真要看它在干活，得让 **best 停在门禁外面**，
并且**被拒候选的距离比 best 更小** —— 那才证明它挡掉的是"拿底线换来的分数"。`test/invariants.test.mjs`
③ 就是这么钉的，⑦⑧ 用变异体证明这两条断言真的会红。

#### 0.8.0：门禁自己的三种病（跑完一定会说，不会悄悄过去）

门禁写歪了比没装门更坏：它让人**以为**底线被守住了。0.8.0 起三种病各有判据与出口：

| 病 | 判据 | 出口 |
|---|---|---|
| **假门**（写宽了，永远为真） | 某条 `rejected == 0` 且本次评估 ≥ 10 次 | 终端 `[invariants][warn] 硬不变量 <id> 本次一次都没拦住候选（评估 N 次…）——门可能是写宽的…`；`report.md` 那一行的「本次」列标 `⚠ 本次未拦任何候选` + 一段「假门告警」。`--no-fake-gate-warn` **只关终端**，报告照写 |
| **写死了**（把搜索全挡了） | 连续 3 轮**没有任何新候选**过门（或某一轮 0 个候选能过门） | 早停，`stop=invariant-blocked`（不是 `stagnant`，也不是 `all-dead`/`no-alive-after-precheck`）；提示里点名"是门禁挡住了搜索，不是参数死了" + 被拒最多的 id 与最近一次观测 |
| **贴阈值**（这次过、下次翻脸） | 目标观测通过，但离阈值 < 1%（小数）或 < 1e-6（整数对整数） | 终端 `[invariants][warn] 目标离不变量 <id> 的阈值很近（观测 x / 阈值 y）——判据下一版微调就可能翻脸`；`report.md` 的「目标贴阈值」段 |

三条的口径细节：

- **假门为什么要 ≥10 次**：3 次评估没拦住什么都说明不了（可能只是没扫到那片区域）。10 次是个不狼来了的门槛。
- **"新候选"不含 `none`**：每轮第一个候选是当前最优（它当初就过过门），把它算进去就永远"至少有一个过了"。
  判据是「这一轮除了当前最优，**没有任何候选**过门」。
- **`stagnant` 与 `invariant-blocked` 的区别**：前者是"参数空间里找不到更好的"，后者是"更好的点全被门禁判废"。
  两者都跑不动，但修法完全相反：前者换策略 / 放宽步长，后者先看清那条不变量是不是写错了。
- **`all-dead` / `no-alive-after-precheck` 是第三种**：那是**预检阶段**每根轴改一档、距离一点不动（轴死了），
  连搜索都没开跑 —— 提示里会明说，别跟门禁挡路混在一起。
- **`not` 与 `==` / `!=` 不参与贴阈值判定**：`==` 的"通过"天然就贴在那个值上，报了等于每轮都报。

**事后改了判据怎么办**：门禁只在当下判，旧 run 的 `best` 是不是还合格要用
`node harness/audit.mjs` 复算（见 §8）。

---

## 2. 硬闸语义（全部中文硬错 + 非零退出）

| 情况 | 引擎的反应 |
|---|---|
| 没有 intent 文件 | 硬错，并写出 `<out>/intent.template.json`；错误里说清三件事：填什么 / 填完怎么确认 / 显式跳过的开关是什么 |
| 有文件但 `confirmed !== true` | 硬错，把 `confirm[]` 里待确认的问题**原样逐条列出** |
| `confirmed === true` | 通过；`criteria` 按 id 覆盖判据（权重 / 目标值），覆盖了哪几条写进台帐 |
| `criteria` 里有 adapter 不存在的 id | 硬错，点名写错的 id + 列出真实的指标 id（**绝不静默忽略**） |
| `--no-intent` / `-NoIntent` | 放行，但台帐里必须有一条 `intent` = `skipped`，reason 写"显式 --no-intent 跳过需求转译" |

v2 新增的六条硬错：

| 情况 | 引擎的反应 |
|---|---|
| `restate` 空 / 只有空白 / >200 字 | 硬错："v2 必须有一句话复述（≤200 字）……复述是'三秒判对错'的那一行" |
| `anchors` 缺失 / 空数组 / `kind` 不合法 / `ref` 空 | 硬错："锚不住东西的锚等于空话" |
| `anchors[i].kind="image"` 的 `ref` 解析后**不存在** | 硬错，点名 ref、给出解析出的绝对路径，并说明"图不在，只剩指标" |
| `criteria` > 5 条 | 硬错，错误信息含**"轻合规：写越厚，花在做到上的预算越少"** |
| `confirm` > 3 条 | 硬错，点名"有 4 条 > 上限 3 条" |
| `criteria[].anchor` 缺失 / 指向不存在的 `anchors[i]`（下标越界） | 硬错："悬空的锚等于没锚" |

**0.7.0 新增的硬错（硬不变量，细节见 §1.7）**：

| 情况 | 引擎的反应 |
|---|---|
| `invariants` 文法不认识（`op` 不在 `== != < <= > >=` 里 / 空 `all`/`any` / 缺 `why` / 重复 `id` / 多写字段） | 硬错，错误信息列出支持的 op 与 check 形状，并点回 `intent.invariants[i].check…` |
| `check.field` 在观测里取不到 / 取到非数字 | **运行时硬错**（不静默判过），列出观测里有的字段名，并附 `id=…` |
| 目标 / 起点本身违反不变量 | 硬错，点名 id + why + 观测值 + "判据/目标自相矛盾" |
| 截图链路写了 `invariants` | 硬错（fail-closed）："截图链路不支持硬不变量"，绝不静默忽略 |

**警告（不是硬错）**：`notWanted` / `freeVsFixed` 字段缺失 → warn + 台帐 `degraded`；
`howWeVerify` 缺失 → warn（"谁点头算过"没写进契约）；
`confirm` 非空但已 `confirmed:true` → 允许通过，warn"还有 N 条待确认问题没答，已按当前判据开跑"。

**位置**：intent 是所有评估之前的**第 01 个节点**（比目标帧渲染、比活性预检、比稳定性闸都早），
因为它会改判据 —— 判据改了，后面每一次"距离"的含义才成立。闸被拦下时，台帐里会留一条 `intent` = `failed`，
所以"这次跑到哪一步断的"在 run 目录里查得到，不是只在终端最后几行。

**它不做的事**（重要，别指望它）：

- 不判断你的 `restate` / `understood` 写得对不对 —— 那需要人；
- 不自动填 intent（引擎保持纯确定性，不确定的那层关在 agent 里）；
- 不因为 criteria 为空就拒跑（复述本身也算消化了一半，只会在台帐里提醒）；
- 不改 `extract` / `norm` —— 换归一化不只是"更看重它"，是换了一把尺，那要改 adapter；
- **不因为写了锚就改变搜索**：锚目前只进台帐与报告，**不进距离、不进搜索建议**（见 §7 已知缺口第一条）。

---

## 3. 两条链路的实现差别

同一套闸（`harness/intent.mjs`），两个入口都是**转发**它，不各写一份：

### 3.1 命令链路（`cmdloop.mjs`，进程内）

- 权重覆盖：直接改运行期 plan，然后**重新 `score.plan()`**（不重算等于没改）；
- 目标覆盖：拿到目标行（`trow`）之后、算起点距离之前覆盖 —— 所以起点距离用的就是覆盖后的目标；
- 指纹：`metricsCfg`（含权重）与 `target`（实际生效值）都进 hash，改了判据 hash 必变。

### 3.2 截图链路（`iter.ps1`，转 `node intent.mjs gate`）

- 权重覆盖：产出一份**派生 adapter** `<Out>\intent\adapter.effective.json`（只改 `metrics[].weight`），
  之后 `metrics2.js` / `score.js` 都读它；
- 相对路径不受影响：`$adapterDir` 仍取**原始** adapter 目录（`target.path` 这些相对路径是相对它的）；
- 复现命令里的 `-Adapter` 写原始 adapter，并带上 `-Intent` / `-NoIntent`（派生件是本次的临时产物）。
- **硬不变量（0.7.0）不在这一侧实现**：截图链路的观测是页面指标、判定在 PowerShell 里，没有测试守着
  PS 侧实现，所以 `intent.invariants` 非空会**硬错**（fail-closed），见 §1.7 第 5 条。

### 3.3 `criteria[].target` 在截图链路**不生效**

截图链路的目标锚点是**目标帧实测出来的**（`<Out>\shots\target.png` 量出来的指标），不在 adapter 配置里，
所以没有"改目标值"的落点。引擎的处理是**降级记账**：台帐 `01-intent.json` 记 `status: "degraded"`，
reason 写"criteria[].target 在截图链路不生效……已记账，未参与距离"。
**不假装生效，也不硬错**（否则"更粗 0.02"这种很合理的诉求在截图链路上会变成一个没法过的闸）。

### 3.4 v1 字符串写法的指标不能覆盖权重

`adapter.metrics: ["cov","lapVar"]` 这种 v1 写法没有 weight 槽位。要用 intent 覆盖权重，
把它写成 v2 对象 `{id:"cov", extract:"cov", weight:0.35, norm:{...}}` —— 引擎会硬错提示，不会偷偷改写形状。

---

## 4. `--no-intent` 的代价（读一遍再决定用不用）

它是**给"我这次就是要跑个数字"**准备的逃生门，不是默认路径：

| 得到 | 失去 |
|---|---|
| 马上能跑，不用先写转译 | 判据全部按 adapter 原样 —— **没人确认过它是不是你要的** |
| 台帐照常记（`intent` = `skipped`，reason 写明 `--no-intent`） | "需求被消化"这件事没有证据；汇总行会写 `1 skipped` |
| hash 与带 intent 的同一组判据可比（判据没变） | 你没法用这次的结果回答"我提的那句需求被接住了吗" |

一句话：**跳过可以，跳过必须有名字**（这就是台帐存在的意义）。
默认路径仍然是"没有确认过的转译就拒跑" —— 这一版没有、也不会把默认改成放行。

---

## 5. 节点台帐契约（v1，字段固定）

**位置**：`<out>/nodes/NN-<node>.json`，`NN` 是两位序号（`01`、`02`…），一个 out 目录 = 一次 run。

```json
{
  "node": "precheck",
  "seq": 4,
  "status": "done",
  "producer": "engine",
  "ms": 132,
  "inputs": ["adapter.params.list（白名单）", "plan.startParams", "起点距离 d=1.1111"],
  "decision": {
    "why": "每个参数在起点基础上 +1 步，与起点比 Δd；Δd==0 判 dead 并从搜索轴剔除（不花预算）",
    "basis": ["活 2 个：alpha / beta", "dead 1 个：ghost", "alpha: 2→2.2 Δd=0.147222 → alive"]
  },
  "artifacts": [],
  "cost": { "evals": 3 },
  "reason": ""
}
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `node` | string | 节点名，小写 + `-`：`intent` / `target` / `stability` / `precheck` / `search` / `finalize` |
| `seq` | number | 1 起连续，**等于文件名前两位** |
| `status` | enum | `done` / `skipped` / `degraded` / `failed` |
| `producer` | enum | `agent`（agent 填的，如 intent）/ `engine`（引擎跑的）/ `host`（宿主侧动作） |
| `ms` | number \| null | 该节点耗时；**执行器没逐节点计时就是 `null`**（不编 0） |
| `inputs` | string[] | 这个节点读进来的东西（文件 / 配置项 / 上一节点的输出摘要） |
| `decision.why` | string | 为什么这么做（一句话） |
| `decision.basis` | string[] | 依据：具体数字、哪几条判据、哪几轮胜出、谁在哪确认的 |
| `artifacts` | string[] | 这个节点落下的产物（相对 out 的路径 / 文件） |
| `cost` | object | 花掉的东西：`{evals, msPerEval?, ms?}` |
| `reason` | string | **`skipped` / `degraded` / `failed` 必须非空**；`done` 时是空串 |

**status 的语义（别混用）**：

- `done` —— 这一步真的做了，产物在 `artifacts` 里；
- `skipped` —— 这一步**没做**，`reason` 说清为什么（显式跳过 / 这条链路没有这一节 / 预检判死所以不搜索）；
- `degraded` —— **做了但没做成它该做的**（`repeat=1` 关掉稳定性闸、criteria 的 target 在截图链路没落点、预检中途预算断、**v1 intent 缺锚/反例/自由度**）；
- `failed` —— 硬错中断在这一步（错误原文在 `reason`）。

**`01-intent.json` 的 `artifacts` 与 `decision.basis`（0.5.1 v2）**：

- `artifacts` 里有 `intent.summary.json`（v2 四样的机器可读落盘）和截图链路的 `intent/adapter.effective.json`；
- `decision.basis` 里逐条写着 `intent 版本：v2` / `restate: …` / `锚 N 条：…` / `反例 N 条：…` /
  `自由度：定死 N 条 … / 自由 N 条 …` / `验收方式：…`，以及最后那句
  **`以上（restate / 锚 / 反例 / 自由度 / 验收方式）不参与距离计算，只做记录与呈现`**；
- 那句是给后来的人看的：这四样不是判据，别把它们塞进距离（塞进去就是"指标替代审美"复活）。

**谁写**：

| 节点 | 命令链路（cmdloop） | 截图链路（iter.ps1） |
|---|---|---|
| `01 intent` | 闸自己写（`intent.mjs`） | 闸自己写（`iter.ps1` 转 `intent.mjs gate`） |
| `02 target` | cmdloop 写（目标指标/目标参数 + 起点） | `finalize.js` 补（`_run.json` 里的目标与起始帧） |
| `03 stability` | cmdloop 写（done / degraded） | `finalize.js` 补成 `skipped`（截图链路没有这道闸，等价物是 `freeze.verify`） |
| `04 precheck` | cmdloop 写 | `finalize.js` 补 |
| `05 search` | cmdloop 写（轮数/评估次数/胜出轨迹） | `finalize.js` 补 |
| `06 finalize` | cmdloop 写（hash + cleanup） | `finalize.js` 写（hash + 镜像/本体 sha） |

截图链路为什么由 `finalize.js` 补：这些数据全在 `logs/_run.json` 里，收尾时一次落盘最省事，
而且**不用动 `iter.ps1` 的搜索主流程**（那块是跑通的产品资产，改它风险大于收益）。
代价是截图链路的 `ms` 一律是 `null`（没逐节点计时），成本只能看 `cost.evals` 与 `metas.msPerEval`。

**机器读**：`<out>/best.json` 里有索引 `nodes: { dir, counts, items:[{seq,node,status,reason}] }`；
要读全文就扫 `nodes/*.json`（文件名排序 = seq 顺序）。字段名**固定**，谁写都长一个样。

---

## 6. `report.md` 顶部的汇总行怎么读

```
本次运行：5 done / 1 skipped / 0 degraded
- `skipped` `intent` — 显式 --no-intent 跳过需求转译（台帐：跳过有名字）
```

- 第一行是**计数**：`done / skipped / degraded`（有 `failed` 才追加 `/ N failed`）；
- 下面逐条列 `skipped` / `degraded` / `failed` 的 node 与原因，**最多 8 行**，多了写 `还有 N 条见 nodes/`；
- 计数与 `nodes/` 里的实际条数**必须相等**（测试钉住了这条：`test/intent.test.mjs` ⑥）。

这条汇总就是"**哪些节点被绕过**"的唯一答案。以前它散在日志里，等于没有 ——
现在 `iter.ps1` 跑完也会告诉你"stability 这一节被跳过了，因为截图链路没有这道闸"。

### 6.1 汇总行下面那一段：intent 摘要（0.5.1 v2）

紧跟着汇总行会有一段 intent 摘要（数据来自 `intent.summary.json`；`--no-intent` 时也会有一段，写"本次没有需求转译"）：

```
**需求转译（intent v2 · done）**

- **复述**：火柱要更粗更硬，但别变成一根直线光
- **锚**：2 条（image 1 / text 1） —— `refs/ref-a.png`、「崩坏：星穹铁道（具体游戏名，不是抽象风格）」
- **反例**：2 条：不要写实/PBR 连续渐变；不要像素噪点式的硬过渡
- **自由度**：定死 2 条 / 自由 3 条；定死：命中点的位置、整体配色链；自由：光束长度、弯曲与摆动幅度、火星密度
- **验收**：人眼 + 指标（两者都要）；指标过闸 + 人眼确认一次
- **确认**：`confirmed=true`（user @ 2026-11-14T10:46:00+08:00）；**还有 1 条待确认问题没答，已按当前判据开跑**
- **降级**：（只有 degraded 才出现这一行）
```

- 这段**不参与距离计算**，`intent.summary.json` 里明写 `participatesInDistance: false`；
- v1 intent 会标成 `intent v1 · degraded`，并多一行"降级：缺锚、反例、自由度…"；
- 两个入口口径一致：命令链路由 `cmdloop.mjs` 直接算，截图链路由 `finalize.js` 读同一个文件
  （`harness/intent-summary.js` 是唯一实现，防止两份漂）。

### 6.2 跑的时候怎么看（0.5.2 · `watch.mjs`）

不用等跑完翻文件：另开一个终端，指到这次 run 的输出目录就行。

```bash
node harness/watch.mjs runs/cmd1           # 每 0.5 秒重画；跑完（finalize 落盘）自动退
node harness/watch.mjs runs/cmd1 --once    # 只画一帧就退（排查 / 脚本里用）
node harness/watch.mjs runs/cmd1 --json    # 不画界面，吐一屏 JSON（给面板直接读）
node harness/watch.mjs runs/cmd1 --interval 200 --timeout 120   # 重画间隔 / 最长看多久（默认 500ms / 60s）
```

它**只读磁盘**（不连引擎、不开端口），数据来源三处：`<out>/live.jsonl`（命令链路每评估一行，立刻 flush；
截图链路没有这个文件）、`<out>/nodes/*.json`（两条链路都有）、证据包文件（判断产物存不存在）。

一屏五段，顺序固定：

```
run cmd1  ·  第 3 轮 / 预算 60（已评 32）  ·  best 0.0804（-62.1%）  ·  单次 85ms
✔ intent    done 12ms
✔ target    done 165ms
– stability skipped（截图链路没有这道闸）
✔ precheck  done 190ms
⏝ search    running
· finalize  pending
  3 done / 1 skipped / 0 degraded
#30 d=0.0904 α=0.96 β=1.46  ·  #31 d=0.0881 α=0.94 β=1.46  ·  #32 d=0.0804 α=0.96 β=1.46
<out>\shots\best.png
<out>\report.md
<out>\nodes
Ctrl+C 退出 · 跑完自动显示 summary
```

| 段 | 含义 | 看什么 |
|---|---|---|
| 第 1 行 | 当前轮次 / 预算与已评次数 / 当前 best（相对起点的降幅）/ 单次评估中位数耗时 | `已评` 涨不动 = 卡在某一次命令；`best` 不再降 = 在空转 |
| 节点行 | 6 个流水线节点各一行：`✔` done / `⏝` running / `–` skipped / `!` degraded / `✗` failed / `·` 还没到 | **哪些被绕过**：`–`/`!` 后面必有原因（截 40 字）；`⏝` 是"最后一条评估属于它" |
| 计数行 | 与 `report.md` 顶部同一口径（`N done / N skipped / N degraded`） | 数字和节点行对不上就是台帐写歪了 |
| 评估点行 | `live.jsonl` 末尾 3 条：`#seq d=… 参数缩写` | 是不是在**同一片**里打转（参数几乎不动、d 不变）；预检阶段会看到 `note=precheck` 的点 |
| 产物路径 | 存在才列，**绝对路径**，每行一个 | 手机远程时直接复制 `shots/best.png` / `report.md` 的路径 |

没有 `live.jsonl` 时（截图链路 `iter.ps1`），第 3 段显示"（没有实时评估流：这条链路只写节点台帐）"，其余照常。
跑完（`nodes/` 里有 `finalize` 且 `status=done|failed`）会画最后一屏再以 0 退出；`--timeout` 是防挂死的兜底。
`report.md` 末尾也会打印一条可直接复制的 `实时视图：node harness/watch.mjs "<本目录>"`。

### 6.3 报告里那一节「硬不变量」（0.7.0；0.8.0 起带「本次」列与两种 warn）

跑完之后 `report.md` 在稳定性表下面会有这一段（有 invariants 时）：

```
## 硬不变量（不合格直接判废，不进距离）

| id | 判据 | 为什么 | 通过 | 拒绝 | 本次 | 最近一次拒绝 |
|---|---|---|---|---|---|---|
| `no_dead_band` | `any(loss <= 0.45 \| loss >= 1.05)` | 死区里的解不可用 | 15 | 2 | — | seq=16（search） `{"loss":1.02}` |
| `loss_nonneg` | `loss >= 0` | loss 不该为负 | 17 | 0 | ⚠ 本次未拦任何候选 | — |

**门禁拒绝 2 个候选**（共过门禁 17 次观测：目标 / 起点 / 预检 / 搜索每一次评估都过）。

**假门告警**：
- `loss_nonneg`：硬不变量 loss_nonneg 本次一次都没拦住候选（评估 17 次…）——门可能是写宽的…

**目标贴阈值**（这次合格，但离边界太近）：
- 目标离不变量 `loss_ceiling` 的阈值很近（观测 0.4487 / 阈值 0.45）——判据下一版微调就可能翻脸
```

- **通过 / 拒绝**是**观测次数**（每次评估都过一遍门），不是轮数；
- **本次**列只有两种值：`—`（本次拦过东西，门在干活）或 `⚠ 本次未拦任何候选`（假门：评估 ≥10 次却一次没拦住）；
- **最近一次拒绝**带 `seq` + 阶段 + 判据引用到的字段值，下面还会贴一小段原始 stdout（每个 id 一条）——
  事后要回答"为什么这个点被拒"只看这一节就够；
- 没写 invariants 时这一段变成一句 **"没写硬不变量：搜索会拿底线换分数"** + 截图链路限制说明；
- 同一份结论在 `best.json` 的 `invariants` 块里（机器读，含 `fakeGate` / `nearThreshold` / `gateBlock`），
  `curve.csv` 的 `inv` 列能逐点对照；
- 门禁挡死了搜索时，顶部结论行会变成 **"门禁挡住了搜索，不是参数死了"**，终止原因写 `invariant-blocked`。

---

## 7. 已知缺口（别当 bug）

| 缺口 | 现状 | 下一步 |
|---|---|---|
| **锚还没进搜索**（v2 最大的缺口） | `anchors` / `notWanted` / `freeVsFixed` 只进台帐与报告；搜索仍然只认 `criteria` 的距离。也就是说：**写了锚也不会让搜索更"像那张图"**，它只是把"要什么"钉住了、让人有据可查 | 三条候选路（按代价从低到高）：① `notWanted` 做**拒收闸**（候选命中反例关键词/指标区间 → 直接判负，不进最优，成本≈一次字符串/区间比较）；② `criteria[].anchor` 指向 `kind:"image"` 时，把那条锚图当**第二目标帧**算出 `anchorDist`，进**独立列**但不进主距离（"锚距离"单独看，避免又变成加权平均）；③ 起步方向用锚做**初始化**（按锚图实测指标反推起点参数），省掉前两轮空转。共同纪律：锚只能**约束搜索**或**另立一列**，一旦混进主距离就又变成"指标替代审美" |
| **不变量写错、事后来才发现** | **已补（0.8.0）**。原来门禁只在当下判，三种病都测不出来。现在各有出口：① **假门**（一条不变量一次没拦住候选）→ 终端 warn + 报告「本次」列标 `⚠ 本次未拦任何候选`（`--no-fake-gate-warn` 只关终端）；② **写死了**（连续 3 轮没有新候选过门）→ 早停并写 `stop=invariant-blocked`，明确区别于 `all-dead`/`no-alive-after-precheck`；③ **事后改了不变量** → `node harness/audit.mjs <run> --intent <intent.json>` 拿今天的标准逐点复算旧 run（§8） | 见 §1.7「门禁自己的三种病」与 §8。剩下的缺口只有一条：**贴阈值提醒只看目标那一点**（不回溯历史点），以及复算要求 `outputs/` 还在 |
| **research 节点没有** | "开干之前有没有先去搜索调研"这件事**还没有节点**：`{findings[], extracted[], suggestedStart, changed[]}` 只有设计稿 | 下一个插槽，判据是 `changed.length`（搜了但没改任何判据/起点 → `degraded`，标"装饰性调研"） |
| `anchors[].why` 不做语义检查 | 写"好看"也能过（只校验 has-text） | 需要人；或者要求 `why` 里出现锚的具体部位（"亮核/边缘/配色链"这类词表） |
| 截图链路的 `ms` 是 `null` | 没逐节点计时（改 iter 主流程代价大） | 在 `_run.json` 里加分段计时 |
| `intent` 只覆盖权重与目标 | 不改 `extract` / `norm` / 白名单 / 预算 | 按需扩（每条都要有对应的"改了什么"记账） |
| 没有"反事实对比" | 同一次 run 只留一条轨迹 | 同一套台帐跑两遍（有调研 vs 没调研）逐节点比 |
| 台帐不做 schema 校验文件 | 字段契约写在本文 + `ledger.js` 里硬校验 | 将来定下来再出 JSON Schema（引擎和界面对它编程） |
| `intent` 不做语义检查 | `restate` / `understood` 写得再敷衍也能过（只查长度） | 需要人；或者加一个"复述里必须出现指标名"的弱检查 |

---

## 8. 复算历史结论（audit，0.8.0）

门禁只在**当下**判。事后收紧了阈值、加了一条不变量 —— 旧 run 里那份"最优"还算不算数？
`harness/audit.mjs` 就是回答这个的：拿**今天**的 `intent.invariants`，对旧 run 的**每个历史评估点**重新判一遍。

```bash
node harness/audit.mjs <run目录> --intent <intent.json> [--json] [--strict]
```

它只用三样东西：那个 run 的 `best.json`（评估序列 + 当时的 best）、`curve.csv`（评估点行数对账）、
`outputs/`（**每次评估的原始 stdout**）。**不复算距离** —— 距离用当时记录的 `d`，所以 `criteria` 的
权重/目标值改过也不影响"当时谁更近"这件事（`--json` 里会有 warn 提醒这一点）。

**回答四件事**：

1. 多少点现在不合格（`N / total`）；
2. 当时的 `best` 按今天的标准还合不合格（`bestOk`）；
3. 不合格时：在"今天合格"的点里，按当时记录的距离挑**新的最优**并给出它的参数（`suggestedBest`）。
   目标锚点那个点**不算候选**（它 d 恒为 0 —— 那是"离目标的距离"的定义，不是一次搜索尝试）；
4. 一个合格点都没有：明说 **"按今天的标准，这一轮没有可用结果"**，别拿它当结论。

**退出码**（可以直接进 CI / 脚本）：

| 码 | 含义 |
|---|---|
| `0` | `best` 今天仍合格（`--strict` 时还要求"没有更优点"） |
| `1` | `best` 今天不合格（`--strict` 时"有更优点"也算 1：比如今天放宽门禁后，旧 run 里那个被挡掉的点其实更优） |
| `2` | 跑不起来：缺 `best.json` / `curve.csv` / `outputs/`、截图链路的 run、intent 文法错 —— 一律中文说明，绝不瞎算 |

**什么时候该跑**：

- 改了 `intent.invariants`（加/删/改阈值）之后，回头确认老结论有没有失效；
- 复用别人的 run 目录当"结论"之前（尤其隔了几周、判据可能已经动过）；
- 发版前扫一遍历史证据包，挑出"按今天的标准不合格"的那些，别让它们继续被引用；
- `--json` 给界面/看板读（字段：`total / nowInvalid / bestOk / suggestedBest / reasons / points / warnings / exitCode`）。

**只对命令链路（`cmdloop.mjs`）的 run 生效**：截图链路（`iter.ps1`）的观测是页面指标、只剩 `best.json` 里的
结论，没有 `outputs/` 与字段表 —— 遇到直接报 **"暂不支持截图链路"**（exit 2），不拿旧结论证明旧结论。

**`outputs/` 被清掉了怎么办**：清掉就**没法复算**，工具会 exit 2 并说明。这时只有一条路 ——
用 `best.json` 里的 `meta.command` 原样重跑一次（**换一个新的 `--out` 目录**，别覆盖旧证据），
拿到的新 run 才是可复算的。所以证据包里 `outputs/` 属于**必须留**的那一部分，别当垃圾清。

---

## 9. 自查（跑完一分钟能看完）

```bash
node harness/cmdloop.mjs --adapter examples/command-echo.json --out runs/r1 --budget 12 --no-intent
ls runs/r1/nodes/            # 01-intent … 06-finalize
head -14 runs/r1/report.md   # 汇总行 + 需求转译摘要段
```

想验"闸真的会拦"：删掉 `runs/r2/intent.json` 再跑，应该拿到
`[需求转译闸] 没有需求转译文件：…`、`exit 1`，并且 `runs/r2/intent.template.json` 已经写好了。

想验"锚真的会拦"：把 v2 intent 的 `anchors[0].ref` 改成 `refs/not-there.png` 再跑，应该拿到
`[需求转译闸] intent.anchors[0] 指向的参考图不存在：…`（附解析出的绝对路径）、`exit 1`，
台帐 `01-intent.json` 是 `failed`，且**没有** `best.json`。

想验"v1 的欠账会被记下来"：把 `version` / `restate` / `anchors` / `criteria[].anchor` 全删掉再跑 ——
它会跑完（`exit 0`），但台帐 `01-intent.json` 是 `degraded`、`reason` 含 `v1`，
报告顶部标 `intent v1 · degraded`。

想验"硬不变量真的会拦"（0.7.0）：

```bash
# ① 目标/起点违规 → 硬错（点名 id）
#    intent.invariants 里写 {id:"size_floor", check:{field:"size", op:">=", value:30}, why:"..."}
#    examples/command-echo.json 的目标 size=28 → 必须 exit 1，错误里有 id="size_floor"
# ② 候选被拒 → 跑通，但报告里看得见
grep -n "硬不变量" runs/r1/report.md
grep -n "门禁拒绝" runs/r1/nodes/05-search.json
# ③ 没写 invariants → 终端有那条默认 warn；报告里写"门禁没装"
#    加 --no-invariants-warn 后终端安静，但报告仍如实记录
```

想验"门禁自己的三种病都会被说出来"（0.8.0）：

```bash
# ① 假门：写一条永远为真的（loss >= 0），跑够 10 次评估 → 终端 warn + 报告「本次」列标 ⚠
grep -n "未拦任何候选" runs/r1/report.md
# ② 写死了：不变量把搜索全挡了 → stop=invariant-blocked，提示里点名 id 与"不是参数死了"
node -e "console.log(require('./runs/r1/best.json').stop)"   # { reason: 'invariant-blocked', detail: '…' }
# ③ 贴阈值：目标观测贴着阈值 → 终端与报告各一条"阈值很近"
grep -n "阈值很近" runs/r1/report.md
```

想验"复算历史结论"（0.8.0）：

```bash
node harness/audit.mjs runs/r1 --intent runs/r1/intent.json    # best 今天仍合格 → exit 0
# 把那条不变量收紧（或加一条）再跑：best 今天不合格 → exit 1 + "新的最优 …"
node harness/audit.mjs runs/r1 --intent <更严的 intent>.json --strict --json | head -40
# 把 outputs/ 删掉再跑 → exit 2 + "没有 outputs/ …"
```
