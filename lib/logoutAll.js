const { parseCombo, parseProxies } = require('./validate');
const { runPython } = require('./runPython');

const MAX_BATCH = 50;

// One combo -> logout all sessions. email|pass|2fa in, {email, ok, combo, message, stage, error} out.
async function logoutAllOne(rawLine, proxy) {
  const combo = parseCombo(rawLine);
  if (!combo) {
    return { email: rawLine, ok: false, combo: rawLine, error: 'invalid combo format (expected email|pass|2fa)' };
  }
  const outcome = await runPython('logout_all.py', [combo.combo], proxy);
  return {
    email: combo.email,
    ok: Boolean(outcome.ok),
    combo: combo.combo,
    message: outcome.ok ? (outcome.message || 'Đã đăng xuất tất cả thiết bị thành công') : undefined,
    stage: outcome.stage,
    error: outcome.ok ? undefined : (outcome.error || 'unknown error')
  };
}

async function logoutAllBatch(rawText, onResult, proxyText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_BATCH);
  const proxies = parseProxies(proxyText);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const proxy = proxies.length ? proxies[i % proxies.length] : undefined;
    const r = await logoutAllOne(lines[i], proxy);
    results.push(r);
    if (typeof onResult === 'function') {
      await onResult(r);
    }
  }
  return results;
}

module.exports = { logoutAllOne, logoutAllBatch, MAX_BATCH };
