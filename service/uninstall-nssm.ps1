# 卸载「听雪记忆服务」（需要管理员权限）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File service\uninstall-nssm.ps1
$ErrorActionPreference = 'Continue'
$svc = 'tingxue-memory'
# 不写死本机路径：nssm 随仓库提供，位置由本脚本所在目录推出。
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nssm = Join-Path $repo 'service\bin\nssm.exe'

if (-not (Test-Path $nssm)) {
  Write-Host "ERROR: 找不到 $nssm（本脚本应放在 <repo>\service\ 下）"
  exit 1
}

& $nssm stop $svc
Start-Sleep -Milliseconds 500
& $nssm remove $svc confirm
& sc.exe query $svc
