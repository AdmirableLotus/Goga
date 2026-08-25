Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile((Resolve-Path "scripts\m1-goga-window.png").Path)
$bmp = New-Object System.Drawing.Bitmap $img
$w = $bmp.Width
$h = $bmp.Height
Write-Output "Dimensions: ${w}x${h}"

# Sample background color at center — should be near-black (#06050e)
$cx = [int]($w / 2)
$cy = [int]($h / 2)
$centerPx = $bmp.GetPixel($cx, $cy)
Write-Output "Center pixel ($cx,$cy): R=$($centerPx.R) G=$($centerPx.G) B=$($centerPx.B)"

# Sample top-left area (GOGA identity region) — row ~20, col ~20
$topPx = $bmp.GetPixel(20, 20)
Write-Output "Top-left pixel (20,20): R=$($topPx.R) G=$($topPx.G) B=$($topPx.B)"

# Sample bottom strip (composer area) — bottom 80px
$botY = $h - 40
$botPx = $bmp.GetPixel($cx, $botY)
Write-Output "Bottom-center pixel ($cx,$botY): R=$($botPx.R) G=$($botPx.G) B=$($botPx.B)"

# Check for cyan/purple pixels (triangle colors) in the middle vertical band
# Scan a vertical strip through center for non-black pixels
$trianglePixels = 0
$cyanPixels = 0
$purplePixels = 0
for ($y = [int]($h*0.15); $y -lt [int]($h*0.75); $y += 4) {
  for ($x = [int]($w*0.25); $x -lt [int]($w*0.75); $x += 4) {
    $px = $bmp.GetPixel($x, $y)
    $brightness = ($px.R + $px.G + $px.B)
    if ($brightness -gt 60) { $trianglePixels++ }
    # Cyan: high B+G, low R
    if ($px.B -gt 100 -and $px.G -gt 80 -and $px.R -lt 80) { $cyanPixels++ }
    # Purple/violet: high R+B, lower G
    if ($px.R -gt 60 -and $px.B -gt 80 -and $px.G -lt 60) { $purplePixels++ }
  }
}
Write-Output "Non-black pixels in center band: $trianglePixels"
Write-Output "Cyan-ish pixels (triangle): $cyanPixels"
Write-Output "Purple-ish pixels (triangle): $purplePixels"

# Check top-right corner for icon buttons (💬 ⚙)
$trPx = $bmp.GetPixel($w - 60, 20)
Write-Output "Top-right area ($($w-60),20): R=$($trPx.R) G=$($trPx.G) B=$($trPx.B)"

# Check if image is NOT all-black (Chromium blank capture)
$totalBrightness = 0L
for ($y = 0; $y -lt $h; $y += 8) {
  for ($x = 0; $x -lt $w; $x += 8) {
    $px = $bmp.GetPixel($x, $y)
    $totalBrightness += ($px.R + $px.G + $px.B)
  }
}
$avgBrightness = $totalBrightness / (($h/8) * ($w/8))
Write-Output "Average brightness (0=black, 765=white): $([math]::Round($avgBrightness,1))"

$bmp.Dispose()
$img.Dispose()

if ($avgBrightness -lt 5) {
  Write-Output "RESULT: BLANK_IMAGE — Chromium did not render into PrintWindow"
} elseif ($trianglePixels -gt 50 -and ($cyanPixels -gt 5 -or $purplePixels -gt 5)) {
  Write-Output "RESULT: CONTAINS_TRIANGLE_COLORS — image appears to show Goga UI"
} else {
  Write-Output 'RESULT: UNCERTAIN - low triangle pixel count, manual inspection needed'
}
