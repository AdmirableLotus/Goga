Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
public class GogaCapture {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr h, out int p);
  public struct RECT { public int L,T,R,B; }

  public static string Capture(long hwndLong, string outPath) {
    IntPtr hwnd = new IntPtr(hwndLong);

    // Restore if minimized (SW_RESTORE = 9)
    if (IsIconic(hwnd)) {
      ShowWindow(hwnd, 9);
      System.Threading.Thread.Sleep(600);
    }
    // Bring to foreground
    SetForegroundWindow(hwnd);
    System.Threading.Thread.Sleep(800);

    // Get window rect
    RECT wr = new RECT();
    GetWindowRect(hwnd, out wr);
    int w = wr.R - wr.L;
    int h = wr.B - wr.T;

    // Get client rect for reporting
    RECT cr = new RECT();
    GetClientRect(hwnd, out cr);

    if (w <= 0 || h <= 0)
      return "ERROR: window rect is zero after restore w=" + w + " h=" + h;

    // Capture via PrintWindow with PW_RENDERFULLCONTENT=2 (works for Chromium/Electron)
    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(hwnd, hdc, 2);
      g.ReleaseHdc(hdc);
      if (!ok) {
        // Fallback: CopyFromScreen using window rect
        g.CopyFromScreen(new Point(wr.L, wr.T), Point.Empty, new Size(w, h));
      }
    }

    bmp.Save(outPath, ImageFormat.Png);
    bmp.Dispose();

    return "OK hwnd=" + hwndLong +
           " pid_check=see_caller" +
           " winRect=" + wr.L + "," + wr.T + "," + wr.R + "," + wr.B +
           " winSize=" + w + "x" + h +
           " clientSize=" + cr.R + "x" + cr.B;
  }
}
"@ -ReferencedAssemblies System.Drawing

# The exact Goga Electron HWND (not VS Code)
$gogaHwnd = 198440L

# Verify it is the right window
$sb = New-Object System.Text.StringBuilder 256
[GogaCapture]::GetWindowText([IntPtr]$gogaHwnd, $sb, 256) | Out-Null
$title = $sb.ToString()
Write-Output "Window title: $title"

$pid2 = 0
[GogaCapture]::GetWindowThreadProcessId([IntPtr]$gogaHwnd, [ref]$pid2) | Out-Null
Write-Output "Owner PID: $pid2"

$outPath = "scripts\m1-goga-window.png"
$result = [GogaCapture]::Capture($gogaHwnd, $outPath)
Write-Output $result
