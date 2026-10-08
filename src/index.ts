#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { login } from "./login.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { gmailLogin } from "./invoices/gmail.js";
import { browserLogin } from "./invoices/browser.js";
import { accountableLogin } from "./invoices/camofox.js";
import { saveAuth, type AuthData } from "./services/auth.js";
import { registerExpenseTools, registerExpenseWriteTools } from "./tools/expenses.js";
import { registerOverviewTools } from "./tools/overview.js";
import { registerRevenueTools } from "./tools/revenues.js";
import { registerTransactionTools, registerTransactionWriteTools } from "./tools/transactions.js";
import { registerSessionTools } from "./tools/session.js";
import { registerLoginTools } from "./tools/login.js";
import { registerLearnTools } from "./tools/learn.js";
import { learnSupplierAliases, saveLearnedAliases } from "./services/learn.js";

async function main(): Promise<void> {
  if (process.argv[2] === "login") {
    await login();
    return;
  }
  if (process.argv[2] === "learn-suppliers") {
    // Learn supplier aliases from the user's own linked transactions → ~/.config/accountable-mcp/providers.json
    const since = process.argv[3] ?? `${new Date().getUTCFullYear() - 1}-01-01`;
    const { aliases, conflicts, links_examined } = await learnSupplierAliases(since, new Date().toISOString().slice(0, 10));
    for (const a of aliases) process.stdout.write(`${a.display.padEnd(32)} ← /${a.pattern}/i   (${a.count}× e.g. "${a.seen[0]}")\n`);
    for (const c of conflicts) process.stdout.write(`CONFLICT ${c.date} "${c.bank_text}" resolves to ${c.resolves_to} but is linked to ${c.linked_supplier} (tx ${c.transaction_id}, expense ${c.linked_expense_id})\n`);
    const saved = await saveLearnedAliases(aliases);
    process.stdout.write(`${links_examined} linked payments examined; ${saved.added} new alias(es), ${saved.total} learned in ${saved.file}\n`);
    return;
  }
  if (process.argv[2] === "browser-login") {
    const site = process.argv[3];
    if (!site) throw new Error("Usage: accountable-mcp browser-login <site> [--inject]   (accountable, aliexpress)");
    if (site === "accountable") {
      // Camoufox profile; the user logs in themselves. --inject lets camofox's own vault fill the form.
      const auth = await accountableLogin({ inject: process.argv.includes("--inject") });
      await saveAuth(auth as AuthData);
      process.stdout.write("Logged in; Accountable session saved for the MCP (renews itself from the Camoufox profile from now on).\n");
      return;
    }
    await browserLogin(site);
    return;
  }
  if (process.argv[2] === "gmail-login") {
    const mailbox = process.argv[3];
    if (!mailbox) throw new Error("Usage: accountable-mcp gmail-login <mailbox>   (e.g. work, personal)");
    const email = await gmailLogin(mailbox);
    console.log(`Connected mailbox "${mailbox}" = ${email}`);
    return;
  }

  const server = new McpServer({ name: "accountable-mcp-server", version: "0.1.0" });
  registerSessionTools(server);
  registerLoginTools(server);
  registerLearnTools(server);
  registerOverviewTools(server);
  registerExpenseTools(server);
  registerExpenseWriteTools(server);
  registerTransactionTools(server);
  registerTransactionWriteTools(server);
  registerRevenueTools(server);
  registerInvoiceTools(server);

  await server.connect(new StdioServerTransport());
  console.error("accountable-mcp-server running on stdio");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
