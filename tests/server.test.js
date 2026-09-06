const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('HTTP routes stream workspace/plan results, save recovery logs and report batch exceptions', async t => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gptsvc-route-test-'));
  process.env.LOG_DIR = logDir;
  const calls = [];
  const worker = require('../lib/runPython');
  worker.runPython = async (script, args) => {
    calls.push({ script, args });
    if (script === 'change_2fa.py') return { ok: true, totp_secret: 'NEW-FAKE-SECRET' };
    return { ok: true, plan: 'free', plans: ['free', 'team', 'k12'], plans_complete: true, workspaces: [{ id: 'school', plan: 'k12' }] };
  };
  const { app, batchRoute } = require('../server');
  app.post('/test/batch-error', batchRoute(async () => { throw new Error('fake failure'); }, 'test'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const name of await fs.readdir(logDir)) await fs.unlink(path.join(logDir, name));
    await fs.rmdir(logDir);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, combos = 'test@example.test|fake-password|OLD') {
    return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ combos }) });
  }
  const teamResponse = await post('/api/change-2fa-team');
  assert.match(teamResponse.headers.get('content-type'), /application\/x-ndjson/);
  const team = JSON.parse((await teamResponse.text()).trim());
  assert.equal(team.newTotp, 'NEW-FAKE-SECRET');
  assert.deepEqual(calls[0].args, ['test@example.test|fake-password|OLD', '--workspace']);
  const names = await fs.readdir(logDir);
  const log = await fs.readFile(path.join(logDir, names[0]), 'utf8');
  assert.match(log, /\[change-2fa-team\]\tOK/);
  assert.match(log, /combo_moi: test@example.test\|fake-password\|NEW-FAKE-SECRET/);
  for (const route of ['/api/check-plan', '/api/check-plus']) {
    const result = JSON.parse((await (await post(route)).text()).trim());
    assert.deepEqual(result.plans, ['free', 'team', 'k12']);
    assert.equal(result.plan, 'free');
  }
  assert.equal((await post('/api/check-plan', '')).status, 400);
  const interrupted = JSON.parse((await (await post('/test/batch-error')).text()).trim());
  assert.equal(interrupted.ok, false);
  assert.match(interrupted.error, /Batch interrupted: fake failure/);
});
