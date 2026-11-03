$ip = (Get-NetIPAddress -AddressFamily IPv4).Where({ $_.IPAddress -like '192.168.*' })
if ($ip -and $ip.Count -gt 0) {
  $ip[0].IPAddress
} else {
  (Get-NetIPAddress -AddressFamily IPv4).Where({ -not $_.IPAddress.StartsWith('169.254.') -and $_.IPAddress -ne '127.0.0.1' })[0].IPAddress
}
