# capture.ps1 —— 「浏览器 + 页面 + 截图」边界的 PowerShell 侧薄封装（P1 适配层）
#
# 本文件**只有管道**，没有浏览器知识：真正的实现在 capture.mjs（Node，NDJSON 协议）。
# iter.ps1 通过下面 7 个函数使用边界；将来换 Playwright 只改 capture.mjs 内部，
# 本文件与 iter.ps1 都不用动。
#
# 契约（输入 -> 输出）：
#   Cap-Init   -CaptureJs <path>                        初始化（不启动进程）
#   Cap-Start  -Exe -Args -W -H -CdpPort -Profile -ProfileRoot   起浏览器 + 连 CDP + 钉视口 -> @{pid;wsUrl}
#   Cap-Viewport -W -H                                  改视口（高分辨率留档用）
#   Cap-Goto   -Url -ReadyExpr -TimeoutMs               导航并等 ready -> @{ready;waitedMs;val}
#   Cap-WaitFor -Expr -Want -TimeoutMs                  轮询 JS 直到等于 Want -> @{hit;ms;val}
#   Cap-Eval   -Expr                                    求值 -> 字符串（异常 'EXC:..'，无响应 '<noresp>'）
#   Cap-Shot   -Path                                    截当前帧写成 png 文件 -> 字节数
#   Cap-Stop                                            收尾（按 PID 杀树 + 按 profile 扫残留）-> 残留数
#
# 进程纪律：node 子进程由本文件持有，stdin 关闭即自动收尾；浏览器只杀自己那棵进程树
# 和 CommandLine 里带本 run profile 的进程，绝不泛杀 msedge。

# ---------------- 平台守卫（Windows 专用） ----------------
# 本文件会被 iter.ps1 dot-source（共用作用域），所以这里用 throw 而不是 exit —— exit 会把调用方的
# shell 一起关掉。正常路径上 iter.ps1 已经在入口拦过一遍，这里是"单独 dot-source 本文件"时的兜底。
$isWindowsHost = $true
if ($PSVersionTable.PSEdition -eq 'Core') { $isWindowsHost = ($IsWindows -ne $false) }
if (-not $isWindowsHost) {
    $platDesc = [string]$PSVersionTable.OS
    if (-not $platDesc) { $platDesc = [Environment]::OSVersion.VersionString }
    throw ('本适配器需要 Windows（harness 基于 PowerShell + Edge）；当前平台 ' + $platDesc + ' 不受支持。')
}

$script:capProc = $null
$script:capJs = ''
$script:capId = 0

function Cap-Init([string]$CaptureJs) {
    if (-not (Test-Path $CaptureJs)) { throw ('capture.mjs 不存在: ' + $CaptureJs) }
    $script:capJs = (Resolve-Path $CaptureJs).Path
    $script:capId = 0
}

function Cap-Ensure {
    if ($script:capProc -and -not $script:capProc.HasExited) { return }
    if (-not $script:capJs) { throw 'capture 未初始化：先调 Cap-Init -CaptureJs <capture.mjs>' }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.ArgumentList.Add($script:capJs)
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    # 请求里有中文路径：stdin 必须显式 UTF-8，否则按 ANSI 代码页发出去就是乱码
    $psi.StandardInputEncoding = New-Object System.Text.UTF8Encoding($false)
    $script:capProc = [System.Diagnostics.Process]::Start($psi)
}

function Cap-Call($req, [int]$timeoutMs = 60000) {
    Cap-Ensure
    $script:capId++
    $id = $script:capId
    $req['id'] = $id
    if ($script:capProc.HasExited) { throw ('capture 进程已退出（cmd=' + $req['cmd'] + '）') }
    $script:capProc.StandardInput.WriteLine(($req | ConvertTo-Json -Compress -Depth 8))
    $script:capProc.StandardInput.Flush()
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    while ($true) {
        $remain = [int][math]::Max(1, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        $t = $script:capProc.StandardOutput.ReadLineAsync()
        if (-not $t.Wait($remain)) { throw ('capture 响应超时 ' + $timeoutMs + 'ms（cmd=' + $req['cmd'] + '）') }
        $line = $t.Result
        if ($null -eq $line) { throw ('capture 进程无输出（cmd=' + $req['cmd'] + '）') }
        if (-not $line.Trim()) { continue }
        $resp = $line | ConvertFrom-Json -AsHashtable
        if ($null -eq $resp.id -or $resp.id -ne $id) { continue }   # 非本请求的行：丢弃（诊断行在 stderr）
        if (-not $resp.ok) { throw ('capture ' + $req['cmd'] + ' 失败: ' + $resp.err) }
        return $resp
    }
}

function Cap-Start([string]$Exe, [string[]]$Arguments, [int]$W, [int]$H, [int]$CdpPort, [string]$Profile, [string]$ProfileRoot) {
    # 注意：参数别叫 -Args —— PowerShell 里 $args 是自动变量，容易把自己清空。
    # -ProfileRoot = 本包的临时 profile 根：capture.mjs 只在这个目录下清孤儿（父进程已不在的那些），
    # 传空则退化成 Profile 的上级目录。
    $r = Cap-Call @{ cmd = 'start'; exe = $Exe; args = @($Arguments); w = $W; h = $H; cdpPort = $CdpPort; profile = $Profile; profileRoot = $ProfileRoot } 60000
    return [pscustomobject]@{ pid = [int]$r.pid; wsUrl = $r.wsUrl }
}

function Cap-Viewport([int]$W, [int]$H) {
    $null = Cap-Call @{ cmd = 'viewport'; w = $W; h = $H } 15000
}

function Cap-Goto([string]$Url, [string]$ReadyExpr, [int]$TimeoutMs) {
    $r = Cap-Call @{ cmd = 'goto'; url = $Url; readyExpr = $ReadyExpr; timeoutMs = $TimeoutMs } ($TimeoutMs + 15000)
    return [pscustomobject]@{ ready = [bool]$r.ready; waitedMs = [int]$r.waitedMs; val = [string]$r.val }
}

function Cap-WaitFor([string]$Expr, [string]$Want, [int]$TimeoutMs) {
    $r = Cap-Call @{ cmd = 'waitfor'; expr = $Expr; want = $Want; timeoutMs = $TimeoutMs } ($TimeoutMs + 15000)
    return [pscustomobject]@{ hit = [bool]$r.hit; ms = [int]$r.ms; val = [string]$r.val }
}

function Cap-Eval([string]$Expr) {
    $r = Cap-Call @{ cmd = 'eval'; expr = $Expr } 60000
    if ($r.status -eq 'noresp') { return '<noresp>' }
    if ($r.status -eq 'exc') { return [string]$r.value }
    if ($null -eq $r.value) { return '' }
    return [string]$r.value
}

function Cap-Shot([string]$Path) {
    $r = Cap-Call @{ cmd = 'shot'; path = $Path } 60000
    return [int]$r.bytes
}

function Cap-Stop {
    if (-not $script:capProc) { return -1 }
    $left = -1
    try {
        if (-not $script:capProc.HasExited) {
            $r = Cap-Call @{ cmd = 'stop' } 60000
            $left = [int]$r.leftover
        }
    }
    catch { $left = -1 }
    try { $script:capProc.StandardInput.Close() } catch { }
    if (-not $script:capProc.WaitForExit(8000)) { try { $script:capProc.Kill() } catch { } }
    $script:capProc = $null
    return $left
}
