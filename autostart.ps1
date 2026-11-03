# 开机自启开关
#   powershell -ExecutionPolicy Bypass -File autostart.ps1          设置
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 -Remove  取消

param([switch]$Remove)

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'iPad Second Screen.lnk'
$target = Join-Path $PSScriptRoot 'start.bat'

if ($Remove) {
  if (Test-Path $lnk) {
    Remove-Item $lnk -Force
    Write-Host "已取消开机自启。" -ForegroundColor Green
  } else {
    Write-Host "本来就没有设置开机自启。" -ForegroundColor Yellow
  }
  exit 0
}

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $target
$sc.WorkingDirectory = $PSScriptRoot
$sc.WindowStyle = 7            # 最小化
$sc.Description = 'iPad 副屏串流服务'
$sc.Save()

Write-Host "已设置开机自启：" -ForegroundColor Green
Write-Host "  $lnk"
Write-Host "登录后会自动最小化启动，窗口在任务栏里。" -ForegroundColor Gray
