# 节点台帐（ledger）与 report.md 怎么读

**这份答案一个问题**：跑完这一轮，报告上那些行、那些列、那些 ⚠ 到底在说什么。

**什么时候读**：一轮跑完要看 `report.md` / `nodes/` / `best.json`；或正在用 `watch.mjs` 看实时视图。

**结论先说**：

1. 每节点一条 `nodes/NN-<node>.json`，`status` 只有 `done` / `degraded` / `skipped` / `failed`；**`degraded` 不是失败**，是「跑了但少了某个必要条件」。
2. 硬不变量那节看**「本次」列**：`⚠ 本次未拦任何候选` = 假门（门开着但一次没拦人）。
3. 门禁挡死搜索时顶部结论写 `invariant-blocked`——**是门的问题，不是参数死了**。
4. 末尾有「一分钟自查」清单，跑完照着过一遍。

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
| `node` | string | 节点名，小写 + `-`：`intent` / `research` / `target` / `stability` / `precheck` / `search` / `finalize` |
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
- v2.1 起还有两行：每条 `覆盖判据 <id>：… （原话：… / 量法：…）`（缺的写 `⚠`），以及
  **`判据来源：有原话 N 条 / 有量法 M 条 / 两者都无 0 条`**；量法"靠人看"时再多一行
  `量法靠人看的判据：…`；
- 那句是给后来的人看的：这四样不是判据，别把它们塞进距离（塞进去就是"指标替代审美"复活）。

**谁写**：

| 节点 | 命令链路（cmdloop） | 截图链路（iter.ps1） |
|---|---|---|
| `01 intent` | 闸自己写（`intent.mjs`） | 闸自己写（`iter.ps1` 转 `intent.mjs gate`） |
| `02 research` | `research.mjs` 写（done / degraded / skipped） | **没有这一步**（未接入，见 §3.5） |
| `03 target` | cmdloop 写（目标指标/目标参数 + 起点） | `finalize.js` 补（`_run.json` 里的目标与起始帧）→ 截图链路是 `02` |
| `04 stability` | cmdloop 写（done / degraded） | `finalize.js` 补成 `skipped`（截图链路没有这道闸，等价物是 `freeze.verify`）→ `03` |
| `05 precheck` | cmdloop 写 | `finalize.js` 补 → `04` |
| `06 search` | cmdloop 写（轮数/评估次数/胜出轨迹） | `finalize.js` 补 → `05` |
| `07 finalize` | cmdloop 写（hash + cleanup） | `finalize.js` 写（hash + 镜像/本体 sha）→ `06` |

> 序号是**自动连续编号**的（`ledger.add` 按写入顺序发号），所以两条链路的编号不同不是 bug：
> 命令链路多了 research 这一条。要读某一条就按**节点名**找（`nodes/*-research.json`），别写死序号。

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
- **判据**：2 条（有原话 2 / 有量法 1 / 两者都无 0）
  - `cov`（weight=0.6 target=0.02）：原话：用户原话：火柱要更粗更硬，但别变成一根直线光 / 量法：亮核像素数 ÷ 整幅像素数
  - `lapVar`（weight=0.2）：原话：用户原话：边缘要有锐劲，别糊成一坨 / 量法：⚠
- **确认**：`confirmed=true`（user @ 2026-11-14T10:46:00+08:00）；**还有 1 条待确认问题没答，已按当前判据开跑**
- **降级**：（只有 degraded 才出现这一行）
```

- **判据** 这一段是 v2.1 加的：每条后面挂 `原话：… / 量法：…`，缺的写 `⚠`；
  量法写了"靠人看"的条后面还会多一句 `（⚠ 量法靠人看：搜索不能用它当判据，考虑降权或改成可测量的量）`。
  这一段同样**不参与距离计算**，它的用处只有一个：让"这条判据是凭空编的"在报告上就看得见。

- 这段**不参与距离计算**，`intent.summary.json` 里明写 `participatesInDistance: false`；
- v1 intent 会标成 `intent v1 · degraded`，并多一行"降级：缺锚、反例、自由度…"；
- 两个入口口径一致：命令链路由 `cmdloop.mjs` 直接算，截图链路由 `finalize.js` 读同一个文件
  （`harness/intent-summary.js` 是唯一实现，防止两份漂）。

### 6.1.1 紧跟着那一段：调研摘要（0.9.0，02 号节点）

命令链路的 `report.md` 在 intent 摘要下面还有一段「调研（research · done/degraded/skipped）」：
搜了几条 query、几条 findings（image/doc 各几）、应用了几项、**changed 清单**、note。
格式见 §2.5.4，数据来自 `<out>/research.summary.json`。

与 intent 摘要的区别要记住：**intent 那四样不参与距离，research 会**（它改的是 weight/target/起点）。
所以 research 摘要里 `affectsDistance: true` 时，那份 changed 清单就是"这次调研到底改了什么"的答案；
改成 `false` 且状态是 `degraded`，就是**装饰性调研**。

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


## 9. 自查（跑完一分钟能看完）

```bash
node harness/cmdloop.mjs --adapter examples/command-echo.json --out runs/r1 --budget 12 --no-intent
ls runs/r1/nodes/            # 01-intent / 02-research / 03-target … 07-finalize（没有 research.json 时 02 是 skipped）
head -20 runs/r1/report.md   # 汇总行 + 需求转译摘要段 + 调研摘要段
```

想验"闸真的会拦"：删掉 `runs/r2/intent.json` 再跑，应该拿到
`[需求转译闸] 没有需求转译文件：…`、`exit 1`，并且 `runs/r2/intent.template.json` 已经写好了。

想验"锚真的会拦"：把 v2 intent 的 `anchors[0].ref` 改成 `refs/not-there.png` 再跑，应该拿到
`[需求转译闸] intent.anchors[0] 指向的参考图不存在：…`（附解析出的绝对路径）、`exit 1`，
台帐 `01-intent.json` 是 `failed`，且**没有** `best.json`。

想验"v1 的欠账会被记下来"：把 `version` / `restate` / `anchors` / `criteria[].anchor` 全删掉再跑 ——
它会跑完（`exit 0`），但台帐 `01-intent.json` 是 `degraded`、`reason` 含 `v1`，
报告顶部标 `intent v1 · degraded`。

想验"假指标真的会被拦"（v2.1）：

```bash
# ① criteria 里只留 anchor（userWords / howMeasured 都不写）→ exit 1
#    [需求转译闸] intent.criteria.size：这条判据没有任何用户原话/量法，等于凭空编的指标…
grep -n "判据" runs/r1/report.md      # 每条判据后面有「原话：… / 量法：…」，缺的是 ⚠
grep -n "判据来源" runs/r1/nodes/01-intent.json
# ② 只写 userWords → 能跑（exit 0），但 01-intent 是 degraded、reason 含"缺 howMeasured"
# ③ howMeasured 写"暂无口径，靠参考图对照" → 能跑 + [intent][warn] 靠人看（不硬错）
node test/intent.test.mjs             # 24 条；㉒ 用变异体证明"⑲ 硬错"这条断言真的有牙
```

想验"硬不变量真的会拦"（0.7.0）：

```bash
# ① 目标/起点违规 → 硬错（点名 id）
#    intent.invariants 里写 {id:"size_floor", check:{field:"size", op:">=", value:30}, why:"..."}
#    examples/command-echo.json 的目标 size=28 → 必须 exit 1，错误里有 id="size_floor"
# ② 候选被拒 → 跑通，但报告里看得见
grep -n "硬不变量" runs/r1/report.md
grep -n "门禁拒绝" runs/r1/nodes/06-search.json
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

想验"调研真的改变了这次搜索"（0.9.0）：

```bash
# ① 给一份真改了东西的 research.json（<out>/research.json 或 --research <file>）
#    criteria 改 weight + start 改起点 → 台帐 02-research 是 done，report 顶部有「调研（research · done）」
grep -n "调研（research" runs/r1/report.md
node -e "const r=require('./runs/r1/best.json').research; console.log(r.status, r.changed.map(c=>c.text))"
# ② 装饰性调研：把 weight 写成 adapter 原值（应用了但等于没动）→ 02-research 是 degraded、reason 含"装饰性调研"
# ③ 不给 research.json → 02-research 是 skipped，终端一行 [research][warn]（不拒跑）
# ④ 参考图不存在 → exit 1（[调研] … 参考图不存在：…），02-research 是 failed，没有 best.json
# ⑤ changed 不许信文件自报：在 research.json 里写 "changed": ["随便编两项"] —— 结论不变（引擎自己算）
node test/research.test.mjs        # 10 条；⑨ 用变异体证明"⑤ 装饰性调研"这条断言真的有牙
```

想验"复算历史结论"（0.8.0）：

```bash
node harness/audit.mjs runs/r1 --intent runs/r1/intent.json    # best 今天仍合格 → exit 0
# 把那条不变量收紧（或加一条）再跑：best 今天不合格 → exit 1 + "新的最优 …"
node harness/audit.mjs runs/r1 --intent <更严的 intent>.json --strict --json | head -40
# 把 outputs/ 删掉再跑 → exit 2 + "没有 outputs/ …"
```
