---
name: accountable-mcp-setup
description: Install, build, register and log in the Accountable MCP server (Camoufox browser sessions, Bitwarden hand-off, Gmail, AliExpress, Photos). Use after cloning the repo, when adding the MCP to Claude Code, when a tool reports "Not logged in" / "Refresh token expired" / "AliExpress session expired" / "Gmail is not set up", or when the camofox server will not start.
---

# Accountable MCP — setup and logins

The server lives in this repo (`src/`, built to `dist/`). Everything is project-local, like a `uv`
project: `npm install` brings the MCP SDK, `camofox-browser` (a hardened Firefox build driven over a
local REST server) and `pdf-lib`. No global installs, no Chrome, no Python.

## Hard rules for the agent

1. Never type, paste, read or print a password, OTP, 2FA code, vault master password or API token.
   The user signs in themselves in the Camoufox window the login tools open.
2. Credentials may flow **password manager → browser** without passing through the agent:
   `accountable_login_fill` makes the Bitwarden CLI hand the vault item to camofox's type endpoint.
   The agent only sees the item name and a masked username. Never run `bw unlock`,
   `bw get password`, `npx camofox auth save` or anything that would print a secret.
3. Never print `~/.config/accountable-mcp/auth.json`, `bw-session`, `gmail-*.json` or camofox vault
   files, and never commit them.
4. A captcha / security check / 2FA prompt is completed by the user in the window. Do not try to
   automate it. Tell the user what the page is waiting for (the `check` tool returns the current URL).
5. After `npm run build`, the running MCP keeps the old code: ask the user to restart it from `/mcp`.
   Restarting closes any pending login window; start the login again afterwards.

## 0. Quick path

```bash
./scripts/setup.sh --target code      # or desktop | both; prompts when omitted
```

It checks prerequisites, runs `npm install` (+ Camoufox engine), builds, creates the config dir and
registers the server in Claude Code (`claude mcp add`, user scope) and/or Claude Desktop
(`claude_desktop_config.json`, merged, absolute node path).

Then, inside Claude Code: `accountable_login_start` (site `accountable`) → the user signs in (or
`accountable_login_fill` from Bitwarden) → `accountable_login_check` until `logged_in` →
`accountable_session_status` to confirm. Everything below is the detail of those steps.

## 1. Prerequisites

| Need | Why | Check |
|---|---|---|
| Node.js ≥ 20 | runtime | `node -v` |
| ~2.5 GB disk | Camoufox engine, cached once in `~/Library/Caches/camoufox` (macOS) / `~/.cache/camoufox` (Linux) | — |
| macOS or Linux | Camoufox headed window for logins (Windows: headless only) | `uname -s` |
| Optional: Bitwarden CLI `bw`, logged in | password → browser hand-off | `bw status` |
| Optional: Google Cloud OAuth "Desktop app" client | Gmail invoice fetching | file at `~/.config/accountable-mcp/google-oauth.json` |
| Optional: macOS Photos library | receipt photos provider | — |

## 2. Install and build

```bash
cd <repo>
npm install          # camofox-browser's postinstall runs `npx camoufox-js fetch` (engine download, one time)
npm run build        # tsc → dist/
```

- Engine missing or download interrupted: `npx camoufox-js fetch`.
- `npm run dev` = `tsc --watch`.
- Nothing is read from or written to the repo at runtime; all state is in `~/.config/accountable-mcp/`
  (override with `ACCOUNTABLE_CONFIG_DIR`).

## 3. Register the MCP (Claude Code and/or Claude Desktop)

Claude Desktop: `./scripts/setup.sh --target desktop` (or `both`) merges an `accountable` entry into
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `~/.config/Claude/…` (Linux);
restart Claude Desktop. Skills are not loaded by Desktop — paste the relevant SKILL.md into the project
instructions there.

Claude Code, two ways; the setup script does the first:

```bash
claude mcp add --scope user accountable -- node <abs-path-to-repo>/dist/index.js   # available in every project
```

or open the repo folder in Claude Code: the shipped `.mcp.json` registers `accountable` at project
scope (`node dist/index.js`, cwd = repo). Verify with `/mcp`; tools are prefixed `accountable_`.

## 4. Accountable session (Camoufox profile `accountable`)

Accountable's password login is protected by a Cloudflare Turnstile check and may ask for a TOTP
second factor, so there is no scripted login. The MCP keeps its own Camoufox profile; the user signs
in there once, and the MCP then renews tokens itself.

### In-session (preferred)

1. `accountable_login_start` `{site: "accountable"}` → a visible Camoufox window opens on
   `web.accountable.eu/login`; the tool clicks the first field so the window has keyboard focus.
2. Either the user types (Bitwarden autofill / paste), or — if the user asked for it and Bitwarden is
   unlocked for the MCP — `accountable_login_fill` `{site: "accountable"}`:
   - optional `bitwarden_item` (id or exact name) when several vault items match; list them with
     `accountable_bitwarden_items`;
   - it types username + password and presses Enter; the user handles Turnstile and 2FA (the MCP never
     fills a second factor).
3. `accountable_login_check` `{site: "accountable"}` every ~10 s (ask the user to say when done):
   - `waiting` + `current_url` ending in `/login/totp` → the user must enter the authenticator code;
   - `logged_in` → session saved to `auth.json`, window closed.
4. `accountable_session_status` → `access_token_expires_in_s` > 0 and `has_refresh_token: true`.
5. `accountable_login_cancel` closes the window without saving.

### Bitwarden unlock (user only, once per session)

```bash
bw unlock --raw > ~/.config/accountable-mcp/bw-session && chmod 600 ~/.config/accountable-mcp/bw-session
```

`bw lock` or deleting the file revokes it. The agent never runs this.

### Terminal alternatives

- `npm run login:accountable` — same headed window, blocking, exits when logged in.
- `npm run login:accountable -- --inject` — fills from camofox's own encrypted vault
  (`npx camofox auth save accountable --url https://web.accountable.eu`, user-managed; master
  password prompted in the terminal).
- `npm run login` — paste `copy(localStorage.auth)` from a logged-in Accountable tab (no browser).

### How renewal works

- Access tokens are refreshed via `POST /v2/users/refresh-access-token` before expiry.
- When the refresh token is dead (~1 day) the MCP opens the `accountable` profile headless, lets the
  web app refresh its own session and reads `localStorage.auth`. No credentials involved.
- Only if Accountable logged that profile out does the user see "Refresh token expired … run
  browser-login" → repeat the in-session login.

## 4b. Learn the user's suppliers (once logged in)

Call `accountable_learn_suppliers` (default: links since 1 January of last year; `dry_run: true` to only
propose). It reads bank transactions already linked to expenses and stores "bank text → supplier" aliases
in `~/.config/accountable-mcp/providers.json` (`learned_aliases`), which the importer's payment matching
and the coverage reports use. Show the user the proposed list; prune odd ones by editing the file.
Re-run after a reconciliation pass so new suppliers are picked up. Restart the MCP afterwards.

## 5. Gmail (invoice fetching, read-only)

1. Google Cloud console → project → enable **Gmail API**.
2. OAuth consent screen: *Internal* for a Workspace mailbox; *External* + the address as test user
   for a personal @gmail.com.
3. Credentials → OAuth client ID → **Desktop app** → download JSON to
   `~/.config/accountable-mcp/google-oauth.json`.
4. In-session: `accountable_login_start` `{site: "gmail", mailbox: "work"}` (consent page opens in
   the system browser; the MCP's loopback server receives the code) → `accountable_login_check`.
   Terminal: `npm run login:gmail -- work`. Mailbox names are free (`work`, `personal`); providers
   declare which mailbox they search.
5. Tokens: `~/.config/accountable-mcp/gmail-<mailbox>.json`. Scope: `gmail.readonly`.

## 6. AliExpress (Camoufox profile `aliexpress`)

`accountable_login_start` `{site: "aliexpress"}` → the user logs in on the orders page →
`accountable_login_check`. Terminal: `npm run login:aliexpress`. Receipts are then fetched headless
through AliExpress's own signed `mtop` client inside that profile.

## 7. Receipt photos (macOS only)

Provider `photos-receipts` searches the Photos library for "VAT"/"TVA" through Photos.app scripting.
The first `accountable_fetch_invoices` run triggers a macOS prompt "… wants to control Photos" that
the user must accept. No login needed.

## 8. Verify end to end

1. `accountable_session_status` → valid.
2. `accountable_get_account_overview` → the right company (check the email/VAT number before any write).
3. `accountable_list_invoice_providers` → readiness per provider.
4. `accountable_fetch_invoices` for a short range → files land in `~/Documents/Invoices/<provider>/`.

## Where things live

| What | Path |
|---|---|
| Accountable session | `~/.config/accountable-mcp/auth.json` (0600) |
| Bitwarden CLI session key (user-written, optional) | `~/.config/accountable-mcp/bw-session` (0600) |
| Camoufox profiles, one per site (`accountable`, `aliexpress`, `render`) | `~/.config/accountable-mcp/camofox/profiles/<site>` |
| camofox server log | `~/.config/accountable-mcp/camofox/server.log` |
| Gmail OAuth client / tokens | `~/.config/accountable-mcp/google-oauth.json`, `gmail-<mailbox>.json` |
| Invoice ledger (what was fetched/imported) | `~/.config/accountable-mcp/invoice-ledger.json` |
| Your own providers and supplier aliases | `~/.config/accountable-mcp/providers.json` (format: `src/invoices/localConfig.ts`) |
| Downloaded invoices | `~/Documents/Invoices/<provider>/` (`ACCOUNTABLE_INVOICE_DIR`) |
| camofox port | `127.0.0.1:9378` (`ACCOUNTABLE_CAMOFOX_PORT`) |

The camofox server is started on demand by the MCP/CLI and stopped after 2 minutes idle (and at
process exit). Profiles are strictly per site; never reuse one site's profile for another.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Not logged in to Accountable` | step 4 |
| `Refresh token expired …` and no headless pickup | the Camoufox profile was logged out → step 4 |
| `camofox server did not start` | read `camofox/server.log`; port busy → `ACCOUNTABLE_CAMOFOX_PORT`; engine missing → `npx camoufox-js fetch` |
| Login window does not accept keystrokes | focus: call `accountable_login_fill` (it clicks the field) or click into the field; on macOS the window may be behind others |
| `current_url` ends with `/login/totp` | user enters the authenticator code in the window |
| `Bitwarden is locked for the MCP` | user runs the `bw unlock --raw > …` line above |
| `N Bitwarden items match …` | pass `bitwarden_item` (see `accountable_bitwarden_items`) |
| `AliExpress session expired or blocked` | step 6 |
| `Gmail is not set up` | step 5 |
| `… wants to control Photos` prompt never appeared / denied | System Settings → Privacy & Security → Automation → allow the terminal/Claude for Photos |
| Tools missing or old behaviour after a rebuild | `/mcp` → restart `accountable` |
| HTTP 403 `step_up_required` on a write | Accountable asks for an email OTP for that action; do it once in the web app, retry |

## Related

- `.claude/skills/accountable-bookkeeping` — how to use the tools to reconcile a quarter.
- [camofox-mcp](https://github.com/redf0x1/camofox-mcp): separate MCP exposing Camoufox browsing as
  agent tools; it runs its own server/profiles, keep it separate so site sessions stay isolated.
