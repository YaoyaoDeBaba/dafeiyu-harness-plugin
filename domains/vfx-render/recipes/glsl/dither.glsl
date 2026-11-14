// 适用宿主：任何 8bit 输出的 WebGL 页面（原生 300 或 WebGL1 兼容层）
// 吸收说明：按脱敏规则把宿主私有名称改成通用说法（宿主名 / 兼容层 / 通用 3D 层），配方内容未改。
// ==== 抖动消 banding（三角形分布噪声 / 蓝噪声贴图 / 8x8 Bayer） ====
// 用途：8bit 缓冲的暗部渐变一定有阶梯，加半个 LSB 的噪声就能打散；性价比最高的一条后处理
// 来源：三角形分布与 /255 的量级 WebGL-Fluid-Simulation script.js:601-607（noise/255）；Bayer 阈值当网点的思路 ShaderTutorials-ronja Assets/042_Dithering/BW_Dithering.shader:60-73；Bayer 阈值矩阵的算术构造来源方自研（公有领域的有序抖动矩阵，递归式见文件末自检）
// 许可：MIT（WebGL-Fluid-Simulation）+ CC-BY 4.0（Ronja，须署名 https://www.ronja-tutorials.com/）+ 来源方自研（Bayer 构造）
// 适用管线：两者皆可（哈希走乘加取模、Bayer 走 fract/floor，无 uint、无位运算）
// 依赖：none（自带一份 vkDitherHash12；已 include hash-nosin.glsl 时可换成 vkHash12 省重复）

float vkDitherHash12(vec2 p) {
    vec3 p3 = fract(p.xyx * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// ================= 方案 B（默认，零贴图）：三角形分布白噪声 =================
// 两个均匀随机相加 → 三角形分布；比均匀分布少「出噪点感」，且最大幅度仍是 ±1 LSB。
// 返回值直接加到颜色上：col += vec3(vkDitherTri(gl_FragCoord.xy, uSeed));
// seed 当 uniform：冻帧截图时同 seed 同图，便于 A/B（别用帧号）。
float vkDitherTri(vec2 fragCoord, float seed) {
    float r1 = vkDitherHash12(fragCoord + vec2(seed, seed * 0.37));
    float r2 = vkDitherHash12(fragCoord + vec2(seed + 17.3, seed * 1.71 + 5.1));
    return (r1 + r2 - 1.0) / 255.0;
}

// ================= 方案 A（效果最好，需要一张蓝噪声贴图）=================
// 贴图用 Repeat 寻址 + Nearest 过滤；uv 按屏幕像素对齐（scale = 1/纹理尺寸）最干净。
float vkDitherBlueNoise(sampler2D noiseTex, vec2 uv) {
    float n = texture2D(noiseTex, uv).r;
    return (n * 2.0 - 1.0) / 255.0;
}

// ================= 方案 C：8x8 Bayer（最硬、完全确定，适合 Cel 风格）=================
// 返回阈值 [0,1)，用法：banding 处按阈值做「加半个 LSB 再截断」的量化
//   例：col = floor(col * 255.0 + vkBayer8(gl_FragCoord.xy)) / 255.0;
// 递归构造（算术版，无查表 → WebGL1 安全）：B(2n) 的低位档来自 2x2 基阵，高位档来自 n 阶阵。
float vkDitherBayer2(vec2 p) {
    p = floor(p);
    return fract(p.x * 0.5 + p.y * 0.75);          // = [[0,2],[3,1]] / 4
}
float vkDitherBayer4(vec2 p) {
    p = floor(p);
    return vkDitherBayer2(mod(p, 2.0)) + 0.25 * vkDitherBayer2(floor(p * 0.5));
}
float vkDitherBayer8(vec2 p) {
    p = floor(p);
    return vkDitherBayer4(mod(p, 4.0)) + 0.0625 * vkDitherBayer2(floor(p * 0.25));
}

// 把 Bayer 阈值变成「加到颜色上的偏移」，和方案 B 同一个调用位置
float vkDitherBayerOffset(vec2 fragCoord) {
    return (vkDitherBayer8(fragCoord) - 0.5) / 255.0;
}

// ---- 用法 / 坑 ----
// 1) 位置：色调映射之后、写 fragColor 之前（在 tonemap 之前抖动会被 tonemap 放大成噪点）。
// 2) 量级就是 /255.0（一个 8bit LSB）；调到 /128 就成「胶片颗粒」了，是另一种东西。
// 3) 只对 8bit 缓冲有效。浮点 RT 上没有 banding，别白算。
// 4) 4x4 参考矩阵（自检用，row = y）：
//      0  8  2 10
//     12  4 14  6
//      3 11  1  9
//     15  7 13  5
//    vkDitherBayer4((x,y)) * 16 应逐格等于上表。
