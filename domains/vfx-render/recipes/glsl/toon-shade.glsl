// 适用宿主：原生 GLSL ES 300 页面；WebGL1 兼容层需要 OES_standard_derivatives
// 吸收说明：按脱敏规则把宿主私有名称改成通用说法（宿主名 / 兼容层 / 通用 3D 层），配方内容未改。
// ==== 卡通着色：两档硬阴影 + rim 三开关 + fwidth 抗锯齿阶梯 ====
// 用途：赛璐璐分级受光（阴影2 → 阴影1 → 基色三层插值）+ 二次元边缘光 + 任何硬阈值的抗锯齿
// 来源：URP_Toon Assets/ChiliMilkToonShader/Include/ToonFunction.hlsl 第 22–31 行（StepFeatherToon / StepAntiAliasing）、ToonLighting.hlsl:154-196（RadianceToon / DoubleShadowToon / RimLight）；ceil 分档 shader-school exercises/npr-1/shaders/fragment.glsl:10-12；Gooch exercises/npr-2/shaders/fragment.glsl:11-14（均为逐行转写成 GLSL ES100，语义未变）
// 许可：MIT（URP_Toon / shader-school）
// 适用管线：两者皆可（全文件导数只有 max(fwidth(d), 0.0008) 这一种写法 → 无导数扩展的 WebGL1 由兼容层换成常数，见文末坑 1）
// 依赖：none

// ---- 线性羽化阶梯：不是 smoothstep ----
// 线性在阈值附近斜率恒定，观感更像手绘色块；feather → 0 退化成 step() 但会锯齿。
float vkStepFeather(float v, float s, float f) {
    return clamp((v - s + f) / max(f, 1e-5), 0.0, 1.0);
}

// ---- 半兰伯特：把 [-1,1] 的 NdotL 压进 [0,1]，背面不会全黑（卡渲的大忌）----
float vkHalfLambert(float ndl) {
    return 0.5 * ndl + 0.5;
}

// ---- 两档：返回 (亮面权重, 中间档权重) ----
// s1/f1 = 主阴影阈值/羽化，s2/f2 = 更暗的闭塞档阈值/羽化
vec2 vkToonRadiance(float hLambert, float s1, float f1, float s2, float f2, float atten) {
    vec2 r;
    r.x = vkStepFeather(hLambert, s1, f1) * atten;
    r.y = vkStepFeather(hLambert, s2, f2);
    return r;
}

// ---- 三层颜色插值：阴影2 → 阴影1 → 基色 ----
vec3 vkToonColor(vec3 shade2, vec3 shade1, vec3 base, vec2 radiance) {
    return mix(mix(shade2, shade1, radiance.y), base, radiance.x);
}

// ---- 全文件唯一的导数入口：所有 AA 宽度都从这里出 ----
// 为什么只能有一处：某些宿主用的是 String.replace(字面量, "0.0125")，**只替换第一处**。
// 同一个 shader 里出现两次 max(fwidth(d), 0.0008)，第二处在无导数扩展的 WebGL1 上会留下来 → 编译失败。
// 所以：把契约字面量收成一个函数，别的 AA 都调它（本文件与 fake-bloom.glsl 各只有一处）。
float vkAAWidth(float d) {
    return max(fwidth(d), 0.0008);
}

// ---- 抗锯齿版 A：把「x 与 y 的比较」变成「跨越一个像素宽度的过渡」（URP StepAntiAliasing 的写法）----
// 裸 fwidth(v) 在 WebGL1 没有导数扩展时会让**整个 shader 编译失败**（哪怕这个函数没被调用），
// 所以这里也走 vkAAWidth。
float vkStepAA(float x, float y) {
    float d = x - y;
    return clamp(d / (vkAAWidth(d) + 1e-5), 0.0, 1.0);
}

// ---- 抗锯齿版 B：显式给边界加带宽（推荐，半径可调；用于色带/描边/溶解阈值）----
// ⚠ 逐字硬契约：max(fwidth(d), 0.0008) 必须原样出现（变量名就叫 d），
//   只做文本替换的兼容层在 WebGL1 无导数扩展时靠字符串匹配把它换成 0.0125；
//   写成 max(fwidth(d), 8e-4) / fwidth(d)*1.0 都不会被替换 → WebGL1 直接编译失败。
float vkEdgeBand(float d, float K, float aaMul) {
    float aa = vkAAWidth(d) * aaMul;
    return 1.0 - smoothstep(K - aa, K + aa, d);
}

// ---- Rim 三开关 ----
// rimStep / rimFeather      ：边缘光的「厚度 + 羽化」
// blendLdotV (0/1)          ：边缘光随「光-视线夹角」衰减（逆光时最强）
// blendShadow (0/1)         ：阴影区的边缘光也按阴影压暗（0 = 阴影里照样发亮）
// flip (0/1)                ：反过来——亮面没边缘光、暗面有（描边/墨线感）
// radiance                  ：vkToonRadiance 的亮面权重（当开关输入用）
vec3 vkRimLight(vec3 rimColor, vec3 N, vec3 V, vec3 L,
                float rimStep, float rimFeather,
                float blendLdotV, float blendShadow, float flip,
                float radiance) {
    float LdotV = dot(-L, V) * 0.5 + 0.5;
    float fres = 1.0 - clamp(dot(N, V), 0.0, 1.0);
    fres = vkStepFeather(fres, rimStep, rimFeather);
    fres = mix(fres, fres * LdotV, blendLdotV);
    vec3 c = rimColor * fres;
    float rad = mix(radiance, 1.0 - radiance, flip);
    return mix(c, c * rad, blendShadow);
}

// ---- N 档量化：ceil 一把梭 ----
// 只建议用来调试（临时把 n 打成 2，一眼看出受光是不是分级了）：
// ceil 会在档位边界硬切且无羽化，边界随光照角度移动时还有「爬行」。正式用 vkStepFeather 叠 N 次。
float vkToonBands(float lambert, float n) {
    return ceil(lambert * max(n, 1.0)) / max(n, 1.0);
}

// ---- Gooch 冷暖双色：把「阴影」换成冷色 ----
// 特效的暗部写成冷色比写成黑更像发光体（暖芯 / 暖暗 / 冷边 = 一眼二次元火焰）
vec3 vkGooch(vec3 N, vec3 L, vec3 coolCol, vec3 warmCol) {
    float w = 0.5 * (1.0 + dot(normalize(N), normalize(L)));
    return mix(coolCol, warmCol, w);
}

// ---- 用法 / 坑 ----
// 1) vkStepAA / vkEdgeBand 用到 fwidth：WebGL1 需要 OES_standard_derivatives。
//    兼容层在有扩展时补 #extension，无扩展时只替换那一个字面量 —— 所以凡是会被后端跑的
//    AA 边界，一律走 vkEdgeBand 这一种写法，别自己发明。
// 2) 色带"宽度"和"AA 宽度"是两件事：uEdgeAA 只该控 AA；色带软硬要给 vkStepFeather 的 f。
// 3) rim 的三个开关进配置（宿主参数文件），别写死在 shader 里 —— 它们是"逆光横扫时边框发亮"
//    这类镜头感唯一的旋钮。
