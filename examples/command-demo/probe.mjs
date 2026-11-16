// examples/command-demo/probe.mjs —— 「命令观测」的最小可跑示例：读参数 → 算指标 → 打印 JSON
//
// 它模拟任何"跑一下就有数"的东西：一次构建的耗时、一个接口的延迟、一份日志里的错误数、
// 一次数值求解的残差……这里故意用最简单的算术，好处是**结果可以手算核对**，坏处是它不好看。
//
// 观测入口约定（cmdloop.mjs 写死的那一条，见 skills/selfloop/references/observe-command.md）：
//   ① 参数从 SELFLOOP_PARAMS 指向的文件读（也可 argv[2] 显式给），文件形如 {"params":{...}}；
//   ② 结果打到 stdout，一行 JSON；cmdloop 按 observe.parse=json 取字段；
//   ③ **无随机、无外部依赖**：同一组参数 → 逐字节相同的输出。
import { readFileSync } from 'node:fs'

const file = process.argv[2] || process.env.SELFLOOP_PARAMS
if (!file) {
  console.error('probe: 缺参数文件（argv[2] 或环境变量 SELFLOOP_PARAMS）')
  process.exit(2)
}

let doc
try {
  doc = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error(`probe: 读不到/不是合法 JSON: ${file}（${e.message}）`)
  process.exit(3)
}

const params = doc && typeof doc === 'object' && doc.params && typeof doc.params === 'object' ? doc.params : doc
const need = (k) => {
  const v = Number(params?.[k])
  if (!Number.isFinite(v)) {
    console.error(`probe: 参数 ${k} 不是数（收到 ${JSON.stringify(params?.[k])}）`)
    process.exit(4)
  }
  return v
}

const round6 = (v) => Number(Number(v).toFixed(6))

const alpha = need('alpha')
const beta = need('beta')
// ghost 是**故意无效**的参数：它只出现在输出的诊断字段里，不进任何公式。
// 活性扫描会看到"命令输出变了、但距离一点没动"→ 判 dead —— 这正是它存在的意义。
const ghost = Number.isFinite(Number(params?.ghost)) ? Number(params.ghost) : 0

// 两个"可测指标"：loss 越小越好（目标参数 alpha=1, beta=1 时正好为 0），size 是一个副指标。
const loss = Math.abs(alpha - 1) + 0.5 * Math.abs(beta - 1)
const size = 20 + 5 * alpha + 3 * beta

process.stdout.write(
  JSON.stringify({
    loss: round6(loss),
    size: round6(size),
    // 下面是诊断字段：不进 metrics，只在 outputs/ 里留下"这轮到底吃了什么参数"的证据
    alpha: round6(alpha),
    beta: round6(beta),
    ghost: round6(ghost),
  }) + '\n',
)
