# selfloop 剩余待办 · 施工规格（2026-11-17 夜，给执行子代理）

> 已完成（0.28.0/0.28.1/0.28.2）：①改名 ③状态人话 ④标题精炼 ⑥胶囊行为 ⑦提交不停住 ⑧⑨⑩⑪按轮分组 ⑫状态卡 ⑬视觉(部分) ⑯输入不丢 ⑰模型下拉 ⑮吐槽2.5消费 ②吐槽窗口延后
> 以下为**剩余未做**，按优先级分组。每条都带判据。

## P0 · 今夜踩过的最痛的坑

### A1 自唤醒（㉒）
问题：程序发出 ticket 后只等 Agent；Agent 一停手就永久卡住（今夜断了 4 次，2 次是这个原因）。
要做：一个常驻 watcher —— 当 `<run>/tickets/<node>.json` 存在且超过 N 秒（默认 90s）没有对应产物/信号变化时，
往会话注入一条提醒（或写 `<run>/need-agent.json`，由客户端横幅提示 + 主 Agent 侧轮询）。
判据：模拟「出票但不交活」，60~120s 内出现提醒（测试用假 timer 注入，不真等）。

### A2 子代理吞斥监控（㉘）+ 进度（㉑）
`active-agents.json` 每项加 `lastSeenAt`/`status`；`/state.status` 汇总成 `2/3 已返回`；
超过 X 分钟无更新 → `status.stale=true` 并在状态文案里显示「已静默 X 分钟」。
判据：写一个 3 条 agents 的样例文件（2 done 1 running）→ `/state.status` 返回 `returned:2, total:3, stale:false`。

### A3 崩坏自检（㉞）
`verify` 加 `crashCheck`：每张验收帧统计①洋红像素占比（R>0.9,G<0.1,B>0.9）②纯色大块（连通域方差低且面积>1%屏）③全黑/全白；
任一项命中 → `crashCheck.fail`，且**优先于任何数值判据**。
判据：造 3 张假图（洋红块、纯黑、正常）→ 只有正常图 pass。

## P1 · 执行员的行为约束（㉖㉙㉔㉕㉗）
- 工单模板加字段：`maxSelfIterations`（默认 3）、`mustReportPerCriterion`（每项判据一行实测）、`stopRule`（超预算如实交「当前值+差多少+卡在哪」）
- skill 拆分：把「闭环/搜索」明确归属主 Agent 的 2.x；新增「执行员：只做本轮工单，做完即交，不自跑搜索」一节
- 交付自检清单（写进 skill + 工单）：贴完整帧 / 自查无洋红纯色块 / `GetShaderMessages==0`（Unity 类目标）/ 每完成一项就落盘 rounds
- mcp.ps1 调用坑写进 skill：`-Json` 必须 Plain JSON，额外转义会 `Invalid property identifier`
- 调试帧命名约定：`<stage>_<round>_<variant>_<t>.png` + 每次交付附 `frames.md` 索引
判据：`npm test` 里断言 skill 文件包含这几个标题（防止被删）。

## P2 · 数据归属正确性（㉝⑲）
- ㉝ 意向确认不许被挂到当前轮：只认 `rounds/r<N>/intent.confirm.json`；无归档显示「本轮无意向确认」
- ⑲ `/state.orders` 按会话隔离：只返回当前 session 的订单；本会话有未结束订单时 `/start` 直接 409
判据：两轮 run 的 r2 卡片不含 r1 confirm；两会话各一单互不可见。

## P3 · 交互与视觉（⑭⑱⑳㉛）
- ⑭ `POST /confirm` 允许任意阶段追加待确认问题（含 effort 下拉）
- ⑱⑳ 下单表单加「努力程度」下拉（low/high/max，默认 max），不支持的模型禁用并提示
- ㉛ 验收卡片布局 bug：内容容器 `min-width:0` + `overflow-wrap:anywhere`；折叠态 `max-height:0/overflow:hidden`
判据：折叠态高度 ≤ 折叠头+8px（DOM 尺寸断言）；表单提交体含 effort 字段。
## P0 · 补两条（用户指出：这两条才是今夜出事的根因，必须提到 P0）

### A4 自迭代要有边界，不是禁止（㉖㉙）
澄清（用户 2026-11-18）：**skill 允许子代理自我迭代**，但必须带停止条件，否则会把整晚预算耗在一个子代理身上（exec-cloud5 即如此）。
要做：`SKILL.md` 顶部加「角色分流 + 迭代边界」：
1. 主 Agent（2.1~2.5）负责跨轮闭环；执行员（2.2）可以做**有限**的本地自迭代。
2. **三条停止条件（满足任一即停）**：
   - **达到判据**（所有硬判据都在带内）→ 交；
   - **用满轮次预算**（默认 maxSelfIterations=3）→ 交；
   - **平台期**：连续 **2 轮无显著提升** → 交。判「无显著提升」的口径：任一主判据改善 <5%，或与上一轮交付帧的平均像素差 <2%。
3. 停下时**如实交**：当前值 + 差多少 + 卡在哪个约束（禁止「已优化」这种空话）。
4. 每轮自迭代留一行痕：`rounds/r<N>/iters.md`（第几轮、改了什么、判据/像素差变成多少）。
判据：`test/skill-executor.test.mjs` 断言 SKILL.md 含「最多自调」「无显著提升」「如实交」，且 executor-brief 含停止条件三条。

### A5 中间产物与参数自动存档（㊱）
问题：今晚丢了用户认可的那版云——代码能找回，参数与场景序列化值全丢（cloudCoverage 实机 0.88 没人知道何时被改）。
要做：交活即快照三件套 → `rounds/r<N>/snapshot/`：
1. `code/`：本轮改过的源文件；
2. `scene-params.json`：执行员用 MCP 导出的组件字段 + 材质值；
3. `params.md`：本轮每个参数的旧值→新值→为什么。
`pipeline.mjs` 在 `done --stage 2.2-exec-rN` 时校验三件是否齐：缺则写进 verify.caveat（不硬拦，留痕）。
另加 `harness/snapshot.mjs --run <dir> --tag <名字>` 供随时手动快照。
判据：`test/snapshot.test.mjs`。