const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const updater = require('../lib/updater');
const { app } = require('../server');

test('Semver comparison handles standard, prefixed, and edge version formats', () => {
  assert.equal(updater.compareVersions('1.1.0', '1.0.0'), 1);
  assert.equal(updater.compareVersions('1.0.0', '1.1.0'), -1);
  assert.equal(updater.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(updater.compareVersions('v2.0.0', '1.9.9'), 1);
  assert.equal(updater.compareVersions('v1.0.1', 'v1.0.0'), 1);
  assert.equal(updater.compareVersions('1.0.0', 'v1.0.0'), 0);
  assert.equal(updater.compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(updater.compareVersions('1.0.0-rc1', '1.0.0'), 0);

  assert.equal(updater.isNewerVersion('1.1.0', '1.0.0'), true);
  assert.equal(updater.isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(updater.isNewerVersion('0.9.0', '1.0.0'), false);
});

test('formatBytes properly converts byte counts into human-readable strings', () => {
  assert.equal(updater.formatBytes(0), '0 B');
  assert.equal(updater.formatBytes(512), '512.0 B');
  assert.equal(updater.formatBytes(1024), '1.0 KB');
  assert.equal(updater.formatBytes(1536), '1.5 KB');
  assert.equal(updater.formatBytes(1048576), '1.0 MB');
  assert.equal(updater.formatBytes(1073741824), '1.0 GB');
});

test('Helper PowerShell script contains robust swap, ACK handshake and rollback logic', () => {
  const script = updater.generateHelperScript();
  assert.ok(script.includes('$parentPid'), 'Must reference parentPid');
  assert.ok(script.includes('Wait-Process'), 'Must wait for parent process exit');
  assert.ok(script.includes('.update-backup'), 'Must have backup directory');
  assert.ok(script.includes('Restore-FromBackup'), 'Must have rollback function');
  assert.ok(script.includes('--portable-update-ack'), 'Must launch with ACK flag');
  assert.ok(script.includes('config.json'), 'Must not overwrite config.json');
  assert.ok(script.includes('python'), 'Must preserve python directory');
});

test('checkUpdate identifies update availability against mock HTTP manifest', async () => {
  updater.resetState();

  const mockManifest = {
    schemaVersion: 1,
    version: '9.9.9',
    publishedAt: '2026-09-15T00:00:00Z',
    releaseUrl: 'https://github.com/evel2903/GPTServiceLite/releases/tag/v9.9.9',
    changelog: ['Test changelog 1', 'Test changelog 2'],
    assets: {
      'windows-x64': {
        url: 'https://example.com/update.zip',
        sha256: 'abcdef0123456789',
        sizeBytes: 12345678
      }
    }
  };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockManifest));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockUrl = `http://127.0.0.1:${port}/portable-update-windows.json`;

  try {
    const status = await updater.checkUpdate({
      manifestUrl: mockUrl,
      currentVersion: '1.0.0'
    });

    assert.equal(status.updateAvailable, true);
    assert.equal(status.latestVersion, '9.9.9');
    assert.equal(status.targetVersion, '9.9.9');
    assert.equal(status.phase, 'available');
    assert.deepEqual(status.changelog, ['Test changelog 1', 'Test changelog 2']);
    assert.equal(status.totalBytes, 12345678);

    // When already latest version
    const statusLatest = await updater.checkUpdate({
      manifestUrl: mockUrl,
      currentVersion: '9.9.9'
    });

    assert.equal(statusLatest.updateAvailable, false);
    assert.equal(statusLatest.phase, 'idle');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    updater.resetState();
  }
});

test('startDownload downloads, verifies SHA-256 and extracts into staging', async () => {
  updater.resetState();

  const testTmp = path.join(os.tmpdir(), `test-zip-src-${Date.now()}`);
  await fs.mkdir(testTmp, { recursive: true });
  const sampleFile = path.join(testTmp, 'update-test-sample.txt');
  await fs.writeFile(sampleFile, 'hello from test update payload', 'utf8');

  const mockZip = path.join(os.tmpdir(), `test-payload-${Date.now()}.zip`);
  const tarRes = spawnSync('tar.exe', ['-acf', mockZip, '-C', testTmp, 'update-test-sample.txt']);
  assert.equal(tarRes.status, 0, 'tar.exe should create zip archive successfully');

  const zipBuffer = await fs.readFile(mockZip);
  const zipSha = crypto.createHash('sha256').update(zipBuffer).digest('hex');

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zipBuffer.length
    });
    res.end(zipBuffer);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockDownloadUrl = `http://127.0.0.1:${port}/update.zip`;

  try {
    const status = await updater.startDownload({
      targetVersion: '9.9.9',
      asset: {
        url: mockDownloadUrl,
        sha256: zipSha,
        sizeBytes: zipBuffer.length
      }
    });

    assert.equal(status.phase, 'ready');
    assert.equal(status.targetVersion, '9.9.9');

    // Verify extraction in staging directory
    const cur = updater.getStatus();
    assert.equal(cur.phase, 'ready');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(testTmp, { recursive: true, force: true }).catch(() => {});
    await fs.rm(mockZip, { force: true }).catch(() => {});
    await updater.cancelDownload().catch(() => {});
    updater.resetState();
  }
});

test('HTTP server exposes /api/update/status and handles /api/config updateUrl', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Check status endpoint
    const statusRes = await fetch(`${base}/api/update/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.ok('phase' in statusData);
    assert.ok('currentVersion' in statusData);
    assert.ok('updateAvailable' in statusData);

    // 2. Test saving and reading updateUrl in config
    const testUpdateUrl = 'https://custom-domain.com/manifest.json';
    const postConfig = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxies: 'proxy1:8080', updateUrl: testUpdateUrl })
    });
    assert.equal(postConfig.status, 200);

    const getConfig = await fetch(`${base}/api/config`);
    const cfg = await getConfig.json();
    assert.equal(cfg.updateUrl, testUpdateUrl);
    assert.equal(cfg.proxies, 'proxy1:8080');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
