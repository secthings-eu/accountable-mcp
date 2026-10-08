import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gmailProbe, learnSupplierAliases, proposeProviders, saveLearnedAliases, saveLocalProviders } from "../services/learn.js";
import { run } from "../services/format.js";

/**
 * "LLM in the loop" configuration tools: extraction tools return evidence, the agent reviews it
 * (rules in the setup skill, asking the user when unsure) and the save tools write only what was
 * approved to ~/.config/accountable-mcp/providers.json. Nothing here writes to Accountable.
 */

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);
const lastYear = () => `${new Date().getUTCFullYear() - 1}-01-01`;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE_LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerLearnTools(server: McpServer): void {
  server.registerTool(
    "accountable_learn_suppliers",
    {
      title: "Propose supplier aliases from the user's own linked payments",
      description:
        "Extraction step (no writes): for every bank transaction already linked to an expense, compare the bank counterparty / " +
        "merchant text with the supplier on the expense and propose `[regex, display]` aliases the normaliser does not resolve yet, " +
        "with evidence (raw texts, counts). Also returns `conflicts`: payments whose bank text is one known brand but are linked to " +
        "another supplier's expense (probably wrong links to fix). Review the proposals, then write the good ones with " +
        "accountable_save_supplier_aliases.",
      inputSchema: {
        since: ISO.default(lastYear()).describe("Only links of transactions from this date on"),
        until: ISO.default(today()),
        min_count: z.number().int().min(1).default(1).describe("Keep proposals seen at least this many times"),
      },
      annotations: READ,
    },
    async ({ since, until, min_count }) =>
      run(async () => {
        const { aliases, conflicts, links_examined } = await learnSupplierAliases(since, until);
        return {
          links_examined,
          proposed: aliases.filter((a) => a.count >= min_count).map((a) => ({ pattern: a.pattern, display: a.display, count: a.count, seen: a.seen.slice(0, 3) })),
          conflicts,
          next: "Review each proposal (keep genuine synonyms of one supplier; drop generic words, one-off shops, anything ambiguous), then call accountable_save_supplier_aliases.",
        };
      }),
  );

  server.registerTool(
    "accountable_save_supplier_aliases",
    {
      title: "Save reviewed supplier aliases",
      description:
        "Write the aliases you approved to ~/.config/accountable-mcp/providers.json (`learned_aliases`). Hand-written `supplier_aliases` " +
        "are never touched. replace=true rewrites the learned list instead of merging. Restart the MCP for them to take effect.",
      inputSchema: {
        aliases: z.array(z.object({ pattern: z.string().min(2).describe("Case-insensitive regex source matched against bank/supplier text"), display: z.string().min(1) })).max(500),
        replace: z.boolean().default(false),
      },
      annotations: WRITE_LOCAL,
    },
    async ({ aliases, replace }) => run(async () => ({ ...(await saveLearnedAliases(aliases, replace)) })),
  );

  server.registerTool(
    "accountable_propose_providers",
    {
      title: "Propose suppliers that deserve an invoice-fetching module",
      description:
        "Extraction step (no writes): recurring suppliers in the period whose documents are added by hand (origin manual / dropzone / " +
        "upload) and that no provider module covers, with counts, totals, name variants and sample expense ids. For each candidate the " +
        "agent then finds where its invoices live (accountable_gmail_search with 1-3 candidate queries; otherwise a portal URL) and " +
        "saves a module with accountable_save_providers.",
      inputSchema: {
        since: ISO.default(lastYear()),
        until: ISO.default(today()),
        min_expenses: z.number().int().min(1).default(2),
      },
      annotations: READ,
    },
    async ({ since, until, min_expenses }) => run(async () => ({ ...(await proposeProviders(since, until, min_expenses)) })),
  );

  server.registerTool(
    "accountable_gmail_search",
    {
      title: "Probe a mailbox with a Gmail query (read-only)",
      description:
        "Run a Gmail search in a connected mailbox and return date/from/subject/attachment names of the first results, so you can " +
        "verify a provider query before saving it (e.g. `from:billing@example.com has:attachment filename:pdf`). Read-only; bodies are not returned.",
      inputSchema: {
        mailbox: z.string().default("work"),
        query: z.string().min(2),
        max: z.number().int().min(1).max(25).default(10),
      },
      annotations: READ,
    },
    async ({ mailbox, query, max }) => run(async () => ({ mailbox, query, results: await gmailProbe(mailbox, query, max) })),
  );

  server.registerTool(
    "accountable_save_providers",
    {
      title: "Save reviewed provider modules",
      description:
        "Write provider modules you verified to ~/.config/accountable-mcp/providers.json (`providers`, merged by id). Kinds: gmail-attachment " +
        "(mailboxes, query, attachment regex), gmail-html (mailboxes, query, optional subject regex), portal (url, note). Restart the MCP afterwards.",
      inputSchema: {
        providers: z
          .array(
            z.object({
              id: z.string().regex(/^[a-z0-9-]+$/),
              supplier: z.string().min(1).describe("Display name as used on the expenses"),
              source: z.object({
                kind: z.enum(["gmail-attachment", "gmail-html", "portal"]),
                mailboxes: z.array(z.string()).optional(),
                query: z.string().optional(),
                attachment: z.string().optional().describe("Regex source for the invoice attachment filename"),
                subject: z.string().optional().describe("Regex source the subject must match (gmail-html)"),
                url: z.string().optional(),
                note: z.string().optional(),
              }),
            }),
          )
          .min(1)
          .max(100),
      },
      annotations: WRITE_LOCAL,
    },
    async ({ providers }) => run(async () => ({ ...(await saveLocalProviders(providers)) })),
  );
}
