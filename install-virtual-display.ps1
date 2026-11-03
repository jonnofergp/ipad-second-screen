# 安装虚拟显示器（把「镜像」变成真正的「扩展屏」）
# 需要管理员权限。
#
#   powershell -ExecutionPolicy Bypass -File "D:\AI\ipad-second-screen\install-virtual-display.ps1"
#
# 安装的是 Parsec 官方虚拟显示器驱动（Parsec Cloud, Inc. / DigiCert 签名，已校验）。

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "需要管理员权限。请右键「以管理员身份运行」PowerShell 后再执行。" -ForegroundColor Red
  exit 1
}

$exe = Join-Path $PSScriptRoot 'vendor\drivers\parsec-vdd-0.45.0.0.exe'
if (-not (Test-Path $exe)) {
  Write-Host "找不到安装包: $exe" -ForegroundColor Red
  exit 1
}

$sig = Get-AuthenticodeSignature $exe
Write-Host "签名状态: $($sig.Status)" -ForegroundColor $(if ($sig.Status -eq 'Valid') { 'Green' } else { 'Red' })
Write-Host "签署者  : $($sig.SignerCertificate.Subject)"
if ($sig.Status -ne 'Valid') {
  Write-Host "签名无效，已中止。" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "安装前显示器数量:" -ForegroundColor Cyan
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens |
  Select-Object DeviceName, Primary, @{n='Bounds';e={$_.Bounds.ToString()}} | Format-Table -AutoSize

Write-Host "正在静默安装虚拟显示器驱动（可能需要十几秒）..." -ForegroundColor Yellow
$p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
Write-Host "安装器退出码: $($p.ExitCode)"

Start-Sleep -Seconds 3

Write-Host ""
Write-Host "安装后显示器数量:" -ForegroundColor Cyan
$screens = [System.Windows.Forms.Screen]::AllScreens
$screens | Select-Object DeviceName, Primary, @{n='Bounds';e={$_.Bounds.ToString()}} | Format-Table -AutoSize

if ($screens.Count -le 1) {
  Write-Host ""
  Write-Host "没有检测到新显示器。请手动双击运行安装器完成安装：" -ForegroundColor Yellow
  Write-Host "  $exe"
  Write-Host "装完后再回来看一次显示器列表。"
} else {
  Write-Host ""
  Write-Host "成功。现在用 OUTPUT 环境变量把第二块屏推给 iPad：" -ForegroundColor Green
  Write-Host '  $env:OUTPUT=1' -ForegroundColor Gray
  Write-Host '  cd D:\AI\ipad-second-screen\server; node server.js' -ForegroundColor Gray
  Write-Host ""
  Write-Host "提示：如果画面分辨率不对，用 Windows 显示设置把这块虚拟屏调成 1920x1080。" -ForegroundColor Gray
}

Write-Host ""
Write-Host "卸载方法：  $exe  然后选择卸载；或从「设备管理器 > 显示适配器」移除。" -ForegroundColor DarkGray
