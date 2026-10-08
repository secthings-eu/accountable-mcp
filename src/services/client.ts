import { randomUUID } from "node:crypto";
import { API_BASE_URL, CLIENT_HEADERS, REQUEST_TIMEOUT_MS } from "../constants.js";
import { forceRefresh, getAccessToken } from "./auth.js";

const SESSION_ID = randomUUID();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | boolean | string[] | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Raw body (e.g. Buffer for uploads); skips JSON encoding. */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Arrays are sent comma-separated, like the web app's query-string config. */
  arrayFormat?: "comma" | "repeat";
}

function buildUrl(path: string, query: Query | undefined, arrayFormat: "comma" | "repeat"): string {
  const url = new URL(path.startsWith("http") ? path : `${API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (arrayFormat === "comma") url.searchParams.set(key, value.join(","));
      else value.forEach((v) => url.searchParams.append(key, v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const REFRESHABLE_CODES = new Set(["jwt-expired", "no-auth-token", "invalid-token"]);

function errorCode(body: unknown): string | undefined {
  const errors = (body as { errors?: Array<{ code?: string }> } | null)?.errors;
  return errors?.[0]?.code;
}

async function send(method: string, path: string, opts: RequestOptions, retried: boolean): Promise<unknown> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    ...CLIENT_HEADERS,
    "x-client-session": SESSION_ID,
    Authorization: `Bearer ${token}`,
    ...opts.headers,
  };
  let body: BodyInit | undefined = opts.rawBody;
  if (body === undefined && opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(buildUrl(path, opts.query, opts.arrayFormat ?? "comma"), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (res.ok) return parsed;

  const code = errorCode(parsed);
  if (!retried && (res.status === 401 || (code && REFRESHABLE_CODES.has(code)))) {
    await forceRefresh();
    return send(method, path, opts, true);
  }
  const detail = typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 500);
  throw new ApiError(res.status, code, `Accountable API ${method} ${path} failed: HTTP ${res.status}${code ? ` (${code})` : ""} ${detail}`, parsed);
}

export const api = {
  get: <T = unknown>(path: string, opts: RequestOptions = {}) => send("GET", path, opts, false) as Promise<T>,
  post: <T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}) =>
    send("POST", path, { ...opts, body }, false) as Promise<T>,
  put: <T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}) =>
    send("PUT", path, { ...opts, body }, false) as Promise<T>,
  patch: <T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}) =>
    send("PATCH", path, { ...opts, body }, false) as Promise<T>,
  delete: <T = unknown>(path: string, opts: RequestOptions = {}) => send("DELETE", path, opts, false) as Promise<T>,
};
