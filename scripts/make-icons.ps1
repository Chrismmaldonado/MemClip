# Crops the generated neon-green art to a centered square and writes the four
# extension icon sizes (16/32/48/128) into icons/.
Add-Type -AssemblyName System.Drawing

$srcPath = $args[0]
if (-not $srcPath) { throw "Usage: make-icons.ps1 <source-png>" }

$src = [System.Drawing.Image]::FromFile((Resolve-Path $srcPath).Path)

# Centered square crop.
$side = [Math]::Min($src.Width, $src.Height)
$x = [int](($src.Width - $side) / 2)
$y = [int](($src.Height - $side) / 2)
$square = New-Object System.Drawing.Bitmap $side, $side
$g = [System.Drawing.Graphics]::FromImage($square)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $side, $side), (New-Object System.Drawing.Rectangle $x, $y, $side, $side), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$src.Dispose()

$sizes = 16, 32, 48, 128
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $gg = [System.Drawing.Graphics]::FromImage($bmp)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gg.DrawImage($square, (New-Object System.Drawing.Rectangle 0, 0, $s, $s))
  $gg.Dispose()
  $out = Join-Path (Resolve-Path 'icons').Path ("icon" + $s + ".png")
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("wrote icons/icon" + $s + ".png")
}
$square.Dispose()
