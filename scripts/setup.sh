#!/usr/bin/env bash
# One-shot setup: dependencies (incl. the Camoufox engine), build, config dir, and registration of the
# MCP server in Claude Code and/or Claude Desktop. Idempotent; re-run any time. Never asks for or stores credentials.
#
#   ./scripts/setup.sh [--target code|desktop|both] [--skip-install]
#
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG_DIR="${ACCOUNTABLE_CONFIG_DIR:-$HOME/.config/accountable-mcp}"
TARGET=""
SKIP_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    -h|--help) sed -n 2,6p "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/4  Checking prerequisites"
command -v node >/dev/null || { echo "Node.js >= 20 is required (https://nodejs.org)."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js >= 20 required, found $(node -v)."; exit 1; }
NODE_BIN="$(command -v node)"
echo "node $(node -v) at $NODE_BIN, npm $(npm -v)"
case "$(uname -s)" in
  Darwin) echo "macOS: Photos-library receipts supported; Camoufox engine cache in ~/Library/Caches/camoufox";;
  Linux)  echo "Linux: all features except the Photos-library provider";;
  *)      echo "Unsupported OS for the browser layer (headed Camoufox window); continuing anyway";;
esac

if [ "$SKIP_INSTALL" = 0 ]; then
  say "2/4  Installing dependencies and building"
  npm install            # camofox-browser's postinstall fetches the Camoufox engine (~2.5 GB, one time)
  npx camoufox-js fetch >/dev/null 2>&1 || true   # no-op when already cached
  npm run build
else
  say "2/4  Skipping install/build (--skip-install)"
fi

say "3/4  Preparing config directory"
mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
echo "$CONFIG_DIR (sessions, Camoufox profiles, invoice ledger, your providers.json)"

say "4/4  Registering the MCP server"
if [ -z "$TARGET" ]; then
  if [ -t 0 ]; then
    echo "Where do you want to use it?  [1] Claude Code  [2] Claude Desktop  [3] both  (default 1)"
    read -r -p "> " choice
    case "${choice:-1}" in 2) TARGET=desktop ;; 3) TARGET=both ;; *) TARGET=code ;; esac
  else
    TARGET=code
  fi
fi

ENTRY="$PWD/dist/index.js"

register_code() {
  if command -v claude >/dev/null; then
    if claude mcp get accountable >/dev/null 2>&1; then
      echo "Claude Code: already registered (claude mcp get accountable)"
    else
      claude mcp add --scope user accountable -- "$NODE_BIN" "$ENTRY" && echo "Claude Code: registered 'accountable' (user scope)"
    fi
  else
    echo "Claude Code: 'claude' CLI not found. Register manually:"
    echo "  claude mcp add --scope user accountable -- $NODE_BIN $ENTRY"
    echo "  (or open this folder in Claude Code: .mcp.json registers it at project scope)"
  fi
}

register_desktop() {
  local cfg="${CLAUDE_DESKTOP_CONFIG:-}"
  if [ -z "$cfg" ]; then
    case "$(uname -s)" in
      Darwin) cfg="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
      Linux)  cfg="$HOME/.config/Claude/claude_desktop_config.json" ;;
      *)      cfg="${APPDATA:-$HOME}/Claude/claude_desktop_config.json" ;;
    esac
  fi
  mkdir -p "$(dirname "$cfg")"
  # Merge (never overwrite other servers). Absolute node path: GUI apps do not inherit the shell PATH.
  CFG="$cfg" NODE_BIN="$NODE_BIN" ENTRY="$ENTRY" node -e '
    const fs = require("fs"); const p = process.env.CFG;
    let j = {}; try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    j.mcpServers = j.mcpServers || {};
    j.mcpServers.accountable = { command: process.env.NODE_BIN, args: [process.env.ENTRY] };
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    console.log("Claude Desktop: wrote " + p + " (restart Claude Desktop to load it)");'
  echo "Claude Desktop: skills are a Claude Code feature; for Desktop, paste the relevant SKILL.md into the project instructions."
}

case "$TARGET" in
  code) register_code ;;
  desktop) register_desktop ;;
  both) register_code; register_desktop ;;
  *) echo "invalid --target '$TARGET' (code|desktop|both)"; exit 1 ;;
esac

cat <<EOT

Done. Next, from inside Claude Code (recommended) or a terminal:
  - Accountable login:  tools accountable_login_start / accountable_login_fill / accountable_login_check
                        or  npm run login:accountable
  - Gmail (optional):   put a Google OAuth "Desktop app" client JSON at $CONFIG_DIR/google-oauth.json,
                        then npm run login:gmail -- work
  - AliExpress (opt.):  npm run login:aliexpress
  - Learn your suppliers (after the Accountable login): tool accountable_learn_suppliers  or  npm run learn-suppliers
                        → writes name aliases learned from your linked payments to $CONFIG_DIR/providers.json
  - Your own providers: $CONFIG_DIR/providers.json (see src/invoices/localConfig.ts for the format)
Skills shipped with this repo (auto-discovered by Claude Code when the folder is open):
  .claude/skills/accountable-mcp-setup   — installation, logins, troubleshooting
  .claude/skills/accountable-bookkeeping — quarterly reconciliation methodology
EOT
