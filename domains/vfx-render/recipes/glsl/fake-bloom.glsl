// 适用宿主：没有全局后处理辉光的 WebGL 页面（原生 300 或 WebGL1 兼容层）
// 吸收说明：按脱敏规则把宿主私有名称改成通用说法（宿主名 / 兼容层 / 通用 3D 层），配方内容未改。
// ==== 无后处理的自发光四层（内核 / 色阶 / 外晕 / 抖动挂点） ====
// 用途：不许吃全局辉光的层（alpha∈[4,5] 的「不参与辉光」段）自己画出光晕；命中光斑、刀光、闪电链
// 来源：外晕环采样与总权重归一 pixijs-filters src/glow/glow.frag:16-63；高斯内核 WebGL-Fluid-Simulation script.js:726-744（splatShader，radius 是方差）；色阶与挂点来源方自研
// 许可：MIT（pixijs-filters / WebGL-Fluid-Simulation）+ 来源方自研
// 适用管线：两者皆可（常量循环、无 uint、无数组初始化；fwidth 那一支照硬契约写）
// 依赖：dither.glsl（仅第 ④ 段的抖动挂点需要，可不引）

const int   VK_GLOW_DIST = 2;      // 环半径步数（2 已经够；越大越贵、越柔）
const int   VK_GLOW_ANGS = 12;     // 角步数（12 = 每 30° 一个采样）
const float VK_GLOW_AMAX = 36.0;   // 归一化分母 = ANGS * DIST * (DIST+1) / 2 = 12*2*3/2

// ---- ① 内核：高斯 splat（命中高光、自身发光的心）----
// d = 当前 UV 与注入点的差（aspect 修正后），radius 是方差（不是半径）
vec3 vkGlowCore(vec2 d, float radius, vec3 color, float gain) {
    return exp(-dot(d, d) / max(radius, 1e-4)) * color * gain;
}

// ---- ② 色阶：把发光摊成两档硬阶（二次元不要连续衰减）----
// k1/k2 是两个档位边界，返回 0 / 0.5 / 1
float vkGlowBand(float x, float k1, float k2, float aa) {
    float b = smoothstep(k1 - aa, k1 + aa, x);
    b += smoothstep(k2 - aa, k2 + aa, x);
    return b * 0.5;
}

// 色阶的 AA 版：边界宽度按像素走（WebGL1 硬契约写法，变量名必须叫 d）
float vkGlowBandAA(float d, float k1, float k2) {
    float aa = max(fwidth(d), 0.0008);
    return vkGlowBand(d, k1, k2, aa);
}

// ---- ③ 外晕：环采样求「周围有多亮」，分母是常量 → 换半径不会整体变亮变暗 ----
// tex 传这一层自己的 alpha（覆盖率）；texel 是一个像素的 UV 尺寸；返回 0..1
float vkGlowRatio(sampler2D tex, vec2 uv, vec2 texel) {
    float total = 0.0;
    for (int a = 0; a < VK_GLOW_ANGS; a++) {
        float ang = float(a) * 6.2831853072 / float(VK_GLOW_ANGS);
        vec2 dir = vec2(cos(ang), sin(ang)) * texel;
        for (int d = 0; d < VK_GLOW_DIST; d++) {
            vec2 o = dir * float(d + 1);
            total += float(VK_GLOW_DIST - d) * texture2D(tex, clamp(uv + o, 0.0, 1.0)).a;
        }
    }
    return total / VK_GLOW_AMAX;
}

// ---- ④ 合成：内核 + 色阶 + 外晕（inner 提亮本体，outer 往外溢）----
// col = 当前颜色，ratio = vkGlowRatio 的结果，alpha = 本层覆盖率
// 抖动挂点（最后一步）：col += vec3(vkDitherTri(gl_FragCoord.xy, uSeed));
vec3 vkFakeBloom(vec3 col, float ratio, vec3 glowCol, float alpha,
                 float innerStrength, float outerStrength) {
    float inner = min(1.0, (1.0 - ratio) * innerStrength * alpha);
    float outer = min(1.0 - alpha, ratio * outerStrength * alpha * (1.0 - alpha));
    return mix(col, glowCol, inner) + glowCol * outer;
}

// ---- 用法 / 坑 ----
// 1) 这条正是为覆盖率契约准备的：alpha∈[4,5] 的层声明「我不参与全局辉光」（辉光通道会把掩码置 0），
//    于是它必须自己画光晕 —— 用 ③④，不经过辉光金字塔，正好绕开掩码。
// 2) 成本：VK_GLOW_ANGS * VK_GLOW_DIST 次采样/像素（这里 24 次）。想压成本就降到 ANGS=8/DIST=1（8 次），
//    或者固定 1/4 分辨率跑 + 双线性放大。
// 3) 想按 quality 参数化半径 → 必须构建期常量替换（const 改字面量），运行时 uniform 进不了循环上界。
//    改常量同时要改 VK_GLOW_AMAX，否则亮度会跳（它就是归一化分母）。
// 4) vkGlowCore 的 radius 是方差：想要「半径 r 的软斑」，传 r*r*0.5 附近的数自己试。
