# GLSL 护栏与可观测性

> 来源：案例 A 的 vfx-req-translator 技能 `references/glsl-guardrails.md`，2026-11-14 随案例移交
> 许可：自研（随案例移交；未单独声明开源许可证）
> 适用宿主：原生 GLSL ES 300 页面；以及只做文本替换、没有原生 300 分支的 WebGL1 兼容层
> 吸收说明：把「管线 A/B」改写为「宿主 A/B」的通用说法；删去宿主私有 API 名、源码文件行号与内部手册指路；技术判据未改。

> 这里每一条都来自真机翻车或高星实践核验，不是理论。派单时整段附给模型，写需求书时照此规划。

## 一、八条硬雷（本地检查全查不出，真机必炸）

| # | 雷 | 症状 | 规避 |
|---|---|---|---|
| 1 | VS/FS 共享 uniform 精度不一致 | 链接期 Precisions of uniform differ | 两边都显式 uniform highp（VS 默认 highp，FS 默认 mediump） |
| 2 | fwidth/dFdx/dFdy 进了 VS | 编译失败（连只定义没调用的公共块也会炸） | 带导数的函数单独成块，只拼进 FS |
| 3 | GLSL 保留字当标识符 | Illegal use of reserved word | patch/sample/filter/common/buffer/shared/active/partition/subroutine/noperspective/half/fixed/unsigned/long/short/double/superp/packed 全部避开 |
| 4 | 类型维度不匹配 | dimension mismatch / cannot convert | 特别注意 vec2 hash21(float) 返回 vec2，别赋给 float；ES 3.00 禁 int→float 隐式转换 |
| 5 | 报错行号是拼接后的 | 定位错行 | 文件行 ≈ 报错行 − 公共块行数（公共块行数逐 program 不同） |
| 6 | attribute 没写 layout(location) | 静默错位（增删 in 时画面错但不报错） | 全部显式 layout(location = N) |
| 7 | 用了没声明的标识符 | undeclared identifier | 本地静态扫描不可靠；以真机编译为准，报错就贴行号修 |
| 8 | fract(sin(x) * 43758.5453) 哈希 | 跨 GPU 图案不一致，破坏同 t 同画面 | 换无 sin 哈希（见下）——同 t 两次截图像素 diff 必须 = 0 |

## 二、确定性哈希（跨 GPU 一致）——分两种宿主，别搞混

### 宿主 A：原生 GLSL ES 300 页面（可写 in/out/layout）

用整数 PCG，跨驱动位级一致：

```glsl
uint pcg(uint v){
    uint s = v * 747796405u + 2891336453u;
    uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
float hash11i(uint v){ return float(pcg(v)) * (1.0 / 4294967295.0); }
```

### 宿主 B：只做文本替换的 WebGL1 兼容层（案例 A 的宿主）

⚠️ **重要约束**：某些宿主的运行时只做四处文本替换（`attribute`→`in`、`varying`→`in/out`、`texture2D`→`texture`、`gl_FragColor`→输出变量），**没有原生 300 分支**。因此任何带 `#version`、`in/out`、`uint`、`layout(...)` 的片段贴进去都会编译失败——**整数 PCG 在这种宿主里用不了**。

宿主 B 里用「无 sin 的浮点哈希」（godot-shaders / ashima 系的做法）：

```glsl
// 无 sin、只用 fract 与乘加，跨驱动稳定；可直接贴进只做文本替换的兼容层
float hash11(float p){
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}
float hash12(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
```

### 兼容层宿主的三条硬契约

1. **`max(fwidth(d), 0.0008)` 逐字照抄，且每个 shader 只能出现一次**：某些宿主的文本替换只改第一处（同函数里 attribute/varying 那几条都有全局标志，唯独这条没有）。写两次 → 第二处在 WebGL1 上残留 → 整层编译失败。做法：收成唯一入口函数 `vkAAWidth()`，其它地方调用它。
2. **for 循环上界必须是常量**（GLSL ES 100）：`for(i<uniformLayers)` 不合法。FBM 层数写死常量，改层数=构建期替换。
3. **禁止反向 smoothstep**（`edge0 >= edge1` 是未定义行为）：写 `1.0 - smoothstep(lo,hi,x)`。

## 三、可观测性：uDebug 六档（强烈建议每个特效都留）

```glsl
uniform int uDebug;  // 0=成品 1=距离场 2=法线 3=材质或部件 id 4=步数/迭代 5=遮罩/alpha 6=光照项
```

出问题时：先拍 uDebug=1/3/5 三张，一眼看出是距离场算错、还是遮罩断链、还是 id 串了。
实战价值：有一轮「白卡片」bug 排查了四轮真机出图，有这个档位一张探针图就能定位。

## 四、NaN 与边缘安全

- NaN 源清单：atan(0,0)、负数 pow/sqrt、normalize(vec3(0))（退化几何的极点法线最常犯）；
- 致命细节：max(NaN, 0.0) 在 GLSL 里返回 0.0（NaN 被吞成 0），step(d, NaN) 恒为 1——NaN 会静默污染整条 min/step 记账链；修法是用显式 if (d < bestD) 而不是 min，并在入口守卫 (d >= 0.0 && d < 1e8)；
- 面片必须盖住内容：可见半径 < quad 半宽，否则边缘被切出直边（踩过：爆光球圆盘 1.7r 画在 1.35r 的 quad 里 → 整块白卡片）；
- 导数不能进非一致分支/循环：fwidth 在分支里结果未定义。

## 五、性能与预算（写进需求书时的措辞）

- 写成上限 + 超了先砍谁，不要写死数字：例「FBM ≤6 层，移动端 3 层；超预算先砍粒子数，其次砍噪声层数」；
- 循环边界尽量是常量或 uniform（构建期字符串替换成常量比运行时动态条件快得多）；
- 顶点着色器可以预算相邻 UV（如流体模拟把 vL/vR/vT/vB 在 VS 算好传 FS），片元里省多次乘加；
- 实例化：属性只带最小集（起点、终点、时间、生命周期、半径、种子）；上千粒走 drawArraysInstanced。
