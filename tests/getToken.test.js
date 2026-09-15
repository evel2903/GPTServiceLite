const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pythonPath = require.resolve('../lib/runPython');
require(pythonPath);
const calls = [];
let nextResult = { ok: true, access_token: 'fake-token-xyz', session: { user: { email: 'test@example.test' } } };
require.cache[pythonPath].exports = { runPython: async (...args) => { calls.push(args); return nextResult; } };

const { getTokenOne, getTokenBatch, MAX_BATCH } = require('../lib/getToken');

test('getTokenOne parses combo and calls get_token.py with proxy', async () => {
  calls.length = 0;
  nextResult = { ok: true, access_token: 'valid-token', session: { account_id: '123' } };
  const res = await getTokenOne('test@example.test|pass123|SECRET', 'http://proxy:8080');
  assert.equal(res.ok, true);
  assert.equal(res.email, 'test@example.test');
  assert.equal(res.accessToken, 'valid-token');
  assert.deepEqual(res.session, { account_id: '123' });
  assert.deepEqual(calls[0], ['get_token.py', ['test@example.test|pass123|SECRET'], 'http://proxy:8080']);
});

test('getTokenOne rejects bad combo format without calling Python', async () => {
  calls.length = 0;
  const res = await getTokenOne('bad-combo');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid combo format (expected email|pass|2fa)');
  assert.equal(calls.length, 0);
});

test('getTokenBatch rotates proxies per combo and awaits streaming callback', async () => {
  calls.length = 0;
  const streamed = [];
  const proxyText = 'proxy1:8080\nproxy2:8080';
  const combos = 'a@test.com|p|S\nb@test.com|p|S\nc@test.com|p|S';
  const results = await getTokenBatch(combos, async (r) => {
    await new Promise((resolve) => setImmediate(resolve));
    streamed.push(r.email);
  }, proxyText);

  assert.equal(results.length, 3);
  assert.deepEqual(streamed, ['a@test.com', 'b@test.com', 'c@test.com']);
  assert.equal(calls[0][2], 'proxy1:8080');
  assert.equal(calls[1][2], 'proxy2:8080');
  assert.equal(calls[2][2], 'proxy1:8080');
});

test('UI tab config and formatToken function work properly', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ctx = vm.runInNewContext(
    script.split('const panelsEl =')[0] + '\n({ TABS, formatToken });',
    { TextDecoder }
  );

  const tokenTab = ctx.TABS.find((t) => t.key === 'get-token');
  assert.ok(tokenTab, 'get-token tab must exist in TABS');
  assert.equal(tokenTab.endpoint, '/api/get-token');
  assert.equal(tokenTab.okLabel, 'OK — ACCESS TOKEN');
  assert.equal(tokenTab.isOk({ ok: true }), true);
  assert.equal(tokenTab.isOk({ ok: false }), false);

  const okFormatted = ctx.formatToken({ ok: true, email: 'user@example.com', accessToken: 'eyToken123' });
  assert.equal(okFormatted, 'user@example.com|eyToken123');

  const failFormatted = ctx.formatToken({ ok: false, combo: 'user@example.com|p|S', error: 'invalid credentials' });
  assert.match(failFormatted, /^user@example\.com\|p\|S \| FAIL: invalid credentials/);
});
