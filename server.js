const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const { exec } = require('node:child_process');

const { change2faBatch, MAX_BATCH: MAX_2FA } = require('./lib/change2fa');
const { checkPlanBatch, MAX_BATCH: MAX_CHECK } = require('./lib/checkPlan');
const { logResult, listLogs, logPath } = require('./lib/logger');
const { BASE_DIR } = require('./lib/paths');

// Persisted config (proxy list, etc.) lives in one JSON file next to the app -- survives browser
// clears, editable by hand. Under a packaged .exe this resolves next to the exe, not the snapshot.
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(BASE_DIR, 'config.json');
async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return { proxies: '' }; // missing/corrupt -> empty defaults
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(BASE_DIR, 'public')));

// Streams one JSON result per line (NDJSON) as each combo finishes, instead of buffering the
// whole batch -- a 50-combo run is sequential logins, could take minutes, and the old
// wait-for-everything response left the UI with no sign of progress.
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
        await logResult(action, result); // persist before displaying a changed secret
        if (!res.destroyed) res.write(JSON.stringify(result) + '\n');
      }, proxies);
    } catch (error) {
      console.error(`[${action}] batch failed:`, error.message);
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

app.get('/api/logs', async (req, res) => {
  res.json(await listLogs());
});

app.get('/api/logs/:name', (req, res) => {
  const file = logPath(req.params.name);
  if (!file) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.download(file, req.params.name); // sets Content-Disposition: attachment
});

app.get('/api/config', async (req, res) => {
  res.json(await readConfig());
});

app.post('/api/config', async (req, res) => {
  const proxies = req.body && typeof req.body.proxies === 'string' ? req.body.proxies : '';
  await fs.writeFile(CONFIG_PATH, JSON.stringify({ proxies }, null, 2));
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, maxBatch: { twofa: MAX_2FA, check: MAX_CHECK } });
});

if (require.main === module) {
  const PORT = process.env.PORT || 8099;
  const BIND_IP = process.env.BIND_IP || '0.0.0.0';
  app.listen(PORT, BIND_IP, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`GPTServiceLite listening on ${BIND_IP}:${PORT}  ->  ${url}`);
    // Double-click .exe convenience: open the default browser. Dev runs (node) stay quiet.
    if (process.pkg && process.env.NO_OPEN_BROWSER !== '1') exec(`start "" "${url}"`);
  });
}

module.exports = { app, batchRoute };
