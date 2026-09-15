const { parseCombo, parseProxies } = require('./validate');
const { runPython } = require('./runPython');

const MAX_BATCH = 50;

// One combo -> its access token. email|pass|2fa in, {email, ok, accessToken, session, stage, error} out.
async function getTokenOne(rawLine, proxy) {
  const combo = parseCombo(rawLine);
  if (!combo) {
    return { email: rawLine, ok: false, combo: rawLine, error: 'invalid combo format (expected email|pass|2fa)' };
  }
  const outcome = await runPython('get_token.py', [combo.combo], proxy);
  const token = outcome.ok ? (outcome.access_token || undefined) : undefined;
  return {
    email: combo.email,
    combo: combo.combo,
    ok: Boolean(outcome.ok && token),
    accessToken: token,
    session: outcome.ok ? (outcome.session || {}) : undefined,
    stage: outcome.stage,
    error: outcome.ok && token ? undefined : (outcome.error || 'no_access_token')
  };
}

// Proxies rotate per combo; await the callback so each result can be logged before streaming.
async function getTokenBatch(rawText, onResult, proxyText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_BATCH);
  const proxies = parseProxies(proxyText);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const proxy = proxies.length ? proxies[i % proxies.length] : undefined;
    const r = await getTokenOne(lines[i], proxy);
    results.push(r);
    if (onResult) await onResult(r);
  }
  return results;
}

module.exports = { getTokenOne, getTokenBatch, MAX_BATCH };
