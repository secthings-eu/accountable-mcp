import { api } from "./client.js";

/** Subset of the Expense model returned by GET /v3/expenses (see docs/api/expenses.md). */
export interface Expense {
  _id: string;
  supplier?: { name?: string };
  expenseDate?: string;
  expenseDateNumber?: number;
  isValidated?: boolean;
  isInvoice?: boolean;
  isCreditNote?: boolean;
  sufficientlyDocumented?: boolean;
  createdFrom?: string;
  autofiledAt?: string;
  currency?: string;
  currencyAmount?: number;
  baseCurrencyAmount?: number;
  VATAmount?: number;
  file?: { name?: string; path?: string } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: Array<Record<string, any>>;
  payments?: { status?: unknown; transactions?: unknown[] };
  period?: { year?: number; quarter?: number; month?: number };
  [key: string]: unknown;
}

interface ExpensesPage {
  expenses: Expense[];
  paging: { page: number; per_page: number; total_pages: number; total_count: number };
}

export interface ExpenseFilters {
  /** VAT period years, e.g. [2026]. The API accepts plain years only (quarter objects are ignored). */
  years?: number[];
  search?: string;
  is_validated?: boolean;
  is_credit_note?: boolean;
  sort?: string;
}


export function listExpensesPage(filters: ExpenseFilters, page: number, perPage: number): Promise<ExpensesPage> {
  return api.get<ExpensesPage>("/v3/expenses", {
    query: {
      page,
      per_page: perPage,
      lang: "fr",
      vat_period: filters.years?.map(String),
      search: filters.search,
      is_validated: filters.is_validated,
      is_credit_note: filters.is_credit_note,
      sort: filters.sort,
    },
  });
}

/** Fetch every page (bounded) for aggregate views. */
export async function listAllExpenses(filters: ExpenseFilters, maxPages = 50): Promise<Expense[]> {
  const out: Expense[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await listExpensesPage(filters, page, 100);
    out.push(...res.expenses);
    if (page >= res.paging.total_pages) break;
  }
  return out;
}

/** expenseDateNumber is YYYYMMDD; fall back to expenseDate. */
export function expenseDate(e: Expense): string | null {
  if (typeof e.expenseDateNumber === "number") {
    const s = String(e.expenseDateNumber);
    if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return typeof e.expenseDate === "string" ? e.expenseDate.slice(0, 10) : null;
}

export function summarizeExpense(e: Expense): Record<string, unknown> {
  return {
    id: e._id,
    supplier: e.supplier?.name ?? null,
    date: expenseDate(e),
    amount: e.currencyAmount ?? null,
    currency: e.currency ?? null,
    vat_amount: e.VATAmount ?? null,
    category: (() => {
      const c = e.items?.[0]?.category;
      return c && typeof c === "object" ? { id: c.id ?? c._id, title: c.title ?? c.displayName } : c ?? null;
    })(),
    validated: e.isValidated ?? null,
    credit_note: e.isCreditNote ?? false,
    has_document: Boolean(e.file?.path),
    linked_transactions: e.payments?.transactions?.length ?? 0,
    created_from: (e.origin as { process?: string } | undefined)?.process ?? e.createdFrom ?? null,
    vat_period: e.period ?? null,
  };
}

/**
 * All expenses whose document date falls in [from, to]. Does NOT use the vat_period filter, because
 * expenses still in "Revoir" have no VAT period yet and would be silently excluded.
 */
export async function listExpensesBetween(from: string, to: string): Promise<Expense[]> {
  const all = await listAllExpenses({}, 60);
  return all.filter((e) => {
    const d = expenseDate(e);
    return d !== null && d >= from && d <= to;
  });
}
