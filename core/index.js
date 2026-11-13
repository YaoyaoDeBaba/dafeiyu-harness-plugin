// core/ —— 三层里的中间层：与题材无关的闭环引擎。
//
// 这里只做"一句话契约"的事：一份 adapter 描述的现场能不能解析、缺什么、判据怎么配、
// 参数轴给谁用。具体执行（起浏览器、冻帧、算指标、搜索、出证据包）在 harness/ 里，
// 那一层是**逐字节冻结的产品资产**，本层只描述它、不修改它。
//
// 三个概念（引擎与题材的分界，任何新领域都按这三问落地）：
//   观测 —— 任意能给出可比较数值的探针（渲染图、日志、接口响应、UI 状态）
//   判定 —— 可配置的判据与距离（不做裁判，只做粗筛与报警）
//   搜索 —— 可配置的参数空间（先扫活性，再选轴）
//
// 引用方向（单向，不许回头）：
//   lib/（工具入口）→ core/（本目录）→ 只读 harness/ 与 domains/ 的配置
export {
  HARNESS_REQUIRED,
  HARNESS_ROLES,
  STATIC_SERVER,
  chromiumStatus,
  distanceRule,
  expandEnvTpl,
  groupByDomain,
  harnessStatus,
  listAdapters,
  parseAdapter,
  readJsonFile,
} from './adapter.js'
