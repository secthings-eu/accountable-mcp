import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError } from "../services/client.js";
import {
  expenseDate,
  listAllExpenses,
  listExpensesBetween,
  listExpensesPage,
  summarizeExpense,
  type Expense,
} from "../services/expenses.js";
import { run } from "../services/format.js";
import { isAutomaticOrigin, normalizeSupplier } from "../services/suppliers.js";
import { uploadLocalFile } from "../services/upload.js";
import { UPLOAD_TIMEOUT_MS } from "../constants.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const dateRange = {
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only expenses dated on/after this day (YYYY-MM-DD)"),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only expenses dated on/before this day (YYYY-MM-DD)"),
};

function inRange(e: Expense, from?: string, to?: string): boolean {
  const d = expenseDate(e);
  if (!d) return !from && !to;
  return (!from || d >= from) && (!to || d <= to);
}

export function registerExpenseTools(server: McpServer): void {
  server.registerTool(
    "accountable_list_expenses",
    {
      title: "List Accountable expenses",
      description:
        "List expenses (purchase invoices/receipts) with compact fields: id, supplier, date, amount, VAT, category, " +
        "validated flag, whether a document is attached, number of linked bank transactions and created_from " +
        "(web|dropzone|mobile = uploaded manually; email|peppol|experts = arrived automatically). " +
        "Filter by VAT-period years and/or a date range (date range is applied client-side over all pages).",
      inputSchema: {
        years: z.array(z.number().int().min(2015).max(2100)).optional().describe("VAT period years, e.g. [2026]"),
        ...dateRange,
        search: z.string().optional().describe("Free-text search (supplier name, etc.)"),
        is_validated: z.boolean().optional().describe("false = only expenses still marked 'Revoir'"),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(50),
      },
      annotations: READ_ONLY,
    },
    async (p) =>
      run(async () => {
        const filters = { years: p.years, search: p.search, is_validated: p.is_validated };
        if (p.date_from || p.date_to) {
          const all = (await listAllExpenses(filters)).filter((e) => inRange(e, p.date_from, p.date_to));
          const start = (p.page - 1) * p.per_page;
          return {
            total: all.length,
            page: p.page,
            has_more: start + p.per_page < all.length,
            expenses: all.slice(start, start + p.per_page).map(summarizeExpense),
          };
        }
        const res = await listExpensesPage(filters, p.page, p.per_page);
        return {
          total: res.paging.total_count,
          page: res.paging.page,
          has_more: res.paging.page < res.paging.total_pages,
          expenses: res.expenses.map(summarizeExpense),
        };
      }),
  );

  server.registerTool(
    "accountable_get_expense",
    {
      title: "Get Accountable expense",
      description:
        "Full raw expense record by id, optionally expanding linked bank transactions (expand=payments.transactions).",
      inputSchema: {
        id: z.string().describe("Expense _id"),
        expand_transactions: z.boolean().default(true),
      },
      annotations: READ_ONLY,
    },
    async ({ id, expand_transactions }) =>
      run(async () => {
        const { expense } = await api.get<{ expense: Record<string, unknown> }>(`/v3/expenses/${encodeURIComponent(id)}`, {
          query: { lang: "fr", expand: expand_transactions ? ["payments.transactions", "taxLock"] : undefined },
        });
        return { expense };
      }),
  );

  server.registerTool(
    "accountable_list_suppliers",
    {
      title: "List suppliers from expenses",
      description:
        "Aggregate expenses by supplier for the given years/date range: number of documents, total amount, " +
        "first/last date, and how the documents arrived (created_from counts). Set exclude_automatic=true to " +
        "drop suppliers whose documents all arrived automatically (PEPPOL, email inbox forwarding, recurrences). Supplier name variants (e.g. Amazon EU SARL / Amazon Fr) are merged. " +
        "Use this to know which suppliers need invoices fetched manually.",
      inputSchema: {
        years: z.array(z.number().int()).default([new Date().getFullYear()]).describe("VAT period years"),
        ...dateRange,
        exclude_automatic: z.boolean().default(false).describe("Drop suppliers whose documents all arrived via PEPPOL, email inbox or accountant"),
        include_origin: z.boolean().default(false).describe("Fetch each expense's origin (slower: one request per expense). Implied by exclude_automatic."),
      },
      annotations: READ_ONLY,
    },
    async (p) =>
      run(async () => {
        // Not filtered by vat_period: "Revoir" expenses have no VAT period yet and would be missed.
        const from = p.date_from ?? `${Math.min(...p.years)}-01-01`;
        const to = p.date_to ?? `${Math.max(...p.years)}-12-31`;
        const all = await listExpensesBetween(from, to);
        // The list payload has no origin; it is only on GET /v3/expenses/:id as origin.process.
        const origins = new Map<string, string>();
        if (p.include_origin || p.exclude_automatic) {
          const queue = [...all];
          await Promise.all(
            Array.from({ length: 6 }, async () => {
              for (let e = queue.shift(); e; e = queue.shift()) {
                const { expense: full } = await api.get<{ expense: { origin?: { process?: string; from?: string } } }>(`/v3/expenses/${encodeURIComponent(e._id)}`);
                origins.set(e._id, full.origin?.process ?? full.origin?.from ?? "unknown");
              }
            }),
          );
        }
        type Group = { name: string; aliases: Set<string>; count: number; total: number; first: string | null; last: string | null; sources: Record<string, number>; manual: number };
        const groups = new Map<string, Group>();
        for (const e of all) {
          const raw = (e.supplier?.name ?? "(unknown)").trim();
          const { key, display } = normalizeSupplier(raw);
          const g = groups.get(key) ?? { name: display, aliases: new Set<string>(), count: 0, total: 0, first: null, last: null, sources: {}, manual: 0 };
          const d = expenseDate(e);
          const src = origins.get(e._id) ?? "not_checked";
          g.aliases.add(raw);
          g.count++;
          g.total += e.currencyAmount ?? 0;
          if (d && (!g.first || d < g.first)) g.first = d;
          if (d && (!g.last || d > g.last)) g.last = d;
          g.sources[src] = (g.sources[src] ?? 0) + 1;
          if (!isAutomaticOrigin(src)) g.manual++;
          groups.set(key, g);
        }
        let suppliers = [...groups.values()].map((g) => ({
          name: g.name,
          aliases: [...g.aliases].filter((a) => a !== g.name),
          documents: g.count,
          manual_documents: origins.size ? g.manual : null,
          total_amount: Math.round(g.total * 100) / 100,
          first_date: g.first,
          last_date: g.last,
          created_from: g.sources,
          automatic_only: origins.size ? g.manual === 0 : null,
        }));
        if (p.exclude_automatic) suppliers = suppliers.filter((s) => !s.automatic_only);
        suppliers.sort((a, b) => b.documents - a.documents);
        return { expenses_scanned: all.length, supplier_count: suppliers.length, suppliers };
      }),
  );
}

// ---------------------------------------------------------------------------
// Write tools (docs/api/expenses.md §0, §1, §4.1)
// ---------------------------------------------------------------------------

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const VAT_REGIMES = ["standard", "eu-reverse-charge", "local-reverse-charge", "extra-eu-supplier", "franchisee-supplier", "exempt-item", "foreign-vat"] as const;

type RawExpense = Expense & {
  currencyRate?: number | null;
  notes?: string | null;
  taxPeriod?: unknown;
  accountantReview?: { reviewStatus?: string };
  taxLock?: unknown[];
  user?: { VATType?: string; VATReturnFrequency?: string; country?: string };
  payments?: { cash?: boolean; other_accounts?: boolean; transactions?: unknown[]; status?: Record<string, unknown>; suggested_method?: string };
};

const toDateNumber = (d: string) => Number(d.replace(/-/g, ""));

/** Rebuild the body the web form sends on "Sauvegarder" (formatExpenseForSubmit) from a stored expense. */
function toSubmit(e: RawExpense): Record<string, unknown> {
  return {
    _id: e._id,
    supplier: { name: e.supplier?.name ?? "" },
    expenseDateNumber: e.expenseDateNumber,
    currency: e.currency ?? "EUR",
    currencyRate: e.currencyRate ?? 1,
    items: (e.items ?? []).map((i) => ({
      _id: i._id ?? null,
      name: i.name ?? null,
      currencyAmount: i.currencyAmount,
      VATRate: i.VATRate ?? null,
      localVATRate: i.localVATRate ?? null,
      VATRegime: i.VATRegime,
      category: i.category,
      professionalPart: i.professionalPart ?? 1,
      incomeTaxDeductibility: i.incomeTaxDeductibility,
      maxDeductibleVAT: i.maxDeductibleVAT,
      isAsset: i.isAsset ?? false,
      amortizationPeriod: i.amortizationPeriod ?? null,
      vehicle: i.vehicle,
    })),
    isInvoice: e.isInvoice ?? false,
    isCreditNote: e.isCreditNote ?? false,
    isFake: e.isFake ?? false,
    notes: e.notes ?? null,
    user: e.user,
    period: e.period ?? null,
    taxPeriod: e.taxPeriod ?? null,
    file: e.file?.path ? { path: e.file.path, name: e.file.name ?? e.file.path.split("/").pop() } : null,
    payments: {
      cash: e.payments?.cash ?? false,
      other_accounts: e.payments?.other_accounts ?? false,
      transactions: (e.payments?.transactions ?? []).map((t) => (typeof t === "string" ? t : (t as { _id: string })._id)),
      suggested_method: e.payments?.suggested_method,
      status: e.payments?.status ?? {},
    },
  };
}

async function getRawExpense(id: string): Promise<RawExpense> {
  const res = await api.get<{ expense: RawExpense }>(`/v3/expenses/${encodeURIComponent(id)}`, { query: { lang: "fr", expand: ["taxLock"] } });
  return res.expense;
}

function isLocked(e: RawExpense): boolean {
  return e.accountantReview?.reviewStatus === "reviewed" || (e.taxLock?.length ?? 0) > 0;
}

async function findCategory(id: string): Promise<Record<string, unknown>> {
  const tree = await api.get<unknown>("/v1/expenses/categories/be", { query: { lang: "fr" } });
  const stack: unknown[] = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.id === id || o._id === id) return o;
      stack.push(...Object.values(o).filter((v) => v && typeof v === "object"));
    }
  }
  throw new Error(`Category ${id} not found; use accountable_search_expense_categories.`);
}

export interface UpdateExpenseParams {
  /** EUR value for a foreign-currency expense (sets the exchange rate so base amount = bank debit). */
  eur_amount?: number;
  id: string;
  supplier_name?: string;
  date?: string;
  notes?: string;
  is_invoice?: boolean;
  vat_period?: { year: number; quarter?: number; month?: number };
  item_index?: number;
  amount?: number;
  vat_rate_percent?: number;
  vat_regime?: (typeof VAT_REGIMES)[number];
  professional_percent?: number;
  category_id?: string;
  payment_status?: "paid" | "unpaid";
  /** Replace all lines by the first one (used when a merged multi-receipt PDF was OCR'd into several lines). */
  collapse_to_single_line?: boolean;
}

/** Same as the side panel's "Sauvegarder": rebuild the submit body, apply changes, PUT (also validates). */
export async function updateExpense(p: UpdateExpenseParams): Promise<Expense> {
  const current = await getRawExpense(p.id);
  if (isLocked(current)) throw new Error("Expense is locked (reviewed by accountant or included in a filed tax return); edit it in the web app.");
  const body = toSubmit(current) as Record<string, any>;
  if (p.collapse_to_single_line && body.items.length > 1) body.items = [body.items[0]];
  if (p.supplier_name !== undefined) body.supplier = { name: p.supplier_name };
  if (p.date) body.expenseDateNumber = toDateNumber(p.date);
  if (p.notes !== undefined) body.notes = p.notes;
  if (p.is_invoice !== undefined) body.isInvoice = p.is_invoice;
  if (p.vat_period) body.period = p.vat_period;
  // OCR sometimes leaves the VAT period empty, but the PUT requires it: derive it from the expense date
  // and the user's VAT return frequency, as the web form does.
  if (!body.period && body.expenseDateNumber) {
    const ds = String(body.expenseDateNumber);
    const year = Number(ds.slice(0, 4));
    const month = Number(ds.slice(4, 6));
    const freq = current.user?.VATReturnFrequency ?? "quarterly";
    body.period = freq === "monthly" ? { year, month } : freq === "yearly" ? { year } : { year, quarter: Math.ceil(month / 3) };
  }
  const idx = p.item_index ?? 0;
  const item = body.items[idx];
  const touchesItem = [p.amount, p.vat_rate_percent, p.vat_regime, p.professional_percent, p.category_id].some((v) => v !== undefined);
  if (touchesItem && !item) throw new Error(`Expense has no line ${idx}.`);
  if (p.amount !== undefined) item.currencyAmount = p.amount;
  // Foreign-currency invoices: pin the EUR value to what the bank actually debited (card FX markup).
  if (p.eur_amount !== undefined) {
    if (!body.currency || body.currency === body.baseCurrency) throw new Error("eur_amount only applies to foreign-currency expenses.");
    body.currencyRate = Math.round((body.currencyAmount / p.eur_amount) * 100000) / 100000;
    body.baseCurrencyAmount = p.eur_amount;
    item.baseCurrencyAmount = p.eur_amount;
  }
  if (p.vat_rate_percent !== undefined) item.VATRate = p.vat_rate_percent / 100;
  if (p.vat_regime !== undefined) {
    item.VATRegime = p.vat_regime;
    if (p.vat_regime === "foreign-vat") item.VATRate = null;
  }
  if (p.professional_percent !== undefined) item.professionalPart = p.professional_percent / 100;
  if (p.category_id) item.category = await findCategory(p.category_id);
  if (p.payment_status) body.payments.status = { ...body.payments.status, type: p.payment_status };
  const put = () =>
    api.put<{ expense?: Expense } & Expense>(`/v3/expenses/${encodeURIComponent(p.id)}`, { expense: body, options: { update_tax_status: false } });
  let res: { expense?: Expense } & Expense;
  try {
    res = await put();
  } catch (err) {
    // Tax-type categories (e.g. 618020 social contributions) also require a taxPeriod; OCR leaves it null.
    if (!(err instanceof ApiError) || !/taxPeriod-field-is-expected-object/.test(err.message) || !body.period) throw err;
    body.taxPeriod = { frequency: "quarterly", year: body.period.year, quarter: body.period.quarter ?? Math.ceil((body.period.month ?? 1) / 3) };
    res = await put();
  }
  return (res.expense ?? res) as Expense;
}

export function registerExpenseWriteTools(server: McpServer): void {
  server.registerTool(
    "accountable_create_expense_from_file",
    {
      title: "Create expense from a document",
      description:
        "Upload a local PDF/JPG/PNG/XML invoice (max 10 MB) and let Accountable OCR it into a new expense, exactly like the " +
        "'Uploader une nouvelle dépense' dropzone. Returns the created expense (supplier, date, amount, VAT as read by OCR) — " +
        "check it and fix fields with accountable_update_expense. Takes up to a few minutes for OCR.",
      inputSchema: { file_path: z.string().describe("Absolute path to the local file") },
      annotations: WRITE,
    },
    async ({ file_path }) =>
      run(async () => {
        const up = await uploadLocalFile(file_path, "expense");
        const res = await api.post<{ expense: Expense }>(
          "/v3/expenses/from-file",
          { file_name: up.key.split("/").pop(), file_path: up.key, is_fake: false },
          { query: { cache: Date.now() }, timeoutMs: UPLOAD_TIMEOUT_MS },
        );
        return { expense: summarizeExpense(res.expense), uploaded: up };
      }),
  );

  server.registerTool(
    "accountable_attach_expense_document",
    {
      title: "Attach/replace an expense's document",
      description: "Upload a local file and set it as the document of an existing expense (replaces any current attachment).",
      inputSchema: { expense_id: z.string(), file_path: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ expense_id, file_path }) =>
      run(async () => {
        const up = await uploadLocalFile(file_path, "document");
        const res = await api.patch<{ expense?: Expense } & Expense>(`/v3/expenses/${encodeURIComponent(expense_id)}`, {
          expense: { file: { path: up.key, name: up.name } },
        });
        return { expense: summarizeExpense((res.expense ?? res) as Expense), uploaded: up };
      }),
  );

  server.registerTool(
    "accountable_update_expense",
    {
      title: "Update / validate an expense",
      description:
        "Edit an expense like the side panel's 'Sauvegarder' (saving also removes the 'Revoir' flag, i.e. validates it). " +
        "Only the fields you pass change. Line-level fields apply to the single line of single-line expenses (or to item_index). " +
        "Rates are given in PERCENT here (21, 6, 0) and converted to Accountable's fractions. Refuses locked (accountant-reviewed / " +
        "tax-locked) expenses. Call with only id to just validate.",
      inputSchema: {
        id: z.string(),
        supplier_name: z.string().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        notes: z.string().optional(),
        is_invoice: z.boolean().optional().describe("'Facture en bonne et due forme' (invoice with your VAT number)"),
        vat_period: z.object({ year: z.number().int(), quarter: z.number().int().min(1).max(4).optional(), month: z.number().int().min(1).max(12).optional() }).optional(),
        item_index: z.number().int().min(0).default(0),
        amount: z.number().optional().describe("Gross amount incl. VAT for the line"),
        eur_amount: z.number().positive().optional().describe("Foreign-currency expenses only: EUR amount actually debited by the bank; adjusts the exchange rate"),
        vat_rate_percent: z.number().min(0).max(100).optional(),
        vat_regime: z.enum(VAT_REGIMES).optional().describe("Why VAT is 0 / reverse charge: eu-reverse-charge = intra-EU autoliquidation"),
        professional_percent: z.number().min(1).max(100).optional(),
        category_id: z.string().optional().describe("Category id from accountable_search_expense_categories"),
        payment_status: z.enum(["paid", "unpaid"]).optional(),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (p) => run(async () => ({ expense: summarizeExpense(await updateExpense(p)) })),
  );

  server.registerTool(
    "accountable_search_expense_categories",
    {
      title: "Search expense categories",
      description: "Search Accountable's (Belgian) expense categories by text, e.g. 'logiciel', 'restaurant', 'vélo'. Returns ids for accountable_update_expense.",
      inputSchema: { query: z.string().min(2) },
      annotations: READ_ONLY,
    },
    async ({ query }) =>
      run(async () => ({ results: await api.get("/v2/expenses/categories/search", { query: { text: query, search: query, lang: "fr" } }) })),
  );

  server.registerTool(
    "accountable_delete_expense",
    {
      title: "Delete an expense",
      description: "Permanently delete an expense (e.g. a duplicate). Cannot be undone. Linked bank transactions become unlinked.",
      inputSchema: { id: z.string(), confirm: z.literal(true).describe("Must be true") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) =>
      run(async () => {
        const before = summarizeExpense(await getRawExpense(id));
        await api.delete(`/v3/expenses/${encodeURIComponent(id)}`);
        return { deleted: before };
      }),
  );
}
