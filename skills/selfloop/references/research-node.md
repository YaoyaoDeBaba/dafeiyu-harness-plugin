# 调研节点（research，02 号）

**这份答案一个问题**：跑之前那段「自己先搜一遍、把判据或起点改掉」的活怎么落成一个节点，引擎怎么判它有没有认真做。

**什么时候读**：要写 `research.json`，或看不懂报告里 `02-research` 为什么是 `degraded` / `skipped` / `failed`。

**结论先说**：

1. 判据不是「搜了几条」，是「**有没有真的改变判据或起点**」——`changed` 由引擎自己算，不信文件自报。
2. 三态：`done`（真改了）/ `degraded`（改了但等于没动，如把 weight 写回原值）/ `skipped`（没给文件，只 warn 不拒跑）。
3. 参考图路径不存在 → **exit 1**，节点记 `failed`，没有 `best.json`。
4. 只在**命令链路**跑；截图链路暂未接入（见 `chains-and-gaps.md`）。

---

## 2.5 调研节点（research，02 号）

需求转译回答"你要什么被复述清楚了吗"；调研回答**"为了做到它，你去查了什么、查到的变成了什么"**。
它排在 `01 intent` 之后、`03 target` 之前 —— 因为它会改判据与起点，而起点距离就在 target 那一步算出来。

**放哪**：`<out>/research.json`（默认）或 `--research <file>`。**没有这个文件不拒跑**，只记一条 `skipped` + 一行 warn。

### 2.5.1 结构（照抄下面这份，改内容）

```json
{
  "queries": ["二次元火焰特效 参考", "崩坏星穹铁道 火焰 配色"],
  "findings": [
    { "kind": "image", "ref": "refs/ref-a.png", "why": "同类高评分火焰，边缘有描边" },
    { "kind": "doc",   "ref": "https://example.com/article", "why": "配色链：白芯→黄→橙→暗红" }
  ],
  "extracted": [
    { "apply": "criteria", "id": "cov", "weight": 0.25, "target": 0.02, "confidence": 0.7, "source": "ref-a.png 的亮核占比" },
    { "apply": "start",    "name": "widthPx", "value": 28, "confidence": 0.5, "source": "参考图里光束更粗" }
  ],
  "note": "配色链：白芯→黄→橙→暗红；描边比现版更硬"
}
```

| 字段 | 是什么 | 硬要求 |
|---|---|---|
| `queries[]` | 实际搜过的 query | 可以是空数组（说明没搜），但**此时必须写 `note`** 说明为什么没搜（离线 / 没资料 / 只是复验都算） |
| `findings[].kind` | `image`（参考图/帧）或 `doc`（文章/文档/网页） | 只认这两个 |
| `findings[].ref` | 参考物的位置 | `image`：**必须真实存在**（相对 research.json 所在目录或绝对路径），不存在 = 硬错；`doc`：非空 URL/路径即可 |
| `findings[].why` | 这条参考为什么有用 | 建议写（进台帐与报告） |
| `extracted[].apply` | 这条"提取"往哪落 | 只认 `criteria`（改某条指标的 weight/target）与 `start`（改某个参数的起点值） |
| `extracted[].id` | `apply:"criteria"` 时必填 | 必须是 adapter 里真实存在的指标 id（写错硬错） |
| `extracted[].name` | `apply:"start"` 时必填 | 必须在参数白名单里（写错硬错） |
| `extracted[].weight` / `.target` / `.value` | 要覆盖成多少 | `criteria` 至少给 weight 或 target 之一（都给就都覆盖）；`start` 必须给 `value`（数） |
| `extracted[].confidence` | 这条提取有多确定（0~1） | **只记录，不打折、不决定要不要用**（引擎不做加权融合） |
| `extracted[].source` | 这个数是从哪看出来的（哪张图哪个部位 / 哪段文档） | 写清楚；它是"这条判据凭什么这么改"的唯一来路 |
| `note` | 一句话总结调研结论 | `queries` 空时**必填** |

**不要写 `changed`**：写了也会被忽略（引擎自己比出来才是真的）。台帐里会留一句"文件里自报的 changed 已忽略"。

### 2.5.2 引擎做什么（三件事，不多做）

1. **读与校验**（全中文硬错）：图在不在、id/name 认不认识、queries 空有没有 note；
2. **应用**：`criteria` 覆盖权重/目标值，`start` 覆盖起点值。顺序固定 **adapter → intent → research**（research 最后压，
   所以它会盖掉 intent 写过的同一个值）；报告与台帐都写清"谁覆盖了谁"；
3. **算起效**：对比"应用 research 之前"与"之后"的判据与起点，逐项列 `changed`。

### 2.5.3 三种状态（这就是这一节的判据）

| 情况 | 台帐 | 终端 | `report.md` |
|---|---|---|---|
| 有产物且 `changed` 非空 | `done`（`artifacts` 里放 `research.summary.json`） | 逐条打印 `[research] 改动：criteria.cov.weight 0.35 → 0.25` | 「调研（research · done）」+ changed 清单 |
| 有产物但 `changed` 为空 | **`degraded`**，reason「装饰性调研：搜了/给了产物，但没改变任何判据或起点」 | `[research][warn]` 一行 | 「调研（research · degraded）」+「装饰性调研」 |
| 没有产物 | `skipped`，reason「没提供调研产物（--research <file>）」 | `[research][warn] 没提供调研产物…`（不拒跑） | 「调研（research · skipped）」 |

**为什么 degraded 不是 done**：搜了一堆图、写了一份好看的文件，但判据和起点一个都没动 —— 那"调研"只是开场白，
这一轮还是按原判据在调。**这也是为什么 changed 必须由引擎算**：让被检查的人自己填结论，等于没检查。

### 2.5.4 报告里长什么样

```
**调研（research · done）**

- **搜索**：2 条 query —— 二次元火焰特效 参考；崩坏星穹铁道 火焰 配色
- **参考**：2 条 findings（image 1 / doc 1） —— `refs/ref-a.png`（同类高评分火焰，边缘有描边）、`https://example.com/article`（配色链…）
- **应用**：2 项（criteria 1 / start 1，来自 2 条 extracted）；**真正改了 2 项**（引擎自己比出来的，不认文件自报）
- **changed 清单**：
  - `criteria.size.weight 0.5 → 0.25`（依据：ref-a.png 的色相圆均值；confidence 0.7）
  - `start.alpha 2 → 2.28`（依据：参考图里光束更粗；confidence 0.5）
- **结论**：配色链：白芯→黄→橙→暗红
- **覆盖顺序**：adapter → intent → research（research 最后压）；判据与起点都会进 run 指纹
```

同一份内容也落成 `<out>/research.summary.json`（台帐 `02-research.json` 的 `artifacts` 指向它），
`best.json` 里还有一份机器可读的 `research` 块（含 `changed` / `affectsDistance`）。

### 2.5.5 指纹（为什么两次不同调研不会撞 hash）

`research.json` 的**声明内容**（`queries` / `findings` / `extracted` / `note`）进 run 指纹。
判据与起点本来也进指纹，所以内容一变 hash 必变 —— 但把内容本身也放进去，是为了
"这两次结论为什么不一样"能落在一个不同的 hash 上，而不是被同一个 hash 糊成同一次。
**没给调研产物**时指纹里是 `null`，跨目录重跑照旧同 hash。

### 2.5.6 它不做的事（别指望它）

- **不会自己从图里提数**：`extracted` 是人/agent 给的（从参考图量出色相、占比、粗细这件事在 agent 里做）；
  引擎只判定"这个值有没有真的落到判据上"。这是这一层最大的缺口，见 §7；
- **不按 `confidence` 打折**：0.3 的结论和 0.9 的结论一样生效（写清 `source` 是你自己的事）；
- **不校验 query 真的搜过**：它只记录"你说你搜了什么"，没有联网证据；
- **不改 `extract` / `norm` / 白名单 / 预算**：只改 weight / target / 起点值；
- **截图链路（`iter.ps1`）暂未接入**：research 只在命令链路（`cmdloop.mjs`）生效，见 §3.5。

---
