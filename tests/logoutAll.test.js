const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pythonPath = require.resolve('../lib/runPython');
require(pythonPath);
const calls = [];
let nextResult = { ok: true, message: 'logged out all sessions' };
require.cache[pythonPath].exports = { runPython: async (...args) => { calls.push(args); return nextResult; } };

const { logoutAllOne, logoutAllBatch, MAX_BATCH } = require('../lib/logoutAll');

test('logoutAllOne parses combo and calls logout_all.py with proxy', async () => {
  calls.length = 0;
  nextResult = { ok: true, message: 'logged out all sessions' };
  const res = await logoutAllOne('test@example.test|pass123|SECRET', 'http://proxy:8080');
  assert.equal(res.ok, true);
  assert.equal(res.email, 'test@example.test');
  assert.equal(res.message, 'logged out all sessions');
  assert.deepEqual(calls[0], ['logout_all.py', ['test@example.test|pass123|SECRET'], 'http://proxy:8080']);
});

test('logoutAllOne rejects bad combo format without calling Python', async () => {
  calls.length = 0;
  const res = await logoutAllOne('bad-combo');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid combo format (expected email|pass|2fa)');
  assert.equal(calls.length, 0);
});

test('logoutAllBatch rotates proxies per combo and awaits streaming callback', async () => {
  calls.length = 0;
  const streamed = [];
  const proxyText = 'proxy1:8080\nproxy2:8080';
  const combos = 'a@test.com|p|S\nb@test.com|p|S\nc@test.com|p|S';
  const results = await logoutAllBatch(combos, async (r) => {
    await new Promise((resolve) => setImmediate(resolve));
    streamed.push(r.email);
  }, proxyText);

  assert.equal(results.length, 3);
  assert.deepEqual(streamed, ['a@test.com', 'b@test.com', 'c@test.com']);
  assert.equal(calls[0][2], 'proxy1:8080');
  assert.equal(calls[1][2], 'proxy2:8080');
  assert.equal(calls[2][2], 'proxy1:8080');
});

test('UI tab config and formatLogoutAll function work properly', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ctx = vm.runInNewContext(
    script.split('const panelsEl =')[0] + '\n({ TABS, formatLogoutAll });',
    { TextDecoder }
  );

  const logoutTab = ctx.TABS.find((t) => t.key === 'logout-all');
  assert.ok(logoutTab, 'logout-all tab must exist in TABS');
  assert.equal(logoutTab.endpoint, '/api/logout-all');
  assert.equal(logoutTab.okLabel, 'OK — LOGOUT ALL');
  assert.equal(logoutTab.isOk({ ok: true }), true);
  assert.equal(logoutTab.isOk({ ok: false }), false);

  const okFormatted = ctx.formatLogoutAll({ ok: true, email: 'user@example.com', message: 'all sessions terminated' });
  assert.match(okFormatted, /user@example\.com \| OK: all sessions terminated/);

  const failFormatted = ctx.formatLogoutAll({ ok: false, combo: 'user@example.com|p|S', error: 'session invalid' });
  assert.match(failFormatted, /^user@example\.com\|p\|S \| FAIL: session invalid/);
});
