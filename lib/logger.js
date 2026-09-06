const fsp = require('node:fs/promises');
const path = require('node:path');
const { BASE_DIR } = require('./paths');

const LOG_DIR = process.env.LOG_DIR || path.join(BASE_DIR, 'logs');

// Local date (user's tz) as YYYY-MM-DD. Built from parts, NOT toLocaleDateString: the packaged
// (pkg) Node ships small-ICU, where 'en-CA' silently falls back to "M/D/YYYY" and the slashes turn
// the log path into nested dirs -> ENOENT -> lost logs. getFullYear/Month/Date need no ICU.
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Self-contained recovery record per result. The body ALWAYS carries the credentials that would
// otherwise be lost -- for change-2fa the new secret on OK, the combo on FAIL -- so a closed/crashed
// browser mid-run never means a lost account.
function formatLine(action, r) {
  const t = new Date().toISOString();
  if (action === 'change-2fa' || action === 'change-2fa-team') {
    if (r.ok) {
      // Show old -> new (what it changed to) plus a ready-to-reuse new combo.
      return `${t}\t[${action}]\tOK\t${r.email} | 2fa: ${r.oldTotp || '?'} -> ${r.newTotp} | combo_moi: ${r.email}|${r.password}|${r.newTotp}`;
    }
    const recovery = r.recoveryTotp ? ` | combo_du_phong: ${r.email}|${r.password}|${r.recoveryTotp}` : '';
    const original = r.password && r.oldTotp ? ` | combo_cu: ${r.email}|${r.password}|${r.oldTotp}` : '';
    const uncertain = r.activationUncertain ? ' | CHƯA XÁC NHẬN kích hoạt 2FA mới' : '';
    return `${t}\t[${action}]\tFAIL\t${r.email} | ly do: ${r.stage ? `[${r.stage}] ` : ''}${r.error || 'unknown'}${uncertain}${original}${recovery}`;
  }
  const tag = r.combo || r.email;
  const parts = [tag];
  if (r.ok) {
    parts.push(`plan=${r.plan || 'unknown'}`);
    parts.push(`plans=${(r.plans && r.plans.length ? r.plans : [r.plan || 'unknown']).join(',')}`);
    if (r.workspaces && r.workspaces.length) parts.push(`workspaces=${JSON.stringify(r.workspaces)}`);
    if (r.daysLeft != null) parts.push(`days_left=${r.daysLeft}`);
    if (r.remainingPercent != null) parts.push(`remaining=${r.remainingPercent}%`);
    if (r.plansComplete != null) parts.push(`plans_complete=${r.plansComplete}`);
    if (r.warnings && r.warnings.length) parts.push(`warnings=${JSON.stringify(r.warnings)}`);
  } else {
    parts.push(`status=${r.status || 'unknown'}`, `error=${r.error || r.status || 'unknown'}`);
    if (r.stage) parts.push(`stage=${r.stage}`);
  }
  return `${t}\t[${action === 'check-plus' ? 'check-plus' : 'check-plan'}]\t${r.ok ? 'OK' : 'FAIL'}\t${parts.join(' | ')}`;
}

// Append one result to today's file. Best-effort: a logging failure must never crash a batch, but
// it is loud on stderr because a silent logging failure defeats the whole point.
async function logResult(action, result) {
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await fsp.appendFile(path.join(LOG_DIR, `${today()}.txt`), formatLine(action, result) + '\n');
  } catch (e) {
    console.error('[logger] failed to write log:', e.message);
  }
}

// Available daily log files, newest first, for the download UI.
async function listLogs() {
  try {
    const names = (await fsp.readdir(LOG_DIR)).filter((n) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(n));
    const rows = await Promise.all(
      names.map(async (name) => ({ name, size: (await fsp.stat(path.join(LOG_DIR, name))).size }))
    );
    return rows.sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

// Absolute path of one log file, or null if the name isn't a valid daily-log name (blocks traversal).
function logPath(name) {
  if (!/^\d{4}-\d{2}-\d{2}\.txt$/.test(name)) return null;
  return path.join(LOG_DIR, name);
}

module.exports = { logResult, listLogs, logPath, LOG_DIR, formatLine };

// ponytail: run `node lib/logger.js` for a quick self-check of the formatter + traversal guard.
if (require.main === module) {
  const assert = require('node:assert');
  const ok2fa = formatLine('change-2fa', { ok: true, email: 'a@b.c', password: 'p', oldTotp: 'OLD', newTotp: 'SECRET' });
  assert.ok(ok2fa.includes('\tOK\t') && ok2fa.includes('2fa: OLD -> SECRET') && ok2fa.endsWith('a@b.c|p|SECRET'));
  const fail2fa = formatLine('change-2fa', { ok: false, email: 'a@b.c', error: 'boom' });
  assert.ok(fail2fa.includes('\tFAIL\t') && fail2fa.includes('ly do: boom'));
  assert.ok(formatLine('check-plan', { ok: true, plan: 'plus', combo: 'x', daysLeft: 5, remainingPercent: 80 }).includes('plan=plus'));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(today()), 'today() must be YYYY-MM-DD, got ' + today());
  assert.strictEqual(logPath('../server.js'), null);
  assert.strictEqual(logPath('2026-08-30.txt') && path.basename(logPath('2026-08-30.txt')), '2026-08-30.txt');
  console.log('logger selfcheck ok');
}
