import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { API_BASE_URL, AUTH_FILE, CONFIG_DIR, REFRESH_MARGIN_SECONDS } from "../constants.js";

/**
 * Same shape the web app keeps in `localStorage.auth`.
 * `exp`/`iat` are JWT seconds; `refresh_token_expires_at` is an ISO date.
 */
export interface AuthData {
  access_token: string;
  refresh_token?: string;
  refresh_token_expires_at?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

let cached: AuthData | null = null;
let refreshing: Promise<AuthData> | null = null;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const LOGIN_HINT =
  "Run `accountable-mcp login` and paste the value of `localStorage.auth` from a logged-in web.accountable.eu tab.";

export async function loadAuth(): Promise<AuthData> {
  if (cached) return cached;
  let raw: string;
  try {
    raw = await readFile(AUTH_FILE, "utf8");
  } catch {
    throw new AuthError(`Not logged in to Accountable. ${LOGIN_HINT}`);
  }
  const data = JSON.parse(raw) as AuthData;
  if (!data.access_token) throw new AuthError(`Stored session is invalid. ${LOGIN_HINT}`);
  cached = data;
  return data;
}

export async function saveAuth(data: AuthData): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(AUTH_FILE, 0o600);
  cached = data;
}

/** Decode the JWT payload without verifying it (we only need exp/iat). */
function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function secondsLeft(data: AuthData): number {
  const exp = typeof data.exp === "number" ? data.exp : (jwtPayload(data.access_token).exp as number | undefined);
  return exp ? exp - Date.now() / 1000 : Number.POSITIVE_INFINITY;
}

/**
 * Fallback when the stored tokens are dead: reuse the MCP's own Camoufox profile for Accountable
 * (created once with `accountable-mcp browser-login accountable`), whose web app keeps its own
 * session renewed. No credentials are involved.
 */
async function fromBrowser(failure: string): Promise<AuthData> {
  try {
    const { accountableSessionFromCamofox } = await import("../invoices/camofox.js");
    const auth = await accountableSessionFromCamofox();
    if (auth) {
      await saveAuth(auth as AuthData);
      return auth as AuthData;
    }
  } catch {
    /* camofox unavailable or profile missing: fall through to the manual hint */
  }
  throw new AuthError(`${failure} Or run \`accountable-mcp browser-login accountable\` once so the MCP can renew sessions itself.`);
}

export async function forceRefresh(): Promise<AuthData> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const data = await loadAuth();
    if (!data.refresh_token) return fromBrowser(`Session expired and no refresh token stored. ${LOGIN_HINT}`);
    if (data.refresh_token_expires_at && new Date(data.refresh_token_expires_at).getTime() < Date.now()) {
      return fromBrowser(`Refresh token expired. ${LOGIN_HINT}`);
    }
    const res = await fetch(`${API_BASE_URL}/v2/users/refresh-access-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: data.refresh_token }),
    });
    if (!res.ok) return fromBrowser(`Token refresh failed (HTTP ${res.status}). ${LOGIN_HINT}`);
    const body = (await res.json()) as { access_token: string; finalPayload?: Record<string, unknown> };
    const next: AuthData = { ...data, access_token: body.access_token, ...(body.finalPayload ?? {}) };
    const payload = jwtPayload(next.access_token);
    if (typeof payload.exp === "number") next.exp = payload.exp;
    if (typeof payload.iat === "number") next.iat = payload.iat;
    await saveAuth(next);
    return next;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Returns a valid access token, refreshing it proactively when close to expiry. */
export async function getAccessToken(): Promise<string> {
  const data = await loadAuth();
  const left = secondsLeft(data);
  if (left < REFRESH_MARGIN_SECONDS && data.refresh_token) {
    try {
      return (await forceRefresh()).access_token;
    } catch (err) {
      if (left > 5) return data.access_token;
      throw err;
    }
  }
  return data.access_token;
}

export function sessionSummary(data: AuthData): Record<string, unknown> {
  const payload = jwtPayload(data.access_token);
  return {
    access_token_expires_in_s: Math.round(secondsLeft(data)),
    has_refresh_token: Boolean(data.refresh_token),
    refresh_token_expires_at: data.refresh_token_expires_at ?? null,
    jwt_claims: Object.keys(payload),
  };
}
