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
  best.json     最佳参数 + 距离 + 降幅 + hash + 全轨迹 + 预检 + 稳定性闸（repeat/spread/ok）+ 元信息
  report.md     结论 + 稳定性闸小表 + 曲线文字版 + 参数轨迹 + 复现命令 + 已知限制
  params/       每次评估交给命令的参数文件（复核"这轮到底吃了什么"）
  outputs/      每次评估的原始命令输出（stdout / stderr / argv / 指标 / 距离），单份截断 4KB
```

`best.json.hash` 的口径照抄 `finalize.js`：只放决定"搜到哪"的东西（目标锚点 / 判据配置 / 命令 / 种子与步长 / 白名单 / 基线 sha / 每点参数与距离 / 终止原因），**不放**时间、路径、原始输出。
所以换一个 `--out` 目录、同一 seed 再跑，hash 必须一样——`test/command.test.mjs` ⑦ 钉住了这条。

---

## 6. 稳定性闸（0.4.1）：先证明观测可重复，再谈"更好了"

截图链路一直有这道闸：`freeze.verify=strict` —— **同一个 URL 连拍两张，逐字节比**，比不过就报错（说明冻帧没冻住，后面量出来的像素都在漂）。
命令链路 0.4.0 的时候**什么都没有**。这是它最大的一个洞：

> 命令一旦有随机性（时间戳、并发、浮点不确定性、真实接口抖动），
> 搜索会学会**在噪声里挑"看起来更好"的点**，最后交付一个假的最优 —— 而且证据包长得跟真的一样：曲线在降、hash 也对。

所以 0.4.1 起，**搜索之前**先验一遍观测。

### 6.1 配置与默认值

```json
"observe": {
  "type": "command",
  "cmd": "node ./probe.mjs",
  "parse": "json",
  "stability": { "repeat": 3, "maxSpread": 0.02 },
  "metrics": [ ... ]
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `stability.repeat` | `3` | 用**起点参数**把命令连跑几次。**不写也生效** —— 默认值就应该是安全的那一档 |
| `stability.maxSpread` | `0.02` | 允许的相对离散度上限，取值 `(0, 1]`（1 = 100%） |

不合法一律中文硬错：`repeat` 不是 ≥1 的整数 / `maxSpread` 不在 `(0,1]` 里。
**`repeat: 1` 是唯一的"关掉"姿势**，而且会打一条 warn：

```
[stability][warn] 本次不验证观测稳定性（observe.stability.repeat=1 显式关掉了检查）：命令若有随机性，收敛结果不可信 —— 这个 run 的"最优"不能当结论。
```

> 为什么不给 `repeat: 0` 当开关：0 会被读成"关掉检查"这种含糊状态。想关就明说 `1`，让 warn 一定出现在日志里。

### 6.2 它跑在哪、花多少钱

顺序是**固定的**：

```
目标（target.mode=params 时跑一次） → 起点（跑一次） → 【稳定性闸】 → 活性预检 → 搜索
```

- **起点那一次就算第 1 次采样**，闸只需要再补 `repeat - 1` 次（默认 2 次）；
- 所以默认成本 = **多 2 次评估**，这几次是真实评估、**记进预算**（报告里写"稳定性花掉 N 次"）；
- 位置必须在活性预检**之前**（噪声会把参数误判成 `dead`/`alive`，判错了这个参数就再也进不了搜索轴），也必须在花预算的搜索**之前**；
- 预算不够时**硬错**（不会偷偷少跑几次、也不会"这次就不验了"）：

```
[命令观测] 预算太小：稳定性检查要在起点参数上再连跑 2 次（repeat=3，起点那一次算第 1 次采样），但 --budget 4 只剩 1 次。
提高 --budget，或在 adapter 里显式写 observe.stability.repeat=1 关掉检查（会 warn）
```

### 6.3 判定口径

对每条指标（就是 `observe.metrics` 声明的那几条）算**相对离散度**：

```
spread = (max - min) / max(|mean|, 1e-9)
```

任一指标 `spread > maxSpread` → 硬错，点名是哪条、多少、阈值多少、`repeat` 次的原始值：

```
[命令观测] 观测不稳定：指标 `loss` 的相对离散度 0.100000 超过上限 maxSpread=0.02（repeat=3 次的原始值：1、1.05、0.95）
  spread=(max-min)/max(|mean|,1e-9)。命令只要有随机性（时间戳 / 并发 / 浮点不确定性 / 真实接口抖动），
  搜索学到的就是"在噪声里挑好看的点"，交付的最优是假的 —— 拒绝继续（不静默降级、不自动取平均）。
  先让观测确定下来（固定 seed、去掉时间戳、关并发、别读真实接口），或显式放宽 observe.stability.maxSpread 并自担风险
```

**不许静默降级**：不会把"不稳的那条指标"剔掉继续跑，也不会把几次采样取平均接着跑 —— 平均一下噪声就"不见了"，那正是最危险的那种"看起来可信"。

分母兜底 `1e-9` 是刻意的：指标在 0 附近时，绝对抖动再小、相对也是爆炸的。那种情况本来就该报"不稳"，而不是因为除零算不出来就放过。

### 6.4 证据包里的样子

`report.md` 多一节（一张小表 + 一句结论）：

```md
## 观测稳定性闸（搜索前必过）

口径与截图链路的 `freeze.verify=strict`（同一个 URL 连拍两张、逐字节比）同构：**用起点参数把命令连跑 3 次**
（起点那一次算第 1 次采样，额外花 2 次评估、**已记进预算**）……

| 指标 | 第 1 次 | 第 2 次 | 第 3 次 | spread | 上限 | 判定 |
|---|---|---|---|---|---|---|
| `loss` | 1.5 | 1.5 | 1.5 | 0.000000 | 0.02 | 通过 |
| `size` | 36 | 36 | 36 | 0.000000 | 0.02 | 通过 |
```

`best.json` 里：

```json
"stability": {
  "repeat": 3, "maxSpread": 0.02, "ok": true,
  "spreads": { "loss": 0, "size": 0 },
  "values":  { "loss": [1.5, 1.5, 1.5], "size": [36, 36, 36] },
  "checked": true, "spend": 2
}
```

`repeat: 1` 时是 `checked:false / ok:false`，`report.md` 里写 **未验证** —— 它不会假装通过。
`evaluations` 里多一个 `stability` 计数（那几次评估的 `outputs/eNNN.json` 也都在，可以逐份复核）。

`best.json.hash` 的指纹里放的是**闸的配置**（`repeat` / `maxSpread` / `checked`），不放采样到的数值 ——
换阈值本来就该换 hash，但同 seed 同参数的重跑必须还是一个 hash。

### 6.5 自己造一个"不稳定命令"验闸

写一个**确定性**抖动的 demo（别用 `Math.random`，否则你自己也没法复现）：

```js
// jitter.mjs —— 第 n 次调用依次给 ×1.00 / ×1.05 / ×0.95
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const f = join(dirname(fileURLToPath(import.meta.url)), 'jitter.n')
const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
writeFileSync(f, String(n + 1))
const k = [1, 1.05, 0.95][n % 3]
console.log(JSON.stringify({ loss: Number((1 * k).toFixed(6)), size: 10 }))
```

adapter 只要把 `observe.cmd` 换成 `node ./jitter.mjs`，其余不动，然后：

```bash
node harness/cmdloop.mjs --adapter <你的 adapter> --out runs/jitter --budget 10
```

期望：**非零退出**，错误里出现 `观测不稳定` / `loss` / `0.100000` / `maxSpread=0.02` / `1、1.05、0.95`，
并且 `runs/jitter/best.json` **不存在**（硬错时不许交出"看起来跑完了"的证据包）。

把 `--budget` 压到 2 再看一次：会撞上"预算太小"那条硬错（闸不会因为预算小就放过）。

### 6.6 这道闸**不管**什么（别指望它）

- **只管"同一组参数重跑是否一样"**，不管**判据本身有没有意义**：`loss` 一直是 5.000 的稳定输出，照样过闸；
- **不管目标指标**：`target.mode=params` 是"用目标参数跑一次"，那一次只有 1 个采样，它的抖动不进闸（闸只验起点）；
- **不管跨机器/跨时间的漂移**：它比的是同一轮 run 内的连跑，不保证今天和下周的观测同一量纲；
- **指标接近 0 时相对离散度会放大**：分母兜底 `1e-9`，所以 `0` 附近的指标请自己看一眼 `spread` 的绝对值（`report.md` 表里有）。

---

## 7. 常见坑

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| `指标缺失：输出里取不到数字字段 xxx` | `field` 写错（大小写、嵌套层级） | 先手工跑一次命令，把 stdout 贴出来对着看；嵌套写 `a.b` |
| `observe.parse=json 但 stdout 不是合法 JSON` | 命令往 stdout 打了日志/进度条 | 诊断信息走 **stderr**；stdout 只留结果 |
| `命令非零退出（exit=1）` 但手工跑没事 | `cwd` 不对（默认 adapter 目录），或命令依赖交互式终端 | 显式给 `observe.cwd`；别用需要 TTY 的命令 |
| 每条命令都要 1~2 秒，预算还没用完就超时挂住 | 单次太慢 | 调 `timeoutMs`；**别把"慢"当"超时"** —— 超时是硬错不是 0 |
| 同一个参数跑两次距离不一样 | 命令本身有随机性（时间戳、随机种子、并发） | 0.4.1 起会被**稳定性闸**当场拦下（`观测不稳定：指标 xxx 的相对离散度 …`）；先把它变成确定性的（固定种子/去时间戳/关并发），或显式放宽 `maxSpread` 自担风险 |
| `预算太小：稳定性检查要在起点参数上再连跑 N 次` | 闸要 2 次额外评估（默认 repeat=3），`--budget` 太小 | 提高 `--budget`（最小：目标 1 + 起点 1 + 闸 2）；真要省就把 `stability.repeat` 写 1，但要接受"本次不验证观测稳定性"那条 warn |
| 所有参数 dead、一次搜索都没跑 | 命令没真的读参数文件 | 打印参数回显字段（示例里的 `alpha`/`beta`）；确认 `SELFLOOP_PARAMS` 或 `{params}` 接上了 |
| 白名单里有参数，但记忆里"这个参数明明有用" | 它只影响**没进 metrics** 的字段 | 要么把它加进 `observe.metrics`，要么承认它对当前判据无效（这正是活性扫描的用途） |
| 想对比"哪份实现更好" | 距离只做粗筛 | 换指标/权重，别指望它替你判断好坏 |

### 一条纪律

**命令必须确定性。** 同一个参数跑两次给出不同的数，那就是噪声，不是观测。
0.4.1 起这句话不再是"你自己保证"，而是**开跑前就被验一遍**（§6 稳定性闸：起点参数连跑 `repeat` 次，任一指标相对离散度超过 `maxSpread` 就硬错）。
引擎仍然不做重复采样去噪、也不会帮你把噪声平均掉 —— 闸只负责**拒绝**，不负责**修复**。
（渲染链路有"锁 seed + 锁绝对毫秒 + `freeze.verify=strict`"那套等价物；命令链路的等价物就是这道闸 + "别让命令自己摇摆"。）

---

## 8. 真实非图形示例：压缩体积预算（0.4.2）

**场景**：发布包体积预算 —— 给定一份语料，选 zlib 参数把压缩后体积调到目标比例（本例 37%），同时**必须能无损解压**。
完全非图形、确定性、一次几十毫秒；它证明的是"观测是一条命令的 stdout"这条路能落在真实工程问题上，而不是只能算算术玩具。

**探针**（`examples/command-compress/probe.mjs`）：当场用固定 seed 生成约 256KB 类 JSON 日志（重复结构 + 每行 232 位十六进制高熵 payload），按 `level / strategy / windowBits / memLevel` 做 `deflateSync` → `inflateSync` → **逐字节比对**，打印一行 `{ratio, roundtrip, ms}`。
语料是当场生成的（不读外部文件）：换台机器、换个日子跑，语料逐字节相同 —— 否则"ratio 变了"到底是参数变了还是语料变了就说不清。

**adapter**（`examples/command-compress.json`）：

| 指标 | 权重 | 归一 | 说明 |
|---|---|---|---|
| `ratio`（压缩后/原始） | 0.8 | `abs` scale 1 | ratio 本身就是 0~1 的比例，abs 就是"原值差"，不用再换算 |
| `roundtrip`（1/0） | **0** | `abs` scale 1 | **不进距离**，只给 penalty 用 —— 权重 0 是"闸门指标"的写法 |

`score.penalties = [{ "id": "roundtripBroken", "when": "roundtrip <= 0", "add": 0.5 }]`：解压坏了 = 方案废，+0.5 直接把候选压到任何正常点之后。
实测有牙：`ratio` 都取 0.3712 的两行，`roundtrip=1` → `d=0.0012`，`roundtrip=0` → `d=0.5012`（`node harness/score.js` 复跑可核）。

```bash
node harness/cmdloop.mjs --adapter examples/command-compress.json --out runs/cmp1 --budget 60
# start=0.020232  best=0.002145  drop=89.4%  stop=stagnant  used=28/60  2.5s  单次评估 85~91ms
# 起点的 ratio 0.390232 → 最佳的 ratio 0.372145（目标 0.37）；28 次评估里的 roundtrip 全是 1，penalty 一次没触发
```

### 8.1 哪些参数是假轴（活性预检实测，步长 10%）

| 参数 | 预检扰动 | Δd | 判定 | 实测原因 |
|---|---|---|---|---|
| `windowBits` 12 | →13.2（round 后 13） | **0.0158** | alive | 真主轴：每档 0.016~0.031（11 档 0.4212 / 13 档 0.3744） |
| `level` 6 | →6.6（round 后 7） | 0.000354 | alive | 弱轴：每档 ~0.0004（这份语料重复度太高，level 早饱和） |
| `memLevel` 8 | →8.8（round 后 9） | 0.000880 | alive | **弱轴**：约 1/18 于 windowBits，且和 windowBits 强耦合（wb15 时 M1→M8 差 0.077，wb9 时差 0.158） |
| `strategy` 0 | →0.05（round 后 0） | 0 | **dead** | **假轴（口径造成的）**：零基参数走绝对步长 0.05，`round(0.05)=0` → 每一步都回到原地，永远出不了 0 |

一条结论：**`strategy` 不是物理无效，是"整数档位 × 相对步长"进不去** —— 手工设 `strategy=2`（HUFFMAN_ONLY）能把 ratio 从 0.390 拉到 0.619，那是这份语料上最大的单根杠杆，但活性扫描按 +10% 一档永远试不到它。
`memLevel` 反过来：物理上有用但整体很弱，而且**量级随 `windowBits` 变**（wb9 时 M1→M8 差 0.158，wb15 时只差 0.077）—— 所以**别只看"是 alive 还是 dead"，要看 Δd 的量级和它依赖谁**。

### 8.2 两个真实陷阱

1. **整数档位 × 相对步长 = 跳档**。`curve.csv` 里 `windowBits` 的取值只有 `12 / 13.2 / 14.52 / 11.88`，四舍五入后是 `12 / 13 / 15 / 12`：**14 这一档整轮没被评估过**。
   而 14 恰好是这份语料的最优（`(9,0,14,8)` → ratio 0.369890，离目标只剩 0.00011）。
   所以 89.4% 那部分降幅是**真能带走**的；剩下 0.21 个点不是"观测做不到"，是**数字档位和 10% 步长不共格**（想消掉它：把参数改成"档位索引"（0/1/2…）让步长落在整数上，或显式用 `--step-ratio` 对齐）。
2. **时间不进判据**。`ms` 每轮都在变（4~7ms），它只做诊断字段留在 `outputs/` 里。把 `ms` 放进 metrics 会被稳定性闸当场拦下 —— 但真正的问题不是"抖"，
   而是"要与不要"：体积预算这个目标不该花预算在"快"上；要快要另立一条指标并锁测量口径（同一份语料、同一次进程、取中位数）。

### 8.3 反证：目标够不到时它怎么表现

把目标从 0.37 改成 **0.05**（这份语料的熵地板是 0.3696，物理上够不到）：**不崩、不硬错**，它把"尽量往下压"当成同一个目标去优化，最后停在 `ratio 0.372145`（和 0.37 那轮**同一个局部最小**），
`start=0.340232 → best=0.322145`、降幅 5.3%，`stop=stagnant`，证据包照常齐。
这一条要读的是：**它不会给你一个"已命中"的假象** —— `bestDist=0.322` 摆在 `best.json` 里，`report.md` 也写清"离目标 0.32"，谁都能看见没到。

## 9. 这个示例不能证明什么

- **不能证明"压得越小越好"**：判据是"接近 0.37"，不是"越接近 0 越好"；改目标数值就是另一道题。
- **不能替你做工程取舍**：解压 CPU 成本、窗口内存、`strategy` 对下游工具链的兼容性都不在判据里。
- **不能消掉 8.2 那个跳档**：这是相对步长遇上离散参数的边界，不是这份示例的 bug。
