// 适用宿主：仅原生 GLSL ES 300 页面（需要 uint 与位运算）
// 吸收说明：按脱敏规则把宿主私有名称改成通用说法（宿主名 / 兼容层 / 通用 3D 层），配方内容未改。
// ==== 整数 PCG 哈希（pcg / hash11u / hash12u / hash22u） ====
// 用途：真均匀、零浮点精度依赖的整数哈希；大世界坐标或需要与其它系统共享随机流时，比浮点哈希可靠
// 来源：来源方自研（来源方调研的 15 个仓库里没有整数哈希实现；算法为公开的 PCG 变体，Jarzynski & Olano 2020）
// 许可：来源方自研（无第三方许可）
// 适用管线：仅原生 GLSL ES 300 页面（uint / 位运算 / u 后缀字面量在 WebGL1 里不存在；只做四处文本替换的兼容层帮不了你）
// 依赖：none
//
// ⚠ 这个文件整段贴进只兼容 WebGL1 的宿主（含只做文本替换的兼容层）会直接编译失败：
//   兼容层把源码原样送进 WebGL1 编译单元，而 WebGL1 没有 uint、没有位运算。
//   想让它在这种宿主里跑，得先给一个「跳过文本替换的 raw 300 源码逃逸口」。

uint vkPcg(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

// uint -> [0,1)：1/2^32 是精确可表示的乘数，除法不会引入偏置
float vkHash11u(uint x) {
    return float(vkPcg(x)) * (1.0 / 4294967296.0);
}

// uvec2 -> [0,1)：像素坐标当种子最常用写法 vkHash12u(uvec2(gl_FragCoord.xy))
float vkHash12u(uvec2 p) {
    return float(vkPcg(p.x + vkPcg(p.y))) * (1.0 / 4294967296.0);
}

// uvec2 -> [0,1)^2：两条独立流（x/y 用不同乘数，互不相关）
vec2 vkHash22u(uvec2 p) {
    return vec2(
        float(vkPcg(p.x ^ (p.y * 0x9E3779B9u))),
        float(vkPcg(p.y ^ (p.x * 0x85EBCA6Bu)))
    ) * (1.0 / 4294967296.0);
}

// ---- 用法 / 坑 ----
// 1) 片元里取像素种子别用 gl_FragCoord 的浮点值转 uint（小数会丢、会截断），
//    用 uvec2(gl_FragCoord.xy) 正好是整数像素坐标。
// 2) 同 seed 同图：冻帧截图做 A/B 时把 seed 当 uniform 传进来，别直接用帧号。
// 3) highp 的 float 只有 24 位尾数，float(uint) 会因为舍入丢掉低 8 位——
//    要保留全部 32 位随机性就得自己拼：highp float 拆 (v >> 8) 与 (v & 255u) 两段再加权。
//    示例宿主用不到（后面接的是 [0,1) 的视觉随机），但和别的系统对齐随机流时要记住这条。
