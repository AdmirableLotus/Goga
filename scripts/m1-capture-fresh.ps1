Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
public class M1Cap {
  public delegate bool EnumWinProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWinProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public struct RECT { public int L,T,R,B; }

  public static List<long[]> FindGoga() {
    var results = new List<long[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string title = sb.ToString();
      if (title == "Goga" || title == "Goga " || (title.StartsWith("Goga") && title.Length < 10)) {
        int pid = 0;
        GetWindowThreadProcessId(h, out pid);
        results.Add(new long[]{ h.ToInt64(), pid });
      }
      return true;
    }, IntPtr.Zero);
    return results;
  }

  public static string GetTitle(long hwndLong) {
    var sb = new StringBuilder(512);
    GetWindowText(new IntPtr(hwndLong), sb, 512);
    return sb.ToString();
  }

  public static string Capture(long hwndLong, string outPath) {
    IntPtr hwnd = new IntPtr(hwndLong);
    if (IsIconic(hwnd)) { ShowWindow(hwnd, 9); System.Threading.Thread.Sleep(600); }
    SetForegroundWindow(hwnd);
    System.Threading.Thread.Sleep(800);
    RECT wr = new RECT();
    GetWindowRect(hwnd, out wr);
    int w = wr.R - wr.L;
    int h = wr.B - wr.T;
    RECT cr = new RECT();
    GetClientRect(hwnd, out cr);
    if (w <= 0 || h <= 0) return "ERROR: zero rect w=" + w + " h=" + h;
    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(hwnd, hdc, 2);
      g.ReleaseHdc(hdc);
      if (!ok) g.CopyFromScreen(new Point(wr.L, wr.T), Point.Empty, new Size(w, h));
    }
    bmp.Save(outPath, ImageFormat.Png);
    bmp.Dispose();
    return "OK hwnd=" + hwndLong + " winSize=" + w + "x" + h + " clientSize=" + cr.R + "x" + cr.B + " winRect=" + wr.L + "," + wr.T + "," + wr.R + "," + wr.B;
  }
}
"@ -ReferencedAssemblies System.Drawing

$windows = [M1Cap]::FindGoga()
Write-Output "Goga windows found: $($windows.Count)"

foreach ($w in $windows) {
  $hwnd = $w[0]
  $wpid = $w[1]
  $title = [M1Cap]::GetTitle($hwnd)
  Write-Output "  HWND=$hwnd  PID=$wpid  Title='$title'"
}

if ($windows.Count -ne 1) {
  Write-Output "ABORT: expected exactly 1 Goga HWND, found $($windows.Count)"
  exit 1
}

$gogaHwnd = $windows[0][0]
$gogaPid  = $windows[0][1]

$outPath  = "$PSScriptRoot\m1-goga-window.png"

Write-Output "Capturing HWND=$gogaHwnd PID=$gogaPid to $outPath"
$result = [M1Cap]::Capture($gogaHwnd, $outPath)
Write-Output $result
