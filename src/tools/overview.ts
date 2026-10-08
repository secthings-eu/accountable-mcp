import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../services/client.js";
import { run } from "../services/format.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

interface TaxYear {
  data?: Record<string, { items?: Array<Record<string, unknown>> }>;
  meta?: { actionsRequired?: Record<string, number>; dueItems?: Record<string, Array<Record<string, unknown>>> };
}

interface Paged {
  paging?: { totalCount?: number; total_count?: number };
}

export function registerOverviewTools(server: McpServer): void {
  server.registerTool(
    "accountable_get_tax_overview",
    {
      title: "Tax overview for a year",
      description:
        "Tax obligations for a year (VAT returns per quarter, client listing, company/income tax, prepayments): " +
        "each item's type, period, status (done/not_done/unknown), due date and submission status, plus the " +
        "'actions required' counters for all years and overdue items. Same data as the 'Taxes' page.",
      inputSchema: { year: z.number().int().min(2015).max(2100).default(new Date().getFullYear()) },
      annotations: READ_ONLY,
    },
    async ({ year }) =>
      run(async () => {
        const res = await api.get<TaxYear>(`/v2/taxes/${year}`);
        const periods: Record<string, unknown[]> = {};
        for (const [period, block] of Object.entries(res.data ?? {})) {
          periods[period] = (block.items ?? []).map((i) => ({
            id: i._id,
            type: i.readableType ?? i.type,
            period: i.period,
            status: i.status,
            due_date: typeof i.dueDate === "string" ? i.dueDate.slice(0, 10) : i.dueDate,
            submission_status: i.submissionStatus ?? null,
          }));
        }
        const overdue = Object.values(res.meta?.dueItems ?? {})
          .flat()
          .filter((i) => i.hasDueDatePassed)
          .map((i) => ({ type: i.readableType ?? i.type, period: i.period, due_date: String(i.dueDate ?? "").slice(0, 10) }));
        return { year, actions_required_by_year: res.meta?.actionsRequired ?? {}, overdue, periods };
      }),
  );

  server.registerTool(
    "accountable_get_account_overview",
    {
      title: "Accountable account overview",
      description:
        "Counts that summarise the bookkeeping backlog: total expenses, bank transactions, transactions still to " +
        "classify, revenues, expenses still to review, plus Accountable's own feature counters. Good first call.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const count = (r: Paged) => r.paging?.totalCount ?? r.paging?.total_count ?? null;
        const [counters, expenses, toReview, txs, toClassify, revenues] = await Promise.all([
          api.get<Record<string, unknown>>("/v2/users/feature-counters"),
          api.get<Paged>("/v3/expenses", { query: { page: 1, per_page: 1 } }),
          api.get<Paged>("/v3/expenses", { query: { page: 1, per_page: 1, is_validated: false } }),
          api.get<Paged>("/v1/transactions", { query: { page: 1, perPage: 1, expense_version: 3 } }),
          api.get<Paged>("/v1/transactions", { query: { page: 1, perPage: 1, expense_version: 3, toClassify: "true" } }),
          api.get<Paged>("/v2/revenues", { query: { page: 1, perPage: 1 } }),
        ]);
        return {
          expenses: count(expenses),
          expenses_to_review: count(toReview),
          bank_transactions: count(txs),
          transactions_to_classify: count(toClassify),
          revenues: count(revenues),
          feature_counters: counters,
        };
      }),
  );
}
