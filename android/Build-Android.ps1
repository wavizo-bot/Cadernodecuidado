# =============================================================================
# Caderno de Cuidado - build reproduzivel do Android (AAB + APK de teste)
# Uso:  .\Build-Android.ps1
#
# Antes de cada ENVIO a Play:
#   1. aumente android\version-code.txt (inteiro) e android\package.json (version)
#   2. rode este script; ele falha se o versionCode nao for maior que o AAB
#      ja existente em entregas\play (regra A3)
#
# O que ele faz, em ordem:
#   - confere JDK 21 e SDK Android
#   - copia google-client.json de C:\APPS\ID.OAuth (segredo nao versionado)
#   - npm run stage  (fonte web -> android\www, com android.css/bridge)
#   - npx cap sync android
#   - gradlew clean bundleRelease assembleRelease  (R8 ligado, A1/A2)
#   - node scripts\check-artifact.mjs  (assets == www, mapping, versao, UTF-8)
#   - move o pacote anterior para entregas\play\historico e copia o novo
#
# OBS: texto em ASCII de proposito. O PowerShell 5.1 le arquivo UTF-8 SEM BOM
# como ANSI e corromperia acentos; as mensagens ficam sem acento.
# =============================================================================
param(
    [switch]$SkipClean,
    [switch]$AllowSameVersion   # use so para rebuild local (nunca para subir)
)

# Stderr de comandos nativos (java/gradle) vira erro terminal com 'Stop' no
# PowerShell 5.1; cada comando nativo confere $LASTEXITCODE logo depois.
$ErrorActionPreference = 'Continue'

$androidDir = $PSScriptRoot
$projectDir = (Resolve-Path (Join-Path $androidDir '..')).Path
$gradleDir = Join-Path $androidDir 'android'
$playDir = Join-Path $projectDir 'entregas\play'
$histDir = Join-Path $playDir 'historico'

function Write-Step([string]$text) {
    Write-Host ""
    Write-Host "== $text ==" -ForegroundColor Cyan
}

# --------------------------------------------------------------- ambiente ---
Write-Step "Ambiente"

$javaHome = $env:JAVA_HOME
$javaOk = $false
if ($javaHome -and (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
    $ver = & (Join-Path $javaHome 'bin\java.exe') -version 2>&1 | Out-String
    if ($ver -match 'version "(1[7-9]|2[0-3])') { $javaOk = $true }
}
if (-not $javaOk) {
    $cand = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Java') -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($cand) {
        $env:JAVA_HOME = $cand.FullName
        $javaOk = $true
    }
}
if (-not $javaOk) {
    throw "JDK 17-23 nao encontrado. Gradle 8.13 nao roda em Java 25; instale o JDK 21 (Temurin) ou aponte JAVA_HOME."
}
Write-Host "JAVA_HOME = $env:JAVA_HOME"

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path (Join-Path $sdk 'platforms\android-36'))) {
    throw "Android SDK 36 nao encontrado em $sdk (instale platforms;android-36)."
}
$env:ANDROID_HOME = $sdk
Write-Host "ANDROID_HOME = $sdk"

if (-not (Test-Path (Join-Path $gradleDir 'keystore.properties'))) {
    throw "Assinatura ausente: android\android\keystore.properties + keystore\caderno-upload.keystore (nao versionados - regra 3.1)."
}

$clientDest = Join-Path $gradleDir 'app\src\main\assets\google-client.json'
if (-not (Test-Path $clientDest)) {
    $oauthDir = Join-Path (Split-Path $projectDir -Parent) 'ID.OAuth'
    $clientSrc = Join-Path $oauthDir 'client_secret_768118833529-eq07d7r7t7femhcliv6an01ia4ogldrk.apps.googleusercontent.com.json'
    if (-not (Test-Path $clientSrc)) {
        throw "google-client.json nao esta no projeto nem em $clientSrc. Copie o client Desktop do projeto Google 'cadernodecuidado'."
    }
    Copy-Item $clientSrc $clientDest -ErrorAction Stop
    Write-Host "google-client.json copiado para assets (conteudo nao exibido)."
}

$version = (Get-Content (Join-Path $androidDir 'package.json') -Raw | ConvertFrom-Json).version
$versionCode = (Get-Content (Join-Path $androidDir 'version-code.txt') -Raw).Trim()
if ($versionCode -notmatch '^\d+$') { throw "android\version-code.txt deve conter apenas o inteiro do versionCode." }
$capCfg = Get-Content (Join-Path $androidDir 'capacitor.config.json') -Raw | ConvertFrom-Json
$appId = $capCfg.appId
Write-Host "Versao: $version (versionCode $versionCode) - package $appId"

# -------------------------------------------------------- versao x anterior -
Write-Step "versionCode contra o AAB local anterior"
$previousAab = $null
if (Test-Path $playDir) {
    $previousAab = Get-ChildItem $playDir -Filter '*.aab' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
$bundletool = Join-Path $androidDir 'build\bundletool-all.jar'
if ($previousAab -and (Test-Path $bundletool)) {
    $manifest = & (Join-Path $env:JAVA_HOME 'bin\java.exe') -jar $bundletool dump manifest --bundle $previousAab.FullName 2>$null | Out-String
    $prevPkg = if ($manifest -match 'package="([^"]+)"') { $Matches[1] } else { "" }
    if ($prevPkg -and $prevPkg -ne $appId) {
        Write-Host "AAB anterior e de outro pacote ($prevPkg); versionCode reinicia neste pacote novo ($appId)."
    } elseif ($manifest -match 'android:versionCode="(\d+)"') {
        $prevCode = [int]$Matches[1]
        if ([int]$versionCode -le $prevCode) {
            if ($AllowSameVersion) {
                Write-Warning "versionCode $versionCode <= $prevCode (rebuild local permitido por -AllowSameVersion). So envie se este numero ainda NAO tiver sido usado no Play Console; se ja foi, aumente version-code.txt e package.json (regra A3)."
            } else {
                throw "versionCode $versionCode nao e maior que o AAB local anterior ($prevCode em $($previousAab.Name)). A Play rejeita a reutilizacao (regra A3)."
            }
        } else {
            Write-Host "OK: $versionCode > $prevCode (AAB local anterior em entregas\play)."
        }
    } else {
        Write-Warning "Nao consegui ler o versionCode de $($previousAab.Name); siga a regra A3 manualmente."
    }
} elseif ($previousAab) {
    Write-Warning "bundletool-all.jar ausente; comparacao de versionCode nao feita (regra A3 manual)."
} else {
    Write-Host "Nenhum AAB anterior em entregas\play (primeiro envio)."
}

# ------------------------------------------------------------------- build ---
Write-Step "Conteudo web (stage)"
Push-Location $androidDir
& npm.cmd run stage
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm run stage falhou" }

& npx.cmd cap sync android
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cap sync falhou" }
Pop-Location

Write-Step "Gradle (release com R8)"
Push-Location $gradleDir
$tasks = @('bundleRelease', 'assembleRelease')
if (-not $SkipClean) { $tasks = @('clean') + $tasks }
& .\gradlew.bat @tasks --no-daemon
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Gradle falhou" }
Pop-Location

$aab = Join-Path $gradleDir 'app\build\outputs\bundle\release\app-release.aab'
$apk = Join-Path $gradleDir 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $aab)) { throw "AAB nao gerado: $aab" }
if (-not (Test-Path $apk)) { throw "APK release nao gerado: $apk" }

# ------------------------------------------------------------- conferencia ---
Write-Step "Conferencia do artefato (A1/A2/A3/A5 + encoding)"
& node (Join-Path $androidDir 'scripts\check-artifact.mjs') $aab
if ($LASTEXITCODE -ne 0) { throw "Conferencia do AAB falhou; nada foi copiado para entregas." }

# --------------------------------------------------------------- entregas ---
Write-Step "Entregas"
New-Item -ItemType Directory -Force $playDir | Out-Null
New-Item -ItemType Directory -Force $histDir | Out-Null

$newAabName = "CadernoDeCuidado-v$version-vC$versionCode.aab"
$newApkName = "CadernoDeCuidado-v$version-vC$versionCode-sideload.apk"
$newAabHash = (Get-FileHash $aab -Algorithm SHA256).Hash.ToLower()
$existing = Join-Path $playDir $newAabName

if (Test-Path $existing) {
    $existingHash = (Get-FileHash $existing -Algorithm SHA256).Hash.ToLower()
    if ($existingHash -eq $newAabHash) {
        Write-Host "Pacote identico ja esta em entregas\play; nada a mover."
    } else {
        Move-Item $existing (Join-Path $histDir $newAabName) -Force -ErrorAction Stop
    }
}
# Pacotes de OUTRAS versoes vao para o historico.
Get-ChildItem $playDir -File | Where-Object {
    $_.Extension -in @('.aab', '.apk') -and $_.Name -notin @($newAabName, $newApkName)
} | ForEach-Object { Move-Item $_.FullName (Join-Path $histDir $_.Name) -Force -ErrorAction Stop }

Copy-Item $aab (Join-Path $playDir $newAabName) -Force -ErrorAction Stop
Copy-Item $apk (Join-Path $playDir $newApkName) -Force -ErrorAction Stop

$sums = @(
    ((Get-FileHash (Join-Path $playDir $newAabName) -Algorithm SHA256).Hash.ToLower() + " *" + $newAabName),
    ((Get-FileHash (Join-Path $playDir $newApkName) -Algorithm SHA256).Hash.ToLower() + " *" + $newApkName)
)
$sumsPath = Join-Path $playDir 'SHA256SUMS.txt'
[System.IO.File]::WriteAllLines($sumsPath, [string[]]$sums, [System.Text.Encoding]::ASCII)

Write-Host ""
Write-Host "PRONTO" -ForegroundColor Green
Write-Host "  AAB:  entregas\play\$newAabName"
Write-Host "  APK:  entregas\play\$newApkName  (sideload, mesma assinatura)"
Write-Host "  AAB:  $([math]::Round((Get-Item $aab).Length / 1MB, 2)) MB"
Write-Host ""
Write-Host "Proximo envio: suba o AAB no Play Console. Depois, aumente version-code.txt e package.json ANTES do build seguinte."
