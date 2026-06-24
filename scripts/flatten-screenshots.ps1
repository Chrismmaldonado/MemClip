# Re-saves store screenshots as 24-bit PNG (no alpha), which the Chrome Web
# Store requires. Source screenshots are fully opaque, so flattening onto a
# solid background is lossless in appearance.
Add-Type -AssemblyName System.Drawing

$files = @(
  'store-assets\01-history.png',
  'store-assets\02-detail.png',
  'store-assets\03-privacy.png'
)

foreach ($f in $files) {
  $path = (Resolve-Path $f).Path
  $img = [System.Drawing.Image]::FromFile($path)
  $bmp = New-Object System.Drawing.Bitmap $img.Width, $img.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Black)
  $g.DrawImageUnscaled($img, 0, 0)
  $g.Dispose()
  $img.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("flattened " + $f)
}
