import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BROWSER_SITES, checkSiteLogin, requireSite } from "../invoices/browser.js";
import { checkAccountableLogin, findLoginRefs, finishLogin, pendingLogin, startLogin } from "../invoices/camofox.js";
import { bwStatus, fillFromBitwarden, listItemsForUrl } from "../invoices/bitwarden.js";
import { beginGmailLogin, checkGmailLogin, cancelGmailLogin } from "../invoices/gmail.js";
import { saveAuth, type AuthData } from "../services/auth.js";
import { run } from "../services/format.js";

/**
 * Login setups driven from inside the agent session: `start` opens a visible Camoufox window (or the
 * Google consent page) in which the USER signs in; `check` detects the signed-in state, stores the
 * session and closes the window. The MCP never handles credentials.
 */

const SITES = ["accountable", "aliexpress", "gmail"] as const;
const ACCOUNTABLE_LOGIN_URL = "https://web.accountable.eu/login";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function registerLoginTools(server: McpServer): void {
  server.registerTool(
    "accountable_login_start",
    {
      title: "Start a login (Accountable / AliExpress / Gmail)",
      description:
        "Open a visible Camoufox window on the site's login page (its own isolated profile) so the user can sign in " +
        "themselves — the agent must never type credentials. For site='gmail' it starts the Google OAuth consent flow " +
        "and returns the URL (opened in the system browser). Then poll accountable_login_check until it reports success.",
      inputSchema: {
        site: z.enum(SITES),
        mailbox: z.string().optional().describe("Gmail only: mailbox name, e.g. work or personal (default work)"),
      },
      annotations: WRITE,
    },
    async ({ site, mailbox }) =>
      run(async () => {
        if (site === "gmail") {
          const { authUrl, opened } = await beginGmailLogin(mailbox ?? "work");
          return {
            site,
            mailbox: mailbox ?? "work",
            status: "waiting_for_consent",
            auth_url: authUrl,
            opened_in_system_browser: opened,
            next: "Ask the user to grant access in the browser, then call accountable_login_check with site='gmail'.",
          };
        }
        const loginUrl = site === "accountable" ? ACCOUNTABLE_LOGIN_URL : requireSite(site).loginUrl;
        const p = await startLogin(site, loginUrl);
        // Headed Camoufox windows sometimes do not take keyboard focus until a field is clicked.
        try {
          const refs = findLoginRefs(await p.c.snapshot(p.tab));
          if (refs.user) await p.c.click(p.tab, refs.user);
        } catch {
          /* best effort */
        }
        return {
          site,
          status: "window_open",
          profile: site,
          login_url: loginUrl,
          since: new Date(p.startedAt).toISOString(),
          next: "Ask the user to sign in in the Camoufox window (password manager / paste / any security check), then call accountable_login_check.",
        };
      }),
  );

  server.registerTool(
    "accountable_login_check",
    {
      title: "Check a pending login",
      description:
        "Poll a login started with accountable_login_start. When the user is signed in, the session is saved " +
        "(Accountable token / Camoufox profile cookies / Gmail refresh token), the window is closed and status='logged_in'. " +
        "Otherwise status='waiting' — ask the user to finish signing in and call again (wait a few seconds between calls).",
      inputSchema: {
        site: z.enum(SITES),
        mailbox: z.string().optional().describe("Gmail only"),
      },
      annotations: WRITE,
    },
    async ({ site, mailbox }) =>
      run(async () => {
        if (site === "gmail") {
          const r = await checkGmailLogin(mailbox ?? "work");
          return { site, mailbox: mailbox ?? "work", ...r };
        }
        if (!pendingLogin(site)) return { site, status: "not_started", next: "Call accountable_login_start first." };
        if (site === "accountable") {
          const { auth, url } = await checkAccountableLogin();
          if (!auth) return { site, status: "waiting", current_url: url };
          await saveAuth(auth as AuthData);
          return { site, status: "logged_in", saved: "~/.config/accountable-mcp/auth.json", note: "Tokens renew automatically from now on." };
        }
        const { loggedIn, url } = await checkSiteLogin(site);
        return loggedIn
          ? { site, status: "logged_in", profile: site, note: `Camoufox profile "${site}" keeps the session for headless fetches.` }
          : { site, status: "waiting", current_url: url };
      }),
  );

  server.registerTool(
    "accountable_login_fill",
    {
      title: "Fill a pending login from Bitwarden",
      description:
        "Type username and password from the user's Bitwarden vault into the login window opened by accountable_login_start, " +
        "then press Enter. The `bw` CLI reads the item and camofox types it; the values never reach the agent. Requires the user " +
        "to have unlocked Bitwarden for the MCP (bw unlock --raw > ~/.config/accountable-mcp/bw-session). If several vault items " +
        "match the site, the names are returned so the user can pick one via bitwarden_item. Then poll accountable_login_check.",
      inputSchema: {
        site: z.enum(["accountable", "aliexpress"]),
        bitwarden_item: z.string().optional().describe("Bitwarden item id or exact name; default: the single item matching the site URL"),
        submit: z.boolean().default(true).describe("Press Enter after filling"),
      },
      annotations: WRITE,
    },
    async ({ site, bitwarden_item, submit }) =>
      run(async () => {
        const p = pendingLogin(site);
        if (!p) throw new Error("No login window open; call accountable_login_start first.");
        const url = site === "accountable" ? "https://web.accountable.eu" : requireSite(site).loginUrl;
        const refs = findLoginRefs(await p.c.snapshot(p.tab));
        if (!refs.user && !refs.pass && refs.code) {
          return { site, status: "second_factor_required", hint: "The page asks for a 2FA code; the user enters it in the window (never filled by the MCP)." };
        }
        if (!refs.user || !refs.pass) {
          return { site, status: "fields_not_found", hint: "The page may not be on the email+password step yet; ask the user, or let them type.", bitwarden: await bwStatus() };
        }
        const filled = await fillFromBitwarden(p.c, p.tab, { url, item: bitwarden_item, userRef: refs.user, passRef: refs.pass });
        if (submit) await p.c.press(p.tab, "Enter");
        return { site, status: "filled", bitwarden_item: filled.item, username_hint: filled.username_hint, submitted: submit, next: "Poll accountable_login_check; the user handles any security check in the window." };
      }),
  );

  server.registerTool(
    "accountable_bitwarden_items",
    {
      title: "List Bitwarden items for a site (no secrets)",
      description: "Names/ids of vault items whose URL matches the site, to pick `bitwarden_item` for accountable_login_fill.",
      inputSchema: { site: z.enum(["accountable", "aliexpress"]) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ site }) =>
      run(async () => ({ site, bitwarden: await bwStatus(), items: await listItemsForUrl(site === "accountable" ? "https://web.accountable.eu" : requireSite(site).loginUrl) })),
  );

  server.registerTool(
    "accountable_login_cancel",
    {
      title: "Cancel a pending login",
      description: "Close the login window / abandon the Gmail consent flow without saving anything.",
      inputSchema: { site: z.enum(SITES), mailbox: z.string().optional() },
      annotations: WRITE,
    },
    async ({ site, mailbox }) =>
      run(async () => {
        if (site === "gmail") {
          cancelGmailLogin(mailbox ?? "work");
          return { site, status: "cancelled" };
        }
        const was = pendingLogin(site) !== null;
        await finishLogin(site);
        return { site, status: was ? "cancelled" : "nothing_pending", known_sites: ["accountable", ...Object.keys(BROWSER_SITES), "gmail"] };
      }),
  );
}
