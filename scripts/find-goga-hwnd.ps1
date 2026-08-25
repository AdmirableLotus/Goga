Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public struct RECT { public int L,T,R,B; }
}
"@

$results = @()
[WinEnum]::EnumWindows([WinEnum+EnumWindowsProc]{
  param($h,$l)
  if ([WinEnum]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinEnum]::GetWindowText($h,$sb,256) | Out-Null
    $t = $sb.ToString()
    if ($t -match 'Goga' -or $t -match 'goga') {
      $p = 0; [WinEnum]::GetWindowThreadProcessId($h,[ref]$p) | Out-Null
      $r = New-Object WinEnum+RECT
      [WinEnum]::GetWindowRect($h,[ref]$r) | Out-Null
      $script:results += "HWND=$([long]$h) PID=$p TITLE=$t RECT=$($r.L),$($r.T),$($r.R),$($r.B)"
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null

foreach ($line in $results) { Write-Output $line }
if ($results.Count -eq 0) { Write-Output "NO_GOGA_WINDOW_FOUND" }
