// 适用宿主：原生 GLSL ES 300 页面，以及只做文本替换的 WebGL1 兼容层（需要纹理与 alpha 通道）
// 吸收说明：按脱敏规则把宿主私有名称改成通用说法（宿主名 / 兼容层 / 通用 3D 层），配方内容未改。
// ==== 消散四式（一条式子出全套 / 有符号距离 / alpha 侵蚀 / 反向生长 + 三平面噪声入口） ====
// 用途：角色蒸发、护盾碎裂、贴地纹烧穿、粒子变淡、出场聚合
// 来源：一条式子 godot-shaders godot/Shaders/dissolve.gdshader:18-21 与 dissolve2D.gdshader:12-18；有符号距离 ShaderTutorials-ronja Assets/038_Dissolve/Dissolve.shader:46-52；alpha 侵蚀 godot-shaders godot/Shaders/stylized_fire.gdshader:86-102；反向生长与三平面入口来源方自研（三平面思路出自 stylized_fire.gdshader:63-79 的双平面简化）
// 许可：MIT（godot-shaders）+ CC-BY 4.0（vkDissolveSigned 出自 Ronja，须署名 https://www.ronja-tutorials.com/）
// 适用管线：两者皆可（只用 smoothstep/mix/clamp/texture2D；无 uint、无位运算）
// 依赖：none（噪声值由调用方算好传进来；要程序化噪声见 fbm.glsl）

// ================= ① 一条式子同时给「挖空」和「烧边」（首选，代码最少）=================
// noise  ：噪声值 [0,1]（贴图 R 通道，或 fbm.glsl 的 vkFbmNorm）
// amount ：0 → 1 的溶解进度（外部驱）
// burn   ：烧边宽度（0.05 ~ 0.2）
// 两个 smoothstep 的区间是**错开**的：alpha 用 [amount-burn, amount]，发光用 [amount, amount+burn]；
// 两者在 [amount-burn, amount] 重叠 = 「还留着、且最亮」的一圈 → 这就是烧边。
vec4 vkDissolveOneLiner(float noise, float amount, float burn,
                        vec3 base, vec3 tint, vec3 burnCol, float burnGain) {
    float glow = 1.0 - smoothstep(amount, amount + burn, noise);
    float a    =         smoothstep(amount - burn, amount, noise);
    return vec4(base * tint + burnCol * glow * burnGain, a);
}

// ================= ② 有符号距离版（要精确控制发光带宽/在洞里还是洞外时用它）=================
// 返回 > 0 = 还在，< 0 = 已挖掉。乘 0.999 是为了 amount=1 时能全挖光
// （否则噪声顶到 1 的像素永远留着）。
// 调用方：if (vkDissolveSigned(...) < 0.0) discard;
float vkDissolveSigned(float noise, float amount) {
    return noise * 0.999 - amount;
}

// 发光带 = 「还可见、但很接近边界」的那一层，range 是带宽、falloff 是软边，返回值 0..1。
// 出处原版写成 smoothstep(range+falloff, range, visible)（边界从大到小）；
// 但那在 GLSL 规范里是「未定义行为」（edge0 >= edge1 时结果未定义），这里改写成等价的 1 - smoothstep(小,大)：
// 曲线完全一致，且在所有驱动上都安全。
float vkDissolveGlow(float visible, float range, float falloff) {
    return 1.0 - smoothstep(range, range + max(falloff, 1e-4), visible);
}

// ================= ③ alpha 侵蚀：不 discard、不硬边（粒子时代最重要的一条）=================
// life  ：粒子寿命（1 = 新生，0 = 死，直接传顶点色/实例数据的 alpha）
// softness：最后的软化宽度，越小边越锐
// 直接减 alpha 比 clip 少了所有硬边与排序问题；记得 clamp —— 负 alpha 会出一堆混合怪像。
float vkDissolveErosion(float noise, float mask, float life, float softness) {
    float a = noise * mask + life - 1.0;
    return smoothstep(0.0, max(softness, 1e-4), clamp(a, 0.0, 1.0));
}

// ================= ④ 反向用法：同一份代码做「生长/聚合」=================
// 只改两个数：进度符号 + 烧边色（溶解=暖橙、生长=青白）。别开第二个 program。
float vkDissolveProg(float amount, float reversed) {
    return mix(amount, 1.0 - amount, step(0.5, reversed));
}

// ================= ⑤ 噪声入口：噪声必须走对象空间/三平面，不能只吃 UV =================
// UV 直接喂噪声，UV 拉伸处会把烧边拉成条纹，一眼假。
vec3 vkTriplanarWeights(vec3 nWS) {
    vec3 w = abs(normalize(nWS));
    return w / (w.x + w.y + w.z + 1e-5);
}

// scale 是「世界坐标 → 噪声 UV」的比例；返回 R 通道噪声值 [0,1]
float vkTriplanarNoise(sampler2D noiseTex, vec3 pWS, vec3 weights, float scale) {
    return texture2D(noiseTex, pWS.yz * scale).r * weights.x
         + texture2D(noiseTex, pWS.xz * scale).r * weights.y
         + texture2D(noiseTex, pWS.xy * scale).r * weights.z;
}

// ---- 用法 / 坑 ----
// 1) coverage 契约冲突：vkDissolveOneLiner 返回的 alpha 是**真实覆盖率 0~1**，
//    而示例宿主的复合通道把 alpha≥2 当「覆盖率段」解码。所以溶解必须单独一层（自建 program + 自己的 RT），
//    不能直接塞进现有复合，否则 alpha≥2 的像素会被当成段号。
// 2) clip/discard 在加法混合层没问题，但在 OPAQUE 段会破坏 early-z —— 别让它在透明天空之前跑。
// 3) 双平面版（cheaper）：只采 xy 与 zy 两个投影、按 world_x_dot 混，对 billboard 类特效够用且便宜一半；
//    三平面留给「角色被溶解」这种真 UV 拉伸需求。
// 4) 噪声用 3D/对象空间（3D 采样）而不是 2D UV，是 3.4 那条保命建议的核心。
