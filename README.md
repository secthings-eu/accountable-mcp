# accountable-mcp

An unofficial [MCP](https://modelcontextprotocol.io) server plus Claude Code skills for doing your
bookkeeping in [Accountable](https://www.accountable.eu) (BE/DE freelancer & company accounting)
with an AI agent — safely.

- **The MCP server** gives the agent typed tools for expenses, bank transactions, revenues, taxes,
  and for fetching and importing supplier invoices (Gmail, shop accounts, receipt photos).
- **The skills** tell the agent *how* to use them: a setup/login skill and a bookkeeping
  methodology skill that encode the rules learned on real data (automatch corrections, VAT
  treatments, duplicates, foreign currency, refunds…).
- **Security model**: the agent never sees a password, token or 2FA code. Logins happen in a
  browser window the user controls; a password manager can hand credentials straight to the
  browser; captchas and 2FA stay human.

Accountable has no public API: endpoints were reverse-engineered from the web app (`docs/api/*.md`),
are undocumented, may change at any time, and their use is subject to Accountable's terms. This project
is not affiliated with Accountable.

## What it does

| Goal | How |
|---|---|
| Reconcile a quarter: every bank movement linked to a document or classified | `accountable_list_transactions`, `accountable_link_transaction`, `accountable_classify_transaction`, corrections of shifted/automatched links |
| Keep expenses clean | `accountable_update_expense` (supplier, VAT rate/regime, `is_invoice`, `eur_amount` for foreign currency, validates "Revoir" items), `accountable_delete_expense` for duplicates |
| Get the missing invoices | provider modules: Gmail attachments / HTML receipts, AliExpress (merged receipts per checkout), macOS Photos receipts; `accountable_fetch_invoices` → `accountable_import_invoices` (upload + OCR + link to the bank payment) |
| Log in without exposing credentials | `accountable_login_start/fill/check/cancel`: Camoufox window per site, optional Bitwarden → browser hand-off |
| Overview | `accountable_get_account_overview`, `accountable_get_tax_overview`, `accountable_list_suppliers` |

## Quick start

```bash
git clone https://github.com/secthings-eu/accountable-mcp.git && cd accountable-mcp
./scripts/setup.sh      # Node ≥ 20 check, npm install (+ Camoufox engine, one time), build, then registers the
                        # server in Claude Code, Claude Desktop or both (--target code|desktop|both, or interactive)
```

Then in Claude Code (the skills are picked up automatically when the folder is open, or after
`claude mcp add` from anywhere):

```
accountable_login_start  {site: "accountable"}     → a Camoufox window opens, sign in there
accountable_login_check  {site: "accountable"}     → "logged_in": session stored, renews itself
accountable_session_status
accountable_learn_suppliers / accountable_propose_providers   → evidence; the agent reviews and saves what you approve
```

Optional: Gmail (`google-oauth.json` + `accountable_login_start {site:"gmail"}`), AliExpress
(`{site:"aliexpress"}`), Bitwarden hand-off (`bw unlock --raw > ~/.config/accountable-mcp/bw-session`
then `accountable_login_fill`). Full detail in `.claude/skills/accountable-mcp-setup/SKILL.md`.

Everything is project-local (no global installs, no Chrome, no Python); runtime state lives in
`~/.config/accountable-mcp/`.

## Configuration with the agent in the loop

Supplier aliases and invoice-fetching modules are personal, so they live in
`~/.config/accountable-mcp/providers.json`, not in the repo — and they are built *with* the agent rather
than by a heuristic: extraction tools return evidence (`accountable_learn_suppliers` from your linked
payments, `accountable_propose_providers` from your hand-added expenses, `accountable_gmail_search` to test
a query), the agent reviews it following the setup skill's rules and asks you when unsure, and save tools
write only the approved entries. Contradictory links surface as `conflicts` to fix in Accountable.

## Skills shipped in this repo

| Skill | Purpose |
|---|---|
| `.claude/skills/accountable-mcp-setup` | Prerequisites, install, registration, every login path (Accountable/Camoufox, Bitwarden, Gmail OAuth, AliExpress, Photos), where state lives, troubleshooting table, hard rules on credentials |
| `.claude/skills/accountable-bookkeeping` | Reconciliation methodology: measure the backlog → link existing documents → fetch/import missing ones → classify what never has a document → VAT/flag quality → document-less expenses → duplicates → closing report; plus the gotchas learned on real data |

`scripts/setup.sh` installs them: for Claude Code they are symlinked into `~/.claude/skills/` (available in
every project, kept current by `git pull`); for Claude Desktop, which has no skill files, it generates
`~/.config/accountable-mcp/claude-desktop-instructions.md` (and copies it to the clipboard on macOS) to paste
into the Project's custom instructions. They are also auto-discovered when the repository folder is open.

## Tools

| Tool | Kind |
|---|---|
| `accountable_session_status` | read |
| `accountable_login_start` / `_check` / `_cancel` (sites: accountable, aliexpress, gmail) | setup |
| `accountable_login_fill`, `accountable_bitwarden_items` (Bitwarden `bw` → camofox; no secrets reach the agent) | setup |
| `accountable_get_account_overview`, `accountable_get_tax_overview` | read |
| `accountable_list_expenses`, `accountable_get_expense`, `accountable_list_suppliers`, `accountable_search_expense_categories` | read |
| `accountable_create_expense_from_file` (S3 upload + OCR), `accountable_attach_expense_document` | write |
| `accountable_update_expense` (also validates; `eur_amount`; derives `taxPeriod` when required) | write |
| `accountable_delete_expense` (explicit `confirm`) | destructive |
| `accountable_list_transactions`, `accountable_get_transaction`, `accountable_suggest_transaction_classification` | read |
| `accountable_classify_transaction` (incl. tax periods), `accountable_link_transaction` (1 payment → N documents), `accountable_unlink_transaction_document`, `accountable_unclassify_transaction` | write |
| `accountable_list_revenues`, `accountable_get_revenue` | read |
| `accountable_list_invoice_providers`, `accountable_fetch_invoices`, `accountable_import_invoices` | invoices |
| `accountable_learn_suppliers` → `accountable_save_supplier_aliases`, `accountable_propose_providers` + `accountable_gmail_search` → `accountable_save_providers` (agent-reviewed configuration, stored locally) | setup |

All tools were verified live (test account for writes, then real data). Not implemented yet:
revenue creation, VAT return grids, exports, portal modules for suppliers without email invoices
(download by hand and import with `files`).

## Architecture

```
src/
  index.ts            MCP server (stdio) + CLI: login, browser-login <site> [--inject], gmail-login <mailbox>
  services/           auth (token refresh + Camoufox session pickup), API client, expense helpers, S3 upload
  tools/              one file per tool group (session, login, overview, expenses, transactions, revenues, invoices)
  invoices/
    providers.ts      generic supplier modules (gmail-attachment | gmail-html | browser | photos | portal)
    localConfig.ts    merges your own providers/aliases from ~/.config/accountable-mcp/providers.json
    fetch.ts          fetch + local ledger (~/.config/accountable-mcp/invoice-ledger.json)
    camofox.ts        the only browser: project-local camofox-browser server, one Camoufox profile per site,
                      idle-stopped; interactive login registry used by the login tools
    bitwarden.ts      bw CLI → camofox type endpoint (values never returned)
    gmail.ts          read-only Gmail client, PKCE loopback OAuth (begin/check/cancel for in-session use)
    aliexpress.ts     orders via AliExpress's signed mtop client in-page, receipts merged per checkout
    photos.ts         macOS Photos search ("VAT"/"TVA") + export, HEIC → JPEG
    render.ts         HTML → PDF (Camoufox full-page capture paginated to A4)
docs/api/             reverse-engineered API notes (auth, expenses, transactions, revenues, taxes)
.claude/skills/       the two skills
scripts/setup.sh      one-shot setup
.mcp.json             project-scoped registration for Claude Code
```

### Browser layer

[Camoufox](https://camoufox.com), a hardened Firefox build, via [camofox-browser](https://github.com/redf0x1/camofox-browser),
installed as a normal npm dependency. The server listens on `127.0.0.1:9378` (`ACCOUNTABLE_CAMOFOX_PORT`),
starts on demand and stops after 2 minutes idle. Each site gets an isolated profile under
`~/.config/accountable-mcp/camofox/profiles/<site>`. Headed mode is used only for interactive logins;
fetches run headless in the already-authenticated profile. Nothing is bypassed: Turnstile checks and 2FA
are completed by the human in the window, and site modules (e.g. AliExpress) only read the user's own
receipts from the user's own logged-in session.

### Credentials

- Accountable: session tokens only (`auth.json`, mode 600), refreshed by the MCP; when the refresh
  token dies, the MCP re-reads the session from its own Camoufox profile. No password is stored.
- Bitwarden hand-off: the user runs `bw unlock --raw > ~/.config/accountable-mcp/bw-session`; the MCP
  spawns `bw get item` and sends username/password to camofox's type endpoint. Nothing is logged or
  returned. Second factors are never filled by the MCP.
- Gmail: read-only scope, your own OAuth client, tokens in `gmail-<mailbox>.json`.

## API notes (the ones that bite)

- Single-resource GETs are wrapped: `GET /v3/expenses/:id` → `{expense}`.
- `PUT /v3/expenses/:id` body is `{expense, options:{update_tax_status}}`; `expense.user` snapshot and
  `period` are required; rates are fractions (0.21). Saving validates (clears "Revoir"). Tax-type
  categories (social contributions) also need `taxPeriod`.
- `POST /v3/expenses` (document-less expense) needs `file: null`, `items[0]._id: null`, `user`.
- Transactions are classified/linked by PUTting the whole transaction (`transactionCategory`,
  `matchedItems`); links replace the list. Revenue amounts are ×1000.
- Expense lists filtered by `vat_period` drop "Revoir" expenses; use date ranges.
- Accountable's server-side **automatch** links a new expense to *any* same-amount payment (wrong
  month, other supplier); the importer waits for it and moves the link.

More in `docs/api/`.

## Development

```bash
npm run dev             # tsc --watch
npm run build
node dist/index.js      # stdio MCP server
```

After a rebuild, restart the server from Claude Code (`/mcp`) or Claude Desktop. Provider modules are
declarative: the repo ships generic ones (`src/invoices/providers.ts`); add your own suppliers and name
aliases in `~/.config/accountable-mcp/providers.json` (format in `src/invoices/localConfig.ts`) — they are
merged at start-up, nothing personal needs to live in the repo.

## License

This project is **source-available** under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)
(see `LICENSE`).

- Free for personal, hobby, research, educational and nonprofit use.
- Commercial use is not permitted without a separate commercial license — contact julian@secthings.io.

Not affiliated with Accountable; use at your own risk, on your own account, with the write tools
pointed at a test account first.
