# 需求转译闸（intent）与节点台帐（ledger）

> 两件东西解决的是同一个病：**这套引擎原来只有中段**。
> 需求转译、调研参考这两段根本没有节点，直接从中段（活性扫描 → 搜索）开始 —— 所以它"虚"不是缺界面，
> 是头两段不存在；而"被绕过"一直在发生（缺回读、参数判 dead、缓存命中、`repeat=1` 关掉稳定性闸），
> 只是散在日志里，没有一处汇总，于是"被绕过"这件事连名字都没有。
>
> 这一版只做两件：**跑之前必须有一份经过确认的需求转译**（否则拒跑），**每一步都落一条能机器读的台帐**。
> 调研（research）插槽还没做，见 §7 已知缺口。

---

## 1. 需求转译（intent）怎么填

**放哪**：

| 链路 | 默认位置 | 能不能指别处 |
|---|---|---|
| 命令（`harness/cmdloop.mjs`） | `<out>/intent.json` | `--intent <file>` |
| 截图（`harness/iter.ps1`） | `<Out>\intent.json` | `-Intent <file>` |

**结构**（照抄下面这份，改内容）：

```json
{
  "understood": "把 size 从 12 压回 10，loss 别反弹",
  "criteria": [
    { "id": "size", "weight": 2, "target": 10, "why": "体积是你说的重点" },
    { "id": "loss", "weight": 1, "why": "次要点，别归零" }
  ],
  "uncertain": ["'更硬'是指边缘锐利还是对比度更高？"],
  "confirm": ["粗细优先还是亮度优先？"],
  "confirmed": true,
  "confirmedBy": "user",
  "confirmedAt": "2026-11-14T10:46:00+08:00"
}
```

| 字段 | 是什么 | 硬要求 |
|---|---|---|
| `understood` | 一句话复述"我理解你要的是什么"（对标即梦接活先复述需求） | 建议必填；空着会进台帐的 `decision.basis` 当提醒 |
| `criteria[].id` | 要动哪条判据 —— 必须是**这份 adapter 里真实存在的指标 id** | **写错 = 硬错**，绝不静默忽略 |
| `criteria[].weight` | 这条指标在距离里占多重（覆盖 `adapter.metrics[].weight`） | ≥0 的数；不给 = 不改 |
| `criteria[].target` | 这条指标的目标值（覆盖 `adapter.target.metrics[id]` / 目标帧跑出来的那个数） | 数；不给 = 不改；**截图链路不生效**（见 §3.4） |
| `criteria[].why` | 为什么这么定（写给人看，也进台帐） | 随便写，但别空着 |
| `uncertain` | 还没说清的地方 | 数组 |
| `confirm` | 要用户拍板的问题 | 数组；**未确认时会被原样打出来** |
| `confirmed` | 用户点头了没有 | 必须是 `true`，否则拒跑 |
| `confirmedBy` / `confirmedAt` | 谁、什么时候确认的 | 进台帐（`confirmedBy @ confirmedAt`） |

**不同链路怎么知道有哪些 id**：`node harness/intent.mjs gate` 的报错和模板里都会列出来；
也可以看 `adapter.metrics[].id`（截图链路）或 `adapter.observe.metrics[].id`（命令链路）。
最省事的办法：**先不带 intent 跑一次** —— 引擎会写出 `intent.template.json`，模板的 `_说明[2]` 里就写着这份 adapter 的指标 id。

**确认这一步不能省**：`confirmed: true` 是"用户看过并点头"，不是"agent 觉得自己懂了"。
引擎只认这一个布尔值 —— 它不判断你的转译写得好不好，只保证"没被点头的转译不会开跑"。

---

## 2. 硬闸语义（四条，全部中文硬错 + 非零退出）

| 情况 | 引擎的反应 |
|---|---|
| 没有 intent 文件 | 硬错，并写出 `<out>/intent.template.json`；错误里说清三件事：填什么 / 填完怎么确认 / 显式跳过的开关是什么 |
| 有文件但 `confirmed !== true` | 硬错，把 `confirm[]` 里待确认的问题**原样逐条列出** |
| `confirmed === true` | 通过；`criteria` 按 id 覆盖判据（权重 / 目标值），覆盖了哪几条写进台帐 |
| `criteria` 里有 adapter 不存在的 id | 硬错，点名写错的 id + 列出真实的指标 id（**绝不静默忽略**） |
| `--no-intent` / `-NoIntent` | 放行，但台帐里必须有一条 `intent` = `skipped`，reason 写"显式 --no-intent 跳过需求转译" |

**位置**：intent 是所有评估之前的**第 01 个节点**（比目标帧渲染、比活性预检、比稳定性闸都早），
因为它会改判据 —— 判据改了，后面每一次"距离"的含义才成立。闸被拦下时，台帐里会留一条 `intent` = `failed`，
所以"这次跑到哪一步断的"在 run 目录里查得到，不是只在终端最后几行。

**它不做的事**（重要，别指望它）：

- 不判断你的 `understood` 写得对不对 —— 那需要人；
- 不自动填 intent（引擎保持纯确定性，不确定的那层关在 agent 里）；
- 不因为 criteria 为空就拒跑（复述本身也算消化了一半，只会在台帐里提醒）；
- 不改 `extract` / `norm` —— 换归一化不只是"更看重它"，是换了一把尺，那要改 adapter。

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
- `degraded` —— **做了但没做成它该做的**（`repeat=1` 关掉稳定性闸、criteria 的 target 在截图链路没落点、预检中途预算断）；
- `failed` —— 硬错中断在这一步（错误原文在 `reason`）。

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

---

## 7. 初版已知缺口（别当 bug）

| 缺口 | 现状 | 下一步 |
|---|---|---|
| **research 节点没有** | "开干之前有没有先去搜索调研"这件事**还没有节点**：`{findings[], extracted[], suggestedStart, changed[]}` 只有设计稿 | 下一个插槽，判据是 `changed.length`（搜了但没改任何判据/起点 → `degraded`，标"装饰性调研"） |
| 截图链路的 `ms` 是 `null` | 没逐节点计时（改 iter 主流程代价大） | 在 `_run.json` 里加分段计时 |
| `intent` 只覆盖权重与目标 | 不改 `extract` / `norm` / 白名单 / 预算 | 按需扩（每条都要有对应的"改了什么"记账） |
| 没有"反事实对比" | 同一次 run 只留一条轨迹 | 同一套台帐跑两遍（有调研 vs 没调研）逐节点比 |
| 台帐不做 schema 校验文件 | 字段契约写在本文 + `ledger.js` 里硬校验 | 将来定下来再出 JSON Schema（引擎和界面对它编程） |
| `intent` 不做语义检查 | `understood` 写得再敷衍也能过 | 需要人；或者加一个"复述里必须出现指标名"的弱检查 |

---

## 8. 自查（跑完一分钟能看完）

```bash
node harness/cmdloop.mjs --adapter examples/command-echo.json --out runs/r1 --budget 12 --no-intent
ls runs/r1/nodes/            # 01-intent … 06-finalize
head -6 runs/r1/report.md    # 本次运行：N done / N skipped / N degraded
```

想验"闸真的会拦"：删掉 `runs/r2/intent.json` 再跑，应该拿到
`[需求转译闸] 没有需求转译文件：…`、`exit 1`，并且 `runs/r2/intent.template.json` 已经写好了。
