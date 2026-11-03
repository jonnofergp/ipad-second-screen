# 确保副屏使用 4:3 的 1600x1200
# 重启后 Parsec 虚拟屏常常回落成 1280x720，画面会变糊且比例不对。
# 由 start.bat 自动调用，也可以单独运行。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$TargetW = 1600
$TargetH = 1200

$code = @"
using System;
using System.Runtime.InteropServices;
public class DispMode {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
        public int dmFields; public int dmPositionX; public int dmPositionY;
        public int dmDisplayOrientation; public int dmDisplayFixedOutput;
        public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
        public int dmDisplayFlags; public int dmDisplayFrequency;
        public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
        public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplaySettings(string d, int n, ref DEVMODE m);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int ChangeDisplaySettingsEx(string d, ref DEVMODE m, IntPtr h, uint f, IntPtr l);

    public static string Set(string dev, int w, int h) {
        DEVMODE m = new DEVMODE();
        m.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        if (!EnumDisplaySettings(dev, -1, ref m)) return "读取当前模式失败";
        if (m.dmPelsWidth == w && m.dmPelsHeight == h) return "已经是 " + w + "x" + h;
        DEVMODE probe = new DEVMODE();
        probe.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        bool found = false;
        for (int i = 0; EnumDisplaySettings(dev, i, ref probe); i++) {
            if (probe.dmPelsWidth == w && probe.dmPelsHeight == h) { found = true; break; }
            if (i > 400) break;
        }
        if (!found) return "不支持 " + w + "x" + h;
        m.dmPelsWidth = w; m.dmPelsHeight = h;
        m.dmFields = 0x80000 | 0x100000;
        int rc = ChangeDisplaySettingsEx(dev, ref m, IntPtr.Zero, 0x01, IntPtr.Zero);
        return rc == 0 ? ("已设为 " + w + "x" + h) : ("失败 rc=" + rc);
    }
}
"@
Add-Type -TypeDefinition $code -ErrorAction Stop

$screens = [System.Windows.Forms.Screen]::AllScreens
if ($screens.Count -lt 2) {
  Write-Host "只检测到 1 块屏，虚拟屏可能没创建（运行 4-add-display.bat）。" -ForegroundColor Yellow
  exit 1
}

$second = $screens | Where-Object { -not $_.Primary } | Select-Object -First 1
if (-not $second) {
  Write-Host "没找到非主屏。" -ForegroundColor Yellow
  exit 1
}

$result = [DispMode]::Set($second.DeviceName, $TargetW, $TargetH)
Write-Host ("{0}: {1}" -f $second.DeviceName, $result) -ForegroundColor Green
exit 0
