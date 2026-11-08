# 安装/重装「听雪记忆服务」为 Windows 服务（nssm）。
# 需要管理员权限运行（UAC）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File service\install-nssm.ps1
#
# 不写死任何本机路径：
#   · 仓库位置 = 本脚本所在目录的上一级（$PSScriptRoot\..）—— clone 到哪都行
#   · node 位置 = 先看 PATH，再按常见安装位置探测；也可用 -NodePath 显式指定
#     .\service\install-nssm.ps1
#     .\service\install-nssm.ps1 -NodePath "C:\Program Files\nodejs\node.exe"
param(
  [string]$NodePath = ''
)
$ErrorActionPreference = 'Continue'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$svc = 'tingxue-memory'
$nssm = Join-Path $repo 'service\bin\nssm.exe'
$logs = Join-Path $repo 'logs'
$log = Join-Path $logs 'install-nssm.log'

# node 探测：PATH 优先，其次常见安装位置（官方安装包 / winget / nvm / 便携版）
function Find-Node([string]$explicit) {
  if ($explicit -and (Test-Path $explicit)) { return (Resolve-Path $explicit).Path }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cands = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:APPDATA 'nvm\node.exe'),
    (Join-Path $env:ProgramData 'chocolatey\bin\node.exe')
  ) | Where-Object { $_ }
  foreach ($c in $cands) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
  return ''
}

$node = Find-Node $NodePath

try { New-Item -ItemType Directory -Force $logs | Out-Null } catch { }
function Say($m) {
  $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m
  try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch { }
  Write-Host $line
}

Say "start; repo=$repo"
Say "nssm=$nssm exists=$(Test-Path $nssm)"
Say "node=$node exists=$(Test-Path $node)"

function Run($exe, [string[]]$argv) {
  Say ('> ' + $exe + ' ' + ($argv -join ' '))
  $out = & $exe @argv 2>&1
  $code = $LASTEXITCODE
  foreach ($line in @($out)) { Say ('  ' + $line) }
  Say ('  exit=' + $code)
  return $code
}

if (-not (Test-Path $nssm)) { Say 'ERROR: nssm.exe missing（service\bin\nssm.exe 应随仓库提供）'; exit 1 }
if (-not $node -or -not (Test-Path $node)) {
  Say 'ERROR: 找不到 node.exe。先装 Node.js >= 22.19，或用 -NodePath 指定：'
  Say '  .\service\install-nssm.ps1 -NodePath "C:\Program Files\nodejs\node.exe"'
  exit 1
}

# 幂等清理：不存在时返回非 0，允许
$null = Run $nssm @('stop', $svc)
Start-Sleep -Milliseconds 500
$null = Run $nssm @('remove', $svc, 'confirm')
Start-Sleep -Milliseconds 300

$code = Run $nssm @('install', $svc, $node, 'service\memory-service.mjs')
if ($code -ne 0) { Say 'ERROR: nssm install failed'; exit 1 }

$settings = @(
  @('AppDirectory', $repo),
  @('DisplayName', 'Tingxue Memory Service'),
  @('Description', 'Tingxue independent memory service: LanceDB single writer on 127.0.0.1:8766.'),
  @('Start', 'SERVICE_AUTO_START'),
  @('AppStdout', (Join-Path $logs 'memory-service.out.log')),
  @('AppStderr', (Join-Path $logs 'memory-service.err.log')),
  @('AppRotateFiles', '1'),
  @('AppRotateOnline', '1'),
  @('AppRotateBytes', '10485760'),
  @('AppExit', 'Default', 'Restart'),
  @('AppRestartDelay', '5000'),
  @('AppPriority', 'HIGH_PRIORITY_CLASS')
)
foreach ($s in $settings) {
  $argv = @('set', $svc) + $s
  $code = Run $nssm $argv
  if ($code -ne 0) { Say ('WARN: nssm set ' + ($s -join ' ') + ' failed') }
}

$code = Run $nssm @('start', $svc)
Start-Sleep -Seconds 3
$null = Run 'sc.exe' @('query', $svc)
Say ('done; service logs: ' + (Join-Path $logs 'memory-service.out.log'))
exit 0
