# Build Cutline Studio Windows Installer (.exe) via Tauri v2 + PyInstaller Sidecar
# Run on Windows 10/11 (PowerShell) with Node.js 20+, Python 3.11+, and Rust (cargo) installed.

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Set-Location $RootDir

Write-Host "==> 1. Preparing Python virtual environment..."
if (-not (Test-Path ".venv-win")) {
    python -m venv .venv-win
}
& .\.venv-win\Scripts\python.exe -m pip install --upgrade pip
& .\.venv-win\Scripts\pip.exe install `
    "pydantic>=2.7.0" `
    "httpx>=0.27.0" `
    "faster-whisper>=1.0.3" `
    "yt-dlp>=2024.10.0" `
    "fastapi>=0.115.0" `
    "uvicorn>=0.30.0" `
    "python-multipart>=0.0.9" `
    "pyinstaller>=6.10.0"

Write-Host "==> 2. Compiling cutline-sidecar-x86_64-pc-windows-msvc.exe..."
New-Item -ItemType Directory -Force -Path "src-tauri\binaries" | Out-Null
New-Item -ItemType Directory -Force -Path "src-tauri\resources\bin" | Out-Null

& .\.venv-win\Scripts\pyinstaller.exe `
    --noconfirm `
    --distpath "src-tauri\binaries" `
    --workpath "build\pyinstaller-sidecar" `
    clippah_core\packaging\tauri_windows\sidecar.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

Write-Host "==> 2b. Smoke-testing compiled sidecar on 127.0.0.1:43111..."
$SidecarExe = "src-tauri\binaries\cutline-sidecar-x86_64-pc-windows-msvc.exe"
$SidecarProc = Start-Process -FilePath $SidecarExe -PassThru
$SidecarHealthy = $false
try {
    for ($i = 0; $i -lt 40; $i++) {
        if ($SidecarProc.HasExited) {
            throw "Sidecar exited prematurely with code $($SidecarProc.ExitCode)"
        }
        try {
            $Health = Invoke-RestMethod -Uri "http://127.0.0.1:43111/api/health" -TimeoutSec 2
            if ($Health.status -eq "ok") {
                $SidecarHealthy = $true
                Write-Host "Sidecar smoke test passed: $($Health | ConvertTo-Json -Compress)"
                break
            }
        } catch {
            Start-Sleep -Milliseconds 750
        }
    }
    if (-not $SidecarHealthy) {
        throw "Sidecar did not respond on 127.0.0.1:43111/api/health within 30s"
    }
} catch {
    $LogFile = Join-Path $env:USERPROFILE ".cutline_studio\sidecar.log"
    if (Test-Path $LogFile) {
        Write-Host "--- sidecar.log ---"
        Get-Content $LogFile -Tail 50
    }
    throw
} finally {
    if ($SidecarProc -and -not $SidecarProc.HasExited) {
        Stop-Process -Id $SidecarProc.Id -Force -ErrorAction SilentlyContinue
    }
    taskkill /F /IM cutline-sidecar-x86_64-pc-windows-msvc.exe /T 2>$null | Out-Null
}

Write-Host "==> 3. Fetching static Windows ffmpeg.exe, ffprobe.exe, and yt-dlp.exe if missing..."
$BinDir = "src-tauri\resources\bin"
if (-not (Test-Path "$BinDir\yt-dlp.exe")) {
    Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile "$BinDir\yt-dlp.exe"
}
if (-not (Test-Path "$BinDir\ffmpeg.exe") -or -not (Test-Path "$BinDir\ffprobe.exe")) {
    $FfmpegZip = "$env:TEMP\ffmpeg-release-essentials.zip"
    $FfmpegExtract = "$env:TEMP\ffmpeg-extract"
    Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $FfmpegZip
    Expand-Archive -Path $FfmpegZip -DestinationPath $FfmpegExtract -Force
    $FoundBin = Get-ChildItem -Path $FfmpegExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    Copy-Item $FoundBin.FullName "$BinDir\ffmpeg.exe" -Force
    Copy-Item (Join-Path $FoundBin.DirectoryName "ffprobe.exe") "$BinDir\ffprobe.exe" -Force
}

Write-Host "==> 4. Installing frontend deps & building Tauri v2 NSIS installer (.exe)..."
if (Test-Path "package-lock.json") {
    npm ci --legacy-peer-deps
} else {
    npm install --legacy-peer-deps
}
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

npx --yes @tauri-apps/cli@2 build --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }

Write-Host "==> Done! Installer created under src-tauri\target\release\bundle\nsis\"
