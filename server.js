const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const { exec } = require('node:child_process');

const { change2faBatch, MAX_BATCH: MAX_2FA } = require('./lib/change2fa');
const { checkPlanBatch, MAX_BATCH: MAX_CHECK } = require('./lib/checkPlan');
const { getTokenBatch, MAX_BATCH: MAX_TOKEN } = require('./lib/getToken');
const { logoutAllBatch, MAX_BATCH: MAX_LOGOUT } = require('./lib/logoutAll');
const { logResult, listLogs, logPath, setDisableLogs } = require('./lib/logger');
const { BASE_DIR } = require('./lib/paths');
const updater = require('./lib/updater');

// Persisted config (proxy list, updateUrl, disableLogs, etc.) lives in one JSON file next to the app.
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(BASE_DIR, 'config.json');
async function readConfig() {
  try {
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    if (typeof cfg.disableLogs === 'boolean') {
      setDisableLogs(cfg.disableLogs);
    }
    return cfg;
  } catch {
    return { proxies: '', updateUrl: '', disableLogs: false };
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(BASE_DIR, 'public')));

function batchRoute(handler, action) {
  return async (req, res) => {
    const combos = req.body && req.body.combos;
    if (typeof combos !== 'string' || !combos.trim()) {
      res.status(400).json({ error: 'combos (string) is required' });
      return;
    }
    const proxies = req.body && typeof req.body.proxies === 'string' ? req.body.proxies : '';
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try {
      await handler(combos, async (result) => {
        await logResult(action, result);
        if (!res.destroyed) res.write(JSON.stringify(result) + '\n');
      }, proxies);
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') console.error(`[${action}] batch failed:`, error.message);
      if (!res.destroyed) res.write(JSON.stringify({ ok: false, error: 'Batch interrupted: ' + error.message }) + '\n');
    } finally {
      res.end();
    }
  };
}

app.post('/api/change-2fa', batchRoute(change2faBatch, 'change-2fa'));
app.post('/api/change-2fa-team', batchRoute(
  (combos, onResult, proxies) => change2faBatch(combos, onResult, proxies, { accountType: 'workspace' }),
  'change-2fa-team'
));
app.post('/api/check-plan', batchRoute(checkPlanBatch, 'check-plan'));
app.post('/api/check-plus', batchRoute(checkPlanBatch, 'check-plan')); // compatibility
app.post('/api/get-token', batchRoute(getTokenBatch, 'get-token'));
app.post('/api/logout-all', batchRoute(logoutAllBatch, 'logout-all'));

app.get('/api/logs', async (req, res) => {
  res.json(await listLogs());
});

app.get('/api/logs/:name', (req, res) => {
  const file = logPath(req.params.name);
  if (!file) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.download(file, req.params.name);
});

app.get('/api/config', async (req, res) => {
  res.json(await readConfig());
});

app.post('/api/config', async (req, res) => {
  const current = await readConfig();
  const proxies = req.body && typeof req.body.proxies === 'string' ? req.body.proxies : (current.proxies || '');
  const updateUrl = req.body && typeof req.body.updateUrl === 'string' ? req.body.updateUrl : (current.updateUrl || '');
  const disableLogs = req.body && typeof req.body.disableLogs === 'boolean' ? req.body.disableLogs : Boolean(current.disableLogs);
  setDisableLogs(disableLogs);
  await fs.writeFile(CONFIG_PATH, JSON.stringify({ proxies, updateUrl, disableLogs }, null, 2));
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, maxBatch: { twofa: MAX_2FA, check: MAX_CHECK, token: MAX_TOKEN, logout: MAX_LOGOUT } });
});

// Auto-update endpoints
app.get('/api/update/status', (req, res) => {
  res.json(updater.getStatus());
});

app.get('/api/update/check', async (req, res) => {
  try {
    const config = await readConfig();
    const manifestUrl = (req.query && req.query.url) || config.updateUrl || undefined;
    const status = await updater.checkUpdate({ manifestUrl });
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/update/download', async (req, res) => {
  try {
    updater.startDownload().catch((err) => {
      if (process.env.NODE_ENV !== 'production') console.error('[updater] download error:', err.message);
    });
    res.json({ ok: true, status: updater.getStatus() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/update/cancel', async (req, res) => {
  try {
    const status = await updater.cancelDownload();
    res.json({ ok: true, status });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/update/apply', async (req, res) => {
  try {
    const result = await updater.applyUpdate();
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 8099;
  const BIND_IP = process.env.BIND_IP || '0.0.0.0';
  app.listen(PORT, BIND_IP, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Evel GPT Service Lite listening on ${BIND_IP}:${PORT}  ->  ${url}`);

    // Check for auto-update ACK argument from updater helper
    const ackIdx = process.argv.indexOf('--portable-update-ack');
    if (ackIdx !== -1 && process.argv[ackIdx + 1]) {
      const ackPath = process.argv[ackIdx + 1];
      try {
        let appVer = '1.1.1';
        try { appVer = require('./package.json').version; } catch {}
        await fs.writeFile(ackPath, JSON.stringify({
          ok: true,
          version: appVer,
          pid: process.pid,
          time: new Date().toISOString()
        }), 'utf8');
        if (process.env.NODE_ENV !== 'production') console.log(`[updater] Health ACK verified: ${ackPath}`);
      } catch (ackErr) {
        if (process.env.NODE_ENV !== 'production') console.error('[updater] Failed to write ACK file:', ackErr.message);
      }
    }

    // Double-click .exe convenience: open the default browser. Dev runs (node) stay quiet.
    if (process.pkg && process.env.NO_OPEN_BROWSER !== '1') exec(`start "" "${url}"`);
  });
}

module.exports = { app, batchRoute };
