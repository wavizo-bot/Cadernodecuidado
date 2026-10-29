$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$res = Join-Path $PSScriptRoot '..\android\app\src\main\res'
$srcPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\icons\icon-512.png')).Path
$src = [System.Drawing.Image]::FromFile($srcPath)

function New-Png([int]$w, [int]$h, [string]$path, [bool]$circle) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'HighQuality'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::White)
  if ($circle) {
    $pathG = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pathG.AddEllipse(0, 0, $w, $h)
    $g.SetClip($pathG)
    $g.Clear([System.Drawing.Color]::White)
  }
  $g.DrawImage($src, 0, 0, $w, $h)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$sizes = @{ 'mdpi' = 48; 'hdpi' = 72; 'xhdpi' = 96; 'xxhdpi' = 144; 'xxxhdpi' = 192 }
foreach ($k in $sizes.Keys) {
  $dir = Join-Path $res "mipmap-$k"
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  New-Png $sizes[$k] $sizes[$k] (Join-Path $dir 'ic_launcher.png') $false
  New-Png $sizes[$k] $sizes[$k] (Join-Path $dir 'ic_launcher_round.png') $true
}

$fg = @{ 'mdpi' = 108; 'hdpi' = 162; 'xhdpi' = 216; 'xxhdpi' = 324; 'xxxhdpi' = 432 }
foreach ($k in $fg.Keys) {
  $dir = Join-Path $res "mipmap-$k"
  New-Png $fg[$k] $fg[$k] (Join-Path $dir 'ic_launcher_foreground.png') $false
}

function New-Splash([int]$w, [int]$h, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'HighQuality'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#F7F5EE'))
  $logo = [int]([Math]::Min($w, $h) * 0.34)
  $x = [int](($w - $logo) / 2)
  $y = [int](($h - $logo) / 2)
  $g.DrawImage($src, $x, $y, $logo, $logo)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$dims = @(
  @('drawable', 480, 320),
  @('drawable-land-mdpi', 480, 320),
  @('drawable-land-hdpi', 800, 480),
  @('drawable-land-xhdpi', 1280, 720),
  @('drawable-land-xxhdpi', 1600, 960),
  @('drawable-land-xxxhdpi', 1920, 1280),
  @('drawable-port-mdpi', 320, 480),
  @('drawable-port-hdpi', 480, 800),
  @('drawable-port-xhdpi', 720, 1280),
  @('drawable-port-xxhdpi', 960, 1600),
  @('drawable-port-xxxhdpi', 1280, 1920)
)
foreach ($d in $dims) {
  $dir = Join-Path $res $d[0]
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  New-Splash $d[1] $d[2] (Join-Path $dir 'splash.png')
}

$src.Dispose()
Write-Output 'icones e splash gerados'
