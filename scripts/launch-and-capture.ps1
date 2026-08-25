Set-Location "c:\Users\redre\OneDrive\Desktop\mom\Goga"

# Launch Goga
$electronExe = "c:\Users\redre\OneDrive\Desktop\mom\Goga\node_modules\electron\dist\electron.exe"
$proc = Start-Process -FilePath $electronExe -ArgumentList "." -PassThru -WindowStyle Normal -WorkingDirectory "c:\Users\redre\OneDrive\Desktop\mom\Goga"
Write-Output "Launched PID: $($proc.Id)"

# Wait up to 20s for the Goga window to appear
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WE2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr h);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public struct RECT { public int L,T,R,B; }
}
"@

$gogaHwnd = [IntPtr]::Zero
$gogaPid  = 0
$deadline = (Get-Date).AddSeconds(25)

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  $found = @()
  [WE2]::EnumWindows([WE2+EnumWindowsProc]{
    param($h,$l)
    if ([WE2]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 256
      [WE2]::GetWindowText($h,$sb,256) | Out-Null
      $t = $sb.ToString()
      # Match "Goga" but NOT VS Code
      if ($t -match 'Goga' -and $t -notmatch 'Visual Studio Code' -and $t -notmatch 'Code') {
        $p = 0; [WE2]::GetWindowThreadProcessId($h,[ref]$p) | Out-Null
        $r = New-Object WE2+RECT
        [WE2]::GetWindowRect($h,[ref]$r) | Out-Null
        # Must have a real positive rect (not minimized)
        if (($r.R - $r.L) -gt 100) {
          $script:found += [PSCustomObject]@{ hwnd=$h; pid=$p; title=$t; rect=$r }
        }
      }
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null

  if ($found.Count -eq 1) {
    $gogaHwnd = $found[0].hwnd
    $gogaPid  = $found[0].pid
    Write-Output "Found Goga window: HWND=$([long]$gogaHwnd) PID=$gogaPid"
    break
  } elseif ($found.Count -gt 1) {
    Write-Output "ERROR: multiple Goga windows found ($($found.Count)) - stopping"
    exit 1
  }
}

if ($gogaHwnd -eq [IntPtr]::Zero) {
  Write-Output "ERROR: Goga window not found within timeout"
  exit 1
}

# Bring to foreground and wait for full Chromium paint
[WE2]::BringWindowToTop($gogaHwnd) | Out-Null
[WE2]::SetForegroundWindow($gogaHwnd) | Out-Null
[WE2]::UpdateWindow($gogaHwnd) | Out-Null
Start-Sleep -Milliseconds 1500

# Get final window rect
$wr = New-Object WE2+RECT
[WE2]::GetWindowRect($gogaHwnd, [ref]$wr) | Out-Null
$cr = New-Object WE2+RECT
[WE2]::GetClientRect($gogaHwnd, [ref]$cr) | Out-Null
$winW = $wr.R - $wr.L
$winH = $wr.B - $wr.T
Write-Output "WindowRect: $($wr.L),$($wr.T) -> $($wr.R),$($wr.B)  size=${winW}x${winH}"
Write-Output "ClientSize: $($cr.R)x$($cr.B)"

# CopyFromScreen on exact window bounds
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($winW, $winH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(
  [System.Drawing.Point]::new($wr.L, $wr.T),
  [System.Drawing.Point]::Empty,
  [System.Drawing.Size]::new($winW, $winH)
)
$g.Dispose()

$outPath = "c:\Users\redre\OneDrive\Desktop\mom\Goga\scripts\m1-goga-window.png"
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "Saved: $outPath"

# Inspect brightness and key pixels
$bmp2 = [System.Drawing.Image]::FromFile($outPath)
$bmp3 = New-Object System.Drawing.Bitmap $bmp2
$totalB = 0L; $samples = 0
for ($y = 0; $y -lt $bmp3.Height; $y += 10) {
  for ($x = 0; $x -lt $bmp3.Width; $x += 10) {
    $px = $bmp3.GetPixel($x,$y)
    $totalB += ($px.R + $px.G + $px.B); $samples++
  }
}
$avg = [math]::Round($totalB / $samples, 1)
$cx = [int]($bmp3.Width/2)
$topPx = $bmp3.GetPixel(30, 20)
$midPx = $bmp3.GetPixel($cx, [int]($bmp3.Height*0.45))
$botPx = $bmp3.GetPixel($cx, $bmp3.Height - 50)
Write-Output "Avg brightness: $avg"
Write-Output "Top-left (30,20): R=$($topPx.R) G=$($topPx.G) B=$($topPx.B)"
Write-Output "Center ($cx,$([int]($bmp3.Height*0.45))): R=$($midPx.R) G=$($midPx.G) B=$($midPx.B)"
Write-Output "Bottom ($cx,$($bmp3.Height-50)): R=$($botPx.R) G=$($botPx.G) B=$($botPx.B)"
$bmp3.Dispose(); $bmp2.Dispose()

if ($avg -lt 5) {
  Write-Output "RESULT: BLANK"
} else {
  Write-Output "RESULT: OK"
}
