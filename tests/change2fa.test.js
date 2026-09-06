const test = require('node:test');
const assert = require('node:assert/strict');
const pythonPath = require.resolve('../lib/runPython');
require(pythonPath);
const calls = [];
let nextResult = { ok: true, totp_secret: 'NEW' };
require.cache[pythonPath].exports = { runPython: async (...args) => { calls.push(args); return nextResult; } };
const { change2faBatch, change2faOne } = require('../lib/change2fa');

test('Team route mode passes workspace flag and waits for recovery logging', async () => {
  const saved = [];
  const results = await change2faBatch('first@example.test|pass|OLD\nsecond@example.test|pass|OLD', async r => {
    await new Promise(resolve => setImmediate(resolve));
    saved.push(r.email);
  }, 'proxy1:8080\nproxy2:8080', { accountType: 'workspace' });
  assert.equal(results.length, 2);
  assert.deepEqual(saved, ['first@example.test', 'second@example.test']);
  assert.deepEqual(calls[0], ['change_2fa.py', ['first@example.test|pass|OLD', '--workspace'], 'proxy1:8080']);
  assert.equal(calls[1][2], 'proxy2:8080');
});

test('Personal route and uncertain activation preserve the right secret fields', async () => {
  calls.length = 0;
  nextResult = { ok: false, stage: 'mfa_activate', error: 'timeout', recovery_totp: 'CANDIDATE', activation_uncertain: true };
  const result = await change2faOne('test@example.test|pass|OLD');
  assert.deepEqual(calls[0][1], ['test@example.test|pass|OLD']);
  assert.equal(result.ok, false);
  assert.equal(result.newTotp, undefined);
  assert.equal(result.recoveryTotp, 'CANDIDATE');
  assert.equal(result.activationUncertain, true);
  assert.equal(result.password, 'pass');
  assert.equal(result.stage, 'mfa_activate');
});
