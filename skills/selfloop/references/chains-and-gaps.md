# 两条链路的差别、`--no-intent` 的代价、已知缺口、复算

**这份答案一个问题**：**为什么这条规则在我这条链路上没生效**。

**什么时候读**：判据/不变量/调研写了却没起作用；想跳过需求转译闸；想拿今天的标准复算旧 run；怀疑踩到已知缺口。

**结论先说**：

1. 两条链路判据**同一份** `score.js`，但 `criteria[].target` **在截图链路不生效**；`research` 只在命令链路。
2. `--no-intent` / `-NoIntent` 能跑，但台帐记一条 `skipped intent`——**跳过有名字**，不是静默。
3. 最大已知缺口：**锚还没进搜索**，只进台帐与报告。
4. 改了不变量要回验旧结论 → `node harness/audit.mjs <run> --intent <intent.json>`（要求 `outputs/` 还在）。

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

### 3.5 research 只在命令链路（截图链路暂未接入）

`harness/research.mjs` 由 `cmdloop.mjs` 直接调用。截图链路（`iter.ps1` + `finalize.js`）**没有** research 节点：
它跑一轮的判据来自 `metrics2.js` 量目标帧/候选帧，起点在 PS 侧算，接入要动那条已经跑通的产品资产（`iter.ps1`），
风险大于收益。所以截图链路的台帐仍然是 `01-intent → 02-target → …`（6 条），命令链路是 7 条。

**不假装**：截图链路的 `report.md` 里不会出现「调研（research · …）」那一段，台帐里也没有 `research` 记录 ——
"这一轮没调研"在截图链路里目前只能从"没有 research.json"这件事本身看出来。见 §7 缺口。

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


---

## 7. 已知缺口（别当 bug）

| 缺口 | 现状 | 下一步 |
|---|---|---|
| **锚还没进搜索**（v2 最大的缺口） | `anchors` / `notWanted` / `freeVsFixed` 只进台帐与报告；搜索仍然只认 `criteria` 的距离。也就是说：**写了锚也不会让搜索更"像那张图"**，它只是把"要什么"钉住了、让人有据可查 | 三条候选路（按代价从低到高）：① `notWanted` 做**拒收闸**（候选命中反例关键词/指标区间 → 直接判负，不进最优，成本≈一次字符串/区间比较）；② `criteria[].anchor` 指向 `kind:"image"` 时，把那条锚图当**第二目标帧**算出 `anchorDist`，进**独立列**但不进主距离（"锚距离"单独看，避免又变成加权平均）；③ 起步方向用锚做**初始化**（按锚图实测指标反推起点参数），省掉前两轮空转。共同纪律：锚只能**约束搜索**或**另立一列**，一旦混进主距离就又变成"指标替代审美" |
| **不变量写错、事后来才发现** | **已补（0.8.0）**。原来门禁只在当下判，三种病都测不出来。现在各有出口：① **假门**（一条不变量一次没拦住候选）→ 终端 warn + 报告「本次」列标 `⚠ 本次未拦任何候选`（`--no-fake-gate-warn` 只关终端）；② **写死了**（连续 3 轮没有新候选过门）→ 早停并写 `stop=invariant-blocked`，明确区别于 `all-dead`/`no-alive-after-precheck`；③ **事后改了不变量** → `node harness/audit.mjs <run> --intent <intent.json>` 拿今天的标准逐点复算旧 run（§8） | 见 §1.7「门禁自己的三种病」与 §8。剩下的缺口只有一条：**贴阈值提醒只看目标那一点**（不回溯历史点），以及复算要求 `outputs/` 还在 |
| **research 从图里提数仍是人/agent 干的**（0.9.0 之后最大的一条） | 引擎只认 `extracted[]` 里的数字：从参考图量出色相/占比/粗细这件事在 agent 里做。也就是说 `changed` 能证明"提取出来的值落了地"，但证明不了"这个值是从图里量出来的"——`source` 只是自述 | 三条候选路（按代价从低到高）：① 要求 `source` 里出现 reference 的 `ref`（点得住那张图才有来路）；② 给 `kind:"image"` 的 finding 存一份**量出来的特征**（引擎出一份 `findings[].measured`，跟 extracted 的 `source` 比对）；③ 真接一次"从图里提数"的提取器（那是 metrics2.js 的活，得进浏览器链路） |
| **research 只接了命令链路** | 截图链路（`iter.ps1`/`finalize.js`）没有 research 节点，那边的"开干前调研"仍然没有证据（§3.5） | 把 `<Out>\research.json` 的权重覆盖并进 `intent\adapter.effective.json`、起点覆盖并进 `_run.json`；代价是要动 PS 侧主流程 |
| **`confidence` 不打折** | 0.3 和 0.9 一样生效，只做记录 | 要么按 confidence 给权重（那就成了另一套判据，容易又变成"指标替代审美"），要么只保留"低 confidence 必须写 source"这条弱检查 |
| **query 没有联网证据** | 只记录"你说你搜了什么"，没验证真搜过 | 需要宿主侧工具配合（搜索 API 的调用日志），引擎本身不联网 |
| **没有"反事实对比"** | 同一次 run 只留一条轨迹 | 同一套台帐跑两遍（有 research vs 无 research）逐节点比 —— 现在有了 `research.skipped` 这一条，对比成本已经很低 |
| `anchors[].why` 不做语义检查 | 写"好看"也能过（只校验 has-text） | 需要人；或者要求 `why` 里出现锚的具体部位（"亮核/边缘/配色链"这类词表） |
| 截图链路的 `ms` 是 `null` | 没逐节点计时（改 iter 主流程代价大） | 在 `_run.json` 里加分段计时 |
| `intent` 只覆盖权重与目标 | 不改 `extract` / `norm` / 白名单 / 预算 | 按需扩（每条都要有对应的"改了什么"记账） |
| 没有"反事实对比" | 同一次 run 只留一条轨迹 | 同一套台帐跑两遍（有调研 vs 没调研）逐节点比 —— 现在两边都会留下 `research` 节点的 done/degraded/skipped，对比成本很低 |
| 台帐不做 schema 校验文件 | 字段契约写在本文 + `ledger.js` 里硬校验 | 将来定下来再出 JSON Schema（引擎和界面对它编程） |
| `intent` 不做语义检查 | `restate` / `understood` 写得再敷衍也能过（只查长度） | 需要人；或者加一个"复述里必须出现指标名"的弱检查 |
| **`userWords` 与 `restate` 不交叉校验**（v2.1 剩下的口子） | 硬错只判"原话/量法有没有写"，判不了"原话是不是真的来自用户"——把 agent 自己编的一句话塞进 `userWords` 也能过；同理 `howMeasured` 写的口径与 adapter 里那条 metric 的 `extract` 可能根本不是一个东西 | 三条候选路（按代价从低到高）：① **弱校验**：`userWords` 必须能在 `restate` / `confirm` 里找到共同子串（≥6 字），找不到 → warn「这句原话在 restate 里找不到，像是自己编的」；② **落点校验**：`howMeasured` 里必须出现该 metric 的 `extract`/`norm` 名字（否则口径和实际算法不是一回事）；③ 真做**双人确认**（用户原话由用户填、agent 只转写），那是流程不是代码 |
| **`howMeasured` 靠人看时只 warn** | 写了"暂无口径，靠参考图对照"照样算"有量法"，`done` 不降级 | 可以按 `humanEyes` 条数降级或自动降权（但这会诱导大家干脆不写量法，所以先停在 warn） |

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
