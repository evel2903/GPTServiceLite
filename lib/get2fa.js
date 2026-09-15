const crypto = require('node:crypto');

const MAX_BATCH = 100;

function extractSecretAndTag(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const parts = trimmed.split('|').map((p) => p.trim());
  let candidate = '';
  let email = '';
  if (parts.length >= 3) {
    email = parts[0];
    candidate = parts[2];
  } else if (parts.length === 2) {
    email = parts[0];
    candidate = parts[1];
  } else {
    candidate = parts[0];
  }
  const clean = candidate.replace(/[\s-]+/g, '').toUpperCase();
  return { secret: clean, email, input: trimmed };
}

function generateTotp(secret) {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let i = 0; i < secret.length; i++) {
    const val = base32chars.indexOf(secret.charAt(i).toUpperCase());
    if (val === -1) return null;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  if (!bytes.length) return null;
  const key = Buffer.from(bytes);
  const epoch = Math.floor(Date.now() / 1000);
  const time = Math.floor(epoch / 30);
  const remaining = 30 - (epoch % 30);
  const timeBuf = Buffer.alloc(8);
  timeBuf.writeBigInt64BE(BigInt(time));
  const hmac = crypto.createHmac('sha1', key).update(timeBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
  return { code, remaining };
}

function get2faOne(rawLine) {
  const extracted = extractSecretAndTag(rawLine);
  if (!extracted || !extracted.secret) {
    return { ok: false, input: rawLine, error: 'invalid format (expected combo or 2FA secret key)' };
  }
  const totp = generateTotp(extracted.secret);
  if (!totp) {
    return { ok: false, input: rawLine, secret: extracted.secret, error: 'invalid 2FA base32 secret key' };
  }
  return {
    ok: true,
    code: totp.code,
    remaining: totp.remaining,
    secret: extracted.secret,
    email: extracted.email,
    input: extracted.input
  };
}

async function get2faBatch(rawText, onResult) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_BATCH);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const r = get2faOne(lines[i]);
    results.push(r);
    if (typeof onResult === 'function') {
      await onResult(r);
    }
  }
  return results;
}

module.exports = { get2faOne, get2faBatch, extractSecretAndTag, generateTotp, MAX_BATCH };
