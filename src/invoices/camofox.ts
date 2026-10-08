import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../constants.js";

/**
 * The only browser this MCP uses: Camoufox, through the project-local `camofox-browser` REST server.
 *
 * Isolation: every site gets its own Firefox profile (camofox `userId` = site name) under
 * `<CONFIG_DIR>/camofox/profiles/<site>`, and the server listens on a dedicated loopback port so it
 * never shares state with another camofox instance on the machine.
 *
 * Credentials never pass through this process: the user logs in themselves in the headed window
 * (optionally letting camofox's own encrypted vault fill the form via `--inject`) and completes
 * any check the site shows. Afterwards this module only drives the already-authenticated profile.
 *
 * The server is started on demand and stopped again after 2 minutes without use (or at exit).
 */

const require = createRequire(import.meta.url);
const PKG_DIR = dirname(require.resolve("camofox-browser/package.json"));
const SERVER_ENTRY = join(PKG_DIR, "dist/src/server.js");
const CLI_ENTRY = join(PKG_DIR, "bin/camofox.js");

export const CAMOFOX_DIR = join(CONFIG_DIR, "camofox");
const PROFILES_DIR = join(CAMOFOX_DIR, "profiles");
const PORT = Number(process.env.ACCOUNTABLE_CAMOFOX_PORT ?? 9378);
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_STOP_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Server lifecycle (one per process; idle-stopped)

let child: ChildProcess | null = null;
let log: FileHandle | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let starting: Promise<void> | null = null;

function killServer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  child?.kill();
  child = null;
  void log?.close();
  log = null;
}

process.on("exit", killServer);

async function startServer(): Promise<void> {
  if (await healthy()) return; // already running (ours from an earlier call, or started by hand)
  await mkdir(PROFILES_DIR, { recursive: true, mode: 0o700 });
  log = await open(join(CAMOFOX_DIR, "server.log"), "a");
  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      CAMOFOX_HOST: "127.0.0.1",
      PORT: String(PORT),
      CAMOFOX_PROFILES_DIR: PROFILES_DIR,
      CAMOFOX_HEADLESS: "true",
      // htmlToPdf serves pages from a loopback http server; the camofox server itself is loopback-only.
      CAMOFOX_ALLOW_PRIVATE_NETWORK: "true",
    },
    stdio: ["ignore", log.fd, log.fd],
  });
  const deadline = Date.now() + 90_000;
  while (!(await healthy())) {
    if (child.exitCode !== null || Date.now() > deadline) {
      killServer();
      throw new Error(`camofox server did not start on ${BASE}; see ${join(CAMOFOX_DIR, "server.log")}`);
    }
    await sleep(500);
  }
}

/** Make sure the server is up; call `release()` when done so it can idle-stop. */
export async function acquireServer(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!starting) starting = startServer().finally(() => (starting = null));
  await starting;
}

export function releaseServer(): void {
  if (!child) return; // not ours to stop
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(killServer, IDLE_STOP_MS);
  idleTimer.unref();
}

// ---------------------------------------------------------------------------------------------
// Per-site client

/** Thin client for one site's isolated profile. */
export class CamofoxSite {
  constructor(readonly site: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`camofox ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async openTab(url: string): Promise<string> {
    const r = await this.call<{ tabId: string }>("POST", "/tabs", { userId: this.site, sessionKey: this.site, url });
    return r.tabId;
  }

  async navigate(tabId: string, url: string): Promise<void> {
    await this.call("POST", `/tabs/${tabId}/navigate`, { userId: this.site, url });
  }

  /** DOM ready (+ network idle). Resolves false on timeout instead of throwing. */
  async wait(tabId: string, timeout = 15_000, waitForNetwork = true): Promise<boolean> {
    const r = await this.call<{ ready: boolean }>("POST", `/tabs/${tabId}/wait`, { userId: this.site, timeout, waitForNetwork }).catch(() => ({ ready: false }));
    return r.ready;
  }

  /** `expression` must evaluate to a JSON-serialisable value (async IIFEs are fine). */
  async evaluate<T>(tabId: string, expression: string, timeout?: number): Promise<T> {
    const long = timeout !== undefined && timeout > 30_000;
    const r = await this.call<{ ok: boolean; result: T; truncated?: boolean }>(
      "POST",
      `/tabs/${tabId}/evaluate${long ? "-extended" : ""}`,
      { userId: this.site, expression, ...(timeout !== undefined ? { timeout } : {}) },
    );
    if (r.truncated) throw new Error("camofox evaluate result was truncated; fetch it in chunks.");
    return r.result;
  }

  /**
   * Evaluate an expression whose JSON result may be large: it is kept in the page and read back in
   * chunks so the server's result cap does not apply.
   */
  async evaluateLarge<T>(tabId: string, expression: string, timeout = 120_000): Promise<T> {
    const key = `__accountableMcp_${Date.now()}`;
    await this.evaluate<number>(tabId, `(async () => { const v = await (${expression}); window["${key}"] = JSON.stringify(v); return window["${key}"].length; })()`, timeout);
    const chunk = 200_000;
    let out = "";
    for (let i = 0; ; i += chunk) {
      const part = await this.evaluate<string | null>(tabId, `window["${key}"].slice(${i}, ${i + chunk}) || null`);
      if (!part) break;
      out += part;
    }
    await this.evaluate(tabId, `delete window["${key}"], true`).catch(() => undefined);
    return JSON.parse(out) as T;
  }

  async url(tabId: string): Promise<string> {
    return this.evaluate<string>(tabId, "location.href");
  }

  async type(tabId: string, ref: string, text: string): Promise<void> {
    await this.call("POST", `/tabs/${tabId}/type`, { userId: this.site, ref, text });
  }

  async press(tabId: string, key: string): Promise<void> {
    await this.call("POST", `/tabs/${tabId}/press`, { userId: this.site, key });
  }

  async click(tabId: string, ref: string): Promise<void> {
    await this.call("POST", `/tabs/${tabId}/click`, { userId: this.site, ref });
  }

  async snapshot(tabId: string): Promise<string> {
    const r = await this.call<{ snapshot: string }>("GET", `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(this.site)}`);
    return r.snapshot;
  }

  async screenshot(tabId: string, fullPage = true): Promise<Buffer> {
    const res = await fetch(`${BASE}/tabs/${tabId}/screenshot?userId=${encodeURIComponent(this.site)}&fullPage=${fullPage}`);
    if (!res.ok) throw new Error(`camofox screenshot: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async closeTab(tabId: string): Promise<void> {
    await this.call("DELETE", `/tabs/${tabId}`, { userId: this.site }).catch(() => undefined);
  }

  /** Switching display mode relaunches the profile's browser; open tabs are invalidated. */
  async setHeadless(headless: boolean): Promise<void> {
    await this.call("POST", `/sessions/${encodeURIComponent(this.site)}/toggle-display`, { headless });
  }

  async close(): Promise<void> {
    await this.call("DELETE", `/sessions/${encodeURIComponent(this.site)}`).catch(() => undefined);
  }
}

/** Run `fn` against a site's profile with the server up, then close the profile's browser. */
export async function withSite<T>(site: string, fn: (c: CamofoxSite) => Promise<T>, opts: { headed?: boolean } = {}): Promise<T> {
  await acquireServer();
  const c = new CamofoxSite(site);
  try {
    if (opts.headed) await c.setHeadless(false);
    return await fn(c);
  } finally {
    await c.close();
    releaseServer();
  }
}

// ---------------------------------------------------------------------------------------------
// Interactive logins driven from MCP tools (start → user signs in → check), one pending per site.

interface PendingLogin {
  c: CamofoxSite;
  tab: string;
  startedAt: number;
}
const pending = new Map<string, PendingLogin>();

/** Open a visible window on `loginUrl` for the site's profile and keep it until finish/cancel. */
export async function startLogin(site: string, loginUrl: string): Promise<PendingLogin> {
  if (pending.has(site)) await finishLogin(site);
  await acquireServer();
  const c = new CamofoxSite(site);
  try {
    await c.setHeadless(false);
    const tab = await c.openTab(loginUrl);
    const p = { c, tab, startedAt: Date.now() };
    pending.set(site, p);
    return p;
  } catch (err) {
    await c.close();
    releaseServer();
    throw err;
  }
}

export function pendingLogin(site: string): PendingLogin | null {
  return pending.get(site) ?? null;
}

/** Close the site's window (success or cancel) and let the server idle-stop. */
export async function finishLogin(site: string): Promise<void> {
  const p = pending.get(site);
  if (!p) return;
  pending.delete(site);
  await p.c.close();
  releaseServer();
}

// ---------------------------------------------------------------------------------------------
// Accountable session

const ACCOUNTABLE = "https://web.accountable.eu";
export type StoredAuth = { access_token: string; [key: string]: unknown };

async function pageState(c: CamofoxSite, tab: string): Promise<{ url: string; auth: StoredAuth | null }> {
  const raw = await c.evaluate<string>(tab, `JSON.stringify({ url: location.href, auth: localStorage.getItem("auth") })`);
  const s = JSON.parse(raw) as { url: string; auth: string | null };
  let auth: StoredAuth | null = null;
  try {
    const parsed = s.auth ? (JSON.parse(s.auth) as StoredAuth) : null;
    auth = parsed && typeof parsed.access_token === "string" ? parsed : null;
  } catch {
    auth = null;
  }
  return { url: s.url, auth };
}

const onLoginPage = (url: string) => /\/(login|signup|reset)/i.test(url);

/** Wait for the web app to settle on a logged-in route and hand back its `localStorage.auth`. */
async function awaitSession(c: CamofoxSite, tab: string, timeoutMs: number): Promise<StoredAuth | null> {
  const probe = timeoutMs <= 30_000; // headless check vs. interactive login
  const start = Date.now();
  for (;;) {
    const s = await pageState(c, tab).catch(() => null);
    if (s?.auth && !onLoginPage(s.url)) {
      await sleep(2000); // let the app finish its own token refresh after navigation
      return (await pageState(c, tab)).auth ?? s.auth;
    }
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) return null;
    if (probe && s && onLoginPage(s.url) && !s.auth && elapsed > 5000) return null; // not logged in
    await sleep(probe ? 1000 : 3000);
  }
}

/** Poll the pending Accountable login window; returns the session once the user is signed in. */
export async function checkAccountableLogin(): Promise<{ auth: StoredAuth | null; url: string }> {
  const p = pending.get("accountable");
  if (!p) throw new Error("No Accountable login in progress; call accountable_login_start first.");
  const s = await pageState(p.c, p.tab);
  if (!s.auth || onLoginPage(s.url)) return { auth: null, url: s.url };
  await sleep(2000); // let the app finish its own token refresh after navigation
  const auth = (await pageState(p.c, p.tab)).auth ?? s.auth;
  await finishLogin("accountable");
  return { auth, url: s.url };
}

/** Headless: reuse the saved profile to pick up a current session. Null means the user must log in again. */
export function accountableSessionFromCamofox(): Promise<StoredAuth | null> {
  return withSite("accountable", async (c) => awaitSession(c, await c.openTab(`${ACCOUNTABLE}/`), 20_000));
}

/**
 * Let camofox fill email/password from its own encrypted vault profile "accountable"
 * (`npx camofox auth save accountable`). The vault master password is prompted on the user's
 * terminal; nothing is read by this process. The user still clicks "Sign in" themselves.
 */
/** Element refs of the email/password fields in an accessibility snapshot (`textbox "…" [eN]`). */
export function findLoginRefs(snapshot: string): { user?: string; pass?: string; code?: string } {
  const ref = (re: RegExp) =>
    snapshot
      .split("\n")
      .find((l) => /textbox/i.test(l) && re.test(l))
      ?.match(/\[(e\d+)\]/)?.[1];
  return {
    user: ref(/e-?mail|courriel|account|username|login/i),
    pass: ref(/password|mot de passe|wachtwoord/i),
    code: ref(/code|totp|authenticat|verification|vérification|verificatie/i),
  };
}

async function injectFromVault(c: CamofoxSite, tab: string): Promise<void> {
  const { user, pass } = findLoginRefs(await c.snapshot(tab));
  if (!user || !pass) throw new Error("Could not find the email/password fields on the login page for --inject.");
  process.stdout.write('Filling the form from camofox\'s vault profile "accountable" (enter the vault master password below).\n');
  await new Promise<void>((resolve, reject) => {
    const args = ["auth", "load", "accountable", "--inject", tab, "--username-ref", user, "--password-ref", pass, "--user", "accountable", "--port", String(PORT)];
    const ch = spawn(process.execPath, [CLI_ENTRY, ...args], { stdio: "inherit" });
    ch.on("error", reject);
    ch.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`camofox auth load exited with ${code}`))));
  });
}

/** Interactive: headed Camoufox window on the login page; resolves once the user is logged in. */
export function accountableLogin(opts: { inject?: boolean } = {}): Promise<StoredAuth> {
  return withSite(
    "accountable",
    async (c) => {
      const tab = await c.openTab(`${ACCOUNTABLE}/login`);
      process.stdout.write(
        "A Camoufox window opened on web.accountable.eu. Log in there yourself (Bitwarden autofill/paste is fine)\n" +
          "and complete any check the page shows. Waiting up to 10 minutes…\n",
      );
      if (opts.inject) await injectFromVault(c, tab);
      const auth = await awaitSession(c, tab, 10 * 60_000);
      if (!auth) throw new Error("Timed out waiting for the Accountable login.");
      return auth;
    },
    { headed: true },
  );
}
