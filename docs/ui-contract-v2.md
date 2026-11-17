# selfloop UI 契约（v2 · 2026-11-17 定稿）

> 后端与客户端同时改，**以本文件为准**。任何字段增删都要先改这里，再改两边。

## 1. `GET /plugins/dsh-selfloop/state` 返回

```jsonc
{
  "ok": true,
  "run": { "dir": "...", "name": "sl-xxx" },
  "title": "雷云优化",                 // 人类可读标题（orders[].title 同源）
  "requirement": "对 MonSlayer 现有雷云技能优化…",   // 原始需求正文（去 markdown 标题行）

  "status": {                          // 置顶「状态」用
    "text": "等待子代理执行",           // 节点 → 人话（见 §4）
    "node": "2.2-exec-r2",
    "agents": [{ "name": "exec-cloud4", "task": "云改 ParticleSystem" }],  // 读 <run>/active-agents.json
    "windowOpen": true,
    "returned": 2,                     // A2：已返回的子代理数（客户端显示「已返回 2/3」）
    "total": 3,                        // A2：名册总数
    "stale": true,                     // A2：超过阈值没更新 → 客户端红字「⚠ 已静默 X 分钟」
    "silentForMs": 660000,             // A2：最久没动静那条的静默毫秒数
    "failed": 0,                       // A2：status=failed 的条数（失败也算"回来了"，但不计入 returned）
    "running": 1,                      // A2：仍在跑（没写 status 的老条目按 running 算）
    "needAgent": false                 // A1 自唤醒：有个节点出票后 90s 没进展 → true（客户端挂提示条，见 §3b）
  },

  "orderState": "vent",                // wait-requirement | wait-agent | wait-reply | vent | review | running | finished
  "orders": [                          // 历史订单（下拉只显示 title）
    // ⑲ 会话隔离：只返回当前 session（?session=）的订单；没给 session 时只返回「没绑会话」的老订单。
    //    例外：明确 ?run= 点开的那一单总会列出。
    { "name": "sl-xxx", "dir": "...", "title": "雷云优化", "state": "finished", "current": true, "updatedAt": "..." }
  ],

  "rounds": [                          // ★按轮分组（本轮新增）
    {
      "round": 1,
      "confirm": { "questions": [ {id,question,options[],recommend,why} ], "answers": [ {id,chosen} ] },
      "interrupts": [ { "at": "...", "stage": "2.4-critique-r1", "text": "...", "expired": false } ],
      "plan":   { "orders": [ {id,task} ], "executor": "deepseek-v4-pro" },
      "verify": { "pass": ["..."], "fail": ["..."] },
      "review": { "verdict": "不合格" },
      "decide": { "action": "next", "gapsForNextRound": ["..."], "nextRoundOrders": [ {id,task} ] }
    }
  ],

  "models": {                          // ★可派活的模型（§5）
    "default": "由主 Agent 分配",
    "source": "live",                  // live = 宿主 llm 服务实时拉的；fallback = config/models.json 兜底
    // efforts：该模型能设的努力程度（⑱⑳）。缺这个字段 = 用标准三档 low/high/max；
    // 写成空数组 [] = 该模型不支持设定努力程度，客户端下拉禁用并提示
    "options": [ { "provider": "haituo", "model": "mimo-v2.6-pro", "label": "mimo-v2.6-pro（haituo）", "efforts": ["low", "high", "max"] } ]
  },

  // 兼容旧字段（客户端 v1 用过，暂不删）
  "currentNode": {...}, "nodes": [...], "budget": {...}, "intent": {...}, "research": {...},
  "plan": {...}, "verify": {...}, "review": {...}, "decide": {...}, "interrupts": [...],
  "shots": [...], "refs": [...],
  "confirm": { "legacy": true, "questions": [...], "answered": [...] }   // ㉝ 只为老客户端保留，永远不许当"本轮"
}
```

> ㉝ **意向确认的归属只认 `rounds/r<N>/intent.confirm.json`**：`rounds[]` 里该轮没有归档就是 `null`（客户端显示「本轮无意向确认」）。
> 顶层 `confirm` 保留但带 `legacy: true`，据此不再把它挂到当前轮。

## 2. `POST /start` 请求体新增

```jsonc
{ "requirement": "…", "title": "雷云优化", "refs": [...],
  "budget": { "research": "high", "maxRounds": 3 },
  "researchModel": { "provider": "haituo", "model": "kimi-k3.1-pro" } | null,   // null = 主 Agent 分配
  "execModel":     { "provider": "haituo", "model": "mimo-v2.6-pro" } | null,
  "researchEffort": "max",   // ⑱：调查模型的努力程度 low|high|max，缺省 max
  "execEffort":     "max",   // ⑳：执行模型的努力程度 low|high|max，缺省 max
  "session": "sess-xxx" }
```
落盘：`<run>/order.json` = `{ title, researchModel, execModel, session, at }`；`title` 缺省时由需求首句截前 12 字。

## 3. `<run>/active-agents.json`（主 Agent 派活时写，UI 只读）

```jsonc
{ "at": "…", "agents": [
  { "name": "exec-cloud4", "task": "云改 ParticleSystem",
    "status": "running",                   // 可选：running | done | failed（A2 起）
    "lastSeenAt": "2026-11-17T…" }         // 可选：最后一次有动静的时刻（A2 起；缺省回落 roster 的 at / 文件 mtime）
] }
```

> 老文件（只有 name/task）照旧能读：`/state.status.agents` **不会**硬塞 `status`/`lastSeenAt` 键（老客户端做深比较会炸），
> 但汇总里按 running 算（否则「吞斥」就漏了）。

谁写：**主 Agent**，每次派子代理时整体覆盖（流水线 `harness/pipeline.mjs` 不写这个文件，它只写 `active.json`＝「主 Agent 正在处理哪个节点」）。
不写就是空名册：`/state.status.agents` 返回 `[]`，UI 不许报错。

### 3b. `<run>/need-agent.json`（A1 自唤醒，watcher 写，客户端只读）

`harness/watch-ticket.mjs` 发现「当前节点的票在、但超过 90s 没有任何进展」时写：

```jsonc
{ "needAgent": true, "node": "2.3-verify-r1", "ticketAt": "2026-11-17T…",
  "waitedMs": 120000, "thresholdMs": 90000,
  "hint": "节点 2.3-verify-r1（验收：能跑 / 能看）出票后 120 秒没有任何进展：主 Agent 可能已经停手。…",
  "at": "2026-11-17T…" }
```

客户端据此挂提示条；主 Agent 侧轮询：`node harness/watch-ticket.mjs --run <dir> --once`（exit 0 = 该喊人了，3 = 还不用）。
该节点的信号一旦 `done`（或当前节点已经换人），`status.needAgent` 自动回落 `false`。

## 4. 节点 → 人话状态映射（后端 `nodeText()`，客户端不再自己映射）

| 节点 | 文案 |
|---|---|
| 1.1 | 量参考、建骨架 |
| 1.2 / 1.8 / 1.10 | 正在转译需求 |
| 1.3 / 1.4 / 1.5 | 等待子代理调查 |
| 1.6 | 核对调研完整性 |
| 1.7 | 吸收调查报告 |
| 1.9 | 等待用户确认意向 |
| 2.1-plan | 列工单 |
| 2.2-exec | 等待子代理执行 |
| 2.3-verify | 验收中 |
| 2.4-critique | 等待观察员评审 |
| 2.4b | 等待用户评审 |
| 2.5-decide | 决定要不要下一轮 |
| 2.6 | 等待补充调查 |
| 2.7 | 吸收调研结论 |
| 3.1 | 写总结 |
| 3.2 | 交付校验 |

## 5. 模型清单：宿主 llm 服务优先，`config/models.json` 兜底

**唯一事实源是宿主 cordis 的 llm 服务**（与 DSH 模型选择器同源）：`listProviders()` → 每个 provider 再 `listModels(id)`，
映射成 `{ provider, model, label: "<name>（<provider>）" }`，`models.source = "live"`。
拿不到服务、服务里一个模型都没列出来、或调用抛错时，退回下面这份静态清单，`models.source = "fallback"`。
live 结果按 llm 实例缓存 45s（`listModels` 可能打网络，不许每次 `/state` 都拉）。

`config` 跟着插件包走（`lib/routes.js` 按自身路径解析，不看用户 cwd）；`DSH_SELFLOOP_MODELS=<path>` 可覆盖。

客户端只看 `source` 显示「实时 / 兜底」，不要自己读文件。


```jsonc
{ "note": "可派活的模型清单；用户可在设置页或直接改这个文件",
  "models": [
    { "provider": "haituo", "model": "mimo-v2.6-pro",   "label": "mimo-v2.6-pro（读图强，执行试过）" },
    { "provider": "haituo", "model": "kimi-k3.1-pro",   "label": "kimi-k3.1-pro（禁用读图）" },
    { "provider": "haituo", "model": "deepseek-v4-pro", "label": "deepseek-v4-pro（默认执行）" },
    { "provider": "haituo", "model": "deepseek-v4-flash","label": "deepseek-v4-flash（快）" }
  ] }
```

## 6. 客户端契约要点

- 胶囊：无订单→`＋ 肥鱼接单`（虚线）；有订单→`肥鱼接单 · <状态>`；**跑单中点它＝打开/聚焦右侧栏**，只有无单或已结束才进接单模式。
- 面板：置顶「状态」卡（含子代理名册）+ 可折叠区（需求 / 意向确认 / 吐槽 / 调查与转译 / 验收），**按轮分组**，当前轮展开、历史轮折叠。
- 吐槽输入框：重绘前保存 value 与选区并回填；输入中 2s 内不重绘。
- 全部文案「肥鱼自治」→「肥鱼接单」。
- 视觉：分类色卡片 + emoji + 三档字号。
