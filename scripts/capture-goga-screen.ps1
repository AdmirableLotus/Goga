Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
public class GogaWinCap {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr h, out int p);
  public struct RECT { public int L,T,R,B; }
}
"@ -ReferencedAssemblies System.Drawing

$hwnd = [IntPtr]198440L

# Verify title
$sb = New-Object System.Text.StringBuilder 256
[GogaWinCap]::GetWindowText($hwnd, $sb, 256) | Out-Null
$title = $sb.ToString()
Write-Output "Title: $title"

$pid2 = 0
[GogaWinCap]::GetWindowThreadProcessId($hwnd, [ref]$pid2) | Out-Null
Write-Output "PID: $pid2"

# Restore if minimized
if ([GogaWinCap]::IsIconic($hwnd)) {
  [GogaWinCap]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  Start-Sleep -Milliseconds 800
}

# Bring to foreground and wait for full paint
[GogaWinCap]::BringWindowToTop($hwnd) | Out-Null
[GogaWinCap]::SetForegroundWindow($hwnd) | Out-Null
[GogaWinCap]::UpdateWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 1200   # allow Electron/Chromium to fully composite

# Get window rect on screen
$wr = New-Object GogaWinCap+RECT
[GogaWinCap]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
$cr = New-Object GogaWinCap+RECT
[GogaWinCap]::GetClientRect($hwnd, [ref]$cr) | Out-Null

$winW = $wr.R - $wr.L
$winH = $wr.B - $wr.T
Write-Output "WindowRect: $($wr.L),$($wr.T) -> $($wr.R),$($wr.B)  size=${winW}x${winH}"
Write-Output "ClientSize: $($cr.R)x$($cr.B)"

if ($winW -le 0 -or $winH -le 0) {
  Write-Output "ERROR: window rect is zero"
  exit 1
}

# CopyFromScreen — captures exactly the window's screen region
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($winW, $winH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(
  [System.Drawing.Point]::new($wr.L, $wr.T),
  [System.Drawing.Point]::Empty,
  [System.Drawing.Size]::new($winW, $winH)
)
$g.Dispose()

$outPath = Join-Path (Get-Location) "scripts\m1-goga-window.png"
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "Saved: $outPath"

# Quick brightness check — confirm not blank
$bmp2 = [System.Drawing.Image]::FromFile($outPath)
$bmp3 = New-Object System.Drawing.Bitmap $bmp2
$totalB = 0L
$samples = 0
for ($y = 0; $y -lt $bmp3.Height; $y += 10) {
  for ($x = 0; $x -lt $bmp3.Width; $x += 10) {
    $px = $bmp3.GetPixel($x, $y)
    $totalB += ($px.R + $px.G + $px.B)
    $samples++
  }
}
$avg = [math]::Round($totalB / $samples, 1)
Write-Output "Avg brightness: $avg  (0=black, 765=white)"

# Sample key regions
$cx = [int]($bmp3.Width / 2)
$topPx   = $bmp3.GetPixel(30, 25)
$midPx   = $bmp3.GetPixel($cx, [int]($bmp3.Height * 0.45))
$botPx   = $bmp3.GetPixel($cx, $bmp3.Height - 50)
Write-Output "Top-left (30,25): R=$($topPx.R) G=$($topPx.G) B=$($topPx.B)"
Write-Output "Center ($cx,$([int]($bmp3.Height*0.45))): R=$($midPx.R) G=$($midPx.G) B=$($midPx.B)"
Write-Output "Bottom ($cx,$($bmp3.Height-50)): R=$($botPx.R) G=$($botPx.G) B=$($botPx.B)"

$bmp3.Dispose(); $bmp2.Dispose()

if ($avg -lt 5) {
  Write-Output "RESULT: BLANK - window not visible on screen"
} else {
  Write-Output "RESULT: OK - image has content"
}
