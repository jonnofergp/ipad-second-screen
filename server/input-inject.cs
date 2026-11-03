// input-inject — turns simple stdin commands into real Windows mouse input.
//
//   input-inject.exe <displayX> <displayY> <displayW> <displayH>
//
// Commands (one per line, space separated):
//   M <nx> <ny>   move to a normalised position inside the target display (0..1)
//   D / U         left button down / up
//   C             click
//   S <notches>   vertical scroll, positive = down
//   X             exit
//
// Coordinates are mapped across the whole virtual desktop, so a display that is
// not at the origin (e.g. the secondary monitor at x=1920) works correctly.
using System;
using System.Globalization;
using System.Runtime.InteropServices;

internal static class InputInject
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public MOUSEINPUT mi;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    private const uint INPUT_MOUSE = 0;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    private static int _dx, _dy, _dw, _dh;
    private static int _vx, _vy, _vw, _vh;

    private static void Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        if (args.Length < 4)
        {
            Console.Error.WriteLine("usage: input-inject <x> <y> <w> <h>");
            Environment.Exit(2);
        }
        _dx = int.Parse(args[0], CultureInfo.InvariantCulture);
        _dy = int.Parse(args[1], CultureInfo.InvariantCulture);
        _dw = int.Parse(args[2], CultureInfo.InvariantCulture);
        _dh = int.Parse(args[3], CultureInfo.InvariantCulture);

        _vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        _vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        _vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        _vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        Console.WriteLine("ready");
        Console.Out.Flush();

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            string[] p = line.Split(' ');
            try
            {
                switch (p[0])
                {
                    case "M":
                        Move(double.Parse(p[1], CultureInfo.InvariantCulture),
                             double.Parse(p[2], CultureInfo.InvariantCulture));
                        break;
                    case "D": Button(MOUSEEVENTF_LEFTDOWN); break;
                    case "U": Button(MOUSEEVENTF_LEFTUP); break;
                    case "C":
                        Button(MOUSEEVENTF_LEFTDOWN);
                        Button(MOUSEEVENTF_LEFTUP);
                        break;
                    case "S": Scroll(int.Parse(p[1], CultureInfo.InvariantCulture)); break;
                    case "X": return;
                }
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("bad command '" + line + "': " + e.Message);
            }
        }
    }

    private static void Move(double nx, double ny)
    {
        if (nx < 0) nx = 0; if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; if (ny > 1) ny = 1;

        int px = _dx + (int)Math.Round(nx * (_dw - 1));
        int py = _dy + (int)Math.Round(ny * (_dh - 1));

        // SendInput expects 0..65535 across the virtual desktop.
        int ax = (_vw > 1) ? (int)Math.Round((px - _vx) * 65535.0 / (_vw - 1)) : 0;
        int ay = (_vh > 1) ? (int)Math.Round((py - _vy) * 65535.0 / (_vh - 1)) : 0;

        INPUT inp = new INPUT();
        inp.type = INPUT_MOUSE;
        inp.mi.dx = ax;
        inp.mi.dy = ay;
        inp.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void Button(uint flag)
    {
        INPUT inp = new INPUT();
        inp.type = INPUT_MOUSE;
        inp.mi.dwFlags = flag;
        SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void Scroll(int notches)
    {
        INPUT inp = new INPUT();
        inp.type = INPUT_MOUSE;
        inp.mi.dwFlags = MOUSEEVENTF_WHEEL;
        inp.mi.mouseData = (uint)(-notches * 120);
        SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
    }
}
