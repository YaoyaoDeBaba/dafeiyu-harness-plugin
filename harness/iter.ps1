# T3/T4 · 迭代器 —— 把 E0 的「评估循环」+ E2 的「搜索」封装成一条命令
#
# 一条命令 = 起静态服 + 起浏览器 + 锁相位 + 参数活性预检 + 坐标下降搜索 + 出标准证据包。
#
# 用法（P2.6 之后的最少命令行 = 只给三样，其余全在 adapter 里）：
#   pwsh -File <包目录>\harness\iter.ps1 -Adapter ...\adapters\fire-ray.json -Budget 20 -Out ...\runs\r1
# 用法（老调用，显式给目标与白名单，行为与 P2.5 一致）：
#   pwsh -File …\iter.ps1 -Target '{"widthPx":32,"distM":3.6}' -Params widthPx,distM -Budget 60 -Out …\r2
#   pwsh -File …\iter.ps1 -Adapter …\adapters\demo-480x270-medium.json -Target …\target.png -Out …
#
# 适配层（P1/P2.5/P2.6）：
#   这个宿主的一切"现场信息"（client 在哪、vfx.json 哪个块、哪张页面、怎么冻、档位分辨率、
#   端口与浏览器 flag）都在 adapter.json 里，脚本不再写死。字段语义见 harness\适配层-说明.md。
#   -Adapter 缺省 = 脚本同目录的 adapter.json。
#   浏览器/截图这一段已抽成边界（capture.mjs + capture.ps1），iter.ps1 只发 goto/eval/shot。
#
# 参数：
#   -Target   目标：① png 路径 ② json 文件 或 内联 JSON（{参数: 值}）
#             不传则用 adapter.target（mode=png|params|default）；两边都没有 = 报错，不静默兜底
#   -Params   白名单，逗号分隔。`name` 取块内现值；`name=初值` 指定起跑值
#             不传则用 adapter.params（mode=list|activity|auto）
#   -Budget   评估次数上限（一次 render+metric = 1 次），用完即停
#   -Out      输出目录（证据包落这里）
#   -Seed     相位种子（写进 URL，全 run 不变）
#   -T        冻结时刻 ms（noloop-step：默认 320 = step(20,16)；url-time：换算成 ?time=<秒>）
#   -StepMs   推进步长 ms（只在 noloop-step 下有值；url-time 下恒为 0）
#   -Tier     画质档（默认 low，等价 renderScale 0.5；url-time 宿主无运行时档位接口时跳过）
#   -Strategy coordinate（默认）| random | bayes（bayes 只有钩子，未实现）
#   -Adapter  适配层 json（缺省 = 本脚本同目录 adapter.json）
#   -Root     旧语义「项目根目录」：**默认空**，运行时按 命令行 > adapter.clientRoot 的上级 > $PSScriptRoot\..
#             推导；只在 adapter 没给 server.staticScript 时当兜底用。包内已自带静态服，通常用不到。
#   -ProfileRoot  浏览器 profile 根目录（默认 %TEMP%\dsh-vfx-loop）。必须与本包以外的东西隔离：
#             孤儿清理只认这个目录下的浏览器进程（见 capture.mjs 的「启动清孤儿」）。
#
# 产出（-Out 下）：curve.csv / best.json / report.md / shots\{target,best,run}.png / shots\thumbs\ / logs\
#
# 纪律（继承 E0/E2）：
#   只改镜像目录下的 vfx.json（本体拒写 + 前后交哈希）；浏览器 --user-data-dir=适配层给的 prof 前缀 + run 名，
#   Start-Process -PassThru 按 PID 收尾（现由 capture.mjs 负责进程树）；端口来自适配层；不碰别人的 msedge。

param(
    [string]$Target = '',
    [string]$Params = '',
    [int]$Budget = 60,
    [string]$Out = '',
    [string]$Adapter = '',
    [int]$Seed = 0,
    [int]$T = 0,
    [int]$StepMs = 0,
    [string]$Tier = '',
    [int]$W = 0,
    [int]$H = 0,
    [string]$Strategy = 'coordinate',
    [double]$StepRatio = 0.1,
    [int]$MaxRounds = 20,
    [int]$MaxStagnant = 2,
    [int]$ThumbEvery = 2,
    [switch]$HiShot,
    [int]$HiW = 1600,
    [int]$HiH = 900,
    [string]$HiTier = 'high',
    [string]$Effect = '',
    [string]$Block = '',
    [string]$Root = '',
    [string]$ProfileRoot = '',
    [string]$Mirror = '',
    [string]$ToolDir = '',
    [string]$MetricsJs = '',
    [string]$BodyClient = '',
    [int]$StaticPort = 0,
    [int]$CdpPort = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# ---------------- 0.000 平台守卫（Windows 专用） ----------------
# harness = PowerShell + Edge/Chromium + taskkill + Win32_Process 的组合，Mac/Linux 上这些根本不存在。
# 这里**只做优雅拒绝**：入口处一条中文错误 + 非零退出码，绝不"跑到一半才因为找不到 pwsh/taskkill 而炸"。
# 也不做跨平台重写（上游已定案：.ps1 是产品资产，重写几千行只换来"理论上能跑 Linux"，不划算）。
# 判据：PSEdition=Desktop（Windows PowerShell 5.1）恒为 Windows；Core 上看 $IsWindows。
$isWindowsHost = $true
if ($PSVersionTable.PSEdition -eq 'Core') { $isWindowsHost = ($IsWindows -ne $false) }
if (-not $isWindowsHost) {
    $platDesc = [string]$PSVersionTable.OS
    if (-not $platDesc) { $platDesc = [Environment]::OSVersion.VersionString }
    [Console]::Error.WriteLine('本适配器需要 Windows（harness 基于 PowerShell + Edge）；当前平台 ' + $platDesc + ' 不受支持。')
    # 用 [Environment]::Exit 而不是 exit：实测 `exit 2` 被 `& iter.ps1` 这样调用时退出码会变成 1
    # （pwsh -File 才是 2）。这里要的是"任何调用方式都给非零且明确的码"。
    [Environment]::Exit(2)
}

# ---------------- 0.0 路径口径（包内零绝对路径） ----------------
# 包要能便携地搬到别的机器：adapter 里的 clientRoot / 浏览器候选路径写成
#   %VFX_LOOP_CLIENT%      -> 用户自己的 client 根目录（clientRoot / guard.bodyClient）
#   %ProgramFiles(x86)%\... -> 本机浏览器（换机器路径照旧成立）
# 这类模板在运行时才展开；展开不出来（变量没设）就中文报错，不静默拼一个错路径接着跑。
function Expand-PathTpl([string]$p) {
    if (-not $p) { return '' }
    $s = $p.Trim()
    if ($s.IndexOf('%') -lt 0) { return $s }
    $s = [Environment]::ExpandEnvironmentVariables($s)
    if ($s -match '%([^%]+)%') {
        throw ('路径模板里的环境变量没设置：%' + $Matches[1] + '%（原文 ' + $p + '）。先在当前 shell 里设置它（如 $env:' + $Matches[1] + ' = ''...''），或用命令行参数直接给绝对路径')
    }
    return $s
}
# 展开环境变量 + 相对路径按给定基准目录解析 + 统一成绝对路径
function Resolve-AbsPath([string]$p, [string]$what, [string]$base) {
    if (-not $p) { return '' }
    $x = Expand-PathTpl $p
    if ([IO.Path]::IsPathRooted($x)) { return [IO.Path]::GetFullPath($x) }
    if (-not $base) { $base = (Get-Location).Path }
    return [IO.Path]::GetFullPath((Join-Path $base $x))
}
# 写护栏的路径判定：$child 是不是"等于 $root，或位于 $root 的子树下"。
# 实现只有一处：harness/writeguard.js 的 isUnder（绝对化 → 父目录 realpath → 去尾分隔符 →
# Windows 忽略大小写 → 按**路径段边界**比较）。这里故意不再自己复制一份语义：
# 复制一次就会再分叉（apply.js 与 apply_params.js 的护栏当年就是这么岔开的）。
# 用 node 而不是 PS 原生实现，是为了能识破"镜像目录是指向本体的 junction"——PS 5.1 没有可靠的链接解析。
# node 跑不起来 = 判定不可信 → 直接 throw（守卫失效必须是响声，不许静默放行）。
$script:WriteguardJs = Join-Path $PSScriptRoot 'writeguard.js'
function Test-PathUnder([string]$child, [string]$root) {
    if (-not $child -or -not $root) { return $false }
    $r = & node -e "const w=require(process.argv[1]);process.stdout.write(w.isUnder(process.argv[2],process.argv[3],'win32')?'1':'0')" $script:WriteguardJs $child $root
    if ($LASTEXITCODE -ne 0) { throw ('写护栏判定失败：node harness/writeguard.js 没跑起来（退出码 ' + $LASTEXITCODE + '）—— 镜像与保护路径谁能写，现在没法确认，先别跑') }
    return (([string]$r).Trim() -eq '1')
}

# ---------------- 0. 适配层（宿主现场信息全在 adapter.json，脚本不写死） ----------------
# 四类信息：怎么改配置(config) / 哪张页面(page) / 怎么冻到某时刻(freeze) / 怎么起服务与浏览器(server+browser)。
# 字段语义与样例见 harness\适配层-说明.md；换项目 = 换 adapter，脚本一行不动。
function Import-Adapter([string]$Path) {
    if (-not (Test-Path $Path)) { throw ('adapter 不存在: ' + $Path) }
    $a = Get-Content $Path -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
    # 包内 harness/adapter.json 已降级成"字段模板"（template:true）：它没有可跑的目标/白名单。
    # 这条检查**必须排在下面的必填校验之前**：模板有意把 name/clientRoot 留成空串，
    # 否则用户先看到的是"缺字段: name（空串）"，永远看不到"这是模板、该换一份 adapter"这句人话。
    if ($a.ContainsKey('template') -and $a['template']) {
        throw ('你用的是包内字段模板 ' + $Path + '（template:true），它没有可跑的目标/白名单。请用 -Adapter 指定一份真实 adapter，例如 domains/vfx-render/adapters/fire-ray.json')
    }
    foreach ($k in @('name', 'clientRoot', 'config', 'page', 'freeze', 'render', 'server')) {
        if (-not $a.ContainsKey($k) -or $null -eq $a[$k]) { throw ('adapter 缺字段: ' + $k + '  (' + $Path + ')') }
    }
    # 与 core/adapter.js 同口径（D4：两侧不能一个"只看键在不在"一个"还查空串"）：
    # 空串不是"字段存在"，别让它一路跑到后面再报成"镜像配置文件不存在"那种误导文案。
    foreach ($k in @('name', 'clientRoot')) {
        if ([string]::IsNullOrWhiteSpace([string]$a[$k])) { throw ('adapter 缺字段: ' + $k + '（空串，' + $Path + '）') }
    }
    foreach ($k in @('path', 'block')) {
        if (-not $a.config.ContainsKey($k)) { throw ('adapter 缺字段: config.' + $k) }
        if ([string]::IsNullOrWhiteSpace([string]$a.config[$k])) { throw ('adapter 缺字段: config.' + $k + '（空串）') }
    }
    foreach ($k in @('file')) {
        if (-not $a.page.ContainsKey($k)) { throw ('adapter 缺字段: page.' + $k) }
        if ([string]::IsNullOrWhiteSpace([string]$a.page[$k])) { throw ('adapter 缺字段: page.' + $k + '（空串）') }
    }
    foreach ($k in @('protocol', 'targetTimeMs', 'seed')) { if (-not $a.freeze.ContainsKey($k)) { throw ('adapter 缺字段: freeze.' + $k) } }
    # P2.6：冻帧协议两种都认；stepMs 只有 noloop-step 才需要（url-time 没有推进过程）
    $fp = [string]$a.freeze.protocol
    if ($fp -notin @('noloop-step', 'url-time')) { throw ('adapter.freeze.protocol=' + $fp + ' 未实现（本版支持 noloop-step | url-time）') }
    if ($fp -eq 'noloop-step' -and (-not $a.freeze.ContainsKey('stepMs') -or [int]$a.freeze.stepMs -le 0)) { throw 'adapter 缺字段: freeze.stepMs（noloop-step 必须有推进步长）' }
    foreach ($k in @('tier', 'width', 'height')) { if (-not $a.render.ContainsKey($k)) { throw ('adapter 缺字段: render.' + $k) } }
    foreach ($k in @('staticPort', 'cdpPort', 'browserProfilePrefix')) { if (-not $a.server.ContainsKey($k)) { throw ('adapter 缺字段: server.' + $k) } }
    return $a
}

$bound = $PSBoundParameters
if (-not $Adapter) { $Adapter = Join-Path $PSScriptRoot 'adapter.json' }
$Adapter = (Resolve-Path $Adapter).Path
$A = Import-Adapter $Adapter
# 注：template:true 的模板在 Import-Adapter 里就拒跑了（那里能先于"缺字段"报出"这是字段模板"）。
$adapterDir = Split-Path -Parent $Adapter

# ---------------- 0.0b 根目录（-Root）：默认空，运行时推导 ----------------
# 优先级：命令行 -Root > adapter.clientRoot 的上级 > 包根（$PSScriptRoot\..）> 报错。
# 旧版这里是 [string]$Root = '<本机项目根>'，等于把某台机器的盘符钉进包里 —— 去掉。
$clientRootRaw = ''
if ($A.ContainsKey('clientRoot')) { $clientRootRaw = [string]$A.clientRoot }
if ($bound.ContainsKey('Root') -and -not $Root) { throw '-Root 传了空串：要么别传（运行时自动推导），要么给一个存在的目录' }
if (-not $Root) {
    $derived = ''
    if ($clientRootRaw) {
        $expanded = ''; $expandErr = ''
        try { $expanded = Expand-PathTpl $clientRootRaw } catch { $expandErr = "$_" }
        if ($expanded) {
            if (-not [IO.Path]::IsPathRooted($expanded)) { $expanded = Join-Path $adapterDir $expanded }
            $derived = Split-Path -Parent $expanded
        }
        elseif ($expandErr) {
            Write-Output ('[root][warn] adapter.clientRoot 解析不了，改用包根：' + $expandErr)
        }
    }
    if ($derived) { $Root = $derived }
    else { $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
}
if (-not (Test-Path $Root)) {
    throw ('推导出的根目录不存在：' + $Root + '。请传 -Root <存在的根目录>，或让 adapter.clientRoot 指到本机真实存在的 client 目录（模板写法见 README「clientRoot 用环境变量」）')
}
$Root = (Resolve-Path $Root).Path

# 命中优先级：显式命令行参数 > adapter > 内置兜底（老调用方式因此完全不受影响）
$blkFull = [string]$A.config.block
if (-not $blkFull) { throw ('adapter 缺字段：config.block（空串）—— 要 effects.<Effect>.<Block>，如 effects.FireRay.fireBeamG1M1（' + $Adapter + '）') }
if ($blkFull -notmatch '^(?:effects\.)?([^.]+)\.(.+)$') { throw ('adapter.config.block 格式不对（要 effects.<Effect>.<Block>）: ' + $blkFull) }
if (-not $bound.ContainsKey('Effect') -or -not $Effect) { $Effect = $Matches[1] }
if (-not $bound.ContainsKey('Block') -or -not $Block) { $Block = $Matches[2] }

if (-not $bound.ContainsKey('Mirror') -or -not $Mirror) { $Mirror = $clientRootRaw }
# clientRoot 也可以写成 %VFX_LOOP_CLIENT% 模板：展开后再看它是不是绝对路径
$Mirror = Resolve-AbsPath $Mirror 'adapter.clientRoot' $adapterDir
if (-not $Mirror) { throw 'adapter.clientRoot 是空的：请给出 client 根目录（可写 %VFX_LOOP_CLIENT% 模板），或命令行传 -Mirror' }
if (-not $bound.ContainsKey('ToolDir') -or -not $ToolDir) { $ToolDir = $PSScriptRoot }
if (-not $bound.ContainsKey('MetricsJs') -or -not $MetricsJs) { if ($A.tools) { $MetricsJs = [string]$A.tools.metricsJs } }
if (-not $bound.ContainsKey('BodyClient') -or -not $BodyClient) { if ($A.guard) { $BodyClient = [string]$A.guard.bodyClient } }
if (-not $MetricsJs) { throw 'adapter 没给 tools.metricsJs，且命令行没传 -MetricsJs —— 指标脚本是跑一轮的必需项' }
$MetricsJs = Resolve-AbsPath $MetricsJs 'tools.metricsJs' $PSScriptRoot
if (-not (Test-Path $MetricsJs)) { throw ('metrics 脚本不存在: ' + $MetricsJs + '（检查 adapter.tools.metricsJs；相对路径按 harness/ 展开）') }
$BodyClient = Resolve-AbsPath $BodyClient 'guard.bodyClient' $adapterDir

# 写护栏（protectPaths）：写入禁区由 adapter 声明，bodyClient 非空时自动并入（并集、不重复）。
# 展开失败必须硬错（Resolve-AbsPath → Expand-PathTpl 就是 throw 语义）：守卫声明了却没法执行，比不声明更危险。
# 缺省（没声明）不硬错，只在 §1 之前打一条 [guard][warn]：这是"护栏缺省只 warn"的唯一口径。
$protectPaths = @()
if ($A.ContainsKey('guard') -and $A.guard -and $A.guard.ContainsKey('protectPaths') -and $null -ne $A.guard.protectPaths) {
    foreach ($pp in @($A.guard.protectPaths)) {
        if ([string]::IsNullOrWhiteSpace([string]$pp)) { continue }
        $protectPaths += (Resolve-AbsPath ([string]$pp) 'guard.protectPaths' $adapterDir)
    }
}
if ($BodyClient) {
    $bodyCovered = $false
    foreach ($pp in $protectPaths) {
        if ((Test-PathUnder $BodyClient $pp) -and (Test-PathUnder $pp $BodyClient)) { $bodyCovered = $true; break }
    }
    if (-not $bodyCovered) { $protectPaths += $BodyClient }
}
if (-not $bound.ContainsKey('W') -or $W -le 0) { $W = [int]$A.render.width }
if (-not $bound.ContainsKey('H') -or $H -le 0) { $H = [int]$A.render.height }
if (-not $bound.ContainsKey('Tier') -or -not $Tier) { $Tier = [string]$A.render.tier }
if (-not $bound.ContainsKey('Seed') -or $Seed -eq 0) { $Seed = [int]$A.freeze.seed }
if (-not $bound.ContainsKey('T') -or $T -le 0) { $T = [int]$A.freeze.targetTimeMs }
if (-not $bound.ContainsKey('StepMs') -or $StepMs -le 0) { $StepMs = [int]$A.freeze.stepMs }
if (-not $bound.ContainsKey('StaticPort') -or $StaticPort -le 0) { $StaticPort = [int]$A.server.staticPort }
if (-not $bound.ContainsKey('CdpPort') -or $CdpPort -le 0) { $CdpPort = [int]$A.server.cdpPort }

# 冻帧协议（P2.6）：脚本内部只认一个抽象动作「跳到某时刻并截图」，两种协议各给一种实现——
#   noloop-step：页面开 __noloop + window.step(n,ms) 手动推进到 targetTimeMs（示例宿主页那种）
#   url-time   ：页面自己按 ?time=<秒> 冻住，**没有推进过程**，targetTimeMs 直接换算成秒填进 URL
$freezeProto = [string]$A.freeze.protocol

# 时钟口径（P2.5 新增，P2.6 与协议解耦）：wall = 页面自己按墙上时间走（旧行为）；virtual = 推进前把
# performance.now 换成"每调用一次 +clockStepMs"的虚拟钟；n/a = 该协议没有时钟口径（url-time 恒为 n/a）。
# 为什么要有 virtual：M2_G1Passthrough.step() 的 uTime 是 `performance.now() 差值`
# （M2_G1Passthrough.js:636-660），同一组参数两次跑会差一个 16ms 量子 → 决策指纹不稳。
$clockMode = [string]$A.freeze.clock
if (-not $clockMode) { if ($freezeProto -eq 'url-time') { $clockMode = 'n/a' } else { $clockMode = 'wall' } }
if ($clockMode -in @('none', 'nan')) { $clockMode = 'n/a' }
if ($freezeProto -eq 'url-time') {
    if ($clockMode -eq 'virtual') { throw 'adapter.freeze.clock=virtual 在 url-time 下没有意义（没有推进过程），写 "n/a"' }
    if ($clockMode -notin @('n/a', 'wall')) { throw ('adapter.freeze.clock=' + $clockMode + ' 在 url-time 下只认 n/a|wall') }
}
elseif ($clockMode -notin @('wall', 'virtual')) {
    throw ('adapter.freeze.clock=' + $clockMode + ' 只支持 wall|virtual（noloop-step）；url-time 下才是 n/a')
}
$clockStepMs = [int]$A.freeze.clockStepMs
if ($clockStepMs -le 0) { $clockStepMs = [int]$A.freeze.stepMs }
if ($clockStepMs -le 0) { $clockStepMs = 16 }
# url-time 冻帧自检（P2.6）：同一 URL 连拍两张，必须逐字节相同 —— 否则说明页面压根没吃 ?time=，
# 那就是"静默降级"（看着跑了，其实每张图都在墙上时间的不同时刻）。strict=报错，warn=只记警告。
$freezeVerifyMode = [string]$A.freeze.verify
if (-not $freezeVerifyMode) { $freezeVerifyMode = 'strict' }
if ($freezeVerifyMode -notin @('strict', 'warn', 'off')) { throw ('adapter.freeze.verify=' + $freezeVerifyMode + ' 只支持 strict|warn|off') }

$bindHost = [string]$A.server.bind
if (-not $bindHost) { $bindHost = '127.0.0.1' }
# 静态服脚本三级兜底（都不写死本机路径）：
#   ① adapter.server.staticScript（相对路径按 harness/ 展开）② 包内自带 ../static/server.mjs
#   ③ 旧项目结构的 $Root\_tmp_static.js（-Root 推导出来的根）④ 全没有 = 报错，不静默起一个假服
$staticScript = Resolve-AbsPath ([string]$A.server.staticScript) 'server.staticScript' $PSScriptRoot
if (-not $staticScript -or -not (Test-Path $staticScript)) {
    $packaged = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\static\server.mjs'))
    if (Test-Path $packaged) {
        if ($staticScript) { Write-Output ('[server][warn] adapter.server.staticScript 指不到（' + $staticScript + '），改用包内自带：' + $packaged) }
        $staticScript = $packaged
    }
    elseif (Test-Path (Join-Path $Root '_tmp_static.js')) {
        $staticScript = Join-Path $Root '_tmp_static.js'
    }
    else {
        throw ('静态服脚本找不到：adapter.server.staticScript=' + $A.server.staticScript + '；包内 ../static/server.mjs 也不在；' + $Root + '\_tmp_static.js 也不在')
    }
}
$profPrefix = [string]$A.server.browserProfilePrefix
if (-not $profPrefix) { $profPrefix = 'prof_' }
# profile 根：默认 %TEMP%\dsh-vfx-loop —— **不落在包目录里**（装在 node_modules 下的包可能只读，
# 而且"启动清孤儿"需要一个只属于本包的临时目录来圈范围，见 capture.mjs）。
$profileRootRaw = ''
if ($A.server.profileRoot) { $profileRootRaw = [string]$A.server.profileRoot }
if (-not $ProfileRoot) { $ProfileRoot = $profileRootRaw }
if (-not $ProfileRoot) { $ProfileRoot = Join-Path ([IO.Path]::GetTempPath()) 'dsh-vfx-loop' }
$ProfileRoot = Resolve-AbsPath $ProfileRoot 'server.profileRoot' $adapterDir

$pageFile = ([string]$A.page.file).TrimStart('/')
$pageQuery = [string]$A.page.query
if ($pageQuery) { $pageQuery = $pageQuery.Replace('{seed}', [string]$Seed).Replace('{timeMs}', [string]$T).Replace('{tier}', $Tier) }

# 浏览器候选路径可以写 %ProgramFiles(x86)%\%ProgramFiles% 这类模板：换机器不用改包
$browserExe = Resolve-AbsPath ([string]$A.browser.exe) 'browser.exe' $adapterDir
if (-not $browserExe -or -not (Test-Path $browserExe)) {
    $browserExe = ''
    foreach ($cand in @($A.browser.exeCandidates)) {
        if (-not $cand) { continue }
        $p = Resolve-AbsPath ([string]$cand) 'browser.exeCandidates' $adapterDir
        if ($p -and (Test-Path $p)) { $browserExe = $p; break }
    }
}
if (-not $browserExe -or -not (Test-Path $browserExe)) {
    throw ('adapter.browser 找不到浏览器（exe / exeCandidates 都没命中）。候选会被展开：%ProgramFiles(x86)%\%ProgramFiles% 这类模板 + 相对路径按 adapter 目录；也可以装 Playwright 的 Chromium 并设 $env:DSH_CAPTURE_ENGINE = ''playwright''')
}
$browserArgsTpl = @($A.browser.args)
if ($browserArgsTpl.Count -eq 0) { throw 'adapter.browser.args 为空' }

$captureJs = [string]$A.tools.capture
if (-not $captureJs) { $captureJs = 'capture.mjs' }
$captureJs = Resolve-AbsPath $captureJs 'tools.capture' $PSScriptRoot
if (-not (Test-Path $captureJs)) { throw ('边界脚本不存在: ' + $captureJs) }

# 改参工具（P2.6）：宿主配置有两种形态，脚本不分辨 —— adapter.config.format 选 applier
#   vfx-block   = vfx.json 里 effects.<Effect>.<Block>（apply.js）
#   flat-params = 一份扁平 {params:{...}} 的 json（apply_params.js，demo 那种页）
$applyFormat = [string]$A.config.format
if (-not $applyFormat) { $applyFormat = 'vfx-block' }
if ($applyFormat -notin @('vfx-block', 'flat-params')) { throw ('adapter.config.format=' + $applyFormat + ' 只支持 vfx-block | flat-params') }
$applyJs = [string]$A.tools.apply
if (-not $applyJs) { $applyJs = $(if ($applyFormat -eq 'flat-params') { 'apply_params.js' } else { 'apply.js' }) }
$applyJs = Resolve-AbsPath $applyJs 'tools.apply' $PSScriptRoot
if (-not (Test-Path $applyJs)) { throw ('改参脚本不存在: ' + $applyJs) }

# 回读校验用哪句 JS（证明"这轮真的吃到了新参数"）：默认**不回读**（中性）。
# adapter 不给 page.readbackExpr 时就不做浏览器侧回读，只靠 apply 自己的 JSON 回读校验 ——
# 这样一轮仍能跑，但**无法证明参数真的被吃到**，证据包 meta 会记 selfCheck:false（绝不假装验过）。
$jsReadback = [string]$A.page.readbackExpr
$script:selfCheck = $true
if (-not $jsReadback) {
    $script:selfCheck = $false
    Write-Output '[adapter][warn] adapter 没给 page.readbackExpr：本轮无法证明参数真的被吃到，证据包会标 selfCheck:false'
}

# metrics 有两种写法：v1 = 裸字符串（仅声明，不参与计算）；v2 = 对象 {id, extract, opts, norm, weight}（真驱动提取与距离）
# P2.5：脚本对"用哪些指标"完全无知，只把 id 列表当标签用（记录进证据包 / 动态列）。
$knownMetrics = @('prof', 'lapVar', 'warmFrac', 'mean', 'covCore', 'ratioCore')
$script:metricIds = @()
$unknownMetrics = @()
foreach ($mi in @($A.metrics)) {
    if ($mi -is [string]) { $script:metricIds += $mi; if ($knownMetrics -notcontains $mi) { $unknownMetrics += $mi } }
    elseif ($mi -is [System.Collections.IDictionary]) {
        if (-not $mi.id) { throw 'adapter.metrics 项缺 id（v2 写法要 {id, extract, ...}）' }
        $script:metricIds += [string]$mi.id
    }
    else { throw ('adapter.metrics 项格式不对（要字符串或 {id,...} 对象）: ' + ($mi | Out-String)) }
}
if ($unknownMetrics.Count) { Write-Output ('[adapter][warn] 未识别的指标（v1 字符串写法，仅作声明）: ' + ($unknownMetrics -join ', ')) }
Write-Output ('[adapter] metrics=' + ((@($A.metrics) | ForEach-Object { if ($_ -is [string]) { $_ } else { [string]$_.id + '<-' + [string]$_.extract + '×' + [string]$_.weight } }) -join '  '))

Write-Output ('[adapter] name=' + $A.name + '  path=' + $Adapter)
Write-Output ('[adapter] block=effects.' + $Effect + '.' + $Block + '  clientRoot=' + $Mirror + '  freeze=' + $freezeProto)
Write-Output ('[adapter] port=' + $StaticPort + '/' + $CdpPort + '  page=' + $pageFile + $pageQuery + '  profPrefix=' + $profPrefix)
Write-Output ('[adapter] profileRoot=' + $ProfileRoot + '  root=' + $Root + '  staticServer=' + $staticScript)
Write-Output ('[adapter] clock=' + $clockMode + $(if ($clockMode -eq 'virtual') { '(每调用 +' + $clockStepMs + 'ms)' } else { '' }) + '  freeze=' + $freezeProto + ' t=' + $T + 'ms')

# ---------------- 0.1 入参自检 ----------------
# 注意：-Target 不再是必填（P2.6 起可以由 adapter.target 提供）；两边都没有时在 §1 报错。
if (-not $Out) { throw '缺 -Out（证据包输出目录）' }
if ($Strategy -notin @('coordinate', 'random', 'bayes')) { throw ('-Strategy 只支持 coordinate|random|bayes，收到 ' + $Strategy) }
if ($Strategy -eq 'bayes') { throw '-Strategy bayes：钩子已留（New-Candidates / Select-Best），尚未实现 —— 先用 coordinate 或 random' }

if ($freezeProto -eq 'url-time') {
    # 没有推进过程：步长与"推进帧数"在指纹里记 0，避免两条协议被误认为等价
    $StepN = 0
    $StepMs = 0
    $pageQuery = [string]$A.page.query
    if ($pageQuery) { $pageQuery = $pageQuery.Replace('{seed}', [string]$Seed).Replace('{tier}', $Tier) }
}
else {
    if ($StepMs -le 0) { throw 'noloop-step 协议需要 freeze.stepMs（推进步长）' }
    $StepN = [int][math]::Round($T / $StepMs)
    $T = $StepN * $StepMs   # 以实际冻结点为准（T 不能被 StepMs 整除时按取整后的写进报告）
}

# URL 模板（P2.6）：noloop-step 用 page.file+page.query；url-time 用 freeze.urlTemplate（缺省退回 page.file+query）。
# url-time 的模板里必须有 {sec}/{timeSec} 占位 —— 没有就说明这个宿主压根不吃 ?time=，直接报错，不许静默降级。
$urlSec = ([double]$T / 1000.0).ToString('0.###', [System.Globalization.CultureInfo]::InvariantCulture)
$urlTemplate = [string]$A.freeze.urlTemplate
if (-not $urlTemplate) { $urlTemplate = $pageFile + $pageQuery }
if ($freezeProto -eq 'url-time') {
    if ($urlTemplate -notmatch '\{(sec|timeSec)\}') {
        throw ('adapter.freeze.protocol=url-time，但 URL 模板里没有 {sec} 占位 → 该宿主不支持此协议（拒绝静默降级）: ' + $urlTemplate)
    }
}
$urlRel = $urlTemplate.Replace('{sec}', $urlSec).Replace('{timeSec}', $urlSec).Replace('{seed}', [string]$Seed).Replace('{tier}', $Tier).Replace('{timeMs}', [string]$T).Replace('{w}', [string]$W).Replace('{h}', [string]$H)

if (-not [IO.Path]::IsPathRooted($Out)) { $Out = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Out)) }
$shots = Join-Path $Out 'shots'
$thumbs = Join-Path $shots 'thumbs'
$logs = Join-Path $Out 'logs'
$baseDir = Join-Path $Out 'base'
foreach ($d in @($Out, $shots, $thumbs, $logs, $baseDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

$cfgRel = ([string]$A.config.path).Replace('/', '\')   # 配置文件在 client 下的相对路径（来自适配层）
$mirrorJson = Join-Path $Mirror $cfgRel
# 写护栏执行点①（早失败，不浪费预算）：镜像配置文件落在保护路径里 = "写回本体"的前兆。
# 必须排在任何写之前（下面那条 Copy-Item 快照、finally 里的还原都绕过 apply*.js，applier 的护栏拦不住）。
# 判定走 Test-PathUnder → writeguard.isUnder，与 applier 口径完全一致（含 junction：镜像指向本体也会被抓）。
if ($protectPaths.Count) {
    foreach ($pp in $protectPaths) {
        if (Test-PathUnder $mirrorJson $pp) {
            throw ('镜像配置文件落在保护路径里：' + $mirrorJson + ' ⊂ ' + $pp + '。这是"写回本体"的前兆 —— 改 -Mirror 或 adapter.clientRoot，别改保护路径')
        }
    }
    Write-Output ('[guard] 保护路径 ' + $protectPaths.Count + ' 条：镜像配置文件不在其中任何一条下')
}
else {
    Write-Output '[guard][warn] adapter 没声明 guard.protectPaths：本轮没有任何"写回本体"保护（applier 只保证 out≠base），证据包会标 guardEnforced:false。想保护就在 adapter.guard 里声明它'
}
# 本体守卫（P2.6）：adapter 不给 guard.bodyClient 时（宿主是临时自建页）就不做本体对比，
# 只把"没给"这件事打出来，绝不假装比过。
$bodyJson = ''
if ($BodyClient) { $bodyJson = Join-Path $BodyClient $cfgRel }
if (-not (Test-Path $mirrorJson)) { throw ('镜像配置文件不存在: ' + $mirrorJson + '（clientRoot=' + $Mirror + ' ← adapter.clientRoot=' + $clientRootRaw + '）—— 确认 client 根目录指对了：-Mirror 直接给，或设 %VFX_LOOP_CLIENT%') }
$baseJson = Join-Path $baseDir 'vfx.json'
Copy-Item -Path $mirrorJson -Destination $baseJson -Force   # 纯净基线快照：每次评估都从它重写（不累加）

function Get-Sha([string]$p) { if ($p -and (Test-Path $p)) { (Get-FileHash -Path $p -Algorithm SHA256).Hash } else { '' } }
function Sha12([string]$h) { if ($h -and $h.Length -ge 12) { $h.Substring(0, 12) } else { '<none>' } }
$baseSha = Get-Sha $baseJson
$mirrorShaBefore = Get-Sha $mirrorJson
$bodyShaBefore = Get-Sha $bodyJson

# ---------------- 1. 目标解析（P2.6：命令行 -Target > adapter.target > 报错，不许静默兜底） ----------------
# 三种 mode：png（现成帧）/ params（跑起来渲一张）/ default（块内现值 + 当前冻帧时刻渲一张）
$adapterDir = Split-Path -Parent $Adapter
function Resolve-Rel([string]$p, [string]$baseDir) {
    if (-not $p) { return '' }
    if ([IO.Path]::IsPathRooted($p)) { return $p }
    return [IO.Path]::GetFullPath((Join-Path $baseDir $p))
}

$targetSrc = ''
$targetKind = ''
$targetSpecObj = $null
$targetSrcPng = ''
$targetModeNote = ''
$targetPng = Join-Path $shots 'target.png'

if ($bound.ContainsKey('Target') -and $Target) {
    $targetSrc = 'cli'
    if (Test-Path $Target) {
        $ext = [IO.Path]::GetExtension($Target).ToLower()
        if ($ext -eq '.png') { $targetKind = 'png'; $targetSrcPng = (Resolve-Path $Target).Path }
        elseif ($ext -eq '.json') { $targetKind = 'json'; $targetSpecObj = Get-Content $Target -Raw | ConvertFrom-Json -AsHashtable }
        else { throw ('-Target 只认 .png / .json，收到 ' + $ext) }
    }
    elseif ($Target.TrimStart().StartsWith('{')) { $targetKind = 'json'; $targetSpecObj = $Target | ConvertFrom-Json -AsHashtable }
    else { throw ('-Target 既不是存在的文件也不是内联 JSON: ' + $Target) }
}
elseif ($A['target']) {
    $targetSrc = 'adapter'
    $tm = [string]$A['target'].mode
    if ($tm -eq 'png') {
        $tp = Resolve-Rel ([string]$A['target'].path) $adapterDir
        if (-not $tp) { throw 'adapter.target.mode=png 但没给 target.path' }
        if (-not (Test-Path $tp)) { throw ('adapter.target.path 不存在: ' + $tp) }
        if ([IO.Path]::GetExtension($tp).ToLower() -ne '.png') { throw ('adapter.target.mode=png 但 path 不是 .png: ' + $tp) }
        $targetKind = 'png'; $targetSrcPng = (Resolve-Path $tp).Path; $targetModeNote = ('png -> ' + $tp)
    }
    elseif ($tm -eq 'params') {
        if (-not $A['target'].params) { throw 'adapter.target.mode=params 但没给 target.params（要 {参数名: 数值}）' }
        $targetKind = 'json'; $targetSpecObj = $A['target'].params
        $targetModeNote = ('params -> ' + ($targetSpecObj | ConvertTo-Json -Compress -Depth 6))
    }
    elseif ($tm -eq 'default') {
        $targetKind = 'default'; $targetModeNote = 'default（块内现值 + 当前冻帧时刻，不打 patch）'
    }
    else {
        throw ('adapter.target.mode=' + $tm + ' 不认（只有 png | params | default），且命令行没给 -Target —— 拒绝静默用默认目标')
    }
}
else {
    throw '目标帧没有来源：命令行没给 -Target，adapter 也没有 target 节（优先级：-Target > adapter.target > 报错）'
}

# ---------------- 2. 白名单解析（P2.6：命令行 -Params > adapter.params > 报错，不许静默兜底） ----------------
# 参数块从"基线配置"里取：vfx-block 形态是 effects.<Effect>.<Block>；flat-params 形态就是 params 对象
$baseFull = Get-Content $baseJson -Raw | ConvertFrom-Json -AsHashtable
if ($applyFormat -eq 'flat-params') {
    $blkObj = $baseFull['params']
    if (-not $blkObj) { $blkObj = $baseFull }
    if (-not $blkObj) { throw ('基线里没有可用的参数对象（既没有 params 也不是对象）: ' + $baseJson) }
}
else {
    $blkObj = $baseFull.effects[$Effect][$Block]
    if (-not $blkObj) { throw ('基线缺 effects.' + $Effect + '.' + $Block) }
}

$paramsSrc = ''
$paramsRaw = ''
$activityInfo = $null
if ($bound.ContainsKey('Params')) {
    $paramsSrc = 'cli'; $paramsRaw = $Params
}
elseif ($A['params']) {
    $pm = [string]$A['params'].mode
    if ($pm -eq 'list') {
        $lst = @($A['params'].list | Where-Object { $_ })
        if ($lst.Count -eq 0) { throw 'adapter.params.mode=list 但 list 为空' }
        $paramsRaw = (($lst | ForEach-Object { [string]$_ }) -join ',')
        $paramsSrc = 'adapter.list'
    }
    elseif ($pm -eq 'activity') {
        $apath = Resolve-Rel ([string]$A['params'].activityPath) $adapterDir
        if (-not $apath) { throw 'adapter.params.mode=activity 但没给 activityPath' }
        if (-not (Test-Path $apath)) { throw ('活性表不存在: ' + $apath) }
        $want = [string]$A['params'].state; if (-not $want) { $want = 'live' }
        $limit = [int]$A['params'].limit; if ($limit -le 0) { $limit = 6 }
        $requireIn = $true
        if ($null -ne $A['params'].requireInBlock) { $requireIn = [bool]$A['params'].requireInBlock }
        $skipList = @($A['params'].skip | Where-Object { $_ } | ForEach-Object { [string]$_ })
        $aj = Get-Content $apath -Raw | ConvertFrom-Json -AsHashtable
        $rows = @($aj['params'])
        if ($rows.Count -eq 0) { throw ('活性表没有 params 数组: ' + $apath) }
        $picked = New-Object System.Collections.ArrayList
        $justSkipped = New-Object System.Collections.ArrayList
        $stateCounts = [ordered]@{}
        foreach ($r in $rows) {
            $nm = [string]$r.name
            $st = [string]$r.state
            if ($stateCounts.Contains($st)) { $stateCounts[$st]++ } else { $stateCounts[$st] = 1 }
            if ($st -ne $want) { continue }
            if ($skipList -contains $nm) { [void]$justSkipped.Add($nm + '(skip)'); continue }
            if ($requireIn) {
                if (-not $blkObj.ContainsKey($nm)) { [void]$justSkipped.Add($nm + '(不在块内)'); continue }
                $vv = $blkObj[$nm]
                if (-not ($vv -is [double] -or $vv -is [int] -or $vv -is [long])) { [void]$justSkipped.Add($nm + '(非数值)'); continue }
            }
            [void]$picked.Add($nm)
            if ($picked.Count -ge $limit) { break }
        }
        if ($picked.Count -eq 0) { throw ('activity 模式一个参数都没挑出来（state=' + $want + '，requireInBlock=' + $requireIn + '）: ' + $apath) }
        $paramsRaw = (@($picked) -join ',')
        $paramsSrc = 'adapter.activity(' + [IO.Path]::GetFileName($apath) + ' | state=' + $want + ' | limit=' + $limit + ' | requireInBlock=' + $requireIn + ')'
        $activityInfo = [ordered]@{ path = $apath; state = $want; limit = $limit; requireInBlock = $requireIn; picked = @($picked); skipped = @($justSkipped); stateCounts = $stateCounts }
        Write-Output ('[params] activity 表 ' + [IO.Path]::GetFileName($apath) + ' 状态分布: ' + (($stateCounts.Keys | ForEach-Object { $_ + '×' + $stateCounts[$_] }) -join ' ') )
        Write-Output ('[params] activity 跳过 ' + $justSkipped.Count + ' 项: ' + $(if ($justSkipped.Count) { ($justSkipped -join ', ') } else { '（无）' }))
    }
    elseif ($pm -eq 'auto') {
        throw 'adapter.params.mode=auto 未实现：要先跑一次迷你活性扫描（额外花预算），本版只留接口。改成 mode=list（手填）或 mode=activity（指向已有的 active_params*.json）'
    }
    else { throw ('adapter.params.mode=' + $pm + ' 不认（只有 list | activity | auto）') }
}
else {
    throw '白名单没有来源：命令行没给 -Params，adapter 也没有 params 节（拒绝内置默认 widthPx,distM）。补法：给 adapter 加 params 节（mode=list + list:[...]），或命令行显式 -Params a,b'
}

$wl = New-Object System.Collections.ArrayList
$startParams = [ordered]@{}
foreach ($itemRaw in $paramsRaw.Split(',')) {
    $item = $itemRaw.Trim()
    if (-not $item) { continue }
    $name = $item; $val = $null; $given = $false
    if ($item -match '^\s*([A-Za-z0-9_]+)\s*=\s*(-?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)\s*$') {
        $name = $Matches[1]; $val = [double]$Matches[2]; $given = $true
    }
    if (-not $given) {
        if (-not $blkObj.ContainsKey($name)) {
            $nums = @($blkObj.Keys | Where-Object { $blkObj[$_] -is [double] -or $blkObj[$_] -is [int] -or $blkObj[$_] -is [long] })
            throw ('白名单参数 `' + $name + '` 不在块内，且没给初值。用 `' + $name + '=<数值>` 指定。块内数值键: ' + ($nums -join ', '))
        }
        $val = [double]$blkObj[$name]
    }
    if ($wl -contains $name) { continue }
    [void]$wl.Add($name)
    $startParams[$name] = [math]::Round($val, 6)
}
if ($wl.Count -eq 0) { throw '白名单解析为空（-Params / adapter.params 都是空）' }

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$tAll0 = $sw.ElapsedMilliseconds
$cmdline = 'pwsh -File ' + (Join-Path $ToolDir 'iter.ps1') + $(if ($bound.ContainsKey('Adapter')) { ' -Adapter "' + $Adapter + '"' } else { '' }) + $(if ($targetSrc -eq 'cli') { ' -Target ' + $(if (Test-Path $Target) { '"' + $Target + '"' } else { "'" + $Target + "'" }) } else { '' }) + $(if ($bound.ContainsKey('Params')) { ' -Params ' + $Params } else { '' }) + ' -Budget ' + $Budget + ' -Out ' + $Out + $(if ($clockMode -eq 'n/a') { '' } else { ' -Seed ' + $Seed + ' -T ' + $T }) + ' -Tier ' + $Tier + ' -W ' + $W + ' -H ' + $H + ' -Strategy ' + $Strategy + $(if ($HiShot) { ' -HiShot' } else { '' })

Write-Output ('[init] Out=' + $Out)
Write-Output ('[init] 基线 vfx.json sha256=' + $baseSha)
Write-Output ('[init] 相位锁 seed=' + $Seed + ' t=' + $T + 'ms ' + $(if ($freezeProto -eq 'url-time') { 'url-time(无推进) ?time=' + $urlSec } else { 'step(' + $StepN + ',' + $StepMs + ')' }) + ' ' + $W + 'x' + $H + ' tier=' + $Tier + ' strategy=' + $Strategy)
Write-Output ('[target] 来源=' + $targetSrc + $(if ($targetModeNote) { '  mode=' + $targetModeNote } else { '' }))
Write-Output ('[params] 来源=' + $paramsSrc)
Write-Output ('[init] 白名单 ' + $wl.Count + ' 个: ' + (($wl | ForEach-Object { $_ + '=' + $startParams[$_] }) -join '  '))


# ---------------- 3. 静态服（脚本路径/端口/绑定地址全部来自适配层） ----------------
$srvProc = $null
$srvStarted = $false
$listening = @(Get-NetTCPConnection -State Listen -LocalPort $StaticPort -ErrorAction SilentlyContinue).Count -gt 0
if (-not $listening) {
    $srvProc = Start-Process node -ArgumentList $staticScript, $Mirror, "$StaticPort", $bindHost -PassThru -WindowStyle Hidden
    $srvStarted = $true
    Start-Sleep -Milliseconds 900
    Write-Output ('[server] 静态服 pid=' + $srvProc.Id + ' port=' + $StaticPort + ' root=' + $Mirror)
}
else { Write-Output ('[server] 端口 ' + $StaticPort + ' 已在监听，复用（本 run 不负责关它）') }
$url = 'http://' + $bindHost + ':' + $StaticPort + '/' + $urlRel
Write-Output ('[server] url=' + $url)

$exe = $browserExe

$script:usage = @{ used = 0; target = 0; start = 0; precheck = 0; search = 0; cache = 0; hi = 0 }
$script:seq = 0
$script:bagN = 0
$script:evals = New-Object System.Collections.ArrayList
$script:bySeq = @{}
$script:cache = @{}
$script:evMs = New-Object System.Collections.ArrayList
$script:dead = New-Object System.Collections.ArrayList
$script:alive = New-Object System.Collections.ArrayList
$script:precheckRows = New-Object System.Collections.ArrayList
$script:roundLog = New-Object System.Collections.ArrayList
$script:thumbFiles = New-Object System.Collections.ArrayList
$script:hiPng = ''
$script:stopReason = ''
$script:stopDetail = ''
$script:browserPid = 0
$script:urlTimeVerified = $false
$profile = Join-Path $ProfileRoot ($profPrefix + [IO.Path]::GetFileName($Out))

function Round6([double]$v) { [math]::Round($v, 6) }
function Copy-Vec($p) { $n = @{}; foreach ($k in $wl) { $n[$k] = [double]$p[$k] }; return $n }
function Key-Of($p) {
    $parts = foreach ($k in $wl) { $k + '=' + ([double]$p[$k]).ToString('0.######') }
    return ($parts -join '|')
}
function Get-Step([double]$v) {
    # ±10%；零基参数用绝对步长（E2 §3.1 的做法，否则 0 永远动不了）
    if ([math]::Abs($v) -lt 1e-9) { return 0.05 }
    return [math]::Round([math]::Abs($v) * $StepRatio, 6)
}
function New-Vector($baseP, $name, [int]$sign) {
    $p = @{}
    foreach ($k in $wl) { $p[$k] = [double]$baseP[$k] }
    if ($name) {
        $s = Get-Step ([double]$baseP[$name])
        $p[$name] = Round6 ([double]$baseP[$name] + $sign * $s)
    }
    return $p
}

# ---------------- 4. 浏览器 + 截图边界（实现全在 capture.mjs，本脚本只发命令） ----------------
# 边界替换点：将来用 Playwright 顶掉 Edge+CDP，只改 capture.mjs 内部；
# 本文件下面这 4 个函数（Start-Browser / Stop-Browser / Save-Shot / Invoke-Frame 里的三句）
# 与 capture.ps1 的管道一行都不用动。
. (Join-Path $PSScriptRoot 'capture.ps1')
Cap-Init -CaptureJs $captureJs

function EvalJs([string]$js) { return (Cap-Eval -Expr $js) }
function Wait-For([string]$js, [string]$want, [int]$timeoutMs) {
    $r = Cap-WaitFor -Expr $js -Want $want -TimeoutMs $timeoutMs
    return [pscustomobject]@{ ms = $r.ms; val = $r.val }
}

$jsReady = [string]$A.page.readyExpr
if (-not $jsReady) {
    $jsReady = 'String(document.readyState === "complete")'
    Write-Output '[adapter][warn] adapter 没给 page.readyExpr，用中性默认（只等 document 就绪）'
}
$jsTier = '(function(){try{OverlayVfx._host.quality=function(){return "TIER";};return "patched";}catch(e){return "ERR:"+e;}})()'

# 浏览器 flag 来自适配层模板，占位符在这里吃掉（{width} {height} {cdpPort} {profile}）
function Get-BrowserArgs {
    return @($browserArgsTpl | ForEach-Object {
            ([string]$_).Replace('{width}', "$W").Replace('{height}', "$H").Replace('{cdpPort}', "$CdpPort").Replace('{profile}', $profile)
        })
}

function Start-Browser {
    if (-not (Test-Path $profile)) { New-Item -ItemType Directory -Path $profile -Force | Out-Null }
    $b = Cap-Start -Exe $exe -Arguments (Get-BrowserArgs) -W $W -H $H -CdpPort $CdpPort -Profile $profile -ProfileRoot $ProfileRoot
    $script:browserPid = $b.pid
    Write-Output ('[browser] pid=' + $b.pid + ' profile=' + $profile)
}

function Stop-Browser {
    $left = Cap-Stop
    return $left
}

# 载入一轮页面（改参 -> 重载 -> 【协议部分】-> 回读校验）
#
# P2.6 把"冻帧"抽象成**一个动作**：跳到某个时刻并让画面停在那里。两种协议各给一种实现，
# 上层（Invoke-Render / 搜索 / 目标帧）不再关心是哪一种：
#   noloop-step：画质档 -> playFx -> 注入虚拟钟 -> window.step(n,ms) 推进到 targetTimeMs
#   url-time   ：URL 里已经带 ?time=<秒>，重载即冻住；没有推进过程，也就没有时钟与档位接口
function Invoke-Frame {
    param([string]$Id, $Vec, [string]$TierName)
    $patchJson = $Vec | ConvertTo-Json -Compress -Depth 6
    # 写护栏执行点②：protectPaths 逐条作为 --protect 传给 applier（可重复），走数组 splat ——
    # 手工拼引号会在路径带空格时被拆开，拼错就又成了"护栏静默失效"。
    $protectArgs = @()
    foreach ($pp in $protectPaths) { $protectArgs += @('--protect', $pp) }
    if ($applyFormat -eq 'flat-params') {
        $nodeArgs = @($applyJs, $baseJson, $mirrorJson, $patchJson) + $protectArgs
    }
    else {
        $nodeArgs = @($applyJs, $baseJson, $mirrorJson, $Effect, $Block, $patchJson) + $protectArgs
    }
    $setOut = & node @nodeArgs 2>&1
    if (("$setOut") -notmatch '^OK') { throw ('apply 失败 id=' + $Id + ' : ' + ($setOut -join ' ')) }

    $null = EvalJs 'window.__t3_stale = 1; "marked"'
    # 载入：偶发 CDP 超时（机器被别的任务压住时），给 1 次重试；再失败才算真失败。
    $g = $null
    for ($try = 1; $try -le 2; $try++) {
        $g = Cap-Goto -Url $url -ReadyExpr $jsReady -TimeoutMs 30000
        if ($g.ready) { break }
        if ($try -lt 2) { Write-Output ('[warn] 载入超时 id=' + $Id + '（第 ' + $try + ' 次，重试一次） val=' + $g.val) ; Start-Sleep -Milliseconds 900; $null = EvalJs 'window.__t3_stale = 1; "marked"' }
    }
    if (-not $g.ready) { throw ('载入超时 id=' + $Id + ' val=' + $g.val) }

    if ($freezeProto -eq 'noloop-step') {
        # 宿主能力自检（P2.6）：noloop-step 必须有 window.step / window.playFx，否则"推进"两句都是空转，
        # 帧其实停在墙上时间的随机时刻 —— 出得来图但根本不是冻帧，这就是静默降级，必须先拦住。
        $cap = EvalJs 'String((typeof window.step === "function" ? "step" : "-") + "|" + (typeof window.playFx === "function" ? "playFx" : "-"))'
        if ("$cap" -ne 'step|playFx') { throw ('该宿主不支持 noloop-step 协议（页面缺 window.step / window.playFx，实测=' + $cap + '）—— 拒绝静默降级，改用 url-time 或换宿主') }
        if ($TierName -ne 'ultra') { $null = EvalJs ($jsTier.Replace('TIER', $TierName)) }
        $null = EvalJs ("String(window.playFx('" + $Effect + "'))")
        if ($clockMode -eq 'virtual') {
            # 注入虚拟钟并**当场自检**：performance.now 必须真的被换成我们的函数（赋值失败会静默，不查就白冻）
            $vc = EvalJs ('(function(){var t=0;function f(){t+=' + $clockStepMs + ';return t;}try{performance.now=f;}catch(e){return "ERR:"+e;}t=0;return "vclock:"+(performance.now===f);})()')
            if ("$vc" -notmatch '^vclock:true') { throw ('虚拟时钟注入失败（performance.now 换不掉）: ' + $vc) }
        }
        $null = EvalJs ("String(window.step(" + $StepN + "," + $StepMs + "))")
    }
    else {
        # url-time：重载即冻。但"页面吃没吃 ?time="必须自己验 —— 同一 URL 连拍两张，逐字节比。
        # 不比的话，页面无视参数继续跑动画，图照样出得来，只是每张都在不同时刻 → 静默降级。
        if (-not $script:urlTimeVerified) {
            if ($freezeVerifyMode -ne 'off') {
                $v1 = Join-Path $logs '_freeze_a.png'
                $v2 = Join-Path $logs '_freeze_b.png'
                Save-Shot $v1
                Start-Sleep -Milliseconds 450
                Save-Shot $v2
                $h1 = Get-Sha $v1; $h2 = Get-Sha $v2
                $script:urlTimeVerified = ($h1 -eq $h2)
                if ($script:urlTimeVerified) {
                    Write-Output ('[freeze] url-time 冻帧自检通过：t=' + $urlSec + 's 两张截图逐字节相同 (' + (Sha12 $h1) + ')')
                }
                elseif ($freezeVerifyMode -eq 'strict') {
                    throw ('url-time 冻帧失败：同一 URL 连拍两张不同 (' + (Sha12 $h1) + ' vs ' + (Sha12 $h2) + ') —— 页面没真的吃 ?time=' + $urlSec + '，拒绝出证据包（不许静默降级）')
                }
                else { Write-Output ('[freeze][warn] url-time 冻帧自检未通过：' + (Sha12 $h1) + ' vs ' + (Sha12 $h2)) }
            }
            else { $script:urlTimeVerified = $true }
        }
    }

    # 回读：证明这轮真的吃到了新参数（E2 §2 的坑：改错块 = 画面零变化却毫无报错）
    # adapter 没给 page.readbackExpr 时这里是中性默认「不回读」：只靠 apply 的 JSON 回读校验兜底，
    # 并且 meta.selfCheck=false（上面打过的 warn）—— 不能因为"跳过"就把结论写成"验过"。
    if ($jsReadback) {
        $cfgRaw = EvalJs $jsReadback
        if ("$cfgRaw" -notmatch '^\{') { throw ('回读配置失败 id=' + $Id + ' : ' + $cfgRaw) }
        $cfgObj = $cfgRaw | ConvertFrom-Json -AsHashtable
        foreach ($k in $wl) {
            if ($Vec.Keys -notcontains $k) { continue }   # 目标帧可以只给部分参数（含"默认参数"= 一个都不给）
            $want = [double]$Vec[$k]
            if ($cfgObj.Keys -notcontains $k) { throw ('回读里缺参数 id=' + $Id + ' ' + $k + '（adapter.page.readbackExpr 指的对象不对？）') }
            $got = [double]$cfgObj[$k]
            if ([math]::Abs($want - $got) -gt 1e-6) { throw ('参数没吃到 id=' + $Id + ' ' + $k + ' want=' + $want + ' got=' + $got) }
        }
    }
}

function Save-Shot([string]$path) {
    $bytes = Cap-Shot -Path $path
    if ($bytes -le 0) { throw ('截图失败 ' + $path) }
}

# 一次评估 = 改参 + 载入 + 截图（缓存命中不算评估）
function Invoke-Render {
    param([string]$Id, $Vec, [int]$Round, [string]$Note, [string]$Phase)
    $key = Key-Of $Vec
    if ($script:cache.ContainsKey($key)) {
        $script:usage.cache++
        return [pscustomobject]@{ seq = $script:cache[$key]; cached = $true }
    }
    if ($script:usage.used -ge $Budget) { return $null }   # 预算保护：用完即停

    $t0 = $sw.ElapsedMilliseconds
    Invoke-Frame -Id $Id -Vec $Vec -TierName $Tier
    $png = Join-Path $shots ($Id + '.png')
    Save-Shot $png
    $ms = $sw.ElapsedMilliseconds - $t0

    $script:seq++
    $rec = [ordered]@{
        seq = $script:seq; id = $Id; round = $Round; note = $Note
        params = $Vec; png = $png; tMs = $ms
        dist = $null; dprof = $null; dlap = $null; dwarm = $null; pen = $null
        lapVar = $null; warmFrac = $null; mean = $null; covCore = $null; ratioCore = $null; prof = $null
        mvals = $null; parts = $null
    }
    [void]$script:evals.Add($rec)
    $script:bySeq[$script:seq] = $rec
    $script:cache[$key] = $script:seq
    [void]$script:evMs.Add($ms)
    $script:usage.used++
    if ($Phase) { $script:usage[$Phase]++ }
    return [pscustomobject]@{ seq = $script:seq; cached = $false }
}

# 批量算指标 + 距离（一次 node 冷启动，不逐张调用）
function Measure-Pending {
    $pend = @($script:evals | Where-Object { $null -eq $_.dist })
    if ($pend.Count -eq 0) { return }
    $script:bagN++
    $pngs = @($pend | ForEach-Object { $_.png })
    $bagPath = Join-Path $logs ('bag_' + $script:bagN + '.json')
    # P2.5：指标提取与距离计算都吃 adapter（--adapter），脚本不再决定"量什么"
    $null = & node $MetricsJs @pngs --out $bagPath --adapter $Adapter --ref $targetPng 2>&1 | Select-Object -Last 1
    if (-not (Test-Path $bagPath)) { throw ('metrics 失败: ' + $bagPath) }
    $bag = Get-Content $bagPath -Raw | ConvertFrom-Json -AsHashtable
    $dPath = Join-Path $logs ('d_' + $script:bagN + '.json')
    $null = & node (Join-Path $ToolDir 'score.js') $bagPath $script:tgtBagPath --adapter $Adapter --out $dPath 2>&1 | Select-Object -Last 1
    $dAll = Get-Content $dPath -Raw | ConvertFrom-Json
    $dBy = @{}
    foreach ($x in $dAll) { $dBy[$x.id] = $x }
    foreach ($e in $pend) {
        $kk = $e.id
        $m = $bag[$kk]; $x = $dBy[$kk]
        if ($null -eq $m -or $null -eq $x) { throw ('缺指标 ' + $kk) }
        $e.dist = [double]$x.d; $e.dprof = $x.dprof; $e.dlap = $x.dlap; $e.dwarm = $x.dwarm; $e.pen = [double]$x.pen
        $e.lapVar = $m.lapVar; $e.warmFrac = $m.warmFrac; $e.mean = $m.mean; $e.covCore = $m.covCore
        $e.ratioCore = $m.ratioCore; $e.prof = $m.prof
        # 配置里声明了哪些指标，就按 id 全量记一遍（证据包动态列用的就是这组）
        $mv = @{}; $pt = @{}
        foreach ($mid in $script:metricIds) {
            if ($m.ContainsKey($mid)) { $mv[$mid] = $m[$mid] }
            if ($null -ne $x.parts -and $null -ne $x.parts.$mid) { $pt[$mid] = $x.parts.$mid }
        }
        $e.mvals = $mv; $e.parts = $pt
    }
}

$startDist = $null
$bestSeq = 0
$bestDist = $null
$bestVec = $null
$r0 = $null

try {
    Start-Browser

    # ---------- 5.1 目标帧 ----------
    $tBagPath = Join-Path $logs 'target_metrics.json'
    if ($targetKind -eq 'png') {
        Copy-Item -Path $targetSrcPng -Destination $targetPng -Force
        $dim = & node -e "const b=require('fs').readFileSync(process.argv[1]);console.log(b.readUInt32BE(16)+'x'+b.readUInt32BE(20))" $targetPng
        if ("$dim" -ne ($W.ToString() + 'x' + $H.ToString())) { Write-Output ('[warn] 目标帧尺寸 ' + $dim + ' 与本次搜索 ' + $W + 'x' + $H + ' 不一致 —— 距离可能没意义') }
        $null = & node $MetricsJs $targetPng --out $tBagPath --adapter $Adapter --ref $targetPng 2>&1 | Select-Object -Last 1
        Write-Output ('[target] png 目标 ' + $targetSrcPng + '  sha256=' + (Get-Sha $targetPng).Substring(0, 16) + '…')
    }
    else {
        if ($targetKind -eq 'default') {
            # 默认参数目标：一个键都不 patch（= 块内现值 / 配置文件的现值）+ 当前冻帧时刻
            $tPatch = '{}'
            Invoke-Frame -Id 'target' -Vec @{} -TierName $Tier
            Save-Shot $targetPng
            $script:usage.used++; $script:usage.target = 1
            $null = & node $MetricsJs $targetPng --out $tBagPath --adapter $Adapter --ref $targetPng 2>&1 | Select-Object -Last 1
            Write-Output ('[target] 默认参数目标（不 patch，块内现值 + 冻帧 t=' + $T + 'ms）  -> 帧 sha256=' + (Get-Sha $targetPng).Substring(0, 16) + '…')
        }
        else {
            $tPatch = $targetSpecObj | ConvertTo-Json -Compress -Depth 6
            Invoke-Frame -Id 'target' -Vec $targetSpecObj -TierName $Tier
            Save-Shot $targetPng
            $script:usage.used++; $script:usage.target = 1
            $null = & node $MetricsJs $targetPng --out $tBagPath --adapter $Adapter --ref $targetPng 2>&1 | Select-Object -Last 1
            foreach ($k in @($targetSpecObj.Keys)) { if ($wl -notcontains $k) { Write-Output ('[warn] 目标参数 ' + $k + ' 不在白名单里（只影响目标帧，不影响搜索轴）') } }
            Write-Output ('[target] 参数目标 ' + $tPatch + '  -> 帧 sha256=' + (Get-Sha $targetPng).Substring(0, 16) + '…')
        }
    }
    if (-not (Test-Path $tBagPath)) { throw ('目标帧指标缺失: ' + $tBagPath) }
    $rawT = Get-Content $tBagPath -Raw | ConvertFrom-Json -AsHashtable
    $tgtMetrics = $rawT[(@($rawT.Keys)[0])]
    $script:tgtBagPath = Join-Path $logs 'tgt.json'
    [IO.File]::WriteAllText($script:tgtBagPath, (ConvertTo-Json @{ tgt = $tgtMetrics } -Depth 8), (New-Object Text.UTF8Encoding($false)))
    Write-Output ('[target] 指标 ' + ((@($script:metricIds) | ForEach-Object { $_ + '=' + $tgtMetrics[$_] }) -join '  ') + '  covCore=' + $tgtMetrics.covCore)

    # ---------- 5.2 起始帧（同时是预检的参照帧） ----------
    $r0 = Invoke-Render -Id 'e001' -Vec $startParams -Round 0 -Note 'start' -Phase 'start'
    Measure-Pending
    $startDist = $script:bySeq[$r0.seq].dist
    $startRec = $script:bySeq[$r0.seq]
    Write-Output ('[start] d=' + $startDist.ToString('0.0000') + '  ' + (Key-Of $startParams))

    # ---------- 5.3 参数活性预检（E2 挖的坑，必做） ----------
    Write-Output '[precheck] 每个参数改一档，Δd=0 记 dead 并跳过'
    $pcList = New-Object System.Collections.ArrayList
    foreach ($k in $wl) {
        if ($script:usage.used -ge $Budget) { $script:stopDetail = '预检阶段预算耗尽'; break }
        $pv = New-Vector $startParams $k 1
        $rr = Invoke-Render -Id ('pc_' + $k) -Vec $pv -Round -1 -Note ('precheck:' + $k) -Phase 'precheck'
        if ($null -eq $rr) { break }
        [void]$pcList.Add([pscustomobject]@{ param = $k; vec = $pv; seq = $rr.seq })
    }
    Measure-Pending
    foreach ($p in $pcList) {
        $rec = $script:bySeq[$p.seq]
        if ($null -eq $rec.dist) { throw ('预检指标缺失 ' + $p.param) }
        $dDelta = [math]::Abs($rec.dist - $startDist)
        $same = ((Get-Sha $rec.png) -eq (Get-Sha $startRec.png))
        $verdict = if ($dDelta -le 1e-9) { 'dead' } else { 'alive' }
        if ($verdict -eq 'alive') { [void]$script:alive.Add($p.param) } else { [void]$script:dead.Add($p.param) }
        [void]$script:precheckRows.Add([ordered]@{
                param = $p.param; start = [double]$startParams[$p.param]; perturbed = [double]$p.vec[$p.param]
                dist = [math]::Round($rec.dist, 6); dDelta = [math]::Round($dDelta, 6)
                pixelSame = $same; verdict = $verdict; seq = $rec.seq
            })
        Write-Output ('[precheck] ' + $p.param + ' ' + $startParams[$p.param] + '->' + $p.vec[$p.param] + '  d=' + $rec.dist.ToString('0.0000') + '  Δd=' + $dDelta.ToString('0.000000') + '  像素同=' + $(if ($same) { 'Y' } else { 'N' }) + '  => ' + $verdict)
    }
    if ($script:alive.Count -eq 0 -and $script:dead.Count -gt 0) { $script:stopReason = 'all-dead'; $script:stopDetail = ('白名单 ' + $script:dead.Count + ' 个参数全部 dead，一次搜索都没跑') }

    # ---------- 5.4 搜索 ----------
    $bestVec = Copy-Vec $startParams
    $bestSeq = $r0.seq
    $bestDist = $startDist
    $roundNo = 0
    $stagnant = 0
    $rng = $null
    if ($Strategy -eq 'random') { $rng = [Random]::new($Seed) }   # 同 seed -> 同序列（可复现）

    while (-not $script:stopReason -and $roundNo -lt $MaxRounds) {
        $roundNo++
        $cands = New-Object System.Collections.ArrayList
        [void]$cands.Add([pscustomobject]@{ note = 'none'; vec = (Copy-Vec $bestVec) })

        if ($Strategy -eq 'coordinate') {
            foreach ($k in $script:alive) {
                [void]$cands.Add([pscustomobject]@{ note = ($k + '-'); vec = (New-Vector $bestVec $k -1) })
                [void]$cands.Add([pscustomobject]@{ note = ($k + '+'); vec = (New-Vector $bestVec $k +1) })
            }
        }
        else {
            # random：以当前最优为盒心，每轴 ±3 步长内均匀采样（2×活参数 个样本）
            $n = [math]::Max(2, 2 * $script:alive.Count)
            for ($i = 0; $i -lt $n; $i++) {
                $v = @{}
                foreach ($k in $wl) {
                    $bv = [double]$bestVec[$k]
                    if ($script:alive -contains $k) {
                        $s = Get-Step $bv
                        $v[$k] = Round6 ($bv + (($rng.NextDouble() * 6 - 3) * $s))
                    }
                    else { $v[$k] = $bv }
                }
                [void]$cands.Add([pscustomobject]@{ note = ('rand' + ($i + 1)); vec = $v })
            }
        }

        $hit = New-Object System.Collections.ArrayList
        $budgetHit = $false
        foreach ($c in $cands) {
            $rr = Invoke-Render -Id ('r' + $roundNo + '_s' + ($script:seq + 1)) -Vec $c.vec -Round $roundNo -Note $c.note -Phase 'search'
            if ($null -eq $rr) { $budgetHit = $true; break }
            [void]$hit.Add([pscustomobject]@{ note = $c.note; vec = $c.vec; seq = $rr.seq })
        }
        if ($hit.Count -eq 0) { $script:stopReason = 'budget'; $script:stopDetail = '预算在换轮前耗尽'; break }
        Measure-Pending
        if ($budgetHit) { $script:stopReason = 'budget'; $script:stopDetail = ('第 ' + $roundNo + ' 轮候选没评完，预算已用尽') }

        $pick = $null
        # 注意：循环变量不能叫 $h —— PowerShell 变量名不区分大小写，会撞上 [int]$H 的类型约束
        foreach ($hd in $hit) {
            $rr2 = $script:bySeq[$hd.seq]
            if ($null -eq $rr2.dist) { continue }
            if ($null -eq $pick -or $rr2.dist -lt $pick.dist) { $pick = [pscustomobject]@{ seq = $hd.seq; dist = $rr2.dist; note = $hd.note; vec = $hd.vec } }
        }
        if ($null -eq $pick) { throw ('第 ' + $roundNo + ' 轮没有任何可用评估') }

        [void]$script:roundLog.Add([ordered]@{
                round  = $roundNo
                cands  = @($hit | ForEach-Object { [ordered]@{ note = $_.note; seq = $_.seq } })
                winner = $pick.seq
            })

        $line = ($hit | ForEach-Object { $_.note + '=' + $script:bySeq[$_.seq].dist.ToString('0.0000') }) -join '  '
        Write-Output ('[round ' + $roundNo + '] ' + $line + '   -> 胜出 ' + $pick.note + ' d=' + $pick.dist.ToString('0.0000') + '  已用 ' + $script:usage.used + '/' + $Budget)

        if ($pick.dist -lt $bestDist - 1e-9) {
            $bestVec = $pick.vec; $bestDist = $pick.dist; $bestSeq = $pick.seq; $stagnant = 0
        }
        else { $stagnant++ }

        if ($roundNo % $ThumbEvery -eq 0) {
            $dst = Join-Path $thumbs ('r' + $roundNo.ToString('00') + '_d' + $bestDist.ToString('0.0000') + '.png')
            Copy-Item $script:bySeq[$bestSeq].png $dst -Force
            [void]$script:thumbFiles.Add($dst)
        }

        if (-not $script:stopReason -and $stagnant -ge $MaxStagnant) { $script:stopReason = 'stagnant'; $script:stopDetail = ('连续 ' + $stagnant + ' 轮没有改进（每轮 ±' + ($StepRatio * 100) + '% 都变差）') }
        if (-not $script:stopReason -and $roundNo -ge $MaxRounds) { $script:stopReason = 'max-rounds'; $script:stopDetail = ('达到 -MaxRounds ' + $MaxRounds) }
    }
    if (-not $script:stopReason) { $script:stopReason = 'max-rounds' }

    Write-Output ('[budget] 已用 ' + $script:usage.used + ' 次评估 / 上限 ' + $Budget + '（目标帧 ' + $script:usage.target + ' + 预检 ' + $script:usage.precheck + ' + 搜索 ' + $script:usage.search + '，缓存命中 ' + $script:usage.cache + '）')
    Write-Output ('[stop] ' + $script:stopReason + '  ' + $script:stopDetail)

    # ---------- 5.5 最佳帧另存 + 可选 B 档留档 ----------
    $bestPng = Join-Path $shots 'best.png'
    Copy-Item $script:bySeq[$bestSeq].png $bestPng -Force
    if ($HiShot) {
        $t0 = $sw.ElapsedMilliseconds
        Cap-Viewport -W $HiW -H $HiH
        Invoke-Frame -Id 'hi' -Vec $bestVec -TierName $HiTier
        $script:hiPng = Join-Path $shots 'run.png'
        Save-Shot $script:hiPng
        $script:usage.hi = 1
        Write-Output ('[hi] ' + $HiW + 'x' + $HiH + ' + ' + $HiTier + ' -> ' + $script:hiPng + ' (' + ($sw.ElapsedMilliseconds - $t0) + 'ms)')
    }
}
finally {
    $leftover = Stop-Browser
    # 镜像还原：实验期间只动过这一份 vfx.json，从基线快照拷回
    try { Copy-Item -Path $baseJson -Destination $mirrorJson -Force } catch { Write-Output ('[cleanup] 镜像还原失败: ' + $_) }
    if ($srvStarted -and $srvProc) { try { Stop-Process -Id $srvProc.Id -Force -ErrorAction SilentlyContinue } catch { } }
    Start-Sleep -Milliseconds 300
    $portLeft = @(Get-NetTCPConnection -State Listen -LocalPort $StaticPort -ErrorAction SilentlyContinue).Count
    Write-Output ('[cleanup] 浏览器残留(按 profile 匹配)=' + $leftover + '  静态服端口 ' + $StaticPort + ' 监听数=' + $portLeft)
}

# ---------------- 6. 证据包 ----------------
$mirrorShaAfter = Get-Sha $mirrorJson
$bodyShaAfter = Get-Sha $bodyJson
$elapsedSec = [math]::Round(($sw.ElapsedMilliseconds - $tAll0) / 1000.0, 2)
$msList = @($script:evMs)
$msPerEval = if ($msList.Count) { [int]($msList | Sort-Object)[[int]($msList.Count / 2)] } else { 0 }

$bestRec = $script:bySeq[$bestSeq]
$evalRows = @($script:evals | ForEach-Object {
        [ordered]@{
            round = $_.round; seq = $_.seq; id = $_.id; note = $_.note
            params = $_.params; png = $_.png
            dist = $_.dist; dprof = $_.dprof; dlap = $_.dlap; dwarm = $_.dwarm; pen = $_.pen
            lapVar = $_.lapVar; warmFrac = $_.warmFrac; mean = $_.mean; covCore = $_.covCore
            mvals = $_.mvals; parts = $_.parts
        }
    })

$bundle = [ordered]@{
    meta        = [ordered]@{
        command = $cmdline; url = $url; mirror = $Mirror; mirrorJson = $mirrorJson
        effect = $Effect; block = $Block
        seed = $Seed; t = $T; stepN = $StepN; stepMs = $StepMs
        w = $W; h = $H; tier = $Tier
        strategy = $Strategy; stepRatio = $StepRatio; budget = $Budget
        maxRounds = $MaxRounds; maxStagnant = $MaxStagnant; thumbEvery = $ThumbEvery
        whitelist = @($wl)
        baseSha256 = $baseSha; mirrorShaBefore = $mirrorShaBefore; mirrorShaAfter = $mirrorShaAfter
        bodyShaBefore = $bodyShaBefore; bodyShaAfter = $bodyShaAfter
        startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        elapsedSec = $elapsedSec; msPerEval = $msPerEval
        hiW = $HiW; hiH = $HiH; hiTier = $HiTier
        metricsJs = $MetricsJs; toolDir = $ToolDir
        metricIds = @($script:metricIds)
        metricsJson = (ConvertTo-Json -InputObject @($A.metrics) -Compress -Depth 8)
        scoreJson = (ConvertTo-Json -InputObject $A.score -Compress -Depth 8)
        adapter = $A.name; adapterPath = $Adapter; adapterSchema = [string]$A.schema
        captureJs = $captureJs; pageFile = $pageFile; freezeProtocol = $freezeProto
        clockMode = $clockMode; clockStepMs = $clockStepMs
        staticPort = $StaticPort; cdpPort = $CdpPort; profPrefix = $profPrefix; profileRoot = $ProfileRoot; root = $Root
        # P2.6：这几项进证据包，证明"目标/白名单/协议/改参形态"都是配置决定的
        targetSrc = $targetSrc; targetModeNote = $targetModeNote
        paramsSrc = $paramsSrc; paramsRaw = $paramsRaw; activity = $activityInfo
        applyFormat = $applyFormat; applyJs = $applyJs
        urlTemplate = $urlTemplate; urlSec = $(if ($freezeProto -eq 'url-time') { $urlSec } else { $null })
        freezeVerify = $freezeVerifyMode; freezeVerified = $script:urlTimeVerified
        # adapter 没给 page.readbackExpr 时 false：这轮只做了 apply 的 JSON 回读，没证明宿主真的吃到参数
        selfCheck = $script:selfCheck
        configPath = $cfgRel; pageQuery = $pageQuery
        # 写护栏的证据：保护路径列表 + 这轮到底强制没强制（enforced=false 时报告里必须看得出来）
        protectPaths = @($protectPaths); guardEnforced = ($protectPaths.Count -gt 0)
        guardBodyClient = $BodyClient
    }
    target      = [ordered]@{
        kind = $targetKind
        mode = $(if ($targetSrc -eq 'adapter') { [string]$A['target'].mode } else { 'cli' })
        srcFrom = $targetSrc
        spec = $(if ($targetKind -eq 'json') { $targetSpecObj } else { $null })
        src = $(if ($targetKind -eq 'png') { $targetSrcPng } elseif ($targetKind -eq 'default') { '(adapter.target.mode=default)' } else { '' })
        png = $targetPng
        sha256 = (Get-Sha $targetPng)
        metrics = $tgtMetrics
    }
    startParams = $startParams
    startDist   = $startDist
    best        = [ordered]@{ params = $bestRec.params; dist = $bestRec.dist; seq = $bestRec.seq; png = $bestPng }
    dead        = @($script:dead)
    alive       = @($script:alive)
    precheck    = [ordered]@{ rows = @($script:precheckRows) }
    rounds      = @($script:roundLog)
    evals       = $evalRows
    usage       = $script:usage
    stop        = [ordered]@{ reason = $script:stopReason; detail = $script:stopDetail; used = $script:usage.used; budget = $Budget }
    thumbs      = @($script:thumbFiles | ForEach-Object { [IO.Path]::GetRelativePath($Out, $_) })
    hiPng       = $(if ($script:hiPng) { [IO.Path]::GetRelativePath($Out, $script:hiPng) } else { '' })
}
$runJson = Join-Path $logs '_run.json'
[IO.File]::WriteAllText($runJson, (ConvertTo-Json $bundle -Depth 12), (New-Object Text.UTF8Encoding($false)))

$fin = & node (Join-Path $ToolDir 'finalize.js') $runJson $Out 2>&1
$fin | ForEach-Object { Write-Output ('[finalize] ' + $_) }

Write-Output ('[done] 证据包 -> ' + $Out)
Write-Output ('[done] report.md / best.json / curve.csv / shots\ (target.png, best.png' + $(if ($script:hiPng) { ', run.png' } else { '' }) + ')')
Write-Output ('[cleanup] 镜像 vfx.json ' + (Sha12 $mirrorShaBefore) + ' -> ' + (Sha12 $mirrorShaAfter) + '（应等于基线 ' + (Sha12 $baseSha) + '）')
if ($BodyClient) {
    Write-Output ('[cleanup] 本体 vfx.json ' + (Sha12 $bodyShaBefore) + ' -> ' + (Sha12 $bodyShaAfter) + '（必须一致）  保护路径 ' + $protectPaths.Count + ' 条')
}
else {
    Write-Output ('[cleanup] 本体 vfx.json n/a（adapter 没给 guard.bodyClient：本体不参与本次实验）  保护路径 ' + $protectPaths.Count + ' 条')
}

