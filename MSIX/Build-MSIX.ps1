# Rebuild do pacote MSIX — Caderno de Cuidado (v1.25+ com Sync Google Drive)
# Uso: powershell -ExecutionPolicy Bypass -File Build-MSIX.ps1
$ErrorActionPreference = 'Stop'
$root    = 'C:\APPS\Caderno de Cuidado'
$msix    = Join-Path $root 'MSIX'
$staging = Join-Path $msix 'staging'
$sdkBin  = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64'
$version = '1.25.15.0'
$appVersion = '1.25.15'
$out = Join-Path $msix "wavizo.Cadernodecuidado_${version}_x64.msix"
$utf8 = New-Object System.Text.UTF8Encoding($false)

Copy-Item "$root\index.html" "$staging\www\index.html" -Force
Copy-Item "$root\sync-ui.js" "$staging\www\sync-ui.js" -Force
Copy-Item "$root\sync-ui.css" "$staging\www\sync-ui.css" -Force
Copy-Item "$root\terms-modal.js" "$staging\www\terms-modal.js" -Force
Copy-Item "$root\terms-modal.css" "$staging\www\terms-modal.css" -Force
Copy-Item "$root\sw.js" "$staging\www\sw.js" -Force
Copy-Item "$root\manifest.webmanifest" "$staging\www\manifest.webmanifest" -Force
Copy-Item "$root\politica-de-privacidade.html" "$staging\www\politica-de-privacidade.html" -Force
Copy-Item "$root\termos-de-servico.html" "$staging\www\termos-de-servico.html" -Force
Copy-Item "$root\aviso-legal.html" "$staging\www\aviso-legal.html" -Force
# Carimba a versao do rodape no pacote (o bundle traz texto estatico).
# UTF-8 sem BOM: Set-Content do PowerShell 5.1 gravaria em ANSI e corromperia acentos.
$html = [System.IO.File]::ReadAllText("$staging\www\index.html", $utf8)
$html = $html -replace 'zg="[0-9.]+"', "zg=`"$appVersion`""
[System.IO.File]::WriteAllText("$staging\www\index.html", $html, $utf8)
# O manifesto e a fonte da versao instalada; nunca deixar divergir do build.
$manifestPath = Join-Path $staging 'AppxManifest.xml'
$manifest = [System.IO.File]::ReadAllText($manifestPath, $utf8)
$manifest = [regex]::Replace($manifest, '(?m)^(\s*Version=")[0-9.]+(")',
    { param($m) $m.Groups[1].Value + $version + $m.Groups[2].Value })
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8)
# Client OAuth Desktop do projeto "Caderno de cuidado" (projeto proprio)
Copy-Item "C:\APPS\ID.OAuth\client_secret_768118833529-eq07d7r7t7femhcliv6an01ia4ogldrk.apps.googleusercontent.com.json" "$staging\google-client.json" -Force

# Nunca empacotar dados de execucao do WebView2 (cache, cookies, sessoes)
$wvData = Join-Path $staging 'CadernoDeCuidado.exe.WebView2'
if (Test-Path $wvData) { Remove-Item $wvData -Recurse -Force }

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /target:winexe /platform:x64 `
  /out:"$staging\CadernoDeCuidado.exe" `
  /reference:"$staging\Microsoft.Web.WebView2.WinForms.dll" `
  /reference:"$staging\Microsoft.Web.WebView2.Core.dll" `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.dll `
  /reference:System.Net.Http.dll /reference:System.Security.dll /reference:System.Web.Extensions.dll `
  "$msix\src\Launcher.cs"

& "$sdkBin\makeappx.exe" pack /d $staging /p $out /nv /o
& "$sdkBin\signtool.exe" sign /fd SHA256 /f "$msix\devcert.pfx" /p 'Caderno123!' $out
Write-Host "OK: $out" -ForegroundColor Green
