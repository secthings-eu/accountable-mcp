import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { ApiError } from "./client.js";
import { AuthError } from "./auth.js";

/** Wrap structured data as a tool result (JSON text + structuredContent). */
export function ok(data: Record<string, unknown>): CallToolResult {
  let text = JSON.stringify(data, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n…[truncated at ${CHARACTER_LIMIT} chars — narrow the query, use filters or a smaller page size]`;
  }
  return { content: [{ type: "text", text }], structuredContent: data };
}

export function fail(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof AuthError) message = err.message;
  else if (err instanceof ApiError) {
    message = err.message;
    if (err.status === 403) message += "\nThis action may require step-up (email OTP) confirmation in the web app.";
    if (err.status === 404) message += "\nCheck the id; use a list/search tool to find valid ids.";
  } else message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Run a tool body and convert thrown errors into MCP error results. */
export async function run(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}
