const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { formatLine } = require('../lib/logger');

function checkPlanWithWorker(worker) {
  const runner = require('../lib/runPython');
  const original = runner.runPython;
  runner.runPython = worker;
  delete require.cache[require.resolve('../lib/checkPlan')];
  const checkPlan = require('../lib/checkPlan');
  runner.runPython = original;
  return checkPlan;
}

test('Check Plan keeps all workspace plans and zero-valued usage metadata', async () => {
  const workspaces = [
    { id: 'personal', name: 'Personal', plan: 'free', is_default: true },
    { id: 'school', name: 'School', plan: 'k12', is_selected: true, days_left: 0 }
  ];
  const { checkPlanOne } = checkPlanWithWorker(async (script, args, proxy) => {
    assert.equal(script, 'check_plan.py');
    assert.deepEqual(args, ['a@example.com|password|SECRET']);
    assert.equal(proxy, 'proxy:1234');
    return { ok: true, plan: 'k12', plans: ['free', 'k12'], workspaces, account_id: 'school', days_left: 0, remaining_percent: 0, limit_reached: false };
  });
  const result = await checkPlanOne(' a@example.com | password | SECRET ', 'proxy:1234');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'k12');
  assert.deepEqual(result.plans, ['k12', 'free']);
  assert.deepEqual(result.workspaces, workspaces);
  assert.equal(result.accountId, 'school');
  assert.equal(result.combo, 'a@example.com|password|SECRET');
  assert.equal(result.daysLeft, 0);
  assert.equal(result.remainingPercent, 0);
  assert.equal(result.limitReached, false);
});

test('Check Plan never converts missing or non-Plus plans to Free', async () => {
  for (const plan of [undefined, 'free', 'plus', 'pro', 'go', 'team', 'business', 'enterprise', 'edu', 'k12', 'future_plan']) {
    const { checkPlanOne } = checkPlanWithWorker(async () => ({ ok: true, plan }));
    const result = await checkPlanOne('a@example.com|password|SECRET');
    assert.equal(result.ok, true);
    assert.equal(result.plan, plan || 'unknown');
    assert.equal(result.status, plan || 'unknown');
  }
});

test('partial plan checks preserve warnings instead of looking like complete Free results', async () => {
  const { checkPlanOne } = checkPlanWithWorker(async () => ({
    ok: true, plan: 'free', plans: ['free'], plans_complete: false,
    warnings: ['accounts_lookup_failed: HTTP 500'], usage_account_id: 'personal'
  }));
  const result = await checkPlanOne('a@example.com|password|SECRET');
  assert.equal(result.plansComplete, false);
  assert.deepEqual(result.warnings, ['accounts_lookup_failed: HTTP 500']);
  assert.equal(result.usageAccountId, 'personal');
  assert.match(formatPlan(result), /CHƯA ĐỦ DỮ LIỆU.*accounts_lookup_failed: HTTP 500/);
  assert.match(formatLine('check-plan', result), /plans_complete=false.*accounts_lookup_failed: HTTP 500/);
});

test('failed checks retain the combo and error; invalid input does not invoke Python', async () => {
  let calls = 0;
  const { checkPlanOne } = checkPlanWithWorker(async () => {
    calls++;
    return { ok: false, error: 'invalid_credentials' };
  });
  const malformed = await checkPlanOne('bad line');
  assert.equal(calls, 0);
  assert.equal(malformed.status, 'bad format');
  assert.equal(malformed.combo, 'bad line');
  const failed = await checkPlanOne('a@example.com|password|SECRET');
  assert.equal(calls, 1);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'wrong password');
  assert.equal(failed.error, 'invalid_credentials');
  assert.deepEqual(failed.plans, []);
});

test('batch rotates proxies and awaits persistence before starting the next account', async () => {
  const seenProxies = [];
  const saved = [];
  const { checkPlanBatch } = checkPlanWithWorker(async (_script, _args, proxy) => {
    assert.equal(saved.length, seenProxies.length);
    seenProxies.push(proxy);
    return { ok: true, plan: 'team' };
  });
  const results = await checkPlanBatch('a@example.com|p|S\nb@example.com|p|S\nc@example.com|p|S', async (r) => {
    await new Promise((resolve) => setImmediate(resolve));
    saved.push(r);
  }, '# comment\np1:80\np2:80');
  assert.deepEqual(seenProxies, ['p1:80', 'p2:80', 'p1:80']);
  assert.deepEqual(saved, results);
});

test('legacy Check Plus module exposes the new results and callable aliases', () => {
  const legacy = require('../lib/checkPlus');
  assert.equal(legacy.checkPlusOne, legacy.checkPlanOne);
  assert.equal(legacy.checkPlusBatch, legacy.checkPlanBatch);
  assert.equal(legacy.statusOf(true, 'enterprise'), 'enterprise');
});

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const { TABS, formatPlan, format2fa, readResults, completionStatus } = vm.runInNewContext(
  script.split('const panelsEl =')[0] + '\n({ TABS, formatPlan, format2fa, readResults, completionStatus });',
  { TextDecoder }
);

test('UI reads split UTF-8 chunks and preserves a final result without a newline', async () => {
  const records = [{ ok: true, plan: 'team' }, { ok: false, error: 'Chưa xác nhận' }];
  const bytes = new TextEncoder().encode(records.map((r) => JSON.stringify(r)).join('\n'));
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  });
  const seen = [];
  await readResults(body, (r) => seen.push(r));
  assert.equal(JSON.stringify(seen), JSON.stringify(records));
  assert.equal(body.locked, false);
});

test('UI does not report completion for an empty or incomplete server response', async () => {
  const seen = [];
  await readResults(new ReadableStream({ start(controller) { controller.close(); } }), (r) => seen.push(r));
  assert.equal(seen.length, 0);
  assert.match(completionStatus(0, 0, 1), /Chưa đủ kết quả: 0\/1.*Xem Logs/);
  assert.match(completionStatus(1, 0, 2), /Chưa đủ kết quả: 1\/2/);
  assert.equal(completionStatus(1, 1, 2), 'Xong: OK 1 / FAIL 1');
  await assert.rejects(readResults(null, () => {}), /không trả luồng kết quả/);
});

test('UI accepts every successfully detected plan and exports both personal and school workspace details', () => {
  const tab = TABS.find((t) => t.key === 'check-plan');
  assert.equal(tab.endpoint, '/api/check-plan');
  for (const plan of ['free', 'plus', 'pro', 'go', 'team', 'business', 'enterprise', 'edu', 'k12', 'unknown']) {
    assert.equal(tab.isOk({ ok: true, plan }), true);
  }
  assert.equal(tab.isOk({ ok: false, plan: 'plus' }), false);
  const text = formatPlan({
    ok: true, combo: 'a@example.com|p|S', plan: 'free', plans: ['free', 'k12'],
    workspaces: [{ id: 'p', name: 'Personal', plan: 'free' }, { id: 's', name: 'School', plan: 'k12', days_left: 0 }]
  });
  assert.match(text, /^a@example\.com\|p\|S \| plan=Free \| plans=Free,K12/);
  assert.match(text, /Personal \(Free\); School \(K12, days_left=0\)/);
  assert.doesNotMatch(text, /remaining=/);
  assert.match(formatPlan({ ok: false, combo: 'a@example.com|p|S', error: 'login failed' }), /FAIL: login failed/);
});

test('both 2FA tabs preserve the new secret in success and uncertain activation output', () => {
  const teamTab = TABS.find((t) => t.key === 'change-2fa-team');
  assert.equal(teamTab.endpoint, '/api/change-2fa-team');
  assert.equal(format2fa({ ok: true, email: 'a@example.com', password: 'p', newTotp: 'NEW' }), 'a@example.com|p|NEW');
  const uncertain = { ok: false, email: 'a@example.com', password: 'p', oldTotp: 'OLD', recoveryTotp: 'NEW', activationUncertain: true, error: 'timeout' };
  assert.equal(teamTab.isOk(uncertain), false);
  assert.match(teamTab.formatOne(uncertain), /CHƯA XÁC NHẬN: timeout.*combo_du_phong: a@example.com\|p\|NEW/);
  for (const action of ['change-2fa', 'change-2fa-team']) {
    const okLog = formatLine(action, { ...uncertain, ok: true, newTotp: 'NEW' });
    assert.ok(okLog.includes(`[${action}]\tOK\t`));
    assert.match(okLog, /combo_moi: a@example.com\|p\|NEW$/);
    const uncertainLog = formatLine(action, uncertain);
    assert.ok(uncertainLog.includes(`[${action}]\tFAIL\t`));
    assert.match(uncertainLog, /CHƯA XÁC NHẬN.*combo_cu: a@example.com\|p\|OLD.*combo_du_phong: a@example.com\|p\|NEW/);
  }
});

test('plan logs use OK/FAIL with actual plan data, including the legacy action', () => {
  for (const action of ['check-plan', 'check-plus']) {
    const log = formatLine(action, { ok: true, combo: 'a@example.com|p|S', plan: 'team', plans: ['free', 'team'], workspaces: [{ id: 't', plan: 'team' }] });
    assert.ok(log.includes(`[${action}]\tOK\t`));
    assert.match(log, /plan=team \| plans=free,team/);
    assert.match(log, /workspaces=\[\{"id":"t","plan":"team"\}\]/);
    assert.doesNotMatch(log, /NON-PLUS/);
  }
  assert.match(formatLine('check-plan', { ok: false, combo: 'a@example.com|p|S', status: 'login error', error: 'HTTP 500' }), /\tFAIL\t.*status=login error.*error=HTTP 500/);
});
