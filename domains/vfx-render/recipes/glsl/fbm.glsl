// 适用宿主：原生 GLSL ES 300 页面，以及只做文本替换的 WebGL1 兼容层
// 吸收说明：按脱敏规则把宿主私有名称改成通用说法（宿主名 / 兼容层 / 通用 3D 层），配方内容未改。
// ==== FBM 叠法 / 域扭曲 / Voronoi（vkValue2 · vkFbm3 · vkFbmNorm · vkWarp2 · vkVoronoiF12） ====
// 用途：把单层噪声叠成分形细节（火焰撕边、水面、能量场的流动感）；以及 F1-F2 裂纹线
// 来源：叠法 A（归一化）godot-shaders godot/Shaders/value_noise_layered.gdshader:29-45；叠法 B（定倍频 + 坐标跳变）来源方一个卡渲火焰着色器的内联 fbm；Voronoi godot-shaders godot/Shaders/voronoi_noise.gdshader:5-24（原版用 sin 哈希，这里换成无 sin 的）
// 许可：MIT（godot-shaders）
// 适用管线：两者皆可（value noise 走乘加取模；循环上界全是常量，无 uint、无位运算）
// 依赖：none（自带一份 vkNoiseHash12/22；若已 include hash-nosin.glsl，可换成 vkHash12/vkHash22 省一份重复实现）

// 本文件自带的哈希（只为不依赖别的文件；想统一实现就换成 hash-nosin.glsl 的同名函数）
float vkNoiseHash12(vec2 p) {
    vec3 p3 = fract(p.xyx * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 vkNoiseHash22(vec2 p) {
    vec3 p3 = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

// ---- 单层 value noise，返回 [0,1) ----
// 用 smootherstep（6t^5-15t^4+10t^3）插值：一阶导在格点处为 0，叠多层不会出方格感
float vkValue2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = vkNoiseHash12(i);
    float b = vkNoiseHash12(i + vec2(1.0, 0.0));
    float c = vkNoiseHash12(i + vec2(0.0, 1.0));
    float d = vkNoiseHash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ---- 叠法 B：定倍频 + 坐标跳变（推荐）----
// 循环边界写死 3，编译器能完全展开；p = p * 2.07 + offset 里的非零偏移是必须的，
// 不加的话偶数层会在原点附近叠出「同心环」。
float vkFbm3(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int k = 0; k < 3; k++) {
        v += (vkValue2(p) * 2.0 - 1.0) * amp;
        p = p * 2.07 + vec2(11.3, 7.7);
        amp *= 0.5;
    }
    return v;
}

// ---- 叠法 B 的归一化版：结果恒在 [0,1]，适合直接当 mask / 覆盖率 ----
float vkFbmNorm(vec2 p) {
    float total = 0.0;
    float totalAmp = 0.0;
    float amp = 0.5;
    for (int k = 0; k < 3; k++) {
        total += vkValue2(p) * amp;
        totalAmp += amp;
        p = p * 2.07 + vec2(11.3, 7.7);
        amp *= 0.5;
    }
    return total / totalAmp;
}

// ---- 层数可变版（构建期常量）----
// GLSL ES 100 要求循环上界是常量表达式，参数化的 int layers 不是常量 → 会编译失败。
// 所以层数写成 const 字面量：想按画质档改，只能在构建期把源码里的 4 拼掉
// 例：src.replace("const int OCT = 4", "const int OCT = " + n)（改层数 = 重编译，播放中改不了）。
// 这个函数默认 4 层，贴上去就能编（比 vkFbm3 多一层）。
float vkFbmN(vec2 p) {
    const int OCT = 4;
    float v = 0.0;
    float amp = 0.5;
    for (int k = 0; k < OCT; k++) {
        v += (vkValue2(p) * 2.0 - 1.0) * amp;
        p = p * 2.07 + vec2(11.3, 7.7);
        amp *= 0.5;
    }
    return v;
}

// ---- 域扭曲（零贴图版）：拿噪声当 UV 偏移，火焰撕边/水面扰动/能量场流动九成靠它 ----
// 用两次 vkFbm3 当偏移向量（r 通道给 x，g 通道给 y），比采样两张噪声贴图省一个 RT
vec2 vkWarp2(vec2 uv, float t, float freq, float amp) {
    vec2 q = uv * freq + vec2(t * 0.35, -t * 0.2);
    vec2 d = vec2(vkFbm3(q), vkFbm3(q + vec2(5.2, 1.3)));
    return uv + d * amp;
}

// ---- Voronoi：一次返回 (F1, F2)，9 格暴力（短、好读、够用）----
vec2 vkVoronoiF12(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 o = vkNoiseHash22(i + g);
            vec2 r = g + o - f;
            float d = dot(r, r);
            if (d < f1) { f2 = f1; f1 = d; }
            else if (d < f2) { f2 = d; }
        }
    }
    return vec2(sqrt(f1), sqrt(f2));
}

// 鳞片/能量网格：F1 本身就是「到最近特征点的距离」
float vkVoronoiF1(vec2 p) {
    return vkVoronoiF12(p).x;
}

// 裂纹线：两最近特征点距离相等处正好是边界 → F2-F1 越小越亮（最省事的裂纹写法）
// w 是裂纹宽度（0.05 干净细线，0.2 以上变粗段）
float vkVoronoiCrack(vec2 p, float w) {
    vec2 f = vkVoronoiF12(p);
    return 1.0 - smoothstep(0.0, max(w, 1e-4), f.y - f.x);
}

// ---- 用法 / 坑 ----
// 1) vkFbm3 返回约 [-1,1]（正负都可能有），要当 mask 用 vkFbmNorm。
// 2) 坐标跳变常数（11.3 / 7.7）是让它每层采到不相关区域，换成 (0,0) 会出同心环。
// 3) 本文件是 value noise；要 simplex（更圆、更贵）就把 vkValue2 换成 snoise 系实现：
//    原生 300 页面的公共块通常已经带 snoise2/snoise3/fbm2，某些宿主也自带自己的 snoise 实现。
//    叠法（vkFbm3/vkFbmNorm）和噪声类型无关，换掉单层函数就行。
// 4) vkFbmN 的 __OCTAVES__ 是构建期占位符，不替换 = 编译失败（这是故意的）。
