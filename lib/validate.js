// Parse "email|pass|2fa" -> {email, password, totp, combo} or null.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function parseCombo(s) {
  const p = String(s || '')
    .trim()
    .split('|')
    .map((x) => x.trim());
  if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return null;
  if (!EMAIL_RE.test(p[0])) return null;
  return { email: p[0], password: p[1], totp: p[2], combo: `${p[0]}|${p[1]}|${p[2]}` };
}

// One proxy per line -> trimmed non-empty list (comments with # and blanks dropped). No format
// validation: curl_cffi accepts [scheme://][user:pass@]host:port and reports its own errors.
function parseProxies(s) {
  return String(s || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith('#'));
}

module.exports = { parseCombo, parseProxies };
