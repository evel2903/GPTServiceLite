const path = require('node:path');

// When bundled by pkg, __dirname points inside the read-only snapshot -- but core/*.py (spawned by
// an external python) and public/ (served from disk) live as REAL files next to the .exe. So the
// app base is the exe's folder when packaged, otherwise the repo root (this file sits in lib/).
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

// Packaged builds ship an embedded Python at <base>/python/python.exe; dev falls back to python3
// (override either with the PYTHON_BIN env var).
const DEFAULT_PYTHON = process.pkg ? path.join(BASE_DIR, 'python', 'python.exe') : 'python3';

module.exports = { BASE_DIR, DEFAULT_PYTHON };
