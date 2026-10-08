import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AUTH_FILE } from "./constants.js";
import { forceRefresh, saveAuth, sessionSummary, type AuthData } from "./services/auth.js";

/**
 * Interactive bootstrap: the user copies their session from a logged-in browser tab.
 * In DevTools console on web.accountable.eu run:  copy(localStorage.auth)
 * then paste here. Nothing is sent anywhere except Accountable's own refresh endpoint.
 */
export async function login(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write(
    [
      "Accountable MCP login",
      "1. Open https://web.accountable.eu and log in.",
      "2. Open DevTools → Console and run:  copy(localStorage.auth)",
      "3. Paste the copied JSON below and press Enter.",
      "",
    ].join("\n"),
  );
  const raw = (await rl.question("> ")).trim();
  rl.close();
  let data: AuthData;
  try {
    data = JSON.parse(raw) as AuthData;
  } catch {
    throw new Error("That is not valid JSON. Copy the whole value of localStorage.auth.");
  }
  if (!data.access_token) throw new Error("No access_token in the pasted value.");
  await saveAuth(data);
  if (data.refresh_token) {
    // Prove the refresh token works and store a fresh access token.
    await forceRefresh();
  }
  stdout.write(`Saved session to ${AUTH_FILE} (mode 600).\n${JSON.stringify(sessionSummary(data), null, 2)}\n`);
}
