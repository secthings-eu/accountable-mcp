import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "../constants.js";

/**
 * Minimal read-only Gmail API client (no SDK).
 * One-time setup: create a Google Cloud OAuth client of type "Desktop app", download its JSON to
 * ~/.config/accountable-mcp/google-oauth.json, then run `accountable-mcp gmail-login <mailbox>`
 * for each mailbox (e.g. `work`, `personal`).
 */

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const OAUTH_FILE = join(CONFIG_DIR, "google-oauth.json");
const tokenFile = (mailbox: string) => join(CONFIG_DIR, `gmail-${mailbox}.json`);

interface ClientConfig {
  client_id: string;
  client_secret: string;
}

interface MailboxToken {
  email: string;
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
}

async function clientConfig(): Promise<ClientConfig> {
  let raw: string;
  try {
    raw = await readFile(OAUTH_FILE, "utf8");
  } catch {
    throw new Error(
      `Gmail is not set up: put a Google OAuth "Desktop app" client JSON at ${OAUTH_FILE}, then run \`accountable-mcp gmail-login <mailbox>\`.`,
    );
  }
  const json = JSON.parse(raw) as { installed?: ClientConfig; web?: ClientConfig } & Partial<ClientConfig>;
  const cfg = json.installed ?? json.web ?? (json as ClientConfig);
  if (!cfg.client_id || !cfg.client_secret) throw new Error(`${OAUTH_FILE} has no client_id/client_secret.`);
  return cfg;
}

async function saveToken(mailbox: string, token: MailboxToken): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(tokenFile(mailbox), JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(tokenFile(mailbox), 0o600);
}

/** Interactive loopback OAuth flow (PKCE). Prints the consent URL; the user opens it in a browser. */
interface GmailPending {
  authUrl: string;
  done: boolean;
  email?: string;
  error?: string;
  close: () => void;
}
const gmailPending = new Map<string, GmailPending>();

/**
 * Start the OAuth (PKCE, loopback) consent flow for a mailbox. Returns the consent URL (opened in
 * the system browser by default); the loopback server finishes the exchange in the background.
 * Poll `checkGmailLogin`.
 */
export async function beginGmailLogin(mailbox: string, openBrowser = true): Promise<{ authUrl: string; opened: boolean }> {
  cancelGmailLogin(mailbox);
  const cfg = await clientConfig();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  resetListening();
  let redirect = "";
  const code = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") return void res.writeHead(404).end();
      const got = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !got) {
        res.writeHead(400).end("OAuth failed (state mismatch or no code).");
        server.close();
        return reject(new Error("OAuth failed"));
      }
      res.writeHead(200, { "Content-Type": "text/plain" }).end("Gmail access granted. You can close this tab.");
      server.close();
      resolve(got);
    });
    server.listen(0, "127.0.0.1", () => {
      redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
      listening.resolve();
    });
    pendingClose = () => {
      server.close();
      reject(new Error("cancelled"));
    };
  });
  await listening.promise;

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const entry: GmailPending = { authUrl: auth.toString(), done: false, close: pendingClose };
  gmailPending.set(mailbox, entry);
  code
    .then((c) => exchangeCode(cfg, mailbox, c, verifier, redirect))
    .then((email) => {
      entry.email = email;
      entry.done = true;
    })
    .catch((err: unknown) => {
      entry.error = err instanceof Error ? err.message : String(err);
      entry.done = true;
    });

  let opened = false;
  if (openBrowser) {
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [entry.authUrl], { stdio: "ignore", detached: true }).unref();
      opened = true;
    } catch {
      opened = false;
    }
  }
  return { authUrl: entry.authUrl, opened };
}

// Small helpers for beginGmailLogin's promise plumbing.
let pendingClose: () => void = () => undefined;
const listening = { promise: Promise.resolve(), resolve: () => undefined as void };
function resetListening(): void {
  listening.promise = new Promise<void>((r) => (listening.resolve = r));
}

export function checkGmailLogin(mailbox: string): { status: "not_started" | "waiting_for_consent" | "logged_in" | "failed"; email?: string; error?: string; auth_url?: string } {
  const e = gmailPending.get(mailbox);
  if (!e) return { status: "not_started" };
  if (!e.done) return { status: "waiting_for_consent", auth_url: e.authUrl };
  gmailPending.delete(mailbox);
  return e.error ? { status: "failed", error: e.error } : { status: "logged_in", email: e.email };
}

export function cancelGmailLogin(mailbox: string): void {
  const e = gmailPending.get(mailbox);
  if (!e) return;
  gmailPending.delete(mailbox);
  if (!e.done) e.close();
}

async function exchangeCode(cfg: ClientConfig, mailbox: string, code: string, verifier: string, redirect: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status} ${await res.text()}`);
  const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  if (!tok.refresh_token) throw new Error("Google returned no refresh token; remove the app's access in your Google account and retry.");
  const profile = (await (
    await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${tok.access_token}` } })
  ).json()) as { emailAddress: string };
  await saveToken(mailbox, {
    email: profile.emailAddress,
    refresh_token: tok.refresh_token,
    access_token: tok.access_token,
    expires_at: Date.now() + (tok.expires_in - 60) * 1000,
  });
  return profile.emailAddress;
}

/** CLI: `accountable-mcp gmail-login <mailbox>` — prints the consent URL and waits. */
export async function gmailLogin(mailbox: string): Promise<string> {
  const { authUrl } = await beginGmailLogin(mailbox, false);
  process.stdout.write(`Open this URL and sign in with the "${mailbox}" mailbox:\n\n${authUrl}\n\nWaiting for consent…\n`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = checkGmailLogin(mailbox);
    if (r.status === "logged_in") return r.email!;
    if (r.status === "failed") throw new Error(r.error);
  }
}

export class Gmail {
  private token: MailboxToken | null = null;

  constructor(readonly mailbox: string) {}

  get email(): string | undefined {
    return this.token?.email;
  }

  static async configuredMailboxes(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      return (await readdir(CONFIG_DIR)).filter((f) => /^gmail-.+\.json$/.test(f)).map((f) => f.slice(6, -5));
    } catch {
      return [];
    }
  }

  private async accessToken(): Promise<string> {
    if (!this.token) {
      try {
        this.token = JSON.parse(await readFile(tokenFile(this.mailbox), "utf8")) as MailboxToken;
      } catch {
        throw new Error(`Mailbox "${this.mailbox}" is not connected. Run \`accountable-mcp gmail-login ${this.mailbox}\`.`);
      }
    }
    if (this.token.access_token && (this.token.expires_at ?? 0) > Date.now()) return this.token.access_token;
    const cfg = await clientConfig();
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        refresh_token: this.token.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`Gmail token refresh failed for "${this.mailbox}" (HTTP ${res.status}); re-run gmail-login.`);
    const tok = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { ...this.token, access_token: tok.access_token, expires_at: Date.now() + (tok.expires_in - 60) * 1000 };
    await saveToken(this.mailbox, this.token);
    return tok.access_token;
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
    url.search = new URLSearchParams(query).toString();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) throw new Error(`Gmail API ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async search(q: string, max = 200): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>("messages", {
        q,
        maxResults: "100",
        ...(pageToken ? { pageToken } : {}),
      });
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < max);
    return ids.slice(0, max);
  }

  async message(id: string): Promise<GmailMessage> {
    const raw = await this.get<RawMessage>(`messages/${id}`, { format: "full" });
    const header = (n: string) => raw.payload.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const parts: RawPart[] = [];
    const walk = (p: RawPart) => {
      parts.push(p);
      p.parts?.forEach(walk);
    };
    walk(raw.payload);
    const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
    const html = parts.find((p) => p.mimeType === "text/html")?.body?.data;
    const text = parts.find((p) => p.mimeType === "text/plain")?.body?.data;
    return {
      id,
      mailbox: this.mailbox,
      date: new Date(Number(raw.internalDate)).toISOString(),
      from: header("from"),
      subject: header("subject"),
      html: decode(html),
      text: decode(text),
      attachments: parts
        .filter((p) => p.filename && p.body?.attachmentId)
        .map((p) => ({ filename: p.filename!, mimeType: p.mimeType, attachmentId: p.body!.attachmentId!, size: p.body?.size ?? 0 })),
    };
  }

  async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const res = await this.get<{ data: string }>(`messages/${messageId}/attachments/${attachmentId}`);
    return Buffer.from(res.data, "base64url");
  }
}

interface RawPart {
  mimeType: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: RawPart[];
}

interface RawMessage {
  internalDate: string;
  payload: RawPart;
}

export interface GmailMessage {
  id: string;
  mailbox: string;
  date: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }>;
}
