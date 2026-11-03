# 一次性放行 Windows 防火墙（需要管理员权限）
# 右键 -> 以管理员身份运行 PowerShell，然后执行：
#   powershell -ExecutionPolicy Bypass -File "D:\AI\ipad-second-screen\allow-firewall.ps1"

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "需要管理员权限。请右键以管理员身份重新运行。" -ForegroundColor Red
  exit 1
}

$ports = @(8080, 8443)

foreach ($p in $ports) {
  foreach ($dir in @('Inbound')) {
    foreach ($proto in @('TCP')) {
      $name = "iPad Second Screen ($proto-$p)"
      Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
      New-NetFirewallRule -DisplayName $name `
        -Direction $dir -Action Allow -Protocol $proto `
        -LocalPort $p -Profile Private, Domain `
        -Description "Allow the iPad second-screen streaming server" | Out-Null
      Write-Host "已放行 $proto/$p ($dir)" -ForegroundColor Green
    }
  }
}

Write-Host ""
Write-Host "完成。当前规则：" -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "iPad Second Screen*" |
  Select-Object DisplayName, Enabled, Direction, Action, Profile |
  Format-Table -AutoSize
