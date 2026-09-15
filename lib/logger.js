const fsp = require('node:fs/promises');
const path = require('node:path');
const { BASE_DIR } = require('./paths');

const LOG_DIR = process.env.LOG_DIR || path.join(BASE_DIR, 'logs');
let logsDisabled = process.env.DISABLE_LOGS === '1' || process.env.DISABLE_LOGS === 'true';

function setDisableLogs(disabled) {
  logsDisabled = Boolean(disabled);
}

function isLogsDisabled() {
  return logsDisabled || process.env.DISABLE_LOGS === '1' || process.env.DISABLE_LOGS === 'true';
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatLine(action, r) {
  const t = new Date().toISOString();
  if (action === 'change-2fa' || action === 'change-2fa-team') {
    if (r.ok) {
      return `${t}\t[${action}]\tOK\t${r.email} | 2fa: ${r.oldTotp || '?'} -> ${r.newTotp} | combo_moi: ${r.email}|${r.password}|${r.newTotp}`;
    }
    const recovery = r.recoveryTotp ? ` | combo_du_phong: ${r.email}|${r.password}|${r.recoveryTotp}` : '';
    const original = r.password && r.oldTotp ? ` | combo_cu: ${r.email}|${r.password}|${r.oldTotp}` : '';
    const uncertain = r.activationUncertain ? ' | CHƯA XÁC NHẬN kích hoạt 2FA mới' : '';
    return `${t}\t[${action}]\tFAIL\t${r.email} | ly do: ${r.stage ? `[${r.stage}] ` : ''}${r.error || 'unknown'}${uncertain}${original}${recovery}`;
  }
  if (action === 'logout-all') {
    if (r.ok) {
      return `${t}\t[logout-all]\tOK\t${r.email} | ${r.message || 'logged out all sessions'}`;
    }
    return `${t}\t[logout-all]\tFAIL\t${r.combo || r.email} | ly do: ${r.stage ? `[${r.stage}] ` : ''}${r.error || 'unknown'}`;
  }
  if (action === 'get-token') {
    if (r.ok) {
      return `${t}\t[get-token]\tOK\t${r.email} | token_len=${(r.accessToken || '').length} | ${r.email}|${r.accessToken}`;
    }
    return `${t}\t[get-token]\tFAIL\t${r.combo || r.email} | ly do: ${r.stage ? `[${r.stage}] ` : ''}${r.error || 'unknown'}`;
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

async function logResult(action, result) {
  if (isLogsDisabled()) return;
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await fsp.appendFile(path.join(LOG_DIR, `${today()}.txt`), formatLine(action, result) + '\n');
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[logger] failed to write log:', e.message);
    }
  }
}

async function listLogs() {
  if (isLogsDisabled()) return [];
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

function logPath(name) {
  if (isLogsDisabled() || !/^\d{4}-\d{2}-\d{2}\.txt$/.test(name)) return null;
  return path.join(LOG_DIR, name);
}

module.exports = {
  logResult,
  listLogs,
  logPath,
  LOG_DIR,
  formatLine,
  setDisableLogs,
  isLogsDisabled
};

if (require.main === module) {
  const assert = require('node:assert');
  const ok2fa = formatLine('change-2fa', { ok: true, email: 'a@b.c', password: 'p', oldTotp: 'OLD', newTotp: 'SECRET' });
  assert.ok(ok2fa.includes('\tOK\t') && ok2fa.includes('2fa: OLD -> SECRET') && ok2fa.endsWith('a@b.c|p|SECRET'));
  const fail2fa = formatLine('change-2fa', { ok: false, email: 'a@b.c', error: 'boom' });
  assert.ok(fail2fa.includes('\tFAIL\t') && fail2fa.includes('ly do: boom'));
  const okToken = formatLine('get-token', { ok: true, email: 'a@b.c', accessToken: 'xyz123' });
  assert.ok(okToken.includes('\tOK\t') && okToken.includes('a@b.c|xyz123'));
  const failToken = formatLine('get-token', { ok: false, email: 'a@b.c', error: 'bad credentials' });
  assert.ok(failToken.includes('\tFAIL\t') && failToken.includes('ly do: bad credentials'));
  assert.ok(formatLine('check-plan', { ok: true, plan: 'plus', combo: 'x', daysLeft: 5, remainingPercent: 80 }).includes('plan=plus'));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(today()), 'today() must be YYYY-MM-DD, got ' + today());
  assert.strictEqual(logPath('../server.js'), null);
  assert.strictEqual(logPath('2026-08-30.txt') && path.basename(logPath('2026-08-30.txt')), '2026-08-30.txt');
  console.log('logger selfcheck ok');
}
