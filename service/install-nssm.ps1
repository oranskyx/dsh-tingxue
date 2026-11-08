# 安装/重装「听雪记忆服务」为 Windows 服务（nssm）。
# 需要管理员权限运行（UAC）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File service\install-nssm.ps1
$ErrorActionPreference = 'Continue'

$repo = 'D:\oransky\Desktop\oransky\dsh\dsh-tingxue'
$svc = 'tingxue-memory'
$nssm = Join-Path $repo 'service\bin\nssm.exe'
$node = 'D:\Program Files\nodejs\node.exe'
$logs = Join-Path $repo 'logs'
$log = Join-Path $logs 'install-nssm.log'

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

if (-not (Test-Path $nssm)) { Say 'ERROR: nssm.exe missing'; exit 1 }
if (-not (Test-Path $node)) { Say 'ERROR: node.exe missing'; exit 1 }

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
  @('Description', 'Tingxue independent memory service: LanceDB single writer + graph UI on 127.0.0.1:8766/8765.'),
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
