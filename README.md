# Evel GPT Service Lite

> **Author:** Telegram [@sanlee035](https://t.me/sanlee035)  
> **Repository:** [github.com/evel2903/Evel GPT Service Lite](https://github.com/evel2903/Evel GPT Service Lite)

A high-performance, lightweight, zero-database automation suite and local web service for batch managing ChatGPT accounts:

- **Change 2FA (Personal / Standard)** — Rotate TOTP 2FA secret keys for personal ChatGPT accounts while preserving passwords.
- **Change 2FA (Team / Workspace)** — Rotate TOTP 2FA factors within Team, Business, Enterprise, Edu, or K12 organization workspace contexts.
- **Check Plan & Quotas** — Inspect active subscriptions across personal and organization workspaces (Free, Plus, Pro, Go, Team, Business, Enterprise, Edu, K12) with quota limits and expiry days.
- **Retrieve Access Tokens** — Authenticate and retrieve live session Access Tokens (`chatgpt.com/api/auth/session`) without altering account credentials.
- **Logout All Sessions** — Terminate and invalidate all active browser, mobile app, and API sessions across all devices for an account.
- **In-Place Portable Auto-Update** — Built-in zero-installer self-update mechanism with SHA-256 verification, atomic file swapping, health handshake (ACK), and automatic rollback.

No database, no external telemetry, and no heavy browser dependencies (Puppeteer/Playwright). All operations use pure HTTP with TLS/JA3 browser impersonation (`curl_cffi`) and automated Cloudflare Turnstile resolution. Results stream line-by-line via NDJSON in real time.

---

## Key Features

- **Automated Workspace Context Detection**: Automatically identifies, navigates, and enrolls TOTP factors across multiple organizational workspaces.
- **Pure-HTTP Impersonation**: High throughput and minimal resource usage via `curl_cffi` (Chrome TLS fingerprint impersonation).
- **Streaming NDJSON Output**: Real-time batch progress without waiting for the full queue to finish.
- **Per-Account Proxy Rotation**: Round-robins proxies across batch accounts (HTTP, HTTPS, SOCKS5) to prevent rate limits.
- **Crash-Proof Logging**: Results are saved to date-stamped audit log files (`logs/YYYY-MM-DD.txt`) *before* client display.
- **Uncertain Activation Recovery**: In the rare event of network interruption between enrollment and confirmation, a `combo_du_phong` backup is preserved so credentials are never locked out.
- **Zero-Dependency Windows Executable**: Bundled with an embedded CPython runtime via [pkg](https://github.com/vercel/pkg) — run with a double-click without installing Node.js or Python.
- **Multi-Language Support (i18n)**: Full English (default) and Vietnamese language localization with instant toggle and remembered preference.
- **Privacy-First Deployment & Log Suppression**: Audit logs can be omitted or completely disabled during deploy/production via `DISABLE_LOGS=1` or the Settings tab to ensure zero sensitive credential residue.
- **In-Place Auto-Update with Auto-Rollback**: One-click updates that overcome Windows file locking, verify SHA-256 checksums, preserve user configs and logs, and roll back automatically if the new version fails to boot.
- **Docker Support**: Ready for containerized deployment on Linux and server environments.

---

## Quick Start

### Option 1: Portable Windows Executable (Recommended)

1. Download the latest release package (`gptservicelite-vX.X.X-windows-x64.zip`) from [GitHub Releases](https://github.com/evel2903/Evel GPT Service Lite/releases).
2. Extract the archive to any folder.
3. Double-click `gptservicelite.exe`. The server starts and opens [http://localhost:8099](http://localhost:8099) in your browser.

*No Node.js, Python, or administrative installation required.*

---

### Option 2: Running from Source

#### Prerequisites
- **Node.js**: v18.0.0 or higher
- **Python**: v3.10 or higher

#### Installation

```bash
# 1. Clone repository
git clone https://github.com/evel2903/Evel GPT Service Lite.git
cd Evel GPT Service Lite

# 2. Install Python dependencies
pip install -r core/requirements.txt

# 3. Install Node.js dependencies
npm install

# 4. Start the server
npm start
```

Open [http://localhost:8099](http://localhost:8099) in your browser.

> **Windows Note:** If `python3` is not in your `PATH`, specify your Python executable:
> ```powershell
> $env:PYTHON_BIN = "python"
> npm start
> ```

---

### Option 3: Docker Deployment

```bash
# Build the Docker image
docker build -t gptservicelite .

# Run container
docker run -d \
  --name gptservicelite \
  -p 8099:8099 \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/config.json:/app/config.json \
  gptservicelite
```

---

## Web Interface & Usage Guide

The local web interface provides a tabbed dashboard:

| Tab | Purpose | Output Format |
|---|---|---|
| **Change 2FA** | Rotate standard 2FA secrets | `email\|password\|new_2fa_secret` |
| **Change 2FA Team / K12** | Rotate 2FA under organization workspaces | `email\|password\|new_2fa_secret` |
| **Check Plan** | Inspect subscription plans and quota details | `email\|plan=...\|plans=...\|workspaces=...` |
| **Lấy Access Token** | Retrieve session Access Token | `email\|access_token` |
| **Logout All Sessions** | Terminate all active device sessions | `email\|OK: logged out all sessions` |
| **Logs** | View and download daily audit logs | `.txt` files |
| **Cấu hình (Config)** | Persist default proxy list and custom update URL | Saved to `config.json` |

### Input Format

Enter accounts one per line into the **Input** textarea (up to 50 accounts per batch):

```text
email@example.com|password|CURRENT_2FA_SECRET
```

### Proxy Format

Enter proxies into the **Proxy** textarea (or set defaults in the **Configuration** tab). Proxies rotate across accounts automatically:

```text
host:port
username:password@host:port
http://username:password@host:port
socks5://host:port
```

---

## In-Place Portable Auto-Update

Evel GPT Service Lite features an enterprise-grade portable self-update system modeled after `EvelProxyTool`:

```
[1. Check Update]      -> Polls portable-update-windows.json -> Compares Semver
[2. Download & Stage]  -> Stream download to %TEMP% -> Verify SHA-256 -> Extract to /staging
[3. Spawn Helper]      -> Generates update-descriptor.json -> Spawns background PowerShell helper
                          -> Parent application exits cleanly (releasing Windows file lock)
[4. Atomic Swap]       -> Helper waits for parent PID exit -> Backs up current files to .update-backup/
                          -> Copies new files into place (preserving config.json, logs/, python/)
[5. ACK & Rollback]    -> Launches new build with --portable-update-ack
                          -> Boot successful: ACK file created -> Helper removes backup -> Complete!
                          -> Boot failed or timeout (45s): Helper restores backup -> Relaunches old version!
```

### Checking & Applying Updates
- Click the version badge in the top-right corner of the web interface.
- If a new version is published, the badge pulses with `🔔 Bản mới vX.X.X!`.
- The modal presents the changelog, download size, live progress bar, and one-click update trigger.
- The web page automatically refreshes once the server successfully restarts.

---

## Building & Packaging Releases

Use the included PowerShell automation script to package release binaries and generate the update manifest:

```powershell
powershell -File scripts/make-release.ps1 -Version "1.1.0" -Changelog "Added Access Token extraction and in-place auto-update"
```

The script produces 3 files in `dist/release-v1.1.0/`:
1. **`portable-update-windows.json`** — Release manifest containing version, changelog, and SHA-256 hashes.
2. **`gptservicelite-update-v1.1.0-windows-x64.zip`** — Compact update archive (~10-15 MB) for existing users (excludes the Python runtime).
3. **`gptservicelite-v1.1.0-windows-x64.zip`** — Full distribution bundle (~45 MB) containing the embedded Python runtime.

Upload all three files as assets to your GitHub Release tag (e.g. `v1.1.0`).

---

## Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8099` | Server port |
| `BIND_IP` | `0.0.0.0` | Server bind IP address |
| `PYTHON_BIN` | `python3` (or embedded `python.exe`) | Path to the Python executable |
| `CONFIG_PATH` | `./config.json` | Path to persistent configuration file |
| `LOG_DIR` | `./logs` | Directory for date-stamped audit logs |
| `DISABLE_LOGS` | `0` | Set to `1` to completely disable writing credential audit logs to disk |
| `UPDATE_MANIFEST_URL` | *Official GitHub Release URL* | URL for `portable-update-windows.json` |
| `NO_OPEN_BROWSER` | *unset* | Set to `1` to suppress auto-opening browser on startup |

---

## API Reference

### Batch Operations (Streaming NDJSON)
- `POST /api/change-2fa` — Rotate TOTP secrets for standard personal accounts.
- `POST /api/change-2fa-team` — Rotate TOTP secrets within organizational workspace context.
- `POST /api/check-plan` — Inspect active subscription tiers and workspace quotas.
- `POST /api/get-token` — Retrieve ChatGPT session Access Tokens.
- `POST /api/logout-all` — Batch log out of all active device sessions (NDJSON streaming).

### System & Configuration
- `GET /api/health` — System health check and batch limit parameters.
- `GET /api/logs` — List all daily log files.
- `GET /api/logs/:name` — Download a specific log file attachment.
- `GET /api/config` — Retrieve persisted settings (`proxies`, `updateUrl`).
- `POST /api/config` — Update and persist settings.

### Auto-Update
- `GET /api/update/status` — Get active update phase and download progress.
- `GET /api/update/check` — Query remote manifest for newer releases (`?force=true`).
- `POST /api/update/download` — Start streaming download and staging of update archive.
- `POST /api/update/cancel` — Abort active update download.
- `POST /api/update/apply` — Trigger background helper swap, health handshake, and restart.

---

## Testing

```bash
# Run Python unit & integration tests
pytest

# Run Node.js tests (HTTP routes, NDJSON streaming, semver, updater)
npm test
```

All 46 Python tests and 24 Node.js tests run in under 2 seconds.

---

## Security Notice

- This software is intended for local or private network administration. It does **not** enforce HTTP authentication by default.
- If exposing this service to the public internet, place it behind a reverse proxy (e.g., Nginx, Caddy, Cloudflare Access) with mandatory authentication and TLS termination.
- Credentials and proxy definitions in `config.json` and `logs/` are stored in plain text. Ensure appropriate operating system file permissions.

---

## License

Private & Proprietary / MIT License. Refer to repository terms for details.
