import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, type ToolSet, tool } from "ai";
import { getAccessToken } from "./archera-oauth.js";

/**
 * Archera integration (Phase 1): connect the review model to Archera's MCP
 * server so cost findings are grounded in real on-demand prices and reservation
 * savings instead of the model's pricing guesses.
 *
 * This is optional — when ARCHERA_MCP_TOKEN is unset the bot still produces an
 * (ungrounded) estimate review. Phase 2 replaces the single env token with a
 * per-installation OAuth connection.
 */

const DEFAULT_MCP_URL = "https://mcp.archera.ai/mcp";

/** MCP tools relevant to grounding a PR's cloud-cost review. */
const ALLOWED_TOOLS = new Set([
  "search_catalog_skus",
  "catalog_sku_details",
  "catalog_sku_offer_comparison",
  "search_resource_skus",
  "daily_savings",
  "commitment_plan_recommended",
  "overview",
]);

/** Cap a single tool result so a large Archera payload can't blow the context. */
const MAX_TOOL_RESULT_CHARS = 8_000;

export interface ArcheraConnection {
  tools: ToolSet;
  close: () => Promise<void>;
}

/** Whether an Archera connection is configured. */
export function archeraConfigured(): boolean {
  return Boolean(process.env.ARCHERA_MCP_TOKEN);
}

/**
 * Connect to the Archera MCP server and expose the curated tools as AI SDK
 * tools. Uses the installation's OAuth token when an installationId is given,
 * falling back to a single ARCHERA_MCP_TOKEN env var (handy for local testing).
 * Returns null when no token is available. Throws if a configured connection
 * fails — callers decide whether to degrade gracefully.
 */
export async function connectArchera(opts?: {
  installationId?: number;
}): Promise<ArcheraConnection | null> {
  let token: string | null = null;
  if (opts?.installationId !== undefined) token = await getAccessToken(opts.installationId);
  if (!token) token = process.env.ARCHERA_MCP_TOKEN ?? null;
  if (!token) return null;

  const url = process.env.ARCHERA_MCP_URL ?? DEFAULT_MCP_URL;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "github-cost-review-bot", version: "0.1.0" });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();
  const tools: ToolSet = {};
  for (const mcpTool of mcpTools) {
    if (!ALLOWED_TOOLS.has(mcpTool.name)) continue;
    tools[mcpTool.name] = tool({
      description: mcpTool.description ?? mcpTool.name,
      // biome-ignore lint/suspicious/noExplicitAny: MCP JSON Schema is untyped.
      inputSchema: jsonSchema(mcpTool.inputSchema as any),
      execute: async (args) => {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: args as Record<string, unknown>,
        });
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
          .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
          .join("\n");
        return text.length > MAX_TOOL_RESULT_CHARS
          ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated]`
          : text;
      },
    });
  }

  return { tools, close: () => client.close() };
}
