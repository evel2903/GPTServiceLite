const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const { BASE_DIR, DEFAULT_PYTHON } = require('./paths');

const PYTHON_BIN = process.env.PYTHON_BIN || DEFAULT_PYTHON;
const CORE_DIR = resolve(BASE_DIR, 'core');

// Spawn one of the core/*.py scripts and parse its last `__RESULT__{json}` stdout line -- same
// contract every script in core/ uses. Returns the parsed object, or {ok:false, error} if the
// process failed to produce one.
// `proxy` (optional) is handed to the script via the PROXY env var -- login_service._make_session
// routes every request through it. Empty/undefined -> direct connection.
function runPython(script, args, proxy) {
  return new Promise((resolvePromise) => {
    const env = proxy ? { ...process.env, PROXY: proxy } : process.env;
    const py = spawn(PYTHON_BIN, [resolve(CORE_DIR, script), ...args], { env });
    let out = '';
    let errTail = '';
    py.stdout.on('data', (d) => (out += d));
    py.stderr.on('data', (d) => (errTail = String(d).slice(-500)));
    py.on('error', (e) => resolvePromise({ ok: false, error: 'spawn failed: ' + e.message }));
    py.on('close', () => {
      const line = out
        .split(/\r?\n/)
        .reverse()
        .find((l) => l.startsWith('__RESULT__'));
      if (!line) {
        console.error(`[runPython] ${script} produced no result. stderr tail:\n${errTail}`);
        resolvePromise({ ok: false, error: errTail || 'no result from script' });
        return;
      }
      try {
        const parsed = JSON.parse(line.slice('__RESULT__'.length));
        if (!parsed.ok) console.error(`[runPython] ${script} failed (${parsed.error}). stderr tail:\n${errTail}`);
        resolvePromise(parsed);
      } catch (e) {
        resolvePromise({ ok: false, error: 'bad script json: ' + e.message });
      }
    });
  });
}

module.exports = { runPython };
