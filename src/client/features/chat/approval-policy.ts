/**
 * Whether a pending approval card may offer "Always allow".
 *
 * A destructive built-in tool may not be granted, and neither may an external (MCP) one: its
 * permission belongs to the third-party server, `ASSISTANT_TOOL_BY_NAME` knows nothing about it, and
 * the server refuses to store that grant. Kept in its own module so the rule can be tested without
 * loading the whole chat surface.
 */
export function approvalOffersAlways(tool: string, permission: string | undefined): boolean {
  return !tool.startsWith('mcp_') && permission !== 'destructive'
}
