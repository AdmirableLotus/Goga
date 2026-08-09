Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$pt = New-Object System.Drawing.Point(0, 0)
$g.CopyFromScreen($screen.Location, $pt, $screen.Size)
$g.Dispose()
$bmp.Save('C:\\Users\\redre\\OneDrive\\Desktop\\mom\\Goga\\scripts\\f02-screenshots\\ss10-desktop-10.png')
$bmp.Dispose()