import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../services/client.js";
import { run } from "../services/format.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Revenue amounts and quantities are stored x1000 (verified live: 775000 = 775.00 EUR, VATRate 210 = 21%). */
export const fromMilli = (v: unknown): number | null => (typeof v === "number" ? v / 1000 : null);

interface Revenue {
  _id: string;
  type?: string;
  status?: string;
  revenueNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  client?: { name?: string };
  totalAmountExclVAT?: number;
  totalVATAmount?: number;
  totalAmountInclVAT?: number;
  transactions?: unknown[];
  createdFrom?: string;
  currency?: string;
  [key: string]: unknown;
}

function summarizeRevenue(r: Revenue): Record<string, unknown> {
  return {
    id: r._id,
    type: r.type ?? null,
    number: r.revenueNumber ?? null,
    status: r.status ?? null,
    client: r.client?.name ?? null,
    invoice_date: r.invoiceDate?.slice(0, 10) ?? null,
    due_date: r.dueDate?.slice(0, 10) ?? null,
    total_excl_vat: fromMilli(r.totalAmountExclVAT),
    vat: fromMilli(r.totalVATAmount),
    total_incl_vat: fromMilli(r.totalAmountInclVAT),
    currency: r.currency ?? null,
    linked_transactions: r.transactions?.length ?? 0,
    created_from: r.createdFrom ?? null,
  };
}

export function registerRevenueTools(server: McpServer): void {
  server.registerTool(
    "accountable_list_revenues",
    {
      title: "List revenues (sales invoices)",
      description:
        "List sales invoices and credit notes, newest first: number, client, dates, status, totals in EUR " +
        "(converted from Accountable's x1000 storage) and number of linked bank transactions.",
      inputSchema: {
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(25),
      },
      annotations: READ_ONLY,
    },
    async ({ page, per_page }) =>
      run(async () => {
        const res = await api.get<{ data: Revenue[]; paging: { page?: number; pageCount?: number; totalCount?: number } }>(
          "/v2/revenues",
          { query: { page, perPage: per_page } },
        );
        return {
          total: res.paging.totalCount ?? null,
          page,
          has_more: res.paging.pageCount ? page < res.paging.pageCount : null,
          revenues: res.data.map(summarizeRevenue),
        };
      }),
  );

  server.registerTool(
    "accountable_get_revenue",
    {
      title: "Get revenue",
      description: "Full raw revenue (invoice/credit note) by id, with linked transactions expanded. Amounts are x1000.",
      inputSchema: { id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ id }) =>
      run(async () => ({
        revenue: await api.get(`/v2/revenues/${encodeURIComponent(id)}`, { query: { expand: ["transactions", "taxLock"] } }),
      })),
  );
}
