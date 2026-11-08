# 卸载「听雪记忆服务」（需要管理员权限）。
$ErrorActionPreference = 'Continue'
$svc = 'tingxue-memory'
$nssm = 'D:\oransky\Desktop\oransky\dsh\dsh-tingxue\service\bin\nssm.exe'
& $nssm stop $svc
Start-Sleep -Milliseconds 500
& $nssm remove $svc confirm
& sc.exe query $svc
