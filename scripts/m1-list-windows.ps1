Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WL2 {
  public delegate bool EWP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EWP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr h, out int p);
}
"@

[WL2]::EnumWindows({
  param($h, $l)
  if ([WL2]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WL2]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t.Length -gt 0) {
      $p = 0
      [WL2]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
      Write-Output "HWND=$([int64]$h) PID=$p Title=$t"
    }
  }
  return $true
}, [IntPtr]::Zero)
