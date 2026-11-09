param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

Add-Type -AssemblyName System.Drawing

$buildDirectory = Join-Path $ProjectRoot "build"
$iconPath = Join-Path $buildDirectory "psmetac.ico"
$sidebarPath = Join-Path $buildDirectory "installerSidebar.bmp"
$headerPath = Join-Path $buildDirectory "installerHeader.bmp"

function New-RoundedPath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-InstallerBitmap([int]$width, [int]$height, [string]$outputPath, [bool]$compact) {
  $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  if ($compact) {
    $graphics.Clear([System.Drawing.Color]::FromArgb(245, 246, 247))
  } else {
    $graphics.Clear([System.Drawing.Color]::FromArgb(24, 27, 32))
  }

  $brandBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(100, 108, 223))
  $primaryBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(244, 246, 250))
  $secondaryBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(168, 174, 186))
  if ($compact) {
    $tilePath = New-RoundedPath 98 8 42 42 10
    $graphics.FillPath($brandBrush, $tilePath)
    $markFont = New-Object System.Drawing.Font("Segoe UI Semibold", 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawString("PS", $markFont, $primaryBrush, 108, 19)
    $tilePath.Dispose(); $markFont.Dispose()
  } else {
    $tilePath = New-RoundedPath 48 44 68 68 17
    $graphics.FillPath($brandBrush, $tilePath)
    $markFont = New-Object System.Drawing.Font("Segoe UI Semibold", 24, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawString("PS", $markFont, $primaryBrush, 65, 65)
    $nameFont = New-Object System.Drawing.Font("Segoe UI Semibold", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $tagFont = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $nameSize = $graphics.MeasureString("PSMetaC", $nameFont)
    $tagSize = $graphics.MeasureString("PSD / PSB", $tagFont)
    $graphics.DrawString("PSMetaC", $nameFont, $primaryBrush, (($width - $nameSize.Width) / 2), 132)
    $graphics.DrawString("PSD / PSB", $tagFont, $secondaryBrush, (($width - $tagSize.Width) / 2), 164)
    $graphics.FillRectangle($brandBrush, 52, 198, 60, 3)
    $tilePath.Dispose(); $markFont.Dispose(); $nameFont.Dispose(); $tagFont.Dispose()
  }

  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $brandBrush.Dispose(); $primaryBrush.Dispose(); $secondaryBrush.Dispose()
  $graphics.Dispose(); $bitmap.Dispose()
}

New-InstallerBitmap 164 314 $sidebarPath $false
New-InstallerBitmap 150 57 $headerPath $true

Write-Output "Generated installer assets: $sidebarPath, $headerPath"
