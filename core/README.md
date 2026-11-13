# core/ —— 领域无关的闭环引擎（三层里的中间层）

这一层只回答一个问题：**一份现场描述（adapter）够不够跑一轮闭环，缺什么。**

它不知道火柱、闪电、UI、接口是什么——那是 `domains/` 的事。它也不起浏览器、不算像素、不搜索——那是 `harness/` 的事。

## 三层怎么分

| 层 | 目录 | 放什么 | 换题材要不要动 |
|---|---|---|---|
| 入口 | `lib/` | 工具定义（`selfloop_probe` / `selfloop_list_adapters`）、参数与输出 schema、技能注册 | 不动 |
| 引擎 | `core/` | adapter 契约解析、硬错口径、清单与分组、harness 齐全性、Chromium 成本探测 | 不动 |
| 领域 | `domains/<domain>/` | 该题材的 `adapters/*.json` 与领域说明 | **只动这里** |
| 执行器 | `harness/` | `iter.ps1` / `capture.mjs` / `metrics2.js` / `score.js` / `finalize.js` / `apply*.js` | 不动（换题材不用动；真要改执行器，记 CHANGELOG） |

执行器为什么留在根上、不自称「core 的实现」：它是已经跑通的**产品资产**（PowerShell + Edge + `taskkill` 那套 Windows 进程卫生，实测过的）。为了目录好看去搬它、改它里面的路径，等于拿跑通的东西换排版。所以三层的边界体现在**谁引用谁**和**文档描述**上，不体现在把执行器搬进 `core/`。

`harness/` 的职责清单仍在 `core/adapter.js` 的 `HARNESS_REQUIRED` / `HARNESS_ROLES` 里——本层**读**它、校验它齐全，但从不写它。

## 三个概念（引擎与题材的分界）

任何新领域想接进来，只需把这三问答清楚：

- **观测**：任意能给出可比较数值的探针（渲染图、日志、接口响应、UI 状态）。
  vfx 领域用的是「冻帧后的 PNG」；换成日志就是「同一时刻的日志行数与错误码」；换成接口就是「响应体里某几个字段」。只要同一个输入跑两次能给出可比的数，就是合格观测。
- **判定**：可配置的判据与距离（不做裁判，只做粗筛与报警）。
  距离公式见 `harness/score.js`，指标见 `harness/metrics2.js`，两者都由 adapter 的 `metrics` / `score` 节配置。它能把候选排个序、把明显坏掉的报警出来；「好不好看」不能问它。
- **搜索**：可配置的参数空间（先扫活性，再选轴）。
  adapter 的 `params` 节给白名单，`freeze` 节给「同一时刻同 seed」的可比条件。**先扫活性再搜索**——这是硬规则，写在 `skills/selfloop/SKILL.md`。

## adapter 契约（本层唯一要守的东西）

一份 adapter = 现场描述。本层校验的硬错**只报执行器自己会抛的那几种**，其余一律进 `warnings`（工具不该比执行器更严）：

- 必填：`name` / `clientRoot` / `config.path` / `config.block` / `page.file` / `freeze` / `render` / `server`
- 只认：`freeze.protocol` ∈ `noloop-step | url-time`；`config.format` ∈ `vfx-block | flat-params`
- 只记账：配置文件不在、浏览器没命中、脚本指不到、`score.type` 不是 `l1`、指标为空

`domain` 字段**可选**：写 `"domain": "vfx-render"` 就让清单能按领域分组；不写的旧配置照常解析、照常跑，只是归到「未标注领域」。

## 引用方向

```
lib/index.js  →  core/index.js  →  core/adapter.js  →  只读 harness/ 与 domains/
```

单向。`core/` 不 import `lib/`；`harness/` 不知道 `core/` 存在。
