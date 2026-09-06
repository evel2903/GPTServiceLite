const { parseCombo, parseProxies } = require('./validate');
const { runPython } = require('./runPython');

const MAX_BATCH = 50;

async function runChange2faScript(combo, proxy, options = {}) {
  const args = [combo];
  if (options.accountType === 'workspace') args.push('--workspace');
  const parsed = await runPython('change_2fa.py', args, proxy);
  return parsed.ok && parsed.totp_secret
    ? { ok: true, totp_secret: parsed.totp_secret }
    : { ok: false, error: parsed.error || 'unknown error', stage: parsed.stage,
        recoveryTotp: parsed.recovery_totp, activationUncertain: parsed.activation_uncertain === true };
}

// One combo -> its change-2fa result. email|pass|2fa in, {email, ok, password, newTotp} out
// (password unchanged -- carried through so the caller can print email|pass|new2fa).
async function change2faOne(rawLine, proxy, options = {}) {
  const combo = parseCombo(rawLine);
  if (!combo) return { email: rawLine, ok: false, error: 'invalid combo format (expected email|pass|2fa)' };
  const outcome = await runChange2faScript(combo.combo, proxy, options);
  return {
    email: combo.email,
    password: combo.password,
    oldTotp: combo.totp,
    ok: outcome.ok,
    newTotp: outcome.ok ? outcome.totp_secret : undefined,
    error: outcome.ok ? undefined : outcome.error,
    stage: outcome.stage,
    recoveryTotp: outcome.recoveryTotp,
    activationUncertain: outcome.activationUncertain
  };
}

// proxyText: one proxy per line, round-robined across combos so a batch spreads over IPs.
// Empty -> every combo goes direct (old behaviour).
async function change2faBatch(rawText, onResult, proxyText, options = {}) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_BATCH);
  const proxies = parseProxies(proxyText);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const proxy = proxies.length ? proxies[i % proxies.length] : undefined;
    const r = await change2faOne(lines[i], proxy, options);
    results.push(r);
    if (onResult) await onResult(r);
  }
  return results;
}

module.exports = { runChange2faScript, change2faOne, change2faBatch, MAX_BATCH };
