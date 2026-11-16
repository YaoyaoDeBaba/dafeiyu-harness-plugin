# 命令观测：写一份 `observe.type=command` 配置

**这份答案一个问题**：目标是一串数（耗时/延迟/日志计数/残差）时，adapter 里那节怎么填。

**什么时候读**：**写观测配置**的时候——`observe` 字段表、参数怎么交给命令、stdout 怎么取数、图片观测、掩膜哨兵、活性扫描、搜索里哪些复用哪些照抄。

**结论先说**：

1. 参数**只有一种**交给命令的方式，别自己发明第二种。
2. stdout 取数只有三种：`json` / `number` / `line:k=v`；取不到就硬错，不会给你 0。
3. 先做**活性扫描**再搜索——死参数上花的预算全是白花。
4. 「这次是不是真的更好了」另有一篇：`observe-stability.md`。


**什么时候用这份**：目标不是一张图，而是一串**数**——构建耗时、接口延迟、日志里的错误数、求解残差、内存占用、测试通过数。
只要那个数能靠"跑一下"拿到、且**同一个输入跑两次能给出可比的数**，就能进闭环。

它和渲染链路的关系：那三件事一个都没变。

| 概念 | 渲染链路（`harness/iter.ps1`） | 命令链路（`harness/cmdloop.mjs`） |
|---|---|---|
| 观测 | 起浏览器 → 冻帧 → 截图 → `metrics2.js` 量像素 | 跑一条命令 → 从 stdout 取数（`json` / `number` / `line:k=v`） |
| 判定 | `adapter.metrics` + `score`（`score.js`） | **同一份** `score.js`、同一套 `norm` / 权重 / penalty |
| 搜索 | 活性预检 + 坐标下降（PowerShell） | 活性预检 + 坐标下降（node，口径照抄） |
| 证据包 | `curve.csv` / `best.json` / `report.md` / `shots/` | 同三件 + `outputs/`（每次评估的原始命令输出，截断 4KB）+ `params/` |

两个执行器**并列**，不是父子：`iter.ps1` 是 Windows 专用（PowerShell + Edge）；`cmdloop.mjs` 是纯 node，跨平台。

---

## 1. 三行示例（能直接跑的那种）

包里有一份**真能跑**的最小示例，照着抄最快：

```bash
node harness/cmdloop.mjs --adapter examples/command-echo.json --out runs/cmd1 --budget 40
```

它长这样（`examples/command-echo.json` 的骨架）：

```json
{
  "name": "example-command-echo",
  "config": { "path": "command-demo/base-params.json", "format": "flat-params" },
  "observe": {
    "type": "command",
    "cmd": "node ./command-demo/probe.mjs",
    "timeoutMs": 30000,
    "parse": "json",
    "metrics": [
      { "id": "loss", "field": "loss", "norm": { "mode": "abs", "scale": 1 }, "weight": 1 },
      { "id": "size", "field": "size", "norm": { "mode": "abs", "scale": 24 }, "weight": 0.5 }
    ]
  },
  "target": { "mode": "params", "params": { "alpha": 1, "beta": 1 } },
  "params": { "mode": "list", "list": ["alpha", "beta", "ghost"] }
}
```

配套的命令（`examples/command-demo/probe.mjs`）只做三件事：读 `SELFLOOP_PARAMS` 指向的参数文件 → 用公式算数 → 打印一行 JSON。

**你要给非图形目标写 adapter，只有四处不同：**

1. `observe.cmd` 换成你自己的命令；
2. `observe.parse` 选你的输出格式（`json` / `number` / `line:k=v`）；
3. `observe.metrics[].field` 指向输出里**那个数**的字段名（可以写 `a.b` 进嵌套）；
4. `target` 换成 `metrics`（直接给目标数值）或 `params`（用目标参数跑一次同一命令）。

其余（`config` / `params` / `score` / `guard`）与渲染链路同义，不用重学。

---

## 2. 字段表（命令观测这一节）

| 字段 | 必填 | 说明 |
|---|---|---|
| `observe.type` | ✅ | 必须 `"command"`。**缺这一节 = 老的截图链路**，行为与以前完全一样 |
| `observe.cmd` | ✅ | 要跑的命令。**不走 shell**（自带极小分词器，认空白与 `'` `"` 引号）；相对路径按 **adapter 所在目录**展开；可含 `{params}` 占位 |
| `observe.cwd` | | 工作目录，默认 = adapter 所在目录 |
| `observe.timeoutMs` | | 单次命令超时，默认 `30000`。超了**中文硬错**，不当 0 |
| `observe.parse` | ✅ | `json`（stdout 是一个 JSON 对象）/ `number`（整个 stdout 是一个数，只能配 1 条指标）/ `line:k=v`（每行 `key=数值`）/ `image`（stdout 是**一张 PNG 的路径**，指标由 `metrics2.js` 的提取器算；见 §2.3） |
| `observe.metrics[]` | ✅ | `{ id, field, weight, norm }`：`id` = 证据包列名（内部距离用的键），`field` = 输出里的字段名（缺省 = `id`），`norm`/`weight` 与 `score.js` 完全同义。`parse=image` 时改为 `{ id, extract, opts, weight, norm }`（见 §2.3） |
| `observe.stability` | | 稳定性闸（0.4.1 起）：`{ repeat: 3, maxSpread: 0.02 }`。**不写也生效**（默认就带闸）；`repeat: 1` = 显式关掉并 warn。见 §6 |
| `target.mode` | ✅ | `params`（用目标参数跑一次命令取指标）/ `metrics`（直接给 `{指标: 数值}`，不跑命令） |
| `config.path` | ✅ | 基线参数文件（扁平 `{params:{...}}` 或顶层扁平都行）。**只读**，从不回写 |
| `config.format` | | 命令观测恒为 `flat-params`（写别的会硬错：`vfx-block` 要靠浏览器去读） |
| `params.mode` / `params.list` | ✅ | 只支持 `mode=list`；`activity` / `auto` 是渲染那边的活性表，这里没有 |
| `score` | | 可省。省了 = `l1` + 无惩罚 |
| `guard.protectPaths` | | 可省。命令链路本来就不写 client 目录（参数文件只落 run 目录） |

### 2.1 参数怎么交给命令（**写死的一种方式，只有一种**）

每次评估 `cmdloop.mjs` 写一份参数文件到 `<run>/params/eNNN.json`，然后用**两条**途径告诉命令：

1. `cmd` 里写 `{params}` 占位 → 被替换成那份文件的**绝对路径**（引号里也行，分词之后替换，路径带空格不会被拆开）；
2. 环境变量 `SELFLOOP_PARAMS` = 同一个绝对路径。

两条都是同一个文件。文档里写死只认这一种，是为了省掉"参数从 stdin 进还是从 argv 进还是从数据库进"的猜谜。

**它绝不写你的源码目录**：adapter 目录、`config.path` 指的基线文件都只读；`apply_params.js` 那套"改镜像配置"在这里不需要。

### 2.2 输出取数：三条硬规则

- 某条指标的字段取不到数 → **硬错**（`指标缺失：输出里取不到数字字段 size`），不当 0；
- stdout 不是合法 JSON / 不是数 → **硬错**（带前 200 字原文）；
- 命令超时 / 非零退出 → **硬错**（带 argv、退出码、stderr 前 200 字）。

只有一种情况会被当成"没变化"：**跑成功了、数也取到了，但距离没动**——那就是参数 dead（见 §3）。

### 2.3 图片观测（`parse:"image"`，0.13.0）：命令交出一张图，指标由 `metrics2.js` 算

观测仍然是"跑一条命令"，只是命令交出来的东西从数变成了一张图。用途：目标要靠**渲染/画出来**、但不想起浏览器的那类现场。

```json
"observe": {
  "type": "command",
  "cmd": "node ./probe.mjs",                  // 写一张 PNG，stdout 只打印它的路径（一行）
  "parse": "image",
  "metrics": [
    { "id": "mean", "extract": "mean", "opts": { "mask": { "mode": "roi", "rect": [40,40,100,100] } },
      "norm": { "mode": "abs", "scale": 255 }, "weight": 1 }
  ]
}
```

- `metrics[].extract` = `metrics2.js` 的提取器 id（`mean / cov / lapVar / hueHist / …`，缺省 = `id`）；`opts` 原样交给提取器，`opts.mask` 就是掩膜口径（四种圈法见 `metrics.md` §8）。**写错 extract / 掩膜口径 → 中文硬错**，不静默当 0。
- stdout **只能是图片路径那一行**（相对路径按 `observe.cwd` 展开）；文件不在 / 不是 PNG / 量不出数 → 硬错。
- 图片的 sha256 进 `outputs/` 的 `pngSha` 与 `best.json` 的 `curve[].pngSha`；"输出同"比的是**图**，不是 stdout 里那行路径。
- 指标仍然只认标量（`hueHist` 这种数组型提取器不能当命令链路的指标）。

### 2.4 掩膜哨兵（`maskFrozen`，0.13.0）：拦"看起来很专业地量错"

命令链路的评估循环**默认开着**一个哨兵，专门拦这类故障：**参数不同、观测 sha 不同，但掩膜圈的是同一块像素，
掩膜内指标向量逐位相同**。第二轮实验里 `luma:200` 的 content 掩膜只圈到枪口白芯（recall 0.09~0.38），
三个不同变体量出 `7305.98|0.21296|0.11216`——指标层看不出来，因为它"看起来很专业"。

- 只在**带掩膜指纹**的观测上比对（`parse:"image"` + `opts.mask`；回退全图 / 没写 mask 的观测不参与）。
- 同一轮（一次 `--out`）里凑够 **3 个**同组候选（maskHash 相同 + 掩膜内指标逐位相同；参数与观测 sha 都不同）→ **硬错 `maskFrozen`**，
  错误里点名换 `roi` / `diff` 口径，并在 `nodes/` 的 `search` 节点写 `failed` + reason。
  只对 `content / diff / chroma` 生效：`roi` 的 maskHash **本来就恒定**（固定矩形不看像素内容），同组只能说明"指标对参数不敏感"，
  不是掩膜冻住 → 只 warn，不硬错。
- 只有 **2 个** → 不硬错，只 warn（阈值边界；别把重复跑同一点当成"冻住"）。
- 另外对照"掩膜内变了但全帧没变（或反之）"→ warn（同一类死法的早期信号，不改判据）。
- `--no-mask-sentinel` 关掉（**会 warn 一句"本次不检测掩膜冻住"**，报告里写"已关闭"——不能看起来像"查过没问题"）。
  intent 里写 `maskSentinel: true` 表示"要求必须拦"；此时再用 `--no-mask-sentinel` 是自相矛盾，硬错。
- **哨兵只有命令链路有**：截图链路（`iter.ps1`）不动、也不实现它 —— 与硬不变量同一处理，在截图链路的 intent 里写 `maskSentinel:true` 会**硬错**（宁可拒跑，不假装有哨兵）。

---

## 3. 活性扫描与"故意无效的参数"

`cmdloop.mjs` 照 `iter.ps1` §5.3 做同一件事：对每个白名单参数在起点基础上 **+1 步**，比 `Δd`。

- `Δd == 0` → `dead`，从搜索轴剔除，不花预算；
- 全部 dead → 直接停（`all-dead`），一次搜索都不跑。

示例里的 `ghost` 就是故意留的无效参数：它让 stdout 变了（诊断字段会变），但两个指标一动不动。
所以证据包的预检表里会出现 `Δd=0 / 输出同=否 / **dead**` —— **判死靠距离，不靠字节**。
这条比"像素同"更严：一个参数只要不影响判据，就不该占预算，哪怕它改了输出。

---

## 4. 搜索：哪些是复用的、哪些是复制的

cmdloop **没有**复用 `iter.ps1` 的搜索代码——它是 PowerShell，且和静态服/浏览器/截图绑在一起，为了"共用搜索"去动它，等于拿跑通的产品资产换抽象。所以是**复制语义**，逐条对齐：

| 语义 | 照抄自 `iter.ps1` | 说明 |
|---|---|---|
| 步长 | `Get-Step`（第 640 行） | ±`StepRatio`（默认 10%）；**零基参数用绝对步长 0.05**（否则 0 永远动不了） |
| 单轴扰动 | `New-Vector`（第 645 行） | 复制整个向量、只改一个键、六位小数 |
| 缓存键 | `Key-Of`（第 636 行） | 白名单顺序 + 六位小数字符串；顺序是身份的一部分 |
| 预算 | `Invoke-Render`（第 787 行） | 缓存命中不算评估；用完即停 |
| 预检 | §5.3（第 905 行起） | +1 步、`Δd<=1e-9` 记 dead |
| 坐标下降 | §5.4（第 940 行起） | 候选 = `none` + 每个活参数 `±1` 步；`pick < bestDist - 1e-9` 才算改进；连续 `MaxStagnant` 轮不改进就停 |
| random 策略 | §5.4 的盒子 | 以当前最优为盒心、每轴 ±3 步长内均匀采样，`2×活参数` 个样本 |

**唯一的口径差别**：`random` 策略的随机源。`iter.ps1` 用 .NET `[Random]::new(seed)`，`cmdloop.mjs` 用自带 mulberry32——同 seed 在两个执行器之间**不可比**。`coordinate`（默认）是确定性的，两边一致。
判据这一层没有复制：两边都 `require` 同一份 `harness/score.js`。

---
