import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR } from "../constants.js";
import type { CamofoxSite } from "./camofox.js";

/**
 * Bitwarden CLI → Camoufox credential hand-off. The vault item is read by the `bw` subprocess and
 * typed straight into the login page through camofox's type endpoint; the values are never logged,
 * returned or shown to the agent. The user unlocks the vault themselves:
 *
 *   bw unlock --raw > ~/.config/accountable-mcp/bw-session && chmod 600 ~/.config/accountable-mcp/bw-session
 *
 * (`bw lock` or deleting the file revokes it.)
 */

const SESSION_FILE = join(CONFIG_DIR, "bw-session");
const exec = promisify(execFile);

async function session(): Promise<string> {
  try {
    const key = (await readFile(SESSION_FILE, "utf8")).trim();
    if (key) return key;
  } catch {
    /* fallthrough */
  }
  throw new Error(`Bitwarden is locked for the MCP. In a terminal run: bw unlock --raw > ${SESSION_FILE} && chmod 600 ${SESSION_FILE}`);
}

async function bw(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("bw", [...args, "--nointeraction"], { env: { ...process.env, BW_SESSION: await session() }, maxBuffer: 8_000_000 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: unknown };
    if (e.code === "ENOENT") throw new Error("Bitwarden CLI `bw` not found on PATH.");
    const msg = (e.stderr ?? "").trim() || e.message || "unknown error";
    throw new Error(`bw ${args.slice(0, 2).join(" ")} failed: ${msg.split("\n")[0].slice(0, 200)}`);
  }
}

export async function bwStatus(): Promise<{ status: string; lastSync?: string }> {
  const s = JSON.parse(await bw(["status"])) as { status: string; lastSync?: string };
  return { status: s.status, lastSync: s.lastSync };
}

interface BwItem {
  id: string;
  name: string;
  login?: { username?: string; password?: string; totp?: string };
}

const mask = (s?: string) => (s ? `${s.slice(0, 2)}***${s.includes("@") ? s.slice(s.indexOf("@")) : ""}` : undefined);

/** Candidate items for a site, without secrets (for disambiguation only). */
export async function listItemsForUrl(url: string): Promise<Array<{ id: string; name: string; username_hint?: string }>> {
  const items = JSON.parse(await bw(["list", "items", "--url", url])) as BwItem[];
  return items.map((i) => ({ id: i.id, name: i.name, username_hint: mask(i.login?.username) }));
}

/**
 * Type username + password of one vault item into the given page fields. `item` is a Bitwarden item
 * id or exact name; when omitted the single item matching `url` is used.
 */
export async function fillFromBitwarden(
  c: CamofoxSite,
  tab: string,
  opts: { url: string; item?: string; userRef: string; passRef: string },
): Promise<{ item: string; username_hint?: string }> {
  let item: BwItem;
  if (opts.item) {
    item = JSON.parse(await bw(["get", "item", opts.item])) as BwItem;
  } else {
    const list = JSON.parse(await bw(["list", "items", "--url", opts.url])) as BwItem[];
    if (list.length !== 1) {
      throw new Error(
        `${list.length} Bitwarden items match ${opts.url}${list.length ? `: ${list.map((i) => `"${i.name}"`).join(", ")}` : ""}; pass bitwarden_item.`,
      );
    }
    item = list[0];
  }
  const { username, password } = item.login ?? {};
  if (!username || !password) throw new Error(`Bitwarden item "${item.name}" has no username/password.`);
  await c.type(tab, opts.userRef, username);
  await c.type(tab, opts.passRef, password);
  return { item: item.name, username_hint: mask(username) };
}
