# CHANGELOG · dsh-selfloop（权臣）

> 规矩：**改了 `harness/` 里的执行器就要在这里记一笔**，并注明"要不要回灌上游原件（案例 A，见 README「案例与来源」）"。
> 这个文件是 0.3.4 起才有的；0.3.0~0.3.3 的条目是事后补的，按 git 提交信息还原。


> 这里是 **0.13.x 及以前**的历史记录（按时间倒序）。主 CHANGELOG 只保留 0.14.0 之后，避免越滚越大。

## 0.14.0（未发布）· 可视化查看器：run 目录直接丢给浏览器

> 触发：用户 2026-11-13 提的「工具要具象化、要有可交互界面，不只是命令行 + 证据包」，2026-11-16 拍板
> **直接推进到可视化版本**（他要在案例 A 上跑实战）。此前的"看得见"只到 `report.md` + `watch.mjs` 终端输出，
> 复盘里那条"0 支画面"警报的本质是**证据包没人愿意翻**。

- **新增 `harness/ui.mjs`（零依赖本地服务，只读）**：
  · `buildState(runDir)` 把一次 run 聚合成一份 JSON——`summary`（距离/降幅/预算/终止原因/seed/绝对时刻/画质档/白名单/决策指纹）、
    `curve`（`curve.csv` 全量点）、`shots`、`nodes`（台帐）、`intent`/`research`、`report` 原文、`live`（`live.jsonl` 末 300 条）；
  · 路由：`GET /api/state`、`GET /`（ui/index.html）、`GET /ui/*`、`GET /run/*`（run 目录静态文件，**带目录穿越防护**）；
  · **更新信号取 max(mtime)**（best.json / curve.csv / report.md / live.jsonl / shots / nodes）——跑的过程中 `best.json` 往往最后才写，
    只盯它会看不到进度；另给 `progress {curveRows, shots, nodes, live}`。
  · 老 run（无 `nodes/`、无 `live.jsonl`）一律降级为空，不抛错；run 之外的绝对路径（如 best.json 里指向别处）**清空**，不泄露本机路径。
- **新增 `ui/`（原生 HTML/CSS/JS，无框架、无 CDN、无构建）**：顶部 KPI 条 / 主对比区（`REF` 与任意帧：并排、可拖动分割线叠加、400ms 闪烁）/
  SVG 距离曲线（y 轴反向，悬停看该点参数，点选切帧）/ 胶片带 / 节点台帐时间线 / 报告折叠区 / 每 2 秒按 mtime 自动刷新。
- **用法**：`node harness/ui.mjs <run 目录> --port 7788 --open`（或 `npm run ui -- <run 目录>`）；`package.json` 的 `files` 加入 `ui`（正名单 12 → 13）。
- **新增 `test/ui.test.mjs`（7 条）**：CSV 解析 / 正常 run 的字段映射与图片相对路径 / 空目录降级 / live 只取末 300 条 / 本地服三个路由与目录穿越拒绝 / **弄坏能红**（把 run 外路径塞进 `bestPng` 必须被清空）/ `normRunPath` 归一（`curve.csv` 里写绝对路径也转成 run 相对路径，前端 `/run/` 才不会 403）。
- 实测（真 run `iter3`）：`GET /` 200 / `GET /ui/app.js` 200 / `GET /api/state` 200（curve 59 点、shots 59 张、bestDist 0.08039）/ `GET /run/shots/e001.png` 200 image/png。

## 0.13.3（未发布）· SKILL.md 收成索引：4,122 字符 / 115 行（评审目标 6,000 / 120）

> 0.13.1 拆完 references 后 SKILL.md 还剩 6,217 字符 / 157 行，比评审建议的 6,000 / 120 超一截。
> 病根还是"索引当摘要写"：**怎么跑一轮**那一节 29 行 / 1,619 字符，把命令、产物清单、纪律、报告要素
> 全塞在索引里——那是"动手时"要读的东西，不是"我该读哪篇"时要读的东西。

- **抽出 `references/run-recipes.md`（2,634 字符 / 67 行）**：两条执行器怎么选 + 画面链路完整命令 +
  一次 run 的产物清单 + 需求转译闸怎么过 + 纪律 + 报告里必须写清的九项。
  SKILL.md 里那段 29 行换成 **4 行指针**（三样输入 / 换目标换 adapter / 跑前过闸 / 细节在这篇）。
- **两条执行器的表从 SKILL.md 移走**（表本身没问题，问题是它占了索引的版面；"选哪个"是动手时的问题）。
- SKILL.md 6217 → **4122 字符**，157 → **115 行**，评审两条目标线都过了。
- **`test/skill-split.test.mjs` 补一条**：SKILL.md ≤ 6,000 字符 / ≤ 120 行（超了红）——把这次的目标固化成门禁，
  以后想往索引里塞细节会当场被拦。
- 索引表补一行「真的跑一轮 → run-recipes.md」。

## 0.13.2（未发布）· 吸收需求翻译器第二轮增量（三处实拍证据 + 自检七问 → 十问）

> 来源：案例 A 的 `vfx-req-translator`（2026-11-15 修订版，随案例移交）。**许可：自研，随案例移交，未单独声明开源许可证 → 不外发原文，只吸收判据表述。**
> 落位判断（按吸收协议 §一「只吸收一种能力：需求 → 技术指标的转译」）：这三处全是**需求书措辞**层面的经验，换到"把压缩体积压到 37%"这种目标上**用不上**（压缩比不需要"色散强度 ≤0.5×线宽"这类口径）→ 全部落 `domains/vfx-render/`，**core 不动**。
> 已有部分不重复搬：三条实现铁律、十一条硬契约、`uDebug` 六档、像素尺子 `pxPerUnit` 公式在 `glsl-guardrails.md` 与本文 §6.1 里早已吸收（2026-11-15 修订时已同步）。

- **§3.5 主观词 → 客观指标：12 行 → 15 行**（`domains/vfx-render/references/demand-translator.md`）
  · 新增「对比/层次（比值类）」：**比值 + 绝对尺寸必须同时约束**——实测脉络÷岩体 luma 比值 3.57「达标」，但脉络只有 2px 宽、屏幕上根本看不见；
  · 新增「多少（数量区间）」：**必须给上下限**——只写「密集」同一模型两版给出 30 根 vs 5 根；只写「暗部 ≥50%」做到 91%，把岩体做成褐色触手、熔岩脉络反而没了；写成「50%~70%」才可控；
  · 新增「色散强度」：**通道偏移像素宽度 ≤ 该处线宽的 k 倍**——只写「强 RGB 色散」会刷成彩虹肥皂泡；
  · 改写「蓬松/柔和」：带宽必须**由屏幕梯度反推**（`fwidth(场) × 目标像素数`），不能用固定场值差——实测场值差 0.06 在一根火舌上只对应 0.7px，出来是 1px 硬线；
  · 表格下加「三条贯穿全表的口径」：比值配绝对尺寸下限 / 量多少给区间不给单边 / 过渡换算到屏幕像素。
- **§7 需求书自检：七问 → 十问**
  · 新增 8「时间轴 vs 端点断言」（`t=0 无残留` 与 `0~0.2 蓄力` 打架）；
  · 新增 9「可数性口径」（`≥18 枚` 没说是峰值帧还是任意帧、多小算一枚）；
  · 新增 10「做不到的公式」（无后处理管线要求 bloom / UV 扭曲 / 菲涅尔）；
  · 前七问各补一行**实拍症状**，收尾加一句总口径：每个「数量/距离/时刻/档数」都要能回答「在哪个范围、以什么基准、怎么算出来的」。
- **新增 `test/demand-translator.test.mjs`（5 条）**：元信息四行 + 第二轮增量标注 / §3.5 四个新口径 / §7 十问与后三问 /
  `glsl-guardrails.md` 的 11 条契约与 3 条铁律 / **弄坏能红**（删「色散强度」、把十问改回七问都必须报缺）。
- **没做的**：`SKILL.md` 里「派单必须让 agent 自己出图」这条**本轮未并入**——它属于"派单流程"而非"指标翻译"，且与既有 §8 第 1 条有冲突待定，留给下一版。

## 0.13.1（未发布）· skill 按「读者在什么时刻需要它」拆篇（不改任何行为）

> 触发：2026-11-15 插件大总管评审（`docs/评审-selfloop-skill体量-20261115.md`）。
> 结论是"内容值这个体量，但不该由一个文件承担"：`intent-and-ledger.md` 37,316 字符 / 881 行，
> 是六份东西粘在一起；`read` 一次给整篇、而且常常只给开头，**读到的顺序不对**比读得慢更伤。

- **references 8 篇 → 13 篇，拆点按"读者在什么时刻需要它"切，不按章节顺序切**：
  · `intent-and-ledger.md`（37,316 字符）→ `intent.md`（8,691）/ `invariants.md`（4,503）/
    `intent-errors.md`（3,024）/ `research-node.md`（4,409）/ `chains-and-gaps.md`（6,825）/
    `ledger-and-report.md`（11,394）
  · `command-observe.md`（15,726）→ `observe-command.md`（7,088）/ `observe-stability.md`（9,303）
  · **章节编号一律保留**（§1.7、§2.5.1、§6.3…），因为引擎的报错原文里点着这些号，改了就对不上。
  · 拆分用脚本切片、逐行比对：原文 990 行非空行里只少了两个 H1 标题，其余一字不丢。
- **每篇开头 20 行内回答三件事**：这份文件回答什么问题 / 什么时候读它 / 结论先说。
  五篇老文件（workflow / metrics / pitfalls / host-adaptation / domains-vfx）补上了「什么时候读」一行。
- **SKILL.md 索引改成「我要…… → 读哪篇」**（13 行表格），不再按"文件 → 内容"罗列。
- **新增 `test/skill-split.test.mjs`（6 条）**：单篇 >12,000 字符红 / 开头 20 行必须有「什么时候读」/
  SKILL.md 索引与 references 目录一一对应（点了名的不许缺、存在的不许没登记）/ 旧的两个大文件不许回来 /
  包内文档与 SKILL.md 不许再引用旧文件名（CHANGELOG 豁免）/ **弄坏能红**：12,001 字符必红、12,000 不红。
- **旧文件名的指针同步改掉**（共 10 处）：`README.md` 2 处、`harness/invariants.mjs` 报错文案、
  `harness/适配层-说明.md` 2 处（其中 §6 稳定性闸那条改指 `observe-stability.md`）、
  `examples/command-demo/probe.mjs`、`examples/command-compress/probe.mjs`。
  → **`harness/invariants.mjs` 动了**：属于"改了执行器就要记一笔"的范围，但只改一句文档指路（无逻辑），
  **不需要回灌上游原件**（案例 A）。
- 未做的事：`SKILL.md` 6,217 字符 / 157 行，与评审建议的 6,000 字符 / 120 行还差一点；
  再压就要删正文，留给下一版。

## 0.13.0（未发布）· 掩膜哨兵：拦住"看起来很专业地量错"

> 第二轮实验的真实死法：`luma:200` 的 content 掩膜只圈到枪口白芯（recall 0.09~0.38），
> 三个参数不同、输出图 SHA 不同的候选，掩膜内指标**逐位相同**——指标层看不出来。

- `metrics2`：`maskInfo` 加 `maskHash`（掩膜位图 FNV-1a，8 位 hex；回退全图/无掩膜为 null）。
- `cmdlib`：新增 `observe.parse:"image"`（命令 stdout 只打印一张 PNG 路径，指标由 metrics2 的
  extract/opts 算；同时算全帧口径作对照），返回 `pngSha` + `maskFp`。
- `cmdloop`：评估循环维护跨候选哨兵——同一轮出现 ≥3 个"参数不同、观测 sha 不同，但 maskHash
  相同且掩膜内指标向量逐位相同"的候选 → 硬错 `maskFrozen`，错误信息点名 maskHash / 掩膜口径 /
  三个候选的 sha 与参数，并给改法（换 roi 或 diff）；2 个只 warn；`--no-mask-sentinel` 可关。
- `intent.maskSentinel`：截图链路要求哨兵 → 硬错（与硬不变量同处理）。
- 刻意偏离：`roi` 口径不参与硬错（固定矩形 maskHash 天然恒定，同组只说明"指标对参数不敏感"）。
- 测试：`test/mask-sentinel.test.mjs` 7 条；`npm test` 182 → 189。
- 已知漏点：指标本身对参数不敏感（需另一条"指标活性"闸）；掩膜漂移但一直圈错（低 recall 不冻住）无人管；
  混合掩膜口径时 `maskInfo` 被最后一个提取器覆盖；FNV-32 理论上会碰撞。

## 0.12.0（未发布）· 掩膜扩到四种口径 + 正对照升级为**双向**（第二轮实验推翻了 0.11.0 的两处设计）

> 这一版不是"再加几个指标"，是修**"看起来很专业地量错"**。两条实验证据把 0.11.0 的两处设计直接推翻了：
>
> **证据①（推翻 0.11.0 的掩膜）**：`luma:200` 的 `content` 掩膜在真实场景**圈错了**——舞台天空 luma≈95~110、
> 火焰体中位数≈124，`luma>=200` 只剩枪口白芯：对真主体的 **recall 只有 0.09~0.38**。
> 最硬的反证不是 recall 低，是**逐位相同**：三个不同变体在三个时刻的掩膜内指标一模一样
> （`7305.98|0.21296|0.11216`）——最大连通域在"枪口团"和"射线"之间跳，等于把不同变体量成同一块像素。
> **圈错的掩膜比没有掩膜更危险：它不报错、不崩，看起来非常专业。**
>
> **证据②（推翻 0.11.0 对 stepRatio 的定位）**：正对照失败。高斯模糊 `lapVar −99.7%` / 锐化 `+169%`
> （剂量单调、方向正确），而 `stepRatio` 在**模糊和锐化两个相反方向上同向下降**（−49~−80% 与 −51~−81%）。
> 一个在"变平"和"变细"时都下降的量，量的不是细节量，是**直方图断崖**——不能当细节指标用。
>
> 结论：`lapVar` 这层可用；掩膜与 `stepRatio` 需要改造。下面四件事就是改造。

- **① 掩膜从 1 种扩到 4 种**（`harness/metrics2.js`），`opts.mask.mode` 认
  `content` / `roi` / `diff` / `chroma` / `none`：
  · `content`（保留）：按 `luma >= luma` 圈 → 最大连通域 → 膨胀。**只适合亮主体 + 暗背景**。
    **新增健全性检查**：面积 <1% 或包围盒 <5% → `maskSuspicious:true` + `maskSuspectReasons[]`
    （写清踩了哪条门槛）。这是把"圈到了小块高光"从"没人发现"变成"机器先喊"。
  · `roi`：`rect:[x,y,w,h]` **固定矩形，完全不看像素内容**——跨帧/跨变体完全一致（实验里证明这是唯一稳的口径）。
    越界**夹紧并 warn**（`maskWarn[]` + `requested`），不静默裁掉也不静默改用全图。
  · `diff`：`ref:"<背景/空舞台 png>"` + `delta:12`，`|luma 差| > delta` 为前景 → 最大连通域。
    这是"分不清亮主体与亮背景"的正解；ref 与候选尺寸不一致 → 硬错。
  · `chroma`：`predicate:{channel,op,value}` 按色度圈（暖主体 vs 冷背景）。
    `channel` 只认 `r/g/b/luma/blue-minus-red/red-minus-blue/saturation`，`op` 只认 `< <= > >=`，写错**硬错**。
  · 四种都支持 `dilate` / `minAreaPct`，回退行为与 0.11.0 一致（`maskFallback:true`，不许静默）；
    `maskInfo` 追加 `bboxPct` 与模式专属口径（`roi` 实际矩形 / `diff` 的 ref+delta / `chroma` 的谓词）。
- **② `stepRatio` 降级 + 新增 `levelCount`**：
  · `stepRatio` 保留，但 `desc` 与注释写死「**只测量化/剁档，不测细节；不得用于"更平/更细"的判断**」。
  · 新增 `levelCount`：掩膜内**唯一 luma 取值数**（连续渐变 256 → 4 档硬切 4）。同样**只声称量化代理**。
    已知边界（实测）：模糊会把取值个数压窄（95 / 51），dither 会把它填回中间值（4 档 + ±2 级抖动 → 20），
    所以它只适合"连续 vs 硬切几档"，别拿去判 dither 有无、更别判细节。
- **③ 正对照纪律升级为「双向」**（`test/metrics.test.mjs`）：
  · 新增 `DETAIL_METRICS`（声称"细节"的指标，现在只有 `lapVar`）：必须**模糊↓ + 锐化↑ + 剂量单调**，
    由 `assertBidirectional` 三个断言一起钉住，**只测一个方向就算没标定**（这正是 `stepRatio` 翻车的形状）。
  · 新增 `QUANT_METRICS`（`stepRatio` / `levelCount`）：正对照只认"连续 vs 硬切 4 档"，**与 `DETAIL_METRICS` 不许有交集**。
  · 反向自检：`assertBidirectional('zzOneWay', ...)`（锐化不涨）与 `('zzNoDose', ...)`（剂量不单调）必须当场被拒。
  · `stepRatio` 多一条**口径断言**：对模糊/锐化两个方向都不显著变化，且同一组图上 `lapVar` 两方向都翻得动
    （证明"不是图没变，是它看不见"）。
- **测试**：`test/metrics.test.mjs` 9 → **20 条**（新增 11）。合成图新增 `det_base/det_blur1/det_blur2/det_sharp`
  （双向细节对照）、`stage_bg/stage_fire`（还原实验现场：亮舞台 + 暖主体）、`warm_cold`（chroma）。
  实测：`stepRatio` 0 → 1.0；`levelCount` **256 → 4**（64×）；`lapVar` 455.5 → **155.85（−65.8%）** →
  **12.05（−97.4%）** → **1191.46（+161.6%）**；`content(luma:200)` 面积 **0.39%** / recall **0.03** /
  `maskSuspicious:true` vs `diff(ref=空舞台, delta:12)` 面积 **13.21%**（= 真值）/ recall **1.00**；
  `chroma(b-r<-20)` 在"暖块 + 冷背景"图上面积 **18.311% = 真值**、冷背景误收 **0**、precision **1.00**，
  在"亮舞台 + 白芯"图上面积 12.82% / recall 0.97（近白的高光芯按谓词定义不算暖色，漏掉 3%）；
  `roi` 同一矩形在三张图上 `count` 完全相同（10404 / 10404 / 10404）、越界 `[-20,200,400,200]` → 夹成 `[0,200,256,56]` + warn。
  **六条弄坏能红**（前三条 0.11.0 就有，后三条本版新增，全部写成可复跑的用例）：① `stepAlwaysCliff`
  ② `legacy3x3Speckle` ③ 塞没标定的新提取器
  ④ `noContentSanity`（删掉健全性门槛 → `maskSuspicious` 断言红，且变异版**照样给数、不崩**，两条用例红）
  ⑤ `diffAsContent`（diff 退回 content(luma:200) → 面积 0.389%、recall 塌到 0.029，diff 那条用例红）
  ⑥ `stepAsDetail`（`stepRatio` 改成随取值个数变化 → 波动 0.5391 ≫ 门槛 0.05，口径 + 量化两条用例红）。
  `npm test` 实测：**182 条全绿**（原 171 + 新增 11），`test/metrics.test.mjs` 单独跑 **20 条全绿**。
- **文档**：`skills/selfloop/references/metrics.md` §8 重写成四种口径 + 醒目警告
  （「`content` 按亮度圈，白天/雪地/亮背景会圈错；跨帧比较请用 `roi` 或 `diff`」）+ §8.1 实验现场表；
  §9 重构成"三套量各管一件事"，`stepRatio` 降到"量化代理"、新增 §9.2 `levelCount`、
  §9.4 双向正对照纪律（含合成图表与实测数字）。`harness/适配层-说明.md` §4.3 清单 12 → **13**，
  §4.3.2 重写成四种口径 + `maskSuspicious` + `roi` 夹紧，§4.3.3 改成双向纪律 + 五条变异。
- **硬约束**：不 commit、不 push、**不改版本号、不改 `package.json`**（`version` 仍是 `0.11.0`，接线留给发布）。
  `test/metrics.test.mjs` 已在 `npm test` 脚本里（0.11.0 的"待接线"已在某个时点接上），
  所以本版 `npm test` 是 **182 条**（原 171 全绿 + 新增 11）。
- **回灌上游**：`metrics2.js` 只**新增**了三种掩膜模式、`levelCount` 与回执字段，老路径数值不变，可整文件回灌；
  `score.js` / `iter.ps1` / `finalize.js` / `core/` / `lib/` 未改（领域词零新增）。

## 0.11.0（未发布）· 指标层：掩膜 + 剁档/噪点两个新量 + 正对照纪律

> 这一版不是"加几个指标"，是**修指标为什么会瞎**。两条实验的结论都是同一件事：
> **指标先瞎了，后面所有搜索都在优化一个错的函数。**
> ① 现有 `posterizeRatio` / `hueBands` / `flatNoise`（实验侧临时实现，不在本仓库）对**肉眼明显可见**的
> 人造 posterize（逐像素抖动 + 硬切 4 档）只有噪声级反应；`flatNoise` 甚至零响应——它的"3×3 极差 <8"
> 门限把噪点/台阶边**自己的像素**排除掉了（结构性盲区，不是参数没调好）。
> ② 全帧统计被背景稀释：火焰只占画面 3.8~6.4%，指标几乎量不到主体。
> ③ 跨批次比较会因为换题材/换占屏比产生假趋势（实测出现过 `p=0.0034` 的假相关）。
> 三条都指向同一个修法：**先圈对区域，再用"已知变坏"的图证明这个量真翻得动。**

- **掩膜（masked stats）**：`harness/metrics2.js` 的提取器统一支持 `opts.mask`
  （`{mode:"content", luma:40, dilate:1, minAreaPct:0.2}`）：按 `luma >= luma` 圈前景 → 取**最大连通域**
  （8 邻域）→ 可选方形膨胀；`mean/p160/lapVar/warmFrac/coldFrac/hueHist/hueMean/cov/maskIoU/bbox`
  的分母全部换成**掩膜内像素数**。面积占比 < `minAreaPct` 时退回全图，但 `extractOne` 会在该图的返回对象上
  标 `maskFallback:true` 并给 `maskInfo`——**不许静默**（"以为在量主体、其实在量整帧"正是这次的原始病灶）。
  不写 `opts.mask` → 与升级前逐字节一致（162 条老测试全绿即契约）。`diag` 保持全图口径，不动老证据包的可比性。
- **两个真能测「剁档 / 噪点」的新提取器**（阈值取实验 P/R 正对照标定出来的量级）：
  · `stepRatio`：256 桶 luma 直方图的**断崖占比**（`bin[i] > 0.05%` 且 `bin[i+1] < bin[i]×0.1` → 记一次；
    除以非空 bin 数）。硬切档在直方图上是空档，与像素位置无关，所以不怕稀释也不怕位移。
  · `speckleFrac`：像素与其 **8 邻域 luma 中位数**之差 > `speckleDelta`(24) 的占比。中位数对"自己是尖点"免疫，
    所以孤立点一定被推出来——这正是老 `flatNoise` 做不到的（它数平坦像素，噪点把自己从统计里删掉了）。
- **正对照纪律（这次最重要的产出）**：新增 `test/metrics.test.mjs`（9 条），用代码生成合成图（**不联网**）：
  `smooth`（连续渐变）、`banded4`（硬切 4 档）、`speckled`（孤立点）、`small_subject`（主体占 5%）、
  `subject_only`（主体纯图，当尺子）、`tiny_subject`（掩膜回退）。
  实测：`stepRatio` 0 → **1.0**；`speckleFrac` 0 → **0.04032**；5% 主体下 `lapVar` 全帧 **427.21** vs 掩膜内
  **7917.72**（主体纯图 6400），稀释 **18.5 倍**。
  纪律本身也进了测试：`EXTRACTORS_WITH_POSITIVE_CONTROL` 清单 ↔ 真断言双边钉住，往注册表里塞一个没标定的
  提取器会直接红（`checkLedger`）——**以后谁加指标不带标定，测试拦他。**
  两条弄坏能红：`SELFLOOP_METRICS_MUTANT=stepAlwaysCliff`（断崖判据放宽到永真 → 剁档对照红）、
  `SELFLOOP_METRICS_MUTANT=legacy3x3Speckle`（换回老的 3×3 门限 → 噪点对照红，实测 0.637 vs 1.0）。
- 文档：`skills/selfloop/references/metrics.md` 新增 §8 掩膜、§9 两个新量 + 正对照纪律（含"怎么判断掩膜圈对了
  主体"三条自查）；`harness/适配层-说明.md` §4.3 清单 10 → 12，新增 §4.3.2 / §4.3.3。
- **待接线**：`test/metrics.test.mjs` 尚未写进 `package.json` 的 `test` 脚本（本版按约定不改 `package.json`），
  接线方式：`... && node test/metrics.test.mjs`。因此 `npm test` 仍是 **162** 条，新测试单独跑是 **9** 条。
- 回灌上游：`metrics2.js` 只**新增**了 `opts.mask` 与新提取器，老路径数值不变，可整文件回灌；
  `score.js` / `iter.ps1` / `finalize.js` 未改。
## 0.10.0（未发布）· 判据必须带用户原话与量法 + 领域翻译器升级

> 外部实跑两轮后的修正版吸收：最值钱的是「主观词 → 客观指标」十二组对照；
> 最该防的是「为了显得专业编一个看似精确的假指标」——历史上"越修越平"就是这么来的。

- **intent v2.1**：`criteria[]` 新增 `userWords`（用户原话）与 `howMeasured`（怎么量）。
  两个都空 → **硬错**「这条判据没有任何用户原话/量法，等于凭空编的指标」；只有一个 → 允许但节点
  `degraded` 并写清缺哪个；`howMeasured` 写「暂无口径，靠参考图对照」→ 允许 + warn
  「这条靠人看，搜索不能拿它当判据」。两者都不参与距离计算，只进台帐与报告摘要。
  （判定收紧为"空串也算没有"——留空蒙不过去。）v1 intent 仍能跑，reason 里补一句缺这两个字段。
- **领域资产升级**（domains/vfx-render/references）：
  · `demand-translator.md` 从"需求润色器"改写成**主观→客观的翻译器**：新增 §0 定位与两条越界线、
    §3.5 十二组对照（用户话术→客观指标→怎么量）、骨架升十节且**末节必须是验收指标表**、
    技法全部条件式（附 11-15「12 份需求全被套硬描边」反例）。
  · `glsl-guardrails.md`：八条硬雷 → **十一条硬契约** + 三条实现铁律（draw() 必须 useProgram /
    极径不做 varying / quad 四边界精确为 0）。
  · `pitfalls.md` 新增「需求书内部不自洽」七类（时间轴矛盾、形态数量不一致等）；
    `no-bloom.md` 明确降级**可选**，不是标准答案。
  · 过时事实修正：「1 世界单位 ≈120~140px」→ 公式 + 实测（92 px/单位、贴地径向 13~38 px/米、俯角 13°）。
- 测试：domain-assets 6→8（钉住"映射表 ≥10 组"与"十一条不许退回八条"）、intent 19→24；
  `npm test` 合计 **162**，含两条弄坏能红（删映射表行 / 把十一条改回八条）。

## 0.9.0（未发布）· 调研节点 + 起点即目标的静态提示

> 这一版把台帐里缺的那个节点补上：**开干之前到底有没有搜、搜到的东西有没有真的改变判据**。

- **esearch 节点（命令链路）**：--research <file> 或 <out>/research.json，结构 {queries, findings[], extracted[], note}。
  - indings[].kind=image 的 ef 必须真实存在；xtracted[].apply 只认 criteria/start，id/name 必须在 adapter 里存在；queries 为空时必须写 
ote 说明为什么没搜。
  - **changed 由引擎自己算**（对比应用前后），文件里自报的 changed 一律忽略并 warn；应用了但一项没变 → 节点记 degraded，理由「装饰性调研」。
  - 没给产物 → skipped + 一行 warn（跑通，不拒跑）；research 内容进 run 指纹，两次不同调研不会撞 hash。
  - 报告顶部多一段「调研（research · done/degraded/skipped）」，列出 query、findings、应用项、changed 清单与结论。
- **起点即目标的静态提示**：selfloop_probe 解析 adapter 时，若 	arget.params 与白名单起点（
ame=初值 写法）完全一致 → 一条 warning「搜索没有起点差异可用」，不用跑一轮才发现。白名单只写名字（给不出初值）或 	arget.mode=metrics 时判不了，代码注释里写明「只能跑起来才知道」。
- 测试：plugin 55→57（T16c/T16d）、新增 research 10 条；
pm test 合计 **155**。

## 0.8.0（未发布）· 门禁自己也要被验收：假门 / 写死了 / 贴阈值 + 拿今天的标准复算旧 run

> 这一版动 `harness/`（`cmdloop.mjs` / `invariants.mjs` + 新文件 `audit.mjs`）、文档与测试。
> **不动 `iter.ps1`、`finalize.js`、`core/`、`lib/` 的执行逻辑**；不改版本号（bump 留给发布）。
> 回灌上游：**不需要**。0.7.0 那道门禁是本包自己的判据结构，审计与复算同理。

**为什么**

0.7.0 把"合格/不合格"从距离里拆出来了，但门禁本身没人验收。三种病在 `report.md` 里看不出来：

- **假门**：写宽了（永远为真）的不变量，`rejected` 恒 0。**假门比没门更危险** —— 它让人以为底线被守住了；
- **写死了**：一条不变量把整段搜索都拒了，引擎只报 `stagnant`，看起来像"参数没救"，其实门禁是元凶；
- **事后改了判据**：门禁只在**当下**判，旧 run 的 `best` 是不是还合格，没有任何机制重算。

**四个改动**

1. **假门告警**（`invariants.mjs` 的 `fakeGateFindings`）：跑完对每条不变量看 `rejected`——
   `rejected === 0` 且本次评估 ≥ 10 次 → 终端 warn
   `硬不变量 <id> 本次一次都没拦住候选（评估 N 次，报告里标「本次未拦任何候选」）——门可能是写宽的（永远为真），或者这段参数空间根本不碰它。假门比没门更危险，因为它让人以为底线被守住了。`
   报告「硬不变量」那节多一列 `本次`（`⚠ 本次未拦任何候选` / `—`）+ 一段「假门告警」。
   `--no-fake-gate-warn` **只关终端**，报告与 `best.json` 照写（开关不改事实）。
2. **"写死了"的归因**（`cmdloop.mjs`）：搜索里连续 3 轮**没有任何新候选**过门禁（或某一轮 0 个候选能过门）
   → 早停，`stop=invariant-blocked`（新增 stop reason，进 `report.md` 与 `best.json`）。
   提示里点名 **"是门禁挡住了搜索，不是参数死了"**，列出被频繁拒绝的 invariant id 与最近一次观测，
   并与「参数全 dead」（预检阶段每根轴改一档距离一点不动 → `all-dead` / `no-alive-after-precheck`）明确区分。
   另外：`--max-stagnant` 默认 2 会先停，所以**已经发生的 stagnant 停机**如果每一轮都是"没有新候选过门"，
   归因也改写成 `invariant-blocked`（只改归因，不多跑一轮）。
3. **目标贴阈值提醒**（`invariants.mjs` 的 `thresholdProximityFindings`）：目标观测**通过**但离边界
   < 1%（小数值）或 < 1e-6（整数对整数）→ warn `目标离不变量 <id> 的阈值很近（观测 x / 阈值 y）——判据下一版微调就可能翻脸`，
   报告里单列「目标贴阈值」。只对 `< <= > >=` 判（`==` / `!=` 的通过天然贴着那个值，报了等于每轮都报），跳过 `not` 节点。
4. **新增 `harness/audit.mjs`**：`node harness/audit.mjs <run目录> --intent <intent.json> [--json] [--strict]` ——
   读旧 run 的 `best.json` / `curve.csv` / `outputs/`，用**当前** `intent.invariants` 对**每个历史评估点**重新判定：
   ① 多少点现在不合格；② 当时的 best 今天还合不合格；③ 不合格时在"今天合格"的点里按**当时记录的 d** 挑新的最优并给参数
   （目标锚点不算候选：它 d 恒为 0）；④ 一个合格点都没有时明说"按今天的标准，这一轮没有可用结果"。
   退出码 `0`=best 仍合格、`1`=今天不合格（`--strict` 时"有更优点"也算 1）、`2`=跑不起来（缺 `best.json`/`curve.csv`/`outputs/`、
   截图链路、intent 文法错）—— 一律中文说明。`--json` 给界面读（`total / nowInvalid / bestOk / suggestedBest / reasons / points / warnings / exitCode`）。
   **只对命令链路生效**：截图链路没有 `outputs/` 与字段表，遇到直接报"暂不支持截图链路"，不拿旧结论证明旧结论。

**指纹**：门禁文法（id + 判据文本）仍在 `hash` 里；新加的三种病是**观测结论**（拒绝次数 / 目标观测 / 轮次），
**不进指纹** —— 换 `--out` 目录重跑，`hash` 必须还是同一个（`test/command.test.mjs` 钉着）。

**已知限制（重要，别当 bug）**

- 假门告警的门槛是 10 次评估：小 run（预检就停）不会报 —— 3 次没拦住什么都说明不了；
- "写死了"的判据是"这一轮**除了当前最优**没有任何候选过门"。`coordinate` 策略下，已经被缓存过的合法邻居
  会让这条判据不成立（那一轮不算"全被拒"），所以这个 early-stop 主要出现在 `random` 策略与真·全拒场景；
- 贴阈值提醒只看**目标那一个点**，不回溯历史点；`not` 与 `==` / `!=` 不参与判定（口径见 §1.7）；
- 复算不改距离：`criteria` 的权重/目标值改过时，`audit` 只重判门禁、仍按当时记录的距离挑新的最优（`--json` 里有 warn）；
- **旧 run 的 `outputs/` 被清掉就没法复算**：`audit` exit 2 并说明。唯一的补救是用 `best.json` 的 `meta.command`
  原样重跑一次（换新的 `--out` 目录）。

**测试**

- `test/invariants.test.mjs` 新增 3 条（10 → 13）：⑪ 假门告警（同一轮里既有会拒绝的、也有永远为真的 ——
  删掉 `rejected==0` 的检查，会拒绝的那条也会被当成假门，断言必红）；⑫ `stop=invariant-blocked` 早停
  （点名 id、与"参数全 dead"区分、第 3 轮就停；把归因改回 `stagnant` 必红）；⑬ 目标贴阈值（终端与报告各恰好一次）。
  两条"弄坏能红"都实做过并贴了输出。
- 新增 `test/audit.test.mjs`（5 条）：更严的 intent → exit 1 + 新最优是被判违规之外那个；更松 → exit 0（`--strict` → 1）；
  缺 `outputs/` → exit 2 + 中文；`--json` 字段齐；截图链路 → exit 2 + "暂不支持截图链路"。
- `npm test`：55 + 12 + 21 + 19 + 6 + 6 + 13 + 5 = **137**（原有 129 全绿 + 新增 8）。
- 顺手记一个**本次发现的既有问题**（未修，不在本版范围）：`adapter.target.params` 与起点参数**完全相同**时，
  目标那一次评估被缓存成 `dist=null`，随后起点读缓存 → `Cannot read properties of null (reading 'toFixed')` 崩。
  症状罕见（目标=起点时本来也没得搜），但确实是崩溃而不是硬错。

**文档**

- `skills/selfloop/references/intent-and-ledger.md`：§1.7 新增「门禁自己的三种病」、§6.3 报告那一节改样例
  （`本次` 列 + 假门/贴阈值/`invariant-blocked`）、§7 的「不变量写错、事后来才发现」改成 **已补（0.8.0）**、
  新增 **§8 复算历史结论（audit）**（用法 / 四件事 / 退出码 / 什么时候该跑 / `outputs/` 被清掉怎么办），§9 自查补两条；
- `README.md`：用法段补"门禁自己的三种病"与 `audit.mjs` 一行，测试段补 `audit.test.mjs` 与 137 的总数；
- `package.json` 的 `test` 脚本加上 `node test/audit.test.mjs`（**版本号没动**）。



## 0.7.0（未发布）· 硬不变量：给闭环加一层「合格/不合格」

> 这一版动 `harness/`（`cmdloop.mjs` / `cmdlib.mjs` / `intent.mjs` + 新文件 `invariants.mjs`）、文档与测试。
> **不动 `iter.ps1`、`finalize.js`、`core/`、`lib/` 的执行逻辑**；不改版本号（bump 留给发布）。
> 回灌上游：**不需要**。这是本包自己的判据结构演进（案例 A 的现场没有这条链路）。

**为什么**

原来只有"距离"一层，penalty 也是加进同一个 `d` 里 —— **等于允许搜索拿底线换分数**：

- 压缩到 37% 是**指标**；解压后逐字节相等、不越界是**不变量**。
- 接口 p95 延迟是**指标**；HTTP 200 + schema 合法是**不变量**。

指标负责"像不像"，不变量负责"是不是"。门禁不追求"更接近"，只判"合格/不合格"。

**契约（`intent.invariants`）**

```json
"invariants": [
  { "id": "roundtrip", "check": { "field": "roundtrip", "op": "==", "value": 1 },
    "why": "解压回不去就是废方案，分数再高也不要" }
]
```

- 每条 `{id, check, why}`：`id` 非空唯一、`why` 非空（不写为什么，将来没人敢删）；
- `check` 只实现最小文法：比较 `{field, op: ==|!=|<|<=|>|>=, value:<数字>}`、组合 `{all:[…]}` / `{any:[…]}` / `{not:…}`；
- `field` 可以是指标 id（`observe.metrics`），也可以是命令输出 JSON 的扁平字段（允许 `a.b` 点路径）；
- 文法不认识 / 字段取不到 / 取到非数字 = **运行时硬错**（不静默判过）；`invariants` 可为空数组。

**行为**

1. **候选级门禁**：每次评估拿到观测先过所有 invariants；任一 fail → 该候选**判废**：不进距离比较、
   不能成为 best、不会被缓存成"更优"。预检点被拒单列 `rejected`（不算活轴，也不算 `dead`）。
2. **目标与起点也要过**：违规 → 硬错（判据/目标自相矛盾），错误信息点名 `id` + `why` + 观测值。
3. **记账**：`report.md` 多一节「硬不变量」（每条 id 的通过/拒绝次数 + 最近一次拒绝的原始观测片段）；
   `best.json` 多 `invariants: { declared, rejected, items[] }`；`curve.csv` 多 `inv` 列（1/0）；
   台帐 `nodes/05-search.json` 的 `decision.basis` 写"门禁拒绝 N 个候选"。
4. **默认行为**：没写 `invariants` → 不拦，但默认 warn「没写硬不变量：搜索会拿底线换分数」；
   `--no-invariants-warn` 关掉终端 warn（报告仍如实记"门禁没装"）。
5. **指纹**：门禁文法（id + 判据文本 + 变异体名）进 `hash`；拒绝次数/样本不进（那是观测，不是决策配置）。

**已知限制（重要，别当 bug）**

- **截图链路（`iter.ps1`）暂不支持门禁**：它的观测是页面指标、判定在 PowerShell 里，没有测试守着 PS 侧实现。
  为此选择**只做命令链路**，并且是 **fail-closed**：在截图链路的 intent 里写 `invariants` 会**硬错**，
  绝不静默忽略（静默忽略比拒跑更坏 —— 用户以为装了门，其实没有）。`iter.ps1` 一行未改。
- 门禁只在**当下**判：没有"不变量写宽了/写死了/事后改了判据"的审计与重放（见
  `skills/selfloop/references/intent-and-ledger.md` §7 的「不变量写错、事后来才发现」）。

**测试**

- 新增 `test/invariants.test.mjs`（10 条）：目标/起点违规硬错；候选判废且 `best` 停在门禁外、
  被拒候选的距离确实比 `best` 更小；`report.md` / `best.json` / `curve.csv` / 台帐的记账；
  默认 warn 与 `--no-invariants-warn`；文法错列出支持的 op；字段取不到硬错；
  两条**弄坏能红**（`SELFLOOP_INVARIANTS_MUTANT=alwaysPass` → 拒绝数变 0、违例候选当上 best；
  `=noTargetGate` → 目标硬错那条断言塌）；文法边界（重复 id / 空组合 / 缺 why）；
  空数组等价于没写；截图链路写 invariants 必须硬错。
- `npm test`：55 + 12 + 21 + 19 + 6 + 6 + 10 = **129**（原有 119 全绿 + 新增 10）。

**文档**

- `skills/selfloop/references/intent-and-ledger.md`：新增 §1.7「硬不变量」（语义/文法/记账/与 metrics 的区别）、
  §2 的硬错表、§3.2 的截图链路 fail-closed、§6.3 报告那一节怎么读、§7 缺口、§8 自查命令；
- `README.md`：用法段一句「硬不变量：不合格直接判废，不进距离」+ 已知限制第 12 条。

## 0.6.0（未发布）· 吸收外部领域资产：需求翻译 + GLSL 配方

> 这一版只动 `domains/vfx-render/`、文档与测试，**不动 `core/`、`lib/`、`harness/` 的执行逻辑**，也不改版本号（bump 留给发布）。
> 吸收原则照 `21-吸收协议`：只吸收「需求 → 可测指标」的转译能力与它的训练材料；领域知识全部留在 domains，骨架不长领域字段。

**吸收了什么（全部落在 `domains/vfx-render/`）**

| 类别 | 落位 | 来源 | 许可 |
|---|---|---|---|
| 需求翻译方法论（九节骨架、三条信条、风格锚点、自由度 + 正确性锚点、F2 案例） | `references/demand-translator.md`（由技能文档 + 模板 + 案例三份合并） | 案例 A 的 vfx-req-translator 技能，2026-11-14 移交 | 自研（未单独声明） |
| 坑表 | `references/pitfalls.md` | 同上 `references/pitfalls.md` | 自研（未单独声明） |
| GLSL 护栏与可观测性 | `references/glsl-guardrails.md` | 同上 `references/glsl-guardrails.md` | 自研（未单独声明） |
| 无后处理发光 | `references/no-bloom.md` | 同上 `references/no-bloom.md` | 自研（未单独声明） |
| 工具索引 | `references/tooling.md` | 同上 `references/tooling.md` | 自研（未单独声明） |
| 施工前置约束（舞台事实 + 11 条硬契约） | `references/construction-contracts.md` | 案例 A 的 skill-lab `PREAMBLE.md` | 自研（未单独声明） |
| 粒子/带子方法论（用法、失效模式、验收方式） | `references/runtime-libs.md` | 案例 A 的 vfx-kit 用法速查 | **未确认**（代码本体未吸收） |
| 8 份 GLSL 配方（哈希 / FBM / 抖动 / 消散 / 假辉光 / 描边 / 卡渲） | `recipes/glsl/` | 逐文件头标注（godot-shaders、pixijs-filters、WebGL-Fluid-Simulation、URP_Toon、shader-school、Ronja 教程、来源方自研） | MIT / Zlib / CC-BY 4.0 / 自研（逐文件头标注，CC-BY 需署名） |

**脱敏与元信息**

- 全部资产补齐统一元信息：`来源 / 许可 / 适用宿主 / 吸收说明`；GLSL 另保留 `配方名 / 用途 / 来源 / 许可 / 适用管线 / 依赖` 六行头，并在开头加 `// 适用宿主：`。
- 去掉项目名、宿主私有 API 代号、本机路径与内部手册指路；「管线 A/B」改写为「宿主 A/B」（原生 300 页面 / 只做文本替换的 WebGL1 兼容层）。包内 `domains/` 零盘符；新增资产零项目名（`test/domain-assets.test.mjs` 钉住）。
- 没有搬任何来源不明的实现代码：`particles.js` / `ribbon.js` 只吸收方法论表述，文件里明写「代码未吸收：来源/许可未确认」。

**未吸收什么、为什么**

- 四份研究分报告、`代码配方手册`（1396 行）、`参考-vfx开源/README.md`：**不复制、不改编**，只在工作区留索引。原因：要么是未定稿的过程记录，要么是第三方开源仓的索引/摘录（许可与可再分发状态未逐条确认），按协议「来源不清 → 只吸收方法论表述」，不进包。
- `particles.js` / `ribbon.js` 代码本体：来源与许可未确认，只写成 `runtime-libs.md` 的方法论。
- `harness/` 的任何执行器：本版一行未动（硬约束）。

**测试**

- 新增 `test/domain-assets.test.mjs`（6 条）：领域资产非空且带来源/许可；GLSL 六行头齐全；`core/`、`lib/` 源码不出现领域词表；`domains/` 零盘符；`runtime-libs.md` 明写「代码未吸收」；资产清单防丢（references 7 份、recipes 8 份）。
- `npm test` 现在把这份挂进来，最终 55 + 12 + 21 + 19 + 6 + 6 = 119。

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
- **文档口径统一**：「闭环产线」→「闭环引擎」（4 处标题）；`fanren 侧原件`→「上游原件（案例 A）」；README 顶部加定位段、文末加「案例与来源」；删掉项目内路径示例，改成中性占位。
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


