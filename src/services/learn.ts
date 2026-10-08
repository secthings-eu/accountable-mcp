import { readFile, writeFile, mkdir } from "node:fs/promises";
import { CONFIG_DIR } from "../constants.js";
import { LOCAL_PROVIDERS_FILE } from "../invoices/localConfig.js";
import { listExpensesBetween, type Expense } from "./expenses.js";
import { normalizeSupplier } from "./suppliers.js";
import { fetchPage } from "../tools/transactions.js";

/**
 * Learn supplier aliases from the user's own books: every bank transaction already linked to an
 * expense tells us "this counterparty / merchant text belongs to that supplier". Aliases that the
 * normaliser does not already resolve are proposed as [regex, display name] pairs and can be written
 * to `<CONFIG_DIR>/providers.json` under `learned_aliases` (kept apart from hand-written ones).
 */

export interface LearnedAlias {
  pattern: string;
  display: string;
  /** Raw bank texts that produced it. */
  seen: string[];
  count: number;
}

const merchantText = (t: { counterPartyName?: string; communication?: string }) => {
  const cp = (t.counterPartyName ?? "").trim();
  const merchant = (t.communication ?? "").split(/\b(Paiement|Virement|Domiciliation|Ordre permanent|Payment|Betaling|Overschrijving)\b/i)[0].trim();
  return [cp, merchant].filter((s) => s && s.length >= 3);
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Words that never identify a supplier on their own (countries, cities, payment words, legal forms).
const STOP = new Set([
  "belgium", "belgique", "belgie", "belgië", "nederland", "netherlands", "france", "deutschland", "germany", "luxembourg", "europe", "eu",
  "brussel", "bruxelles", "brussels", "namur", "liege", "liège", "antwerpen", "gent", "charleroi", "dublin", "london", "paris", "amsterdam",
  "paiement", "payment", "betaling", "virement", "overschrijving", "domiciliation", "mobile", "carte", "card", "debit", "credit", "cb",
  "sa", "nv", "srl", "sprl", "bv", "bvba", "gmbh", "ltd", "llc", "inc", "sas", "sarl", "the", "le", "la", "les", "de", "du", "des", "van", "der",
  "shop", "store", "online", "pay", "bck", "sumup", "zettle", "mollie", "stripe", "paypal", "ppro", "adyen",
]);

/** Pattern from the first two meaningful words of a bank text (case-insensitive, flexible spacing). */
function patternFor(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/[*_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !/^[a-z]{2}\d{4,}$/.test(w) && !/^[0-9a-f]{6,}$/i.test(w))
    .slice(0, 2);
  // Need at least one distinctive word: not a stop word, at least 4 letters (or two words together).
  const distinctive = words.filter((w) => !STOP.has(w) && /[a-z]{3,}/.test(w));
  if (!distinctive.length || (words.length === 1 && words[0].length < 4)) return null;
  return words.map(escapeRe).join("\\s*");
}

export interface LinkConflict {
  transaction_id: string;
  date: string;
  bank_text: string;
  resolves_to: string;
  linked_expense_id: string;
  linked_supplier: string;
}

export async function learnSupplierAliases(
  since: string,
  until: string,
): Promise<{ aliases: LearnedAlias[]; conflicts: LinkConflict[]; links_examined: number }> {
  const conflicts: LinkConflict[] = [];
  const expenses = await listExpensesBetween(since, until);
  const byId = new Map<string, Expense>(expenses.map((e) => [e._id, e]));
  const proposals = new Map<string, LearnedAlias>();
  let examined = 0;
  for (let page = 1; ; page++) {
    const r = await fetchPage(page, 100);
    for (const t of r.data as Array<{ _id: string; valueDate?: string; counterPartyName?: string; communication?: string; matchedItems?: Array<{ type: string; documentId: string }> }>) {
      if ((t.valueDate ?? "").slice(0, 10) < since) continue;
      for (const m of t.matchedItems ?? []) {
        const e = m.type === "expense" ? byId.get(m.documentId) : undefined;
        const supplier = e?.supplier?.name;
        if (!supplier) continue;
        const target = normalizeSupplier(supplier);
        for (const text of merchantText(t)) {
          examined++;
          const norm = normalizeSupplier(text);
          if (norm.key === target.key) continue; // already resolved
          if (norm.display !== text.split("|")[0].trim()) {
            // The bank text already resolves to a *different* known brand: that is a wrong link, not a synonym.
            conflicts.push({ transaction_id: t._id, date: (t.valueDate ?? "").slice(0, 10), bank_text: text, resolves_to: norm.display, linked_expense_id: e!._id, linked_supplier: supplier });
            continue;
          }
          const pattern = patternFor(text);
          if (!pattern) continue;
          const k = `${pattern}→${target.display}`;
          const cur = proposals.get(k) ?? { pattern, display: target.display, seen: [], count: 0 };
          cur.count++;
          if (!cur.seen.includes(text)) cur.seen.push(text);
          proposals.set(k, cur);
        }
      }
    }
    if (page >= (r.paging?.pageCount ?? 1)) break;
  }
  // Drop patterns that point to several different suppliers (ambiguous, e.g. "Paiement Mobile").
  const byPattern = new Map<string, Set<string>>();
  for (const a of proposals.values()) byPattern.set(a.pattern, (byPattern.get(a.pattern) ?? new Set()).add(a.display));
  const aliases = [...proposals.values()].filter((a) => byPattern.get(a.pattern)!.size === 1).sort((a, b) => b.count - a.count);
  const seenConflict = new Set<string>();
  const uniqueConflicts = conflicts.filter((c) => !seenConflict.has(c.transaction_id) && seenConflict.add(c.transaction_id));
  return { aliases, conflicts: uniqueConflicts, links_examined: examined };
}

/** Merge learned aliases into providers.json (`learned_aliases`), without touching hand-written ones. */
export async function saveLearnedAliases(aliases: LearnedAlias[]): Promise<{ file: string; total: number; added: number }> {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(LOCAL_PROVIDERS_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    /* new file */
  }
  const existing = (cfg.learned_aliases as Array<[string, string]> | undefined) ?? [];
  const manual = (cfg.supplier_aliases as Array<[string, string]> | undefined) ?? [];
  const known = new Set([...existing, ...manual].map(([p]) => p));
  let added = 0;
  for (const a of aliases) {
    if (known.has(a.pattern)) continue;
    existing.push([a.pattern, a.display]);
    known.add(a.pattern);
    added++;
  }
  cfg.learned_aliases = existing;
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(LOCAL_PROVIDERS_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return { file: LOCAL_PROVIDERS_FILE, total: existing.length, added };
}
