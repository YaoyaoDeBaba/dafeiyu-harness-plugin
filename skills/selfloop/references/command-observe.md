# 观测是一条命令的输出（`observe.type=command`）

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
| `observe.parse` | ✅ | `json`（stdout 是一个 JSON 对象）/ `number`（整个 stdout 是一个数，只能配 1 条指标）/ `line:k=v`（每行 `key=数值`） |
| `observe.metrics[]` | ✅ | `{ id, field, weight, norm }`：`id` = 证据包列名（内部距离用的键），`field` = 输出里的字段名（缺省 = `id`），`norm`/`weight` 与 `score.js` 完全同义 |
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

## 5. 证据包

```
<run>/
  curve.csv     每轮每候选一行：参数 / 距离 / 指标原值 / 归一化分量 / outputs 路径
  best.json     最佳参数 + 距离 + 降幅 + hash + 全轨迹 + 预检 + 元信息
  report.md     结论 + 曲线文字版 + 参数轨迹 + 复现命令 + 已知限制
  params/       每次评估交给命令的参数文件（复核"这轮到底吃了什么"）
  outputs/      每次评估的原始命令输出（stdout / stderr / argv / 指标 / 距离），单份截断 4KB
```

`best.json.hash` 的口径照抄 `finalize.js`：只放决定"搜到哪"的东西（目标锚点 / 判据配置 / 命令 / 种子与步长 / 白名单 / 基线 sha / 每点参数与距离 / 终止原因），**不放**时间、路径、原始输出。
所以换一个 `--out` 目录、同一 seed 再跑，hash 必须一样——`test/command.test.mjs` ⑦ 钉住了这条。

---

## 6. 常见坑

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| `指标缺失：输出里取不到数字字段 xxx` | `field` 写错（大小写、嵌套层级） | 先手工跑一次命令，把 stdout 贴出来对着看；嵌套写 `a.b` |
| `observe.parse=json 但 stdout 不是合法 JSON` | 命令往 stdout 打了日志/进度条 | 诊断信息走 **stderr**；stdout 只留结果 |
| `命令非零退出（exit=1）` 但手工跑没事 | `cwd` 不对（默认 adapter 目录），或命令依赖交互式终端 | 显式给 `observe.cwd`；别用需要 TTY 的命令 |
| 每条命令都要 1~2 秒，预算还没用完就超时挂住 | 单次太慢 | 调 `timeoutMs`；**别把"慢"当"超时"** —— 超时是硬错不是 0 |
| 同一个参数跑两次距离不一样 | 命令本身有随机性（时间戳、随机种子、并发） | 先把它变成确定性的（固定种子/去时间戳），否则那不是观测、是噪声 |
| 所有参数 dead、一次搜索都没跑 | 命令没真的读参数文件 | 打印参数回显字段（示例里的 `alpha`/`beta`）；确认 `SELFLOOP_PARAMS` 或 `{params}` 接上了 |
| 白名单里有参数，但记忆里"这个参数明明有用" | 它只影响**没进 metrics** 的字段 | 要么把它加进 `observe.metrics`，要么承认它对当前判据无效（这正是活性扫描的用途） |
| 想对比"哪份实现更好" | 距离只做粗筛 | 换指标/权重，别指望它替你判断好坏 |

### 一条纪律

**命令必须确定性。** 同一个参数跑两次给出不同的数，那就是噪声，不是观测：引擎不做重复采样去噪，也不帮你把噪声平均掉。
（渲染链路有"锁 seed + 锁绝对毫秒"那套等价物；命令链路的等价物就是"别让命令自己摇摆"。）
