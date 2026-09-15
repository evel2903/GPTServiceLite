const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { BASE_DIR } = require('./paths');

let pkgVersion = '1.0.0';
try {
  pkgVersion = require('../package.json').version || '1.0.0';
} catch {}

const DEFAULT_MANIFEST_URL = 'https://github.com/evel2903/GPTServiceLite/releases/latest/download/portable-update-windows.json';
const FALLBACK_MANIFEST_URL = 'https://raw.githubusercontent.com/evel2903/GPTServiceLite/main/portable-update-windows.json';

// Semver comparison: returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
function compareVersions(v1, v2) {
  if (!v1 && !v2) return 0;
  if (!v1) return -1;
  if (!v2) return 1;

  const clean = (v) => String(v).trim().replace(/^v/i, '');
  const parts1 = clean(v1).split(/[-+]/)[0].split('.').map(Number);
  const parts2 = clean(v2).split(/[-+]/)[0].split('.').map(Number);
  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

function isNewerVersion(remote, local) {
  return compareVersions(remote, local) > 0;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

let updateTask = {
  phase: 'idle',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  currentVersion: pkgVersion,
  latestVersion: null,
  targetVersion: null,
  releaseUrl: null,
  publishedAt: null,
  changelog: [],
  asset: null,
  message: null,
  error: null,
  cancellable: false,
  workDir: null,
  stagingDir: null,
  zipPath: null
};

let activeAbortController = null;

function getStatus() {
  return {
    phase: updateTask.phase,
    percent: updateTask.percent,
    downloadedBytes: updateTask.downloadedBytes,
    totalBytes: updateTask.totalBytes,
    downloadedFormatted: formatBytes(updateTask.downloadedBytes),
    totalFormatted: formatBytes(updateTask.totalBytes),
    currentVersion: updateTask.currentVersion,
    latestVersion: updateTask.latestVersion,
    targetVersion: updateTask.targetVersion,
    releaseUrl: updateTask.releaseUrl,
    publishedAt: updateTask.publishedAt,
    changelog: updateTask.changelog,
    updateAvailable: Boolean(updateTask.latestVersion && isNewerVersion(updateTask.latestVersion, updateTask.currentVersion)),
    message: updateTask.message,
    error: updateTask.error,
    cancellable: updateTask.cancellable
  };
}

function resetState() {
  if (activeAbortController) {
    try { activeAbortController.abort(); } catch {}
    activeAbortController = null;
  }
  updateTask = {
    phase: 'idle',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    currentVersion: pkgVersion,
    latestVersion: null,
    targetVersion: null,
    releaseUrl: null,
    publishedAt: null,
    changelog: [],
    asset: null,
    message: null,
    error: null,
    cancellable: false,
    workDir: null,
    stagingDir: null,
    zipPath: null
  };
}

async function fetchManifestWithFallback(url) {
  const tryUrls = [url];
  if (url === DEFAULT_MANIFEST_URL) {
    tryUrls.push(FALLBACK_MANIFEST_URL);
  }

  let lastError = null;
  for (const targetUrl of tryUrls) {
    try {
      const res = await fetch(targetUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': `GPTServiceLite-Updater/${pkgVersion}`
        },
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      if (!data || typeof data !== 'object' || !data.version) {
        throw new Error('Manifest JSON không hợp lệ hoặc thiếu version');
      }
      return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Không thể kết nối đến máy chủ cập nhật');
}

async function checkUpdate(options = {}) {
  const manifestUrl = options.manifestUrl || DEFAULT_MANIFEST_URL;
  const curVer = options.currentVersion || pkgVersion;

  if (['downloading', 'verifying', 'staging', 'applying'].includes(updateTask.phase)) {
    return getStatus();
  }

  updateTask.phase = 'checking';
  updateTask.message = 'Đang kiểm tra phiên bản mới...';
  updateTask.error = null;

  try {
    const manifest = await fetchManifestWithFallback(manifestUrl);
    const latestVersion = manifest.version;
    const isNewer = isNewerVersion(latestVersion, curVer);

    const asset = (manifest.assets && (manifest.assets['windows-x64'] || manifest.assets['windows-amd64'])) || null;
    const fullAsset = (manifest.fullAssets && (manifest.fullAssets['windows-x64'] || manifest.fullAssets['windows-amd64'])) || null;

    updateTask.currentVersion = curVer;
    updateTask.latestVersion = latestVersion;
    updateTask.targetVersion = isNewer ? latestVersion : null;
    updateTask.releaseUrl = manifest.releaseUrl || `https://github.com/evel2903/GPTServiceLite/releases/tag/v${latestVersion}`;
    updateTask.publishedAt = manifest.publishedAt || null;
    updateTask.changelog = Array.isArray(manifest.changelog) ? manifest.changelog : [];
    updateTask.asset = asset || fullAsset;
    updateTask.phase = isNewer ? 'available' : 'idle';
    updateTask.message = isNewer ? `Tìm thấy phiên bản mới v${latestVersion}!` : 'Bạn đang sử dụng phiên bản mới nhất.';
    updateTask.percent = 0;
    updateTask.downloadedBytes = 0;
    updateTask.totalBytes = asset?.sizeBytes || 0;

    return getStatus();
  } catch (err) {
    updateTask.phase = 'failed';
    updateTask.error = err.message;
    updateTask.message = `Lỗi kiểm tra cập nhật: ${err.message}`;
    return getStatus();
  }
}

async function extractZip(zipPath, stagingDir) {
  try {
    await new Promise((resolve, reject) => {
      const p = spawn('tar.exe', ['-xf', zipPath, '-C', stagingDir]);
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += d.toString(); });
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      p.on('error', reject);
    });
    return;
  } catch {}

  await new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('" + zipPath + "', '" + stagingDir + "')"
    ]);
    let stderr = '';
    ps.stderr.on('data', (d) => { stderr += d.toString(); });
    ps.on('close', (code) => code === 0 ? resolve() : reject(new Error('Giải nén thất bại: ' + stderr)));
    ps.on('error', reject);
  });
}

async function startDownload(options = {}) {
  if (['downloading', 'verifying', 'staging', 'applying'].includes(updateTask.phase)) {
    return getStatus();
  }

  const asset = options.asset || updateTask.asset;
  const targetVersion = options.targetVersion || updateTask.latestVersion;

  if (!asset || !asset.url) {
    throw new Error('Không tìm thấy link tải bản cập nhật');
  }

  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;

  updateTask.phase = 'downloading';
  updateTask.targetVersion = targetVersion;
  updateTask.percent = 0;
  updateTask.downloadedBytes = 0;
  updateTask.totalBytes = asset.sizeBytes || 0;
  updateTask.cancellable = true;
  updateTask.message = 'Đang tải bản cập nhật...';
  updateTask.error = null;

  const workDir = path.join(os.tmpdir(), `gptservicelite-update-v${targetVersion}-${process.pid}-${Date.now()}`);
  const zipPath = path.join(workDir, 'update.zip');
  const stagingDir = path.join(workDir, 'staging');

  updateTask.workDir = workDir;
  updateTask.zipPath = zipPath;
  updateTask.stagingDir = stagingDir;

  try {
    await fs.mkdir(workDir, { recursive: true });

    const downloadUrls = [asset.url, ...(asset.fallbackUrls || [])];
    let response = null;
    let fetchError = null;

    for (const url of downloadUrls) {
      try {
        response = await fetch(url, {
          headers: { 'User-Agent': `GPTServiceLite-Updater/${pkgVersion}` },
          signal
        });
        if (response.ok) break;
        throw new Error(`HTTP ${response.status}`);
      } catch (e) {
        if (signal.aborted) throw e;
        fetchError = e;
      }
    }

    if (!response || !response.ok) {
      throw fetchError || new Error('Không thể tải gói cập nhật từ các nguồn');
    }

    const contentLength = Number(response.headers.get('content-length')) || asset.sizeBytes || 0;
    if (contentLength > 0) {
      updateTask.totalBytes = contentLength;
    }

    const sha256Hash = crypto.createHash('sha256');
    const fileStream = fsSync.createWriteStream(zipPath);

    const reader = response.body.getReader();
    let receivedBytes = 0;

    await new Promise(async (resolve, reject) => {
      fileStream.on('error', reject);

      try {
        while (true) {
          if (signal.aborted) {
            fileStream.close();
            return reject(new Error('Tải bản cập nhật đã bị hủy'));
          }

          const { done, value } = await reader.read();
          if (done) {
            fileStream.end();
            break;
          }

          receivedBytes += value.length;
          sha256Hash.update(value);
          fileStream.write(value);

          updateTask.downloadedBytes = receivedBytes;
          if (updateTask.totalBytes > 0) {
            updateTask.percent = Math.min(100, Math.round((receivedBytes / updateTask.totalBytes) * 100));
          }
        }
        fileStream.on('finish', resolve);
      } catch (streamErr) {
        fileStream.close();
        reject(streamErr);
      }
    });

    if (signal.aborted) {
      throw new Error('Tải bản cập nhật đã bị hủy');
    }

    updateTask.cancellable = false;
    updateTask.phase = 'verifying';
    updateTask.message = 'Đang kiểm tra tính toàn vẹn gói cập nhật (SHA-256)...';

    const actualSha = sha256Hash.digest('hex').toLowerCase();
    if (asset.sha256 && actualSha !== asset.sha256.trim().toLowerCase()) {
      throw new Error(`Xác thực mã băm SHA-256 thất bại! Kỳ vọng: ${asset.sha256}, Thực tế: ${actualSha}`);
    }

    updateTask.phase = 'staging';
    updateTask.message = 'Đang giải nén và chuẩn bị file cập nhật...';
    await fs.mkdir(stagingDir, { recursive: true });

    await extractZip(zipPath, stagingDir);

    const extractedEntries = await fs.readdir(stagingDir);
    if (extractedEntries.length === 1) {
      const nestedPath = path.join(stagingDir, extractedEntries[0]);
      const stat = await fs.stat(nestedPath);
      if (stat.isDirectory()) {
        const nestedItems = await fs.readdir(nestedPath);
        for (const item of nestedItems) {
          await fs.rename(path.join(nestedPath, item), path.join(stagingDir, item));
        }
        await fs.rmdir(nestedPath);
      }
    }

    const testFile = path.join(BASE_DIR, `.update-test-${Date.now()}`);
    try {
      await fs.writeFile(testFile, 'ok');
      await fs.unlink(testFile);
    } catch (permErr) {
      throw new Error(`Thư mục ứng dụng không có quyền ghi: ${permErr.message}`);
    }

    updateTask.phase = 'ready';
    updateTask.message = 'Bản cập nhật đã sẵn sàng cài đặt!';
    return getStatus();

  } catch (err) {
    if (updateTask.phase !== 'cancelled') {
      updateTask.phase = 'failed';
      updateTask.error = err.message;
      updateTask.message = `Lỗi cập nhật: ${err.message}`;
    }
    if (workDir) {
      try { await fs.rm(workDir, { recursive: true, force: true }); } catch {}
    }
    throw err;
  } finally {
    activeAbortController = null;
  }
}

async function cancelDownload() {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  updateTask.phase = 'cancelled';
  updateTask.message = 'Đã hủy tải bản cập nhật.';
  updateTask.cancellable = false;
  if (updateTask.workDir) {
    try { await fs.rm(updateTask.workDir, { recursive: true, force: true }); } catch {}
  }
  return getStatus();
}

function generateHelperScript() {
  return `# GPTServiceLite Auto-Update Helper Script
param(
    [string]$DescriptorPath = "",
    [string]$LiteralPath = ""
)

$ErrorActionPreference = 'Stop'

if (-not $DescriptorPath -and $LiteralPath) {
    $DescriptorPath = $LiteralPath
}
if (-not $DescriptorPath -and $args.Count -gt 0) {
    $DescriptorPath = $args[0]
}

if (-not (Test-Path -LiteralPath $DescriptorPath)) {
    Write-Error "Descriptor file not found: $DescriptorPath"
    exit 1
}

$desc = Get-Content -LiteralPath $DescriptorPath -Raw | ConvertFrom-Json
$parentPid      = [int]$desc.parent_pid
$appDir         = [string]$desc.app_dir
$currentExe     = [string]$desc.current_exe
$isPackaged     = [bool]$desc.is_packaged
$stagingDir     = [string]$desc.staging_dir
$workDir        = [string]$desc.work_dir
$ackFile        = [string]$desc.ack_file
$targetVersion  = [string]$desc.target_version
$logFile        = Join-Path $workDir "updater.log"

function Write-Log($msg) {
    $time = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -LiteralPath $logFile -Value "[$time] $msg" -ErrorAction SilentlyContinue
}

Write-Log "Updater helper started for v$targetVersion. Parent PID: $parentPid"

# 1. Wait for parent process to exit completely (up to 60s)
Write-Log "Waiting for parent process $parentPid to exit..."
try { Wait-Process -Id $parentPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    $proc = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
    if (-not $proc) {
        break
    }
    Start-Sleep -Milliseconds 300
}

# Stop any lingering process running from the target exe
if ($isPackaged) {
    $allGpt = Get-Process -Name "gptservicelite" -ErrorAction SilentlyContinue
    foreach ($p in $allGpt) {
        try {
            if ($p.Id -eq $parentPid -or $p.Path -eq $currentExe) {
                Write-Log "Stopping lingering process $($p.Id)..."
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
                Wait-Process -Id $p.Id -Timeout 10 -ErrorAction SilentlyContinue
            }
        } catch {}
    }
}
Start-Sleep -Milliseconds 600

# 2. Backup files that will be replaced
$backupDir = Join-Path $appDir ".update-backup"
if (Test-Path -LiteralPath $backupDir) {
    Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

$itemsToBackup = @("gptservicelite.exe", "server.js", "core", "public", "lib", "package.json")
foreach ($item in $itemsToBackup) {
    $src = Join-Path $appDir $item
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $backupDir $item) -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Write-Log "Backup created at $backupDir"

function Restore-FromBackup {
    Write-Log "Rolling back from backup..."
    foreach ($item in $itemsToBackup) {
        $bpath = Join-Path $backupDir $item
        $target = Join-Path $appDir $item
        if (Test-Path -LiteralPath $bpath) {
            try {
                if (Test-Path -LiteralPath $target) {
                    $oldTmp = "$target.rollback-$((Get-Date).Ticks)"
                    Move-Item -LiteralPath $target -Destination $oldTmp -Force -ErrorAction SilentlyContinue
                    Remove-Item -LiteralPath $oldTmp -Recurse -Force -ErrorAction SilentlyContinue
                }
                Copy-Item -LiteralPath $bpath -Destination $target -Recurse -Force -ErrorAction SilentlyContinue
            } catch {}
        }
    }
}

# 3. Swap files from staging into appDir
try {
    Write-Log "Applying new files from staging to appDir..."
    $stagedItems = Get-ChildItem -LiteralPath $stagingDir
    foreach ($item in $stagedItems) {
        if ($item.Name -in @("config.json", "logs", "python")) {
            continue
        }
        $dest = Join-Path $appDir $item.Name
        if (Test-Path -LiteralPath $dest) {
            $retries = 10
            $moved = $false
            while ($retries -gt 0 -and (-not $moved)) {
                try {
                    $tempOld = "$dest.old-$((Get-Date).Ticks)"
                    Move-Item -LiteralPath $dest -Destination $tempOld -Force -ErrorAction Stop
                    $moved = $true
                    Remove-Item -LiteralPath $tempOld -Recurse -Force -ErrorAction SilentlyContinue
                } catch {
                    $retries--
                    Start-Sleep -Milliseconds 400
                }
            }
        }
        Copy-Item -LiteralPath $item.FullName -Destination $dest -Recurse -Force
    }
    Write-Log "Files swapped successfully."
} catch {
    Write-Log "Error during file swap: $_. Rolling back..."
    Restore-FromBackup
    if ($isPackaged) {
        Start-Process -FilePath $currentExe -WorkingDirectory $appDir -WindowStyle Hidden
    }
    exit 1
}

# 4. Start new version with ACK flag
Write-Log "Starting new version with ACK flag..."
if (Test-Path -LiteralPath $ackFile) {
    Remove-Item -LiteralPath $ackFile -Force -ErrorAction SilentlyContinue
}

$newProc = $null
try {
    if ($isPackaged) {
        $newProc = Start-Process -FilePath $currentExe -WorkingDirectory $appDir -ArgumentList @("--portable-update-ack", $ackFile) -PassThru
    } else {
        $serverJs = Join-Path $appDir "server.js"
        $newProc = Start-Process -FilePath "node" -WorkingDirectory $appDir -ArgumentList @($serverJs, "--portable-update-ack", $ackFile) -PassThru
    }
} catch {
    Write-Log "Failed to launch new version: $_. Rolling back..."
    Restore-FromBackup
    if ($isPackaged) {
        Start-Process -FilePath $currentExe -WorkingDirectory $appDir -WindowStyle Hidden
    }
    exit 1
}

# 5. Handshake ACK verification (up to 45s)
Write-Log "Waiting for health ACK file: $ackFile..."
$ackDeadline = (Get-Date).AddSeconds(45)
$confirmed = $false

while ((Get-Date) -lt $ackDeadline) {
    if (Test-Path -LiteralPath $ackFile) {
        $confirmed = $true
        break
    }
    if ($newProc -and $newProc.HasExited) {
        Write-Log "New process terminated prematurely with exit code $($newProc.ExitCode)!"
        break
    }
    Start-Sleep -Milliseconds 500
}

if ($confirmed) {
    Write-Log "Update successfully confirmed by application ACK! Cleaning up backup..."
    Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Log "Update finished."
    exit 0
} else {
    Write-Log "Update ACK verification failed or timed out. Rolling back!"
    if ($newProc -and (-not $newProc.HasExited)) {
        Stop-Process -Id $newProc.Id -Force -ErrorAction SilentlyContinue
    }
    Restore-FromBackup
    Write-Log "Relaunching previous working version..."
    if ($isPackaged) {
        Start-Process -FilePath $currentExe -WorkingDirectory $appDir -WindowStyle Hidden
    } else {
        $serverJs = Join-Path $appDir "server.js"
        Start-Process -FilePath "node" -WorkingDirectory $appDir -ArgumentList @($serverJs)
    }
    exit 1
}
`;
}

async function applyUpdate() {
  if (updateTask.phase !== 'ready' || !updateTask.workDir || !updateTask.stagingDir) {
    throw new Error('Chưa có bản cập nhật nào sẵn sàng để áp dụng');
  }

  updateTask.phase = 'applying';
  updateTask.message = 'Đang áp dụng cập nhật và khởi động lại...';

  const descriptorPath = path.join(updateTask.workDir, 'update-descriptor.json');
  const helperScriptPath = path.join(updateTask.workDir, 'apply-update.ps1');
  const ackFile = path.join(updateTask.workDir, 'update-started.ack');

  const descriptor = {
    parent_pid: process.pid,
    app_dir: BASE_DIR,
    current_exe: process.execPath,
    is_packaged: Boolean(process.pkg),
    staging_dir: updateTask.stagingDir,
    work_dir: updateTask.workDir,
    ack_file: ackFile,
    target_version: updateTask.targetVersion || 'unknown'
  };

  await fs.writeFile(descriptorPath, JSON.stringify(descriptor, null, 2), 'utf8');
  await fs.writeFile(helperScriptPath, generateHelperScript(), 'utf8');

  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', helperScriptPath,
    '-DescriptorPath', descriptorPath
  ], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  setTimeout(() => {
    process.exit(0);
  }, 600);

  return { ok: true, message: 'Đang áp dụng cập nhật và khởi động lại...' };
}

module.exports = {
  DEFAULT_MANIFEST_URL,
  compareVersions,
  isNewerVersion,
  formatBytes,
  getStatus,
  resetState,
  checkUpdate,
  startDownload,
  cancelDownload,
  generateHelperScript,
  extractZip,
  applyUpdate
};
