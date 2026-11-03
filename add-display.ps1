# 添加一块 Parsec 虚拟显示器（需要管理员）
# 由 4-add-display.bat 自动提权后调用。

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "需要管理员权限。" -ForegroundColor Red
  exit 1
}

$exe = Join-Path $PSScriptRoot 'vendor\vdd\ParsecVDisplay.exe'
if (-not (Test-Path $exe)) {
  Write-Host "找不到 $exe" -ForegroundColor Red
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms

function Show-Screens($label) {
  Write-Host ""
  Write-Host $label -ForegroundColor Cyan
  $s = [System.Windows.Forms.Screen]::AllScreens
  foreach ($x in $s) {
    Write-Host ("  {0}  {1}  Primary={2}" -f $x.DeviceName, $x.Bounds, $x.Primary)
  }
  return $s.Count
}

$before = Show-Screens "添加前的显示器:"

Write-Host ""
Write-Host "以管理员权限运行 ParsecVDisplay -a ..." -ForegroundColor Yellow
$p = Start-Process -FilePath $exe -ArgumentList '-a' -PassThru -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5

$after = Show-Screens "添加后的显示器:"

if ($after -gt $before) {
  Write-Host ""
  Write-Host "成功：多出了一块虚拟显示器。" -ForegroundColor Green
  Write-Host "现在回到 Windows「设置 > 系统 > 显示」，把这块屏设为「扩展这些显示器」，"
  Write-Host "分辨率选 2048x1536（4:3，正好匹配 iPad）。"
} else {
  Write-Host ""
  Write-Host "命令行方式没能添加成功，需要手动操作：" -ForegroundColor Yellow
  Write-Host "  1. 我这就把图形界面的窗口打开"
  Write-Host "  2. 在窗口里点「Add display」/「+」添加一块虚拟屏"
  Write-Host "  3. 添加后再跑一次这个脚本确认"
  Start-Process -FilePath $exe
}

Write-Host ""
Write-Host "按任意键关闭。"
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
