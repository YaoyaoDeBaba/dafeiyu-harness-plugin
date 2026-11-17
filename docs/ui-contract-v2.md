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
    "windowOpen": true
  },

  "orderState": "vent",                // wait-requirement | wait-agent | wait-reply | vent | review | running | finished
  "orders": [                          // 历史订单（下拉只显示 title）
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
    "options": [ { "provider": "haituo", "model": "mimo-v2.6-pro", "label": "mimo-v2.6-pro（haituo）" } ]
  },

  // 兼容旧字段（客户端 v1 用过，暂不删）
  "currentNode": {...}, "nodes": [...], "budget": {...}, "intent": {...}, "research": {...},
  "plan": {...}, "verify": {...}, "review": {...}, "decide": {...}, "interrupts": [...],
  "shots": [...], "refs": [...], "confirm": {...}
}
```

## 2. `POST /start` 请求体新增

```jsonc
{ "requirement": "…", "title": "雷云优化", "refs": [...],
  "budget": { "research": "high", "maxRounds": 3 },
  "researchModel": { "provider": "haituo", "model": "kimi-k3.1-pro" } | null,   // null = 主 Agent 分配
  "execModel":     { "provider": "haituo", "model": "mimo-v2.6-pro" } | null,
  "session": "sess-xxx" }
```
落盘：`<run>/order.json` = `{ title, researchModel, execModel, session, at }`；`title` 缺省时由需求首句截前 12 字。

## 3. `<run>/active-agents.json`（主 Agent 派活时写，UI 只读）

```jsonc
{ "at": "…", "agents": [ { "name": "exec-cloud4", "task": "云改 ParticleSystem" } ] }
```

谁写：**主 Agent**，每次派子代理时整体覆盖（流水线 `harness/pipeline.mjs` 不写这个文件，它只写 `active.json`＝「主 Agent 正在处理哪个节点」）。
不写就是空名册：`/state.status.agents` 返回 `[]`，UI 不许报错。

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
