# GPTServiceLite

> **Author:** Telegram [@sanlee035](https://t.me/sanlee035)

A standalone, lightweight, zero-database local web service and batch automation tool for ChatGPT accounts:

- **Change 2FA (Personal / Standard)** — Rotate TOTP secrets for ChatGPT accounts while keeping passwords intact.
- **Change 2FA (Team / Workspace)** — Rotate TOTP factors in the context of Team / Business / Enterprise / Edu / K12 workspaces.
- **Check Plan** — Inspect active subscriptions and quotas across personal and organization workspaces (Free, Plus, Pro, Go, Team, Business, Enterprise, Edu, K12).

No accounts, no admin passwords, no database, and no telemetry. Each request directly triggers high-performance Python automation routines in `core/` via pure HTTP with browser impersonation (`curl_cffi`) and Cloudflare Turnstile token resolution. Results stream line-by-line via NDJSON in real time.

---

## Features

- **Automated Workspace Selection**: Automatically detects and selects organization / Team workspaces when logging into multi-workspace accounts.
- **Pure-HTTP Execution**: No heavyweight headless browsers (Puppeteer/Playwright); requests are executed with TLS/JA3 impersonation for speed and reliability.
- **Streaming NDJSON Output**: Real-time batch progress without waiting for the entire queue to complete.
- **Per-Account Proxy Rotation**: Round-robins proxies across batch accounts to prevent IP rate-limiting.
- **Crash-Proof Logging**: Results are saved to disk (`logs/YYYY-MM-DD.txt`) *before* streaming to the frontend to prevent data loss.
- **Portable Windows Executable**: Bundled with an embedded Python runtime via [pkg](https://github.com/vercel/pkg) — run with a double-click without installing Node or Python.
- **Docker Support**: Containerized deployment ready for Linux/Docker environments.

---

## Getting Started

### Prerequisites

- Node.js (v18+)
- Python (3.10+)

### Local Installation

```bash
# 1. Install Python dependencies
pip install -r core/requirements.txt

# 2. Install Node.js dependencies
npm install

# 3. Start the application
npm start
```

By default, the server listens on `0.0.0.0:8099`. Open [http://localhost:8099](http://localhost:8099) in your browser.

> **Windows Note:** If `python3` is not on your `PATH`, configure your Python executable before starting:
> ```powershell
> $env:PYTHON_BIN = "python"
> npm start
> ```

---

## Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8099` | HTTP server port |
| `BIND_IP` | `0.0.0.0` | Listen host IP |
| `PYTHON_BIN` | `python3` | Path or command for the Python binary (e.g. `python` on Windows) |
| `CONFIG_PATH` | `./config.json` | Path to persistent configuration file (saved proxies) |
| `LOG_DIR` | `./logs` | Directory for date-stamped audit logs |
| `NO_OPEN_BROWSER` | *unset* | Set to `1` to prevent packaged `.exe` from auto-opening the browser |

---

## Docker Deployment

```bash
# Build the Docker image
docker build -t gptservicelite .

# Run the container
docker run -d \
  --name gptservicelite \
  -p 8099:8099 \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/config.json:/app/config.json \
  gptservicelite
```

---

## Portable Windows Executable (Zero-Dependency)

You can package the entire app into a self-contained folder containing `gptservicelite.exe` and an embedded Python runtime. It runs on clean Windows machines **without installing Node.js or Python**.

### Build Instructions

On a Windows development machine:

```powershell
npm run build:portable
```

The build output is located at `dist\gptservicelite\`:
- `gptservicelite.exe` — Packaged Node.js binary
- `python\` — Embedded Python 3.14 + required dependencies
- `core\` — Python scripts
- `public\` — Frontend assets

Simply zip the `dist\gptservicelite\` directory and distribute it. Launching `gptservicelite.exe` automatically starts the server and opens your default browser.

---

## Usage Guide

Open [http://localhost:8099](http://localhost:8099). The interface includes 5 tabs:

1. **Change 2FA**
2. **Change 2FA Team / K12**
3. **Check Plan**
4. **Logs**
5. **Configuration**

### Input Format

Paste accounts into the **Input** textarea, one per line (up to 50 accounts per batch):

```text
email@example.com|password|CURRENT_2FA_SECRET
```

### Proxy Format

Paste proxies into the **Proxy** textarea (or save defaults in the **Configuration** tab). Proxies are round-robined across accounts:

```text
host:port
username:password@host:port
http://username:password@host:port
socks5://host:port
```

### Results & Safety

- **OK Column**: Successful operations display the new combo (`email|pass|NEW_2FA_SECRET`).
- **FAIL Column**: Shows failure stage and descriptive error reasons.
- **Uncertain Activations**: If a network interruption occurs after factor enrollment but before confirmation, the tool marks the account as uncertain and provides a recovery secret (`combo_du_phong`) so credentials are never locked out.
- **Audit Logs**: Every result is written to `logs/YYYY-MM-DD.txt` on the server before client transmission.

---

## API Endpoints

- `POST /api/change-2fa` — Batch rotate TOTP for standard accounts (NDJSON streaming).
- `POST /api/change-2fa-team` — Batch rotate TOTP with workspace context (NDJSON streaming).
- `POST /api/check-plan` — Batch inspect account plans and quotas (NDJSON streaming; legacy alias `/api/check-plus`).
- `GET /api/logs` — List available log files.
- `GET /api/logs/:name` — Download a specific log file.
- `GET /api/config` — Retrieve saved configuration (proxies).
- `POST /api/config` — Update configuration.
- `GET /api/health` — Health check endpoint.

---

## Security Warning

This application **does not include user authentication**. Anyone with network access to the web interface can execute batch operations using provided credentials. 

- **Do not** expose this port publicly to the internet without a reverse proxy (e.g. Nginx, Cloudflare Access) enforcing authentication or IP whitelisting.
- `config.json` and files in `logs/` contain plain-text credentials and proxies. Ensure appropriate filesystem permissions on the host system.

---

## License

Private & Proprietary / MIT (refer to repository terms).