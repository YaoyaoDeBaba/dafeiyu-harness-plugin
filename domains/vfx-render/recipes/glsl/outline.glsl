// 适用宿主：任何 WebGL 页面（几何描边需要 3D 网格；alpha 膨胀需要 2D 精灵）
// 吸收说明：按脱敏规则把宿主私有名称改成通用说法（宿主名 / 兼容层 / 通用 3D 层），配方内容未改。
// ==== 描边三式（几何反向外扩 / 屏幕空间像素宽 / 深度-亮度边缘 + 2D alpha 膨胀） ====
// 用途：角色/道具墨线、物体交界线、2D 精灵的 alpha 描边
// 来源：geometries: godot-shaders godot/Shaders/outline3D_smooth_normals_color.gdshader:7-10 与 pixel_perfect_outline3D.gdshader:7-16；URP_Toon Include/ToonOutlinePass.hlsl:24-40（min(w,3) 钳制）；inverted hull 思路 ShaderTutorials-ronja Assets/020_Inverted_Hull/UnlitOutlines.shader:94-104；边缘检测 postprocessing src/materials/glsl/edge-detection.frag:92-165；alpha 膨胀 pixijs-filters src/outline/outline.frag
// 许可：MIT（godot-shaders / URP_Toon / postprocessing 为 Zlib / pixijs-filters）+ CC-BY 4.0（Ronja 的 inverted hull，须署名 https://www.ronja-tutorials.com/）
// 适用管线：两者皆可（attribute/varying/gl_Position 由兼容层做文本替换；无 uint、无 layout；顶点着色器里的 mat3(mat4) 两边都合法）
// 依赖：none

// ================= ① 几何反向外扩：对象空间固定厚度（近大远小，符合透视）=================
// 用法：描边 pass 关掉正面剔除（gl.cullFace(gl.FRONT)）画同一个网格；法线要用「烘焙过的平滑法线」，
//       否则硬边处描边会裂开。返回 clip 空间位置，直接给 gl_Position。
vec4 vkOutlinePosObject(vec3 pos, vec3 nrm, float thickness, mat4 model, mat4 vp) {
    vec3 p = pos + normalize(nrm) * thickness;
    return vp * model * vec4(p, 1.0);
}

// ================= ② 几何反向外扩：屏幕空间固定像素宽（远近视宽一致，二次元常用）=================
// 核心：除以分辨率再乘 clip.w —— 一除一乘正好把透视除掉；min(w,3) 防止贴脸时描边粗到糊屏。
// 前提：model 是等比缩放（非等比时 nClip 会被拉伸，要么先归一化 model 的缩放，要么改传 normalize 后的法线矩阵）。
vec4 vkOutlinePosPx(vec3 pos, vec3 nrm, float px, vec2 res, mat4 model, mat4 vp) {
    vec4 clip = vp * model * vec4(pos, 1.0);
    vec3 nClip = mat3(vp) * mat3(model) * nrm;
    vec2 dir = nClip.xy;
    float l = length(dir);
    if (l < 1e-6) {
        return clip;                         // 法线正对相机：方向退化，别除零
    }
    dir /= l;
    float w = min(clip.w, 3.0);
    clip.xy += dir / max(res, vec2(1.0)) * w * px * 2.0;
    return clip;
}

// ================= ③ 屏幕空间深度/亮度边缘：三邻居（比 8 邻居省 5 次采样）=================
// 三邻居版本对「加粗墨线」完全够用；vUv / vL / vT 建议在顶点着色器预算（见 README 的邻居 UV 一条）。
// 返回 1 = 边缘，0 = 平坦（调用方 if (m <= 0.0) discard; 省 blend）。
// 亮度版把读深度换成 luminance(texture2D(...)) 即可，同一份代码。
float vkEdgeMask3(float c, float l, float t, float thr) {
    vec2 delta = abs(vec2(c) - vec2(l, t));
    vec2 e = step(vec2(thr), delta);
    return min(1.0, e.x + e.y);
}

// 可选：防止低对比区刷出满屏噪点（postprocessing 的「局部对比自适应」）——
// 边缘强度低于局部对比的阈值时直接不画。
float vkEdgeGate(float maskStrength, float localContrast, float k) {
    return maskStrength * step(localContrast * k, maskStrength);
}

// ================= ④ 2D 侧等价物：alpha 膨胀描边（精灵/飘带没有法线，只能用这个）=================
// 8 方向取 alpha 最大值（常量循环，WebGL1 合法）；px 是「一个像素」的 UV 尺寸 = 1/resolution。
float vkDilateAlpha8(sampler2D tex, vec2 uv, vec2 px) {
    float a = texture2D(tex, uv).a;
    for (int i = 0; i < 8; i++) {
        float ang = float(i) * 0.7853981634;
        vec2 o = vec2(cos(ang), sin(ang)) * px;
        a = max(a, texture2D(tex, clamp(uv + o, 0.0, 1.0)).a);
    }
    return a;
}

// 描边 = 「膨胀后的 alpha」减「原始 alpha」，只留外圈那一环
float vkStrokeAlpha(sampler2D tex, vec2 uv, vec2 px, float softness) {
    float a0 = texture2D(tex, uv).a;
    float a1 = vkDilateAlpha8(tex, uv, px);
    return smoothstep(0.0, max(softness, 1e-4), a1 - a0);
}

// ---- 用法 / 坑 ----
// 1) 示例宿主的覆盖层现在**没有法线**（2D sprite/ribbon 只有 aPos/aUv/aColor），
//    所以 ①② 只能用在 3D 侧（带法线的角色与圆柱网格）；2D 侧走 ④。
// 2) 描边 pass 要独立 program（cullFront + 通常 unshaded），别塞进主 pass 里分支。
// 3) ③ 读深度需要深度纹理；示例宿主的主通道没有深度 RT，③ 只适合带场景深度的 3D 层。
// 4) ①② 的厚度进配置；② 的 px 记得乘 devicePixelRatio 之后的分辨率，不然高分屏上描边细一圈。
