import { homedir } from "node:os";
import path from "node:path";
import type { McpStdioPolicy } from "../mcp/mcp-transport.js";
import { isAllowedStdioCommand, mcpStdioAvailable } from "../mcp/mcp-transport.js";
import type { BrowsePageAction } from "./browse-instructions.js";
import { BROWSE_MCP_SLUG, BROWSE_PAGE_ACTIONS } from "./browse-instructions.js";

/**
 * The browse MCP tools that carry the allowed page actions. `execute` runs the Playwright page
 * actions; the session tools own the tab they run in; `tabs_cleanup` closes tabs the bot left.
 *
 * Deliberately absent: `session_adopt` (it would attach browse's debugger to the panel's CDP tab,
 * which is exactly the chrome.debugger conflict), `session_allowlist`, `network`, `recording`,
 * `flight_recorder`, `settings`, and every `secrets_*` tool. A bot only needs to read and drive a
 * page, so everything that changes the host, captures credentials, or records the person stays out.
 */
export const BROWSE_MCP_ALLOWED_TOOLS = [
  "execute",
  "status",
  "session_list",
  "session_new",
  "session_use",
  "session_reset",
  "session_delete",
  "tabs_cleanup",
] as const;

export type BrowseMcpTool = (typeof BROWSE_MCP_ALLOWED_TOOLS)[number];

/** Whether a browse tool stays inside the page-action allowlist. */
export function browseMcpToolAllowed(tool: string): boolean {
  return (BROWSE_MCP_ALLOWED_TOOLS as readonly string[]).includes(tool);
}

/**
 * Which MCP tools carry one allowed page action. `execute` is the one tool for every page verb;
 * the `tabs` action is the session tools that list, switch and close tabs.
 */
export function browseToolsForAction(action: BrowsePageAction): readonly BrowseMcpTool[] {
  return action === "tabs"
    ? [
        "session_list",
        "session_new",
        "session_use",
        "session_reset",
        "session_delete",
        "tabs_cleanup",
      ]
    : ["execute"];
}

/** Where the deployment's browse executable is; BROWSE_BIN is what scripts/native writes. */
export function browseMcpCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BROWSE_MCP_COMMAND?.trim() || env.BROWSE_BIN?.trim();
  if (configured) return configured;
  const home = env.HOME?.trim() || homedir();
  return path.join(home, ".local", "bin", "browse");
}

export type BrowseMcpServerDefinition = {
  slug: string;
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  /** The tools the server may expose to a bot, filtered at discovery time. */
  allowedTools: readonly string[];
  /** The page actions those tools carry, written into the bot instructions. */
  pageActions: readonly string[];
};

/**
 * The browse server a bot may be given, or undefined when this deployment would not run it.
 * Defining it only when the command is on the deployment's stdio allowlist keeps this entry
 * honest: an unprivileged local server is never offered by accident.
 */
export function browseMcpServerDefinition(
  policy: McpStdioPolicy,
  env: NodeJS.ProcessEnv = process.env,
): BrowseMcpServerDefinition | undefined {
  if (!mcpStdioAvailable(policy)) return undefined;
  const command = browseMcpCommand(env);
  if (!isAllowedStdioCommand(command, policy.allowedCommands ?? [])) return undefined;
  return {
    slug: BROWSE_MCP_SLUG,
    name: BROWSE_MCP_SLUG,
    transport: "stdio",
    command,
    args: ["mcp"],
    allowedTools: BROWSE_MCP_ALLOWED_TOOLS,
    pageActions: BROWSE_PAGE_ACTIONS,
  };
}

/**
 * True for the browse server row, whatever the person named it. The command is what identifies
 * it; the slug covers a row whose stored command is older than the naming rule.
 */
export function isBrowseMcpServer(server: {
  transport?: string | null;
  command?: string | null;
  slug?: string | null;
}): boolean {
  if (server.transport !== "stdio") return false;
  if (server.slug === BROWSE_MCP_SLUG) return true;
  const command = server.command?.trim();
  if (!command) return false;
  return path.basename(command) === "browse";
}
