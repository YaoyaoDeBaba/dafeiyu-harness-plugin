// 适用宿主：原生 GLSL ES 300 页面，以及只做文本替换的 WebGL1 兼容层
// 吸收说明：按脱敏规则把宿主私有名称改成通用说法（宿主名 / 兼容层 / 通用 3D 层），配方内容未改。
// ==== 无 sin 浮点哈希（hash11 / hash12 / hash22 / hash33） ====
// 用途：代替 fract(sin(dot(p,k))*43758.5453)；大坐标（世界坐标、百万级 UV）不出斜向条纹，手机 precision 降级也不崩，是所有噪声/抖动/粒子随机的通用地基
// 来源：godot-shaders godot/Shaders/value_noise_layered.gdshader:7-12（PQ 折叠的源头写法）；pixijs-filters src/simplex-noise/simplex.frag:15-23（hash33 的 [-1,1] 版本）
// 许可：MIT（godot-shaders / pixijs-filters）
// 适用管线：两者皆可（纯乘加取模，无 uint / 无位运算 / 无 #version，兼容层的文本替换会原样拼进 WebGL1 或 300 es）
// 依赖：none
//
// 函数名统一带 vk 前缀（本配方集），同一 shader 里和别人的 hash12 共存不会撞名；改名就整文件替换 "vk"。
// 与 2D 精灵层里那个 sin 版 hash21 是同一个签名：直接把 hash21 换成 vkHash12 即可。

float vkHash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// vec2 -> [0,1)：最常用的那一支（2D 精灵层里叫 hash21 的就是它）
float vkHash12(vec2 p) {
    vec3 p3 = fract(p.xyx * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// vec2 -> [0,1)^2：造 2D 随机向量（偏移、风向、粒子初速度方向）
vec2 vkHash22(vec2 p) {
    vec3 p3 = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

// vec3 -> [-1,1)^3：可直接当梯度/法线扰动（与 pixijs 的 hash33 同语义）
vec3 vkHash33(vec3 p) {
    vec3 p3 = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return -1.0 + 2.0 * fract(vec3((p3.x + p3.y) * p3.z,
                                   (p3.x + p3.z) * p3.y,
                                   (p3.y + p3.z) * p3.x));
}

// ---- 用法 / 坑 ----
// 1) 输入建议是「整数格 + 小数偏移」：vkHash12(floor(uv * N)) 做格子随机，
//    vkHash12(p) 直接喂连续坐标会得到白色噪声（高频、不可控）。要连续场请用 fbm.glsl。
// 2) 0.1031 / 0.1030 / 0.0973 这三个常数是这族哈希的全部参数，改动会明显改变分布
//    （换 0.1031 -> 0.1 会在大坐标出现可见的周期条纹）。别为了「调手感」改它。
// 3) 精度：mediump 下 fract 在大坐标已无意义，需要大坐标的场合在片元里抬到 highp（兼容层会按设备写 precision）。
// 4) 不需要 sin 的 hash 就是全部收益：sin 版在 uNoiseScale 拉到 20+ 时会出斜向条纹。
