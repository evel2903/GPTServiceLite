# Builds a fully portable Windows bundle: dist\gptservicelite\ with the Node app frozen to a
# single .exe (pkg) plus an embedded CPython + deps. Copy that folder to a blank machine and
# double-click the .exe -- no Node, no Python, no install required.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is ~100x faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root  = $PSScriptRoot
$pyver = '3.14.6'                                   # matches the tested interpreter; curl_cffi wheel is abi3 (3.10+)
$dist  = Join-Path $root 'dist\gptservicelite'
$embed = Join-Path $dist 'python'
$tmp   = Join-Path $env:TEMP 'gptsvc-build'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host '[1/5] npm install (fetch pkg)...'
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

Write-Host '[2/5] pkg -> dist\gptservicelite.exe ...'
npx pkg . --targets node18-win-x64 --output (Join-Path $root 'dist\gptservicelite.exe')
if ($LASTEXITCODE -ne 0) { throw 'pkg build failed' }

Write-Host '[3/5] assemble bundle folder...'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item (Join-Path $root 'dist\gptservicelite.exe') $dist
Copy-Item (Join-Path $root 'core')   $dist -Recurse
Copy-Item (Join-Path $root 'public') $dist -Recurse
Copy-Item (Join-Path $root 'README.md') $dist
Get-ChildItem $dist -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force
Get-ChildItem $dist -Recurse -Filter "*.log" | Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $dist 'logs')) { Remove-Item (Join-Path $dist 'logs') -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host "[4/5] embedded Python $pyver ..."
$zip = Join-Path $tmp "python-$pyver-embed.zip"
if (-not (Test-Path $zip)) {
  Invoke-WebRequest "https://www.python.org/ftp/python/$pyver/python-$pyver-embed-amd64.zip" -OutFile $zip
}
if (Test-Path $embed) { Remove-Item $embed -Recurse -Force }
Expand-Archive $zip -DestinationPath $embed -Force
# Embeddable Python controls sys.path entirely via this ._pth and, unlike a normal interpreter,
# does NOT auto-add the script's own directory. So re-enable site-packages (for pip/deps) AND add
# ..\core (sibling of python\) so core/*.py can import their siblings like login_service.
$pth = Get-ChildItem $embed -Filter 'python*._pth' | Select-Object -First 1
$zipline = (Get-Content $pth.FullName)[0]   # e.g. python314.zip
@($zipline, '.', '..\core', 'Lib\site-packages', '', 'import site') | Set-Content $pth.FullName -Encoding ascii

Write-Host '[5/5] pip install deps into embed...'
$pyexe  = Join-Path $embed 'python.exe'
$getpip = Join-Path $tmp 'get-pip.py'
if (-not (Test-Path $getpip)) { Invoke-WebRequest 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getpip }
& $pyexe $getpip --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw 'get-pip failed' }
& $pyexe -m pip install --no-warn-script-location -r (Join-Path $dist 'core\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

Write-Host ''
Write-Host "DONE -> $dist"
Write-Host 'Zip that folder and ship it. On the target: double-click gptservicelite.exe.'
