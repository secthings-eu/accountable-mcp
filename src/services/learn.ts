import { readFile, writeFile, mkdir } from "node:fs/promises";
import { CONFIG_DIR } from "../constants.js";
import { LOCAL_PROVIDERS_FILE } from "../invoices/localConfig.js";
import { listExpensesBetween, type Expense } from "./expenses.js";
import { matchedBrand, normalizeSupplier, isAutomaticOrigin } from "./suppliers.js";
import { api } from "./client.js";
import { findProvider } from "../invoices/providers.js";
import { Gmail } from "../invoices/gmail.js";
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

// Marketplaces / payment processors: their payments legitimately belong to many different suppliers.
const INTERMEDIARIES = new Set(["amazon", "aliexpress", "paypal", "stripe", "mollie", "sumup", "zettle", "adyen", "ppro", "apple"]);

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
          const brand = matchedBrand(text);
          if (brand && INTERMEDIARIES.has(brand.toLowerCase())) continue; // marketplace debit → any seller
          if (brand) {
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

async function readLocal(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(LOCAL_PROVIDERS_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeLocal(cfg: Record<string, unknown>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(LOCAL_PROVIDERS_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** Write reviewed aliases to providers.json (`learned_aliases`); hand-written `supplier_aliases` are never touched. */
export async function saveLearnedAliases(
  aliases: Array<{ pattern: string; display: string }>,
  replace = false,
): Promise<{ file: string; total: number; added: number }> {
  for (const a of aliases) new RegExp(a.pattern, "i"); // throws on invalid patterns before writing anything
  const cfg = await readLocal();
  const existing = replace ? [] : ((cfg.learned_aliases as Array<[string, string]> | undefined) ?? []);
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
  await writeLocal(cfg);
  return { file: LOCAL_PROVIDERS_FILE, total: existing.length, added };
}

// ---------------------------------------------------------------------------------------------
// Provider module candidates: recurring suppliers whose documents are added by hand and that no
// provider module covers yet. The agent then investigates (gmail search, portal) and saves a module.

export interface ProviderCandidate {
  supplier: string;
  name_variants: string[];
  expenses: number;
  total: number;
  first_date: string | null;
  last_date: string | null;
  with_document: number;
  /** origin.process of up to 3 sampled expenses (manual, dropzone-ocr, conversation_upload = added by hand). */
  origin_sample: string[];
  sample_expense_ids: string[];
}

export async function proposeProviders(
  since: string,
  until: string,
  minExpenses = 2,
): Promise<{ candidates: ProviderCandidate[]; skipped_automatic: string[]; skipped_no_documents: string[]; already_covered: string[] }> {
  const noDocs: string[] = [];
  const expenses = await listExpensesBetween(since, until);
  type G = { display: string; variants: Set<string>; items: Expense[] };
  const groups = new Map<string, G>();
  for (const e of expenses) {
    const raw = (e.supplier?.name ?? "").trim();
    if (!raw) continue;
    const n = normalizeSupplier(raw);
    const g = groups.get(n.key) ?? { display: n.display, variants: new Set<string>(), items: [] };
    g.variants.add(raw);
    g.items.push(e);
    groups.set(n.key, g);
  }
  const candidates: ProviderCandidate[] = [];
  const skippedAutomatic: string[] = [];
  const covered: string[] = [];
  for (const g of groups.values()) {
    if (g.items.length < minExpenses) continue;
    if (findProvider(g.display)) {
      covered.push(g.display);
      continue;
    }
    if (!g.items.some((e) => Boolean((e as { file?: { path?: string } }).file?.path))) {
      noDocs.push(g.display); // document-less patterns (rent, pay…): nothing to fetch
      continue;
    }
    const sample = g.items.slice(-3);
    const origins: string[] = [];
    for (const e of sample) {
      try {
        const { expense } = await api.get<{ expense: { origin?: { process?: string } } }>(`/v3/expenses/${encodeURIComponent(e._id)}`);
        origins.push(expense.origin?.process ?? "unknown");
      } catch {
        origins.push("unknown");
      }
    }
    if (origins.length && origins.every((o) => isAutomaticOrigin(o))) {
      skippedAutomatic.push(g.display);
      continue;
    }
    const dates = g.items.map((e) => expenseDateOf(e)).filter(Boolean).sort();
    candidates.push({
      supplier: g.display,
      name_variants: [...g.variants],
      expenses: g.items.length,
      total: Math.round(g.items.reduce((s, e) => s + (e.currencyAmount ?? 0), 0) * 100) / 100,
      first_date: dates[0] ?? null,
      last_date: dates[dates.length - 1] ?? null,
      with_document: g.items.filter((e) => Boolean((e as { file?: { path?: string } }).file?.path)).length,
      origin_sample: origins,
      sample_expense_ids: sample.map((e) => e._id),
    });
  }
  candidates.sort((a, b) => b.expenses - a.expenses || b.total - a.total);
  return { candidates, skipped_automatic: skippedAutomatic, skipped_no_documents: noDocs, already_covered: covered };
}

function expenseDateOf(e: Expense): string {
  const n = (e as { expenseDateNumber?: number }).expenseDateNumber;
  if (!n) return "";
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Read-only Gmail probe so the agent can craft a provider query before saving it. */
export async function gmailProbe(mailbox: string, query: string, max = 10): Promise<Array<{ id: string; date: string; from: string; subject: string; attachments: string[] }>> {
  const g = new Gmail(mailbox);
  const ids = await g.search(query, max);
  const out = [];
  for (const id of ids.slice(0, max)) {
    const m = await g.message(id);
    out.push({ id, date: m.date.slice(0, 10), from: m.from, subject: m.subject, attachments: m.attachments.map((a) => a.filename) });
  }
  return out;
}

export interface LocalProviderInput {
  id: string;
  supplier: string;
  source: { kind: "gmail-attachment" | "gmail-html" | "portal"; mailboxes?: string[]; query?: string; attachment?: string; subject?: string; url?: string; note?: string };
}

/** Validate and merge reviewed provider modules into providers.json (`providers`, by id). */
export async function saveLocalProviders(entries: LocalProviderInput[]): Promise<{ file: string; total: number; written: string[] }> {
  for (const p of entries) {
    if (!/^[a-z0-9-]+$/.test(p.id)) throw new Error(`Provider id "${p.id}" must be kebab-case.`);
    const s = p.source;
    if (s.kind === "gmail-attachment" || s.kind === "gmail-html") {
      if (!s.mailboxes?.length || !s.query) throw new Error(`Provider ${p.id}: gmail sources need mailboxes and query.`);
      if (s.kind === "gmail-attachment" && !s.attachment) throw new Error(`Provider ${p.id}: gmail-attachment needs an attachment pattern.`);
      if (s.attachment) new RegExp(s.attachment, "i");
      if (s.subject) new RegExp(s.subject, "i");
    } else if (s.kind === "portal") {
      if (!s.url) throw new Error(`Provider ${p.id}: portal sources need a url.`);
    } else {
      throw new Error(`Provider ${p.id}: unsupported kind; built-in kinds browser/photos cannot be added locally.`);
    }
  }
  const cfg = await readLocal();
  const existing = (cfg.providers as LocalProviderInput[] | undefined) ?? [];
  const byId = new Map(existing.map((p) => [p.id, p]));
  for (const p of entries) byId.set(p.id, p);
  const merged = [...byId.values()];
  cfg.providers = merged;
  await writeLocal(cfg);
  return { file: LOCAL_PROVIDERS_FILE, total: merged.length, written: entries.map((p) => p.id) };
}
