import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadAuth, sessionSummary } from "../services/auth.js";
import { run } from "../services/format.js";

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    "accountable_session_status",
    {
      title: "Accountable session status",
      description:
        "Check whether the MCP server has a usable Accountable session (token expiry, refresh token present). " +
        "Use this first if other tools return authentication errors. Does not call the API.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => run(async () => sessionSummary(await loadAuth())),
  );
}
