# scripts/make-release.ps1
# Packages GPTServiceLite for release: builds executable, generates update zip, full zip,
# calculates SHA-256 hashes, and outputs portable-update-windows.json.
param(
    [string]$Version,
    [string]$Changelog = "Cập nhật tối ưu hóa hệ thống và sửa lỗi",
    [string]$Repository = "evel2903/GPTServiceLite"
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

# Read version from package.json if not provided
$pkg = Get-Content -Path (Join-Path $root "package.json") -Raw | ConvertFrom-Json
if (-not $Version) {
    $Version = $pkg.version
} else {
    $pkg.version = $Version
    [System.IO.File]::WriteAllText((Join-Path $root "package.json"), ($pkg | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
}

Write-Host "=== Building Release v$Version for $Repository ===" -ForegroundColor Cyan

$releaseDir = Join-Path $root "dist\release-v$Version"
if (Test-Path $releaseDir) {
    Remove-Item $releaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

# 1. Build portable exe via pkg
Write-Host "[1/4] Building gptservicelite.exe via pkg..." -ForegroundColor Yellow
$builtExe = Join-Path $root "dist\gptservicelite.exe"
npx pkg . --targets node18-win-x64 --output $builtExe
if ($LASTEXITCODE -ne 0) { throw "pkg build failed" }

# 2. Package compact update archive (for existing users)
Write-Host "[2/4] Packaging compact update archive..." -ForegroundColor Yellow
$updateStaging = Join-Path $releaseDir "update-staging"
New-Item -ItemType Directory -Path $updateStaging -Force | Out-Null

Copy-Item $builtExe $updateStaging
Copy-Item (Join-Path $root "core") $updateStaging -Recurse
Copy-Item (Join-Path $root "public") $updateStaging -Recurse
Copy-Item (Join-Path $root "README.md") $updateStaging
Copy-Item (Join-Path $root "package.json") $updateStaging
Get-ChildItem $updateStaging -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

$updateZip = Join-Path $releaseDir "gptservicelite-update-v$Version-windows-x64.zip"
Compress-Archive -Path "$updateStaging\*" -DestinationPath $updateZip -Force
Remove-Item $updateStaging -Recurse -Force

# 3. Package full bundle (with embedded Python if available)
Write-Host "[3/4] Packaging full installation bundle..." -ForegroundColor Yellow
$fullZip = Join-Path $releaseDir "gptservicelite-v$Version-windows-x64.zip"
$fullDist = Join-Path $root "dist\gptservicelite"
if (Test-Path (Join-Path $fullDist "python")) {
    Copy-Item $builtExe $fullDist -Force
    Copy-Item (Join-Path $root "core") $fullDist -Recurse -Force
    Copy-Item (Join-Path $root "public") $fullDist -Recurse -Force
    Get-ChildItem $fullDist -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path "$fullDist\*" -DestinationPath $fullZip -Force
} else {
    Write-Host "Notice: dist\gptservicelite\python not found. Using compact bundle as full asset." -ForegroundColor DarkYellow
    Copy-Item $updateZip $fullZip -Force
}

# 4. Generate portable-update-windows.json
Write-Host "[4/4] Generating portable-update-windows.json..." -ForegroundColor Yellow

function Get-Sha256Hex($filePath) {
    return (Get-FileHash -Path $filePath -Algorithm SHA256).Hash.ToLower()
}

$updateSize = (Get-Item $updateZip).Length
$updateSha  = Get-Sha256Hex $updateZip
$fullSize   = (Get-Item $fullZip).Length
$fullSha    = Get-Sha256Hex $fullZip

$manifest = @{
    schemaVersion = 1
    version = $Version
    publishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    releaseUrl = "https://github.com/$Repository/releases/tag/v$Version"
    changelog = @($Changelog)
    assets = @{
        "windows-x64" = @{
            url = "https://github.com/$Repository/releases/download/v$Version/gptservicelite-update-v$Version-windows-x64.zip"
            sha256 = $updateSha
            sizeBytes = $updateSize
        }
    }
    fullAssets = @{
        "windows-x64" = @{
            url = "https://github.com/$Repository/releases/download/v$Version/gptservicelite-v$Version-windows-x64.zip"
            sha256 = $fullSha
            sizeBytes = $fullSize
        }
    }
}

$manifestPath = Join-Path $releaseDir "portable-update-windows.json"
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

Write-Host "`n=== Release generated in $releaseDir ===" -ForegroundColor Green
Write-Host "1. Update package: $updateZip ($([math]::Round($updateSize / 1MB, 2)) MB)"
Write-Host "   SHA256: $updateSha"
Write-Host "2. Full package:   $fullZip ($([math]::Round($fullSize / 1MB, 2)) MB)"
Write-Host "   SHA256: $fullSha"
Write-Host "3. Manifest:       $manifestPath"
Write-Host "`nUpload these 3 files to GitHub Releases v$Version!" -ForegroundColor Cyan
