import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../constants.js";
import type { InvoiceProvider } from "./providers.js";

/**
 * User-specific providers and supplier aliases live outside the repo, in
 * `<CONFIG_DIR>/providers.json`, so the shipped lists stay generic:
 *
 * {
 *   "providers": [ { "id": "...", "supplier": "...", "source": { "kind": "gmail-attachment", "mailboxes": ["work"],
 *                    "query": "from:billing@example.com", "attachment": "^Invoice.*\\.pdf$" } } ],
 *   "supplier_aliases": [ ["^my\\s*leasing", "My Leasing"] ],
 *   "learned_aliases":  [ ["deco\\s*center", "Construct Center"] ]   // maintained by accountable_learn_suppliers
 * }
 *
 * `attachment` / `subject` are case-insensitive regex sources. Local entries are appended after the built-in ones
 * (same id overrides the built-in).
 */

interface LocalFile {
  providers?: Array<Omit<InvoiceProvider, "verified" | "source"> & { verified?: boolean; source: Record<string, unknown> }>;
  supplier_aliases?: Array<[string, string]>;
  /** Written by accountable_learn_suppliers / `learn-suppliers`; hand-written ones above take precedence. */
  learned_aliases?: Array<[string, string]>;
}

export const LOCAL_PROVIDERS_FILE = join(CONFIG_DIR, "providers.json");

function load(): LocalFile {
  try {
    return JSON.parse(readFileSync(LOCAL_PROVIDERS_FILE, "utf8")) as LocalFile;
  } catch {
    return {};
  }
}

const re = (v: unknown) => (typeof v === "string" ? new RegExp(v, "i") : undefined);

export function localProviders(): InvoiceProvider[] {
  return (load().providers ?? []).map((p) => {
    const src = { ...p.source };
    if ("attachment" in src) src.attachment = re(src.attachment);
    if ("subject" in src) src.subject = re(src.subject);
    return { verified: false, ...p, source: src } as unknown as InvoiceProvider;
  });
}

export function localAliases(): Array<[RegExp, string]> {
  const f = load();
  return [...(f.supplier_aliases ?? []), ...(f.learned_aliases ?? [])].map(([pattern, name]) => [new RegExp(pattern, "i"), name]);
}
