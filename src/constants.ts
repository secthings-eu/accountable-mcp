import { homedir } from "node:os";
import { join } from "node:path";

export const API_BASE_URL = process.env.ACCOUNTABLE_API_URL ?? "https://app.accountable.eu/api";

/** Headers the web client sends on every request (see research/BRIEF.md). */
export const CLIENT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "x-bundleversion": process.env.ACCOUNTABLE_BUNDLE_VERSION ?? "1.0.30",
  "x-client": "accountable-web",
};

export const CONFIG_DIR = process.env.ACCOUNTABLE_CONFIG_DIR ?? join(homedir(), ".config", "accountable-mcp");
export const AUTH_FILE = join(CONFIG_DIR, "auth.json");

/** Refresh the access token when it has less than this many seconds left. */
export const REFRESH_MARGIN_SECONDS = 600;

export const REQUEST_TIMEOUT_MS = 60_000;
export const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** Max characters returned in a single tool response. */
export const CHARACTER_LIMIT = 25_000;
