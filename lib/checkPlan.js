const { parseCombo, parseProxies } = require('./validate');
const { runPython } = require('./runPython');

const MAX_BATCH = 50;

// Preserve the detected plan; a successful check does not imply a Free or Plus account.
function statusOf(ok, plan, error) {
  if (ok) return plan || 'unknown';
  const e = (error || '').toLowerCase();
  if (e.includes('invalid_credential') || e.includes('password')) return 'wrong password';
  if (e.includes('deactivat') || e.includes('deleted')) return 'deactivated';
  if (e.includes('locked') || e.includes('ban') || e.includes('suspend')) return 'banned';
  if (e.includes('mfa') || e.includes('2fa') || e.includes('totp') || e.includes('otp')) return '2fa error';
  if (e.includes('format') || e.includes('combo must be')) return 'bad format';
  if (e.includes('network') || e.includes('http') || e.includes('timeout')) return 'login error';
  return error || 'unknown';
}

// One combo -> every workspace plan visible to this account. Read-only.
async function checkPlanOne(rawLine, proxy) {
  const combo = parseCombo(rawLine);
  if (!combo) {
    return { email: rawLine, ok: false, combo: rawLine, status: 'bad format', error: 'invalid combo format (expected email|pass|2fa)' };
  }
  const outcome = await runPython('check_plan.py', [combo.combo], proxy);
  const plan = outcome.ok ? (outcome.plan || 'unknown') : undefined;
  const plans = outcome.ok
    ? [...new Set([plan, ...(Array.isArray(outcome.plans) ? outcome.plans : [])].filter(Boolean))]
    : [];
  return {
    email: combo.email,
    ok: outcome.ok,
    plan,
    plans,
    workspaces: outcome.ok && Array.isArray(outcome.workspaces) ? outcome.workspaces : [],
    warnings: Array.isArray(outcome.warnings) ? outcome.warnings : [],
    plansComplete: outcome.plans_complete ?? null,
    accountId: outcome.account_id ?? null,
    usageAccountId: outcome.usage_account_id ?? null,
    combo: combo.combo,
    status: statusOf(outcome.ok, plan, outcome.error),
    daysLeft: outcome.days_left ?? null,
    expiresAt: outcome.expires_at ?? null,
    remainingPercent: outcome.remaining_percent ?? null,
    limitReached: outcome.limit_reached ?? null,
    usageResetAt: outcome.usage_reset_at ?? null,
    stage: outcome.stage,
    error: outcome.ok ? undefined : (outcome.error || 'unknown error')
  };
}

// Proxies rotate per combo; await the callback so each result can be logged before streaming.
async function checkPlanBatch(rawText, onResult, proxyText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_BATCH);
  const proxies = parseProxies(proxyText);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const proxy = proxies.length ? proxies[i % proxies.length] : undefined;
    const r = await checkPlanOne(lines[i], proxy);
    results.push(r);
    if (onResult) await onResult(r);
  }
  return results;
}

module.exports = { statusOf, checkPlanOne, checkPlanBatch, MAX_BATCH };
