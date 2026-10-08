import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename } from "node:path";
import { z } from "zod";
import { UPLOAD_TIMEOUT_MS } from "../constants.js";
import { api } from "../services/client.js";
import { expenseDate, listExpensesBetween, summarizeExpense, type Expense } from "../services/expenses.js";
import { run } from "../services/format.js";
import { updateExpense } from "./expenses.js";
import { normalizeSupplier } from "../services/suppliers.js";
import { uploadLocalFile } from "../services/upload.js";
import { DEFAULT_INVOICE_DIR, fetchProvider, loadLedger, saveLedger, type FetchedInvoice } from "../invoices/fetch.js";
import { Gmail } from "../invoices/gmail.js";
import { PROVIDERS, findProvider } from "../invoices/providers.js";
import { fetchPage, linkDocuments, unlinkDocument, type Transaction } from "./transactions.js";

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const startOfYear = () => `${new Date().getFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

const txDate = (t: Transaction) => (t.valueDate ?? t.executionDate ?? "").slice(0, 10);
/**
 * Supplier key of a bank transaction. The merchant text before "Paiement/Virement/…" in the communication
 * often names the product (e.g. counterparty "Google", communication "Google YouTubePremium …"), so a known
 * brand found there wins over the bare counterparty. The rest of the communication is ignored because it
 * contains the cardholder name.
 */
const txSupplier = (t: Transaction) => {
  const merchant = (t.communication ?? "").split(/\b(Paiement|Virement|Domiciliation|Ordre permanent|Payment)\b/i)[0].trim();
  const fromMerchant = merchant ? normalizeSupplier(merchant) : null;
  const fromCounterparty = normalizeSupplier(t.counterPartyName || t.guessedCounterpartName || merchant);
  return fromMerchant && fromMerchant.display !== merchant.split("|")[0].trim() ? fromMerchant.key : fromCounterparty.key;
};

/** Bank transactions in [from, to] (list is newest first, so we stop once we pass `from`). */
async function transactionsBetween(from: string, to: string): Promise<Transaction[]> {
  const out: Transaction[] = [];
  for (let page = 1; page <= 30; page++) {
    const res = await fetchPage(page, 100);
    let older = false;
    for (const t of res.data) {
      const d = txDate(t);
      if (d < from) older = true;
      else if (d <= to) out.push(t);
    }
    if (older || page >= res.paging.pageCount) break;
  }
  return out;
}

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

export function registerInvoiceTools(server: McpServer): void {
  server.registerTool(
    "accountable_list_invoice_providers",
    {
      title: "Invoice provider modules & coverage",
      description:
        "List the invoice-fetching modules (one per supplier: Gmail attachment, Gmail email→PDF, or portal) with setup status, " +
        "and for each supplier the bank payments in the period vs. how many are already linked to a document in Accountable. " +
        "Use it to see where invoices are missing before running accountable_fetch_invoices.",
      inputSchema: { date_from: ISO.default(startOfYear()), date_to: ISO.default(today()) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ date_from, date_to }) =>
      run(async () => {
        const [mailboxes, txs, expenses] = await Promise.all([
          Gmail.configuredMailboxes(),
          transactionsBetween(date_from, date_to),
          listExpensesBetween(date_from, date_to),
        ]);
        const providers = PROVIDERS.map((p) => {
          const key = p.supplier.toLowerCase();
          const pays = txs.filter((t) => t.amount < 0 && txSupplier(t) === key);
          const docs = expenses.filter((e) => normalizeSupplier(e.supplier?.name).key === key);
          const needs = p.source.kind === "gmail-attachment" || p.source.kind === "gmail-html" ? p.source.mailboxes : [];
          return {
            id: p.id,
            supplier: p.supplier,
            source: p.source.kind,
            verified: p.verified,
            ready:
              p.source.kind === "browser"
                ? "run browser-login once"
                : p.source.kind === "photos"
                  ? process.platform === "darwin"
                  : p.source.kind !== "portal" && needs.some((m) => mailboxes.includes(m)),
            mailboxes: needs,
            payments: pays.length,
            payments_without_document: pays.filter((t) => !(t.matchedItems ?? []).length).length,
            documents_in_accountable: docs.length,
          };
        });
        return { period: { date_from, date_to }, connected_mailboxes: mailboxes, invoice_dir: DEFAULT_INVOICE_DIR, providers };
      }),
  );

  server.registerTool(
    "accountable_fetch_invoices",
    {
      title: "Fetch supplier invoices",
      description:
        "Run invoice provider modules for a period and save the PDFs to <out_dir>/<provider>/ (default ~/Documents/Invoices). " +
        "Already-fetched items are remembered in a local ledger and not downloaded twice. Each result says whether a matching " +
        "expense already exists in Accountable (same supplier, date within 3 days) so you only import what's missing. Nothing is " +
        "written to Accountable — use accountable_import_invoices for that.",
      inputSchema: {
        providers: z.array(z.string()).optional().describe("Provider ids (see accountable_list_invoice_providers); default all"),
        date_from: ISO.default(startOfYear()),
        date_to: ISO.default(today()),
        out_dir: z.string().optional(),
        detail: z.enum(["missing", "all"]).default("missing").describe("'missing' lists only invoices not yet in Accountable (compact); 'all' lists everything"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (p) =>
      run(async () => {
        const selected = p.providers?.length
          ? p.providers.map((id) => findProvider(id) ?? (() => { throw new Error(`Unknown provider ${id}`); })())
          : PROVIDERS;
        const [mailboxes, ledger, expenses] = await Promise.all([
          Gmail.configuredMailboxes(),
          loadLedger(),
          listExpensesBetween(shiftDays(p.date_from, -10), shiftDays(p.date_to, 10)),
        ]);
        const results = [];
        const claimed = new Set<string>();
        for (const provider of selected) {
          try {
            const r = await fetchProvider(provider, p.date_from, p.date_to, p.out_dir ?? DEFAULT_INVOICE_DIR, ledger, mailboxes);
            const key = provider.supplier.toLowerCase();
            // Receipt photos have no supplier until OCR: a documented expense within ±2 days (typically the same
            // photo uploaded from the phone) is the best available hint.
            const photos = provider.source.kind === "photos";
            const candidates = photos
              ? expenses.filter((e) => Boolean((e as { file?: { path?: string } }).file?.path))
              : expenses.filter((e) => normalizeSupplier(e.supplier?.name).key === key);
            // One-to-one: each Accountable expense can only explain one fetched invoice (closest date wins).
            const pairs = r.invoices
              .flatMap((inv) =>
                candidates.map((e) => ({ inv, e, gap: Math.abs(daysBetween(expenseDate(e) ?? "1970-01-01", inv.date)) })),
              )
              .filter((x) => x.gap <= (photos ? 2 : 3))
              .sort((a, b) => a.gap - b.gap);
            const match = new Map<string, string>();
            for (const { inv, e } of pairs) {
              if (match.has(inv.source_ref) || claimed.has(e._id)) continue;
              match.set(inv.source_ref, e._id);
              claimed.add(e._id);
            }
            results.push({
              ...r,
              invoices: r.invoices.map((inv) => ({ ...inv, likely_in_accountable: inv.expense_id ?? match.get(inv.source_ref) ?? null })),
            });
          } catch (err) {
            results.push({ provider: provider.id, status: "error", message: err instanceof Error ? err.message : String(err), invoices: [] });
          }
        }
        await saveLedger(ledger);
        const all = results.flatMap((r) => r.invoices);
        const missing = all.filter((i) => !i.likely_in_accountable);
        return {
          period: { date_from: p.date_from, date_to: p.date_to },
          fetched: all.length,
          missing_in_accountable: missing.length,
          by_provider: results.map((r) => ({
            provider: r.provider,
            status: r.status,
            message: r.message,
            fetched: r.invoices.length,
            missing: r.invoices.filter((i) => !i.likely_in_accountable).length,
          })),
          invoices: (p.detail === "all" ? all : missing).map((i) => ({
            source_ref: i.source_ref,
            provider: i.provider,
            date: i.date,
            file: i.file,
            subject: i.subject,
            likely_in_accountable: i.likely_in_accountable,
          })),
        };
      }),
  );

  server.registerTool(
    "accountable_import_invoices",
    {
      title: "Import fetched invoices into Accountable",
      description:
        "Create Accountable expenses (upload + OCR) from invoices previously fetched with accountable_fetch_invoices, identified " +
        "by source_ref. With link_payments=true, each new expense is linked to the unlinked bank payment from the same supplier " +
        "with the same amount (±0.02, or ±1.5% for foreign-currency cards) dated 5 days before to 20 days after the invoice. " +
        "Ambiguous matches are reported, not linked. Imported refs are recorded so they are never imported twice.",
      inputSchema: {
        source_refs: z.array(z.string()).max(50).default([]).describe("Refs returned by accountable_fetch_invoices"),
        files: z
          .array(z.object({ path: z.string(), provider: z.string().describe("Provider id or supplier name, e.g. youtube-premium") }))
          .max(50)
          .default([])
          .describe("Local invoice files not fetched by a module (e.g. downloaded by hand). Date is read from a YYYY-MM-DD filename prefix."),
        link_payments: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ source_refs, files, link_payments }) =>
      run(async () => {
        const ledger = await loadLedger();
        for (const f of files) {
          const provider = findProvider(f.provider);
          const ref = `file:${f.path}`;
          if (!ledger[ref]) {
            const date = basename(f.path).match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? today();
            ledger[ref] = {
              provider: provider?.id ?? f.provider,
              supplier: provider?.supplier ?? normalizeSupplier(f.provider).display,
              source_ref: ref,
              date,
              subject: basename(f.path),
              file: f.path,
            };
          }
          source_refs.push(ref);
        }
        if (!source_refs.length) throw new Error("Give source_refs and/or files.");
        source_refs.sort((a, b) => (ledger[a]?.date ?? "").localeCompare(ledger[b]?.date ?? ""));
        const report = [];
        const usedTx = new Set<string>();
        for (const ref of source_refs) {
          const inv: FetchedInvoice | undefined = ledger[ref];
          if (!inv) {
            report.push({ source_ref: ref, status: "unknown_ref" });
            continue;
          }
          if (inv.expense_id) {
            report.push({ source_ref: ref, status: "already_imported", expense_id: inv.expense_id });
            continue;
          }
          try {
            const up = await uploadLocalFile(inv.file, "expense");
            const res = await api.post<{ expense: Expense }>(
              "/v3/expenses/from-file",
              { file_name: up.key.split("/").pop(), file_path: up.key, is_fake: false },
              { query: { cache: Date.now() }, timeoutMs: UPLOAD_TIMEOUT_MS },
            );
            inv.expense_id = res.expense._id;
            await saveLedger(ledger);
            let created: Expense = res.expense;
            if (inv.expected_amount !== undefined || inv.overrides) {
              created = await updateExpense({
                id: res.expense._id,
                collapse_to_single_line: inv.expected_amount !== undefined,
                amount: inv.expected_amount,
                ...inv.overrides,
              });
            }
            const expense = summarizeExpense(created);
            let link: Record<string, unknown> = { status: "not_requested" };
            if (link_payments) link = await linkImported(created, inv, usedTx);
            report.push({ source_ref: ref, status: "imported", expense, link });
          } catch (err) {
            report.push({ source_ref: ref, status: "error", message: err instanceof Error ? err.message : String(err) });
          }
        }
        // Second pass: one payment covering several invoices (e.g. AliExpress orders paid in one checkout).
        const unmatched = report.filter(
          (r): r is typeof r & { expense: Record<string, unknown>; link: Record<string, unknown> } =>
            r.status === "imported" && (r as { link?: { status?: string } }).link?.status === "no_match",
        );
        const groups = new Map<string, typeof unmatched>();
        for (const r of unmatched) {
          const k = `${String(r.expense.supplier ?? "").toLowerCase()}|${r.expense.date}`;
          groups.set(k, [...(groups.get(k) ?? []), r]);
        }
        for (const [k, members] of groups) {
          if (members.length < 2) continue;
          const date = String(members[0].expense.date);
          const supplierKey = normalizeSupplier(String(members[0].expense.supplier ?? "")).key;
          const sum = members.reduce((acc, m) => acc + Math.abs(Number(m.expense.amount ?? 0)), 0);
          const txs = await transactionsBetween(shiftDays(date, -3), shiftDays(date, 10));
          const hit = txs.filter(
            (t) =>
              t.amount < 0 &&
              !usedTx.has(t._id) &&
              !(t.matchedItems ?? []).length &&
              (txSupplier(t) === supplierKey || txSupplier(t) === k.split("|")[0]) &&
              Math.abs(Math.abs(t.amount) - sum) <= Math.max(0.02, sum * 0.01),
          );
          if (hit.length !== 1) continue;
          const t = hit[0];
          const { linkedTotal } = await linkDocuments(t._id, members.map((m) => String(m.expense.id)), []);
          usedTx.add(t._id);
          for (const m of members) {
            m.link = { status: "linked", by: "group", transaction_id: t._id, transaction_date: txDate(t), transaction_amount: t.amount, group_size: members.length, linked_total: linkedTotal };
          }
        }
        if (link_payments) await rebalanceBatch(report);
        return { imported: report.filter((r) => r.status === "imported").length, report };
      }),
  );
}

/**
 * Accountable's automatch links each new expense to *a* same-amount payment as soon as it is created,
 * so a batch of identical monthly invoices ends up shifted by a month. After the batch, re-assign every
 * imported expense to the closest-date payment of the same supplier and amount, touching only payments
 * whose links are empty or point to expenses from this batch.
 */
async function rebalanceBatch(report: Array<Record<string, any>>): Promise<void> {
  const batch = report.filter((r) => r.status === "imported" && r.expense?.id);
  if (batch.length < 2) return;
  const ids = new Set(batch.map((r) => String(r.expense.id)));
  const dates = batch.map((r) => String(r.expense.date)).sort();
  const txs = await transactionsBetween(shiftDays(dates[0], -10), shiftDays(dates[dates.length - 1], 30));
  const bySupplier = new Map<string, Array<Record<string, any>>>();
  for (const r of batch) {
    const k = normalizeSupplier(String(r.expense.supplier ?? "")).key;
    bySupplier.set(k, [...(bySupplier.get(k) ?? []), r]);
  }
  for (const [key, members] of bySupplier) {
    members.sort((a, b) => (a.expense.date < b.expense.date ? -1 : 1));
    const pool = txs.filter((t) => {
      if (t.amount >= 0 || txSupplier(t) !== key) return false;
      const items = t.matchedItems ?? [];
      return items.every((m) => ids.has(m.documentId ?? ""));
    });
    const taken = new Set<string>();
    for (const r of members) {
      if (r.link?.by === "group") continue;
      const amount = Math.abs(Number(r.expense.amount ?? 0));
      const best = pool
        .filter((t) => !taken.has(t._id) && Math.abs(Math.abs(t.amount) - amount) <= Math.max(0.02, amount * 0.03))
        .map((t) => ({ t, gap: daysBetween(String(r.expense.date), txDate(t)) }))
        .filter(({ gap }) => gap >= -5 && gap <= 20)
        .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap))[0]?.t;
      if (!best) continue;
      taken.add(best._id);
      const items = best.matchedItems ?? [];
      if (items.length === 1 && items[0].documentId === r.expense.id) continue;
      await linkDocuments(best._id, [String(r.expense.id)], [], "replace");
      r.link = { status: "linked", by: "rebalanced", transaction_id: best._id, transaction_date: txDate(best), transaction_amount: best.amount };
    }
    // Payments of this supplier still pointing at batch expenses that were assigned elsewhere: release them.
    for (const t of pool) {
      if (taken.has(t._id)) continue;
      for (const m of t.matchedItems ?? []) if (m.documentId && ids.has(m.documentId)) await unlinkDocument(t._id, m.documentId);
    }
  }
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Link a freshly imported expense to its bank payment. Accountable's server-side automatch may already
 * have linked it — matching on amount only, it can pick the wrong month for recurring subscriptions —
 * so we pick the best candidate ourselves (same supplier, amount within 3% for card FX fees, closest
 * date from -5 to +20 days) and move the automatch link if it disagrees.
 */
async function linkImported(expense: Expense, inv: FetchedInvoice, usedTx: Set<string>): Promise<Record<string, unknown>> {
  await new Promise((r) => setTimeout(r, 3000)); // give automatch a moment
  const eDate = expenseDate(expense) ?? inv.date;
  const amount = Math.abs(expense.currencyAmount ?? 0);
  const key = inv.supplier.toLowerCase();
  const txs = await transactionsBetween(shiftDays(eDate, -10), shiftDays(eDate, 30));
  const holds = (t: Transaction) => (t.matchedItems ?? []).some((m) => m.documentId === expense._id);
  const autoLinked = txs.filter(holds);
  const scored = txs
    .filter((t) => {
      if (t.amount >= 0 || usedTx.has(t._id) || txSupplier(t) !== key) return false;
      const items = t.matchedItems ?? [];
      if (items.length && !(items.length === 1 && holds(t))) return false;
      const dd = daysBetween(eDate, txDate(t));
      return dd >= -5 && dd <= 20 && Math.abs(Math.abs(t.amount) - amount) <= Math.max(0.02, amount * 0.03);
    })
    .map((t) => ({ t, gap: Math.abs(daysBetween(eDate, txDate(t))) }))
    .sort((a, b) => a.gap - b.gap);
  if (!scored.length || (scored.length > 1 && scored[0].gap === scored[1].gap)) {
    return {
      status: scored.length ? "ambiguous" : autoLinked.length ? "linked_by_accountable_unverified" : "no_match",
      candidates: scored.map(({ t }) => ({ id: t._id, date: txDate(t), amount: t.amount })),
      accountable_automatch: autoLinked.map((t) => ({ id: t._id, date: txDate(t), amount: t.amount })),
    };
  }
  const best = scored[0].t;
  usedTx.add(best._id);
  const moved = [];
  for (const t of autoLinked) {
    if (t._id === best._id) continue;
    await unlinkDocument(t._id, expense._id);
    moved.push({ id: t._id, date: txDate(t), amount: t.amount });
  }
  if (holds(best)) {
    return { status: "linked", by: "accountable_automatch_verified", transaction_id: best._id, transaction_date: txDate(best), transaction_amount: best.amount };
  }
  const { linkedTotal } = await linkDocuments(best._id, [expense._id], []);
  return {
    status: "linked",
    by: "importer",
    transaction_id: best._id,
    transaction_date: txDate(best),
    transaction_amount: best.amount,
    linked_total: linkedTotal,
    ...(moved.length ? { corrected_automatch_from: moved } : {}),
  };
}
