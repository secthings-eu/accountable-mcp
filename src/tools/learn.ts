import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { learnSupplierAliases, saveLearnedAliases } from "../services/learn.js";
import { run } from "../services/format.js";

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);
const lastYear = () => `${new Date().getUTCFullYear() - 1}-01-01`;

export function registerLearnTools(server: McpServer): void {
  server.registerTool(
    "accountable_learn_suppliers",
    {
      title: "Learn supplier aliases from the user's own books",
      description:
        "Derive supplier name aliases from bank transactions already linked to expenses (bank counterparty / merchant text → " +
        "supplier shown on the expense) and store them in ~/.config/accountable-mcp/providers.json (learned_aliases). " +
        "Improves payment↔invoice matching for the invoice importer and coverage reports. Run once after setup and again " +
        "occasionally; dry_run=true only proposes. Nothing is written to Accountable.",
      inputSchema: {
        since: ISO.default(lastYear()).describe("Only links of transactions from this date on"),
        until: ISO.default(today()),
        dry_run: z.boolean().default(false),
        min_count: z.number().int().min(1).default(1).describe("Keep aliases seen at least this many times"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ since, until, dry_run, min_count }) =>
      run(async () => {
        const { aliases, links_examined } = await learnSupplierAliases(since, until);
        const kept = aliases.filter((a) => a.count >= min_count);
        const saved = dry_run ? null : await saveLearnedAliases(kept);
        return {
          links_examined,
          proposed: kept.map((a) => ({ pattern: a.pattern, display: a.display, count: a.count, seen: a.seen.slice(0, 3) })),
          saved,
          note: "Restart the MCP (or re-run the CLI) for new aliases to take effect; edit learned_aliases in providers.json to prune.",
        };
      }),
  );
}
