const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { get2faOne, get2faBatch, extractSecretAndTag, generateTotp } = require('../lib/get2fa');

const SECRET = 'URYNSETIOMBBUSB6JYK6MVFJYPEXSVLO';

test('get2faOne accepts full combo email|pass|secret', () => {
  const res = get2faOne(`user@example.com|mypass|${SECRET}`);
  assert.equal(res.ok, true);
  assert.equal(res.secret, SECRET);
  assert.equal(res.email, 'user@example.com');
  assert.equal(typeof res.code, 'string');
  assert.equal(res.code.length, 6);
  assert.match(res.code, /^[0-9]{6}$/);
});

test('get2faOne accepts standalone secret key without credentials', () => {
  const res = get2faOne(`  ${SECRET}  `);
  assert.equal(res.ok, true);
  assert.equal(res.secret, SECRET);
  assert.equal(res.code.length, 6);
});

test('get2faOne handles spaced or hyphenated 2FA keys', () => {
  const spaced = 'URYN SETI-OMBB USB6-JYK6 MVFJ YPEX SVLO';
  const res = get2faOne(spaced);
  assert.equal(res.ok, true);
  assert.equal(res.secret, SECRET);
  assert.equal(res.code.length, 6);
});

test('get2faOne rejects invalid or empty strings', () => {
  assert.equal(get2faOne('').ok, false);
  assert.equal(get2faOne('   ').ok, false);
  assert.equal(get2faOne('not_valid_base32_9999').ok, false);
});

test('get2faBatch processes multiple lines (combos and standalone keys)', async () => {
  const input = [
    `a@test.com|p|${SECRET}`,
    SECRET,
    `b@test.com|${SECRET}`
  ].join('\n');

  const streamed = [];
  const results = await get2faBatch(input, (r) => streamed.push(r.code));

  assert.equal(results.length, 3);
  assert.equal(results.every((r) => r.ok && r.code.length === 6), true);
  assert.equal(streamed.length, 3);
});

test('UI tab config and format2faCode function work properly', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ctx = vm.runInNewContext(
    script.split('const panelsEl =')[0] + '\n({ TABS, format2faCode });',
    { TextDecoder }
  );

  const tab = ctx.TABS.find((t) => t.key === 'get-2fa');
  assert.ok(tab, 'get-2fa tab must exist in TABS');
  assert.equal(tab.endpoint, '/api/get-2fa');
  assert.equal(tab.okLabel, 'OK — 2FA CODE');
  assert.equal(tab.noProxy, true);

  const formatted = ctx.format2faCode({ ok: true, input: 'a@b.com|p|SEC', code: '123456', remaining: 25 });
  assert.match(formatted, /a@b\.com\|p\|SEC \| 2FA: 123456/);
});
