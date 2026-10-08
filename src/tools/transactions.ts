import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../services/client.js";
import { run } from "../services/format.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Bank transaction as returned by GET /v1/transactions (verified live). */
export interface Transaction {
  _id: string;
  amount: number;
  currency?: string;
  executionDate?: string;
  valueDate?: string;
  counterPartyName?: string;
  guessedCounterpartName?: string;
  counterPartyNumber?: string | null;
  communication?: string;
  transactionCategory?: string | null;
  guessedExpenseCategory?: string;
  matchedItems?: Array<{ type?: string; documentId?: string; isCreditNote?: boolean }>;
  accountNumber?: string;
  status?: string;
  [key: string]: unknown;
}

interface TransactionsPage {
  data: Transaction[];
  paging: { page: number; perPage: number; pageCount: number; totalCount: number };
}

const day = (s?: string) => (s ? s.slice(0, 10) : null);

export function summarizeTransaction(t: Transaction): Record<string, unknown> {
  return {
    id: t._id,
    date: day(t.executionDate ?? t.valueDate),
    amount: t.amount,
    currency: t.currency ?? null,
    counterparty: t.counterPartyName || t.guessedCounterpartName || null,
    communication: t.communication ?? null,
    classification: t.transactionCategory ?? null,
    linked_documents: (t.matchedItems ?? []).map((m) => ({ type: m.type, id: m.documentId, credit_note: m.isCreditNote ?? false })),
    to_classify: !t.transactionCategory && !(t.matchedItems ?? []).length,
    suggested_category: t.guessedExpenseCategory ?? null,
  };
}

export function fetchPage(page: number, perPage: number, toClassify?: boolean): Promise<TransactionsPage> {
  return api.get<TransactionsPage>("/v1/transactions", {
    query: { page, perPage, lang: "fr", expense_version: 3, toClassify: toClassify === undefined ? undefined : String(toClassify) },
  });
}

export function registerTransactionTools(server: McpServer): void {
  server.registerTool(
    "accountable_list_transactions",
    {
      title: "List bank transactions",
      description:
        "List bank transactions (newest first) with date, amount (negative = outgoing), counterparty, communication, " +
        "classification and linked documents. to_classify=true returns only the 'À classer' ones. " +
        "date_from/date_to/search/min/max filters are applied client-side across pages (max ~2000 transactions scanned).",
      inputSchema: {
        to_classify: z.boolean().optional().describe("true = only unclassified ('À classer') transactions"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        search: z.string().optional().describe("Case-insensitive match on counterparty or communication"),
        min_amount: z.number().optional().describe("Absolute amount lower bound"),
        max_amount: z.number().optional().describe("Absolute amount upper bound"),
        direction: z.enum(["in", "out", "any"]).default("any"),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(50),
      },
      annotations: READ_ONLY,
    },
    async (p) =>
      run(async () => {
        const filtering = p.date_from || p.date_to || p.search || p.min_amount !== undefined || p.max_amount !== undefined || p.direction !== "any";
        if (!filtering) {
          const res = await fetchPage(p.page, p.per_page, p.to_classify);
          return {
            total: res.paging.totalCount,
            page: res.paging.page,
            has_more: res.paging.page < res.paging.pageCount,
            transactions: res.data.map(summarizeTransaction),
          };
        }
        const needle = p.search?.toLowerCase();
        const matches: Transaction[] = [];
        for (let page = 1; page <= 20; page++) {
          const res = await fetchPage(page, 100, p.to_classify);
          let olderThanRange = false;
          for (const t of res.data) {
            const d = day(t.executionDate ?? t.valueDate) ?? "";
            if (p.date_from && d < p.date_from) {
              olderThanRange = true;
              continue;
            }
            if (p.date_to && d > p.date_to) continue;
            const abs = Math.abs(t.amount);
            if (p.min_amount !== undefined && abs < p.min_amount) continue;
            if (p.max_amount !== undefined && abs > p.max_amount) continue;
            if (p.direction === "in" && t.amount < 0) continue;
            if (p.direction === "out" && t.amount > 0) continue;
            if (needle && !`${t.counterPartyName ?? ""} ${t.guessedCounterpartName ?? ""} ${t.communication ?? ""}`.toLowerCase().includes(needle)) continue;
            matches.push(t);
          }
          // Results are sorted newest first: stop once we've passed the start of the range.
          if (olderThanRange || page >= res.paging.pageCount) break;
        }
        const start = (p.page - 1) * p.per_page;
        return {
          total: matches.length,
          page: p.page,
          has_more: start + p.per_page < matches.length,
          transactions: matches.slice(start, start + p.per_page).map(summarizeTransaction),
        };
      }),
  );

  server.registerTool(
    "accountable_get_transaction",
    {
      title: "Get bank transaction",
      description: "Full raw bank transaction by id, including matchedItems and classification.",
      inputSchema: { id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ id }) =>
      run(async () => ({
        transaction: await api.get(`/v1/transactions/${encodeURIComponent(id)}`, { query: { lang: "fr", expense_version: 3 } }),
      })),
  );
}

// ---------------------------------------------------------------------------
// Write tools (see docs/api/transactions.md §2). The UI always GETs the transaction
// and PUTs the whole object back with the changed fields, so we do the same.
// ---------------------------------------------------------------------------

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const TRANSACTION_CATEGORIES = [
  // with next steps (normally create/link a document)
  "professionalIncome", "professionalExpense", "creditNoteOnSales", "creditNoteOnPurchase", "interest", "cashback",
  // pure categories ("Autre" sub-types, personal, taxes, loans…)
  "VATReimbursement", "incomeTaxReimbursement", "withholdingTaxReimbursement", "incomingLoan", "incomingLoanReimbursement",
  "incomingCapitalMovement", "otherProfessionalIncomingPayment", "realEstateActivities", "financialIncome",
  "miscellaneousActivities", "otherNonProfessionalIncome", "personalIncomingPayment", "VATPayment", "withholdingTaxPayment",
  "incomeTaxPayment", "incomeTaxPrePayment", "outgoingLoan", "outgoingLoanReimbursement", "outgoingCapitalMovement",
  "otherProfessionalOutgoingPayment", "personalOutgoingPayment", "socialContributions", "creditCardReimbursement",
  "companyTaxPayment", "companyTaxPrePayment", "companyTaxReimbursement", "tradeTaxPrePayment",
] as const;

/** Categories that need a taxPeriod, with the frequency the UI uses (BE). VAT follows the company's VAT frequency. */
const TAX_PERIOD_FREQUENCY: Record<string, "yearly" | "quarterly" | "vat"> = {
  VATPayment: "vat",
  VATReimbursement: "vat",
  incomeTaxPayment: "yearly",
  incomeTaxReimbursement: "yearly",
  companyTaxPayment: "yearly",
  companyTaxReimbursement: "yearly",
  incomeTaxPrePayment: "quarterly",
  companyTaxPrePayment: "quarterly",
  socialContributions: "quarterly",
};
const MARK_TAX_PAID_CATEGORIES = new Set(["VATPayment", "VATReimbursement", "incomeTaxPayment", "incomeTaxPrePayment", "incomeTaxReimbursement"]);

type MatchedItem = { type: "expense" | "invoice"; documentId: string; isCreditNote?: boolean; amount?: number };

async function getTx(id: string): Promise<Transaction> {
  return api.get<Transaction>(`/v1/transactions/${encodeURIComponent(id)}`, { query: { lang: "fr", expense_version: 3 } });
}

async function putTx(tx: Transaction, changes: Record<string, unknown>): Promise<Transaction> {
  const { matchedItemsDetails: _details, ...rest } = tx as Transaction & { matchedItemsDetails?: unknown };
  const body = {
    ...rest,
    ...changes,
    valueDate: typeof tx.valueDate === "string" ? tx.valueDate.slice(0, 10) : tx.valueDate,
    _source: "mcp",
  };
  return api.put<Transaction>(`/v1/transactions/${encodeURIComponent(tx._id)}`, body);
}

/** Amount the UI stores on a matched item: the document's full absolute amount. */
async function documentLink(type: "expense" | "revenue", id: string): Promise<MatchedItem> {
  if (type === "expense") {
    const { expense: e } = await api.get<{ expense: { _id: string; baseCurrencyAmount?: number; currencyAmount?: number; isCreditNote?: boolean } }>(
      `/v3/expenses/${encodeURIComponent(id)}`,
      { query: { lang: "fr" } },
    );
    return { type: "expense", documentId: e._id, isCreditNote: Boolean(e.isCreditNote), amount: Math.abs(e.baseCurrencyAmount ?? e.currencyAmount ?? 0) };
  }
  const r = await api.get<{ _id: string; type?: string; baseCurrencyTotalAmountInclVAT?: number; totalAmountInclVAT?: number }>(
    `/v2/revenues/${encodeURIComponent(id)}`,
  );
  const isCreditNote = r.type === "credit-note";
  const amount = Math.abs((r.baseCurrencyTotalAmountInclVAT ?? r.totalAmountInclVAT ?? 0) / 1000);
  return { type: "invoice", documentId: r._id, isCreditNote, amount: isCreditNote ? -amount : amount };
}

/** Link documents to a transaction the way the bank panel does (shared with the invoice importer). */
export async function linkDocuments(
  txId: string,
  expenseIds: string[],
  revenueIds: string[],
  mode: "append" | "replace" = "append",
): Promise<{ tx: Transaction; updated: Transaction; linkedTotal: number }> {
  const tx = await getTx(txId);
  const links = await Promise.all([
    ...expenseIds.map((id) => documentLink("expense", id)),
    ...revenueIds.map((id) => documentLink("revenue", id)),
  ]);
  const existing = (mode === "append" ? tx.matchedItems ?? [] : []) as MatchedItem[];
  const byId = new Map(existing.map((m) => [m.documentId, m]));
  for (const l of links) byId.set(l.documentId, l);
  // Existing items read back from the API carry no amount; resolve them like the UI does.
  const matchedItems = await Promise.all(
    [...byId.values()].map((m) => (m.amount !== undefined ? m : documentLink(m.type === "expense" ? "expense" : "revenue", m.documentId))),
  );
  let category = tx.transactionCategory ?? null;
  if (!category) {
    const first = links[0];
    category =
      first.type === "expense"
        ? first.isCreditNote ? "creditNoteOnPurchase" : "professionalExpense"
        : first.isCreditNote ? "creditNoteOnSales" : "professionalIncome";
  }
  const updated = await putTx(tx, { matchedItems, transactionCategory: category });
  const linkedTotal = Math.round(matchedItems.reduce((sum, m) => sum + Math.abs(m.amount ?? 0), 0) * 100) / 100;
  return { tx, updated, linkedTotal };
}

/** Remove one document from a transaction's links; unclassifies the transaction if nothing is left. */
export async function unlinkDocument(txId: string, documentId: string): Promise<Transaction> {
  const tx = await getTx(txId);
  const after = ((tx.matchedItems ?? []) as MatchedItem[]).filter((m) => m.documentId !== documentId);
  return putTx(tx, after.length ? { matchedItems: after } : { matchedItems: [], transactionCategory: null, taxPeriod: null });
}

function taxPeriodFor(category: string, date: string, vatFrequency: "quarterly" | "monthly" | "yearly", year?: number, quarter?: number, month?: number) {
  const kind = TAX_PERIOD_FREQUENCY[category];
  if (!kind) return null;
  const frequency = kind === "vat" ? vatFrequency : kind;
  const d = new Date(date);
  const y = year ?? d.getUTCFullYear();
  if (frequency === "yearly") return { year: y, frequency };
  if (frequency === "monthly") return { year: y, month: month ?? d.getUTCMonth() + 1, frequency };
  return { year: y, quarter: quarter ?? Math.floor(d.getUTCMonth() / 3) + 1, frequency };
}

export function registerTransactionWriteTools(server: McpServer): void {
  server.registerTool(
    "accountable_suggest_transaction_classification",
    {
      title: "Suggested classification for a transaction",
      description:
        "Accountable's own suggestion for an unclassified transaction (guessedAction: create|import|scan|link_existing|classify_as, " +
        "guessedDocumentType, guessedCategory and a candidate expense/invoice). Read-only.",
      inputSchema: { id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ id }) =>
      run(async () => ({
        suggestion: await api.get(`/v1/transactions/${encodeURIComponent(id)}/guess-classification-action`, {
          query: { lang: "fr", expense_version: 3 },
        }),
      })),
  );

  server.registerTool(
    "accountable_classify_transaction",
    {
      title: "Classify a bank transaction",
      description:
        "Set a bank transaction's category WITHOUT linking a document (clears existing links). Use for personal payments " +
        "(personalOutgoingPayment / personalIncomingPayment), tax payments (VATPayment, companyTaxPrePayment, …), loans, " +
        "capital movements, 'other professional' payments, or professionalExpense/professionalIncome when no document exists. " +
        "To attach invoices use accountable_link_transaction instead. Tax categories get a taxPeriod derived from the " +
        "transaction date unless year/quarter/month are given.",
      inputSchema: {
        id: z.string().describe("Transaction _id"),
        category: z.enum(TRANSACTION_CATEGORIES),
        tax_year: z.number().int().optional(),
        tax_quarter: z.number().int().min(1).max(4).optional(),
        tax_month: z.number().int().min(1).max(12).optional(),
        vat_frequency: z.enum(["quarterly", "monthly", "yearly"]).default("quarterly").describe("Company VAT return frequency"),
        mark_tax_item_paid: z.boolean().optional().describe("For VAT/income-tax payments: also mark the matching tax item as paid"),
      },
      annotations: WRITE,
    },
    async (p) =>
      run(async () => {
        const tx = await getTx(p.id);
        const date = (tx.valueDate ?? tx.executionDate ?? new Date().toISOString()).slice(0, 10);
        const changes: Record<string, unknown> = {
          transactionCategory: p.category,
          matchedItems: [],
          taxPeriod: taxPeriodFor(p.category, date, p.vat_frequency, p.tax_year, p.tax_quarter, p.tax_month),
        };
        if (MARK_TAX_PAID_CATEGORIES.has(p.category) && p.mark_tax_item_paid !== undefined) {
          changes.shouldUpdateTaxStatus = p.mark_tax_item_paid;
        }
        const updated = await putTx(tx, changes);
        return { transaction: summarizeTransaction(updated), previous_classification: tx.transactionCategory ?? null, previous_links: tx.matchedItems ?? [] };
      }),
  );

  server.registerTool(
    "accountable_unclassify_transaction",
    {
      title: "Unclassify a bank transaction ('Déclasser')",
      description: "Remove the category AND all linked documents from a transaction, putting it back to 'À classer'.",
      inputSchema: { id: z.string() },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ id }) =>
      run(async () => {
        const tx = await getTx(id);
        const updated = await putTx(tx, { transactionCategory: null, matchedItems: [], taxPeriod: null });
        return { transaction: summarizeTransaction(updated), removed_classification: tx.transactionCategory ?? null, removed_links: tx.matchedItems ?? [] };
      }),
  );

  server.registerTool(
    "accountable_link_transaction",
    {
      title: "Link a bank transaction to expenses/revenues",
      description:
        "Link ONE bank transaction to one or more documents ('Lier à une dépense existante'), e.g. one Amazon card debit " +
        "covering 3 invoices. By default appends to existing links (mode='append'); mode='replace' sets exactly the given list. " +
        "Sets the category to professionalExpense / professionalIncome (or credit-note variants) when none is set. " +
        "Returns the linked total vs. the transaction amount so you can check nothing is left to link.",
      inputSchema: {
        id: z.string().describe("Transaction _id"),
        expense_ids: z.array(z.string()).default([]),
        revenue_ids: z.array(z.string()).default([]),
        mode: z.enum(["append", "replace"]).default("append"),
      },
      annotations: WRITE,
    },
    async (p) =>
      run(async () => {
        if (!p.expense_ids.length && !p.revenue_ids.length) throw new Error("Give at least one expense_id or revenue_id.");
        const { tx, updated, linkedTotal } = await linkDocuments(p.id, p.expense_ids, p.revenue_ids, p.mode);
        return {
          transaction: summarizeTransaction(updated),
          transaction_amount: Math.abs(tx.amount),
          linked_total: linkedTotal,
          remaining_to_link: Math.round((Math.abs(tx.amount) - linkedTotal) * 100) / 100,
        };
      }),
  );

  server.registerTool(
    "accountable_unlink_transaction_document",
    {
      title: "Unlink one document from a transaction",
      description: "Remove a single expense/revenue link from a bank transaction, keeping the other links and the category.",
      inputSchema: { id: z.string().describe("Transaction _id"), document_id: z.string().describe("Expense or revenue _id to unlink") },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ id, document_id }) =>
      run(async () => {
        const tx = await getTx(id);
        const before = (tx.matchedItems ?? []) as MatchedItem[];
        const after = before.filter((m) => m.documentId !== document_id);
        if (after.length === before.length) throw new Error(`Document ${document_id} is not linked to transaction ${id}.`);
        const updated = await putTx(tx, { matchedItems: after });
        return { transaction: summarizeTransaction(updated) };
      }),
  );
}
