/**
 * The reader's external MCP servers, turned into tools the assistant can be offered.
 *
 * A remote tool is not trusted because it came from a URL the reader pasted. Two rules do most of the work:
 * the server's own `toolMode` decides whether every call needs an Approve press, and the arguments the model
 * proposed are stored with the proposal so what runs after approval is exactly what was shown.
 *
 * One session is opened per server per turn, and a server that will not answer is reported as a problem
 * rather than failing the turn: a dead third party must not stop the assistant from replying about notes.
 */
import { MAX_MCP_TOOLS_PER_SERVER, type AssistantMcpServer, type AssistantMcpTool } from '@shared/assistant'
import type { AssistantStore } from './store'
import type { PreparedTarget, ToolContext, ToolDefinition } from './tools'
import { mcpCallTool, mcpInitialize, mcpListTools, mcpToolName, type McpSession } from './mcp-client'

/** How many remote tools one turn may offer at all: their schemas travel with every request. */
const MAX_EXTERNAL_TOOLS_PER_TURN = 24

export interface ExternalTool {
  tool: AssistantMcpTool
  session: McpSession
}

export interface ExternalToolsResult {
  definitions: ToolDefinition[]
  /** Namespaced name to the server's own JSON Schema, which is what the model is told about arguments. */
  schemas: Record<string, Record<string, unknown>>
  /** Servers that could not be listed, with the reason the settings screen should show. */
  problems: { serverId: string, label: string, error: string }[]
  called: () => number
}

/** A server may send anything in `inputSchema`; the model needs an object it can describe. */
function asSchema(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { type: 'object', properties: {} }
}

function remoteTarget(server: AssistantMcpServer, tool: AssistantMcpTool): PreparedTarget {
  return {
    // The id is only an address for the approval card: the call itself is replayed from the stored args.
    targetId: `${server.id}:${tool.remoteName}`,
    targetLabel: `${server.label} · ${tool.remoteName}`.slice(0, 280),
  }
}

/**
 * Every enabled server's tools, with one session each.
 *
 * The listing is done up front because the model is offered the schemas before it can call anything: a tool
 * discovered mid-turn would need a second request to the server inside the token budget of the first.
 */
export async function loadExternalTools(store: AssistantStore): Promise<ExternalToolsResult> {
  const definitions: ToolDefinition[] = []
  const schemas: Record<string, Record<string, unknown>> = {}
  const problems: ExternalToolsResult['problems'] = []
  const servers = await store.enabledMcpServers()
  let calls = 0

  for (const server of servers) {
    if (definitions.length >= MAX_EXTERNAL_TOOLS_PER_TURN) {
      problems.push({ serverId: server.id, label: server.label, error: 'Skipped: the turn already offers enough tools.' })
      continue
    }
    const record = await store.mcpServerRecord(server.id)
    if (!record) continue
    const headers: Record<string, string> = record.token ? { authorization: `Bearer ${record.token}` } : {}
    let session: McpSession
    try {
      session = await mcpInitialize(server.url, headers)
    } catch (error) {
      problems.push({ serverId: server.id, label: server.label, error: error instanceof Error ? error.message : 'unreachable' })
      continue
    }
    const listing = await mcpListTools(session, server.id, server.label)
    for (const tool of listing.tools.slice(0, MAX_MCP_TOOLS_PER_SERVER)) {
      if (definitions.length >= MAX_EXTERNAL_TOOLS_PER_TURN) break
      schemas[tool.name] = asSchema(listing.schemas[tool.name])
      if (server.toolMode === 'auto') {
        definitions.push({
          name: tool.name,
          description: tool.description || `Remote tool ${tool.remoteName} from ${server.label}.`,
          permission: 'read',
          fields: {},
          external: true,
          maxCallsPerTurn: 4,
          run: async (args) => {
            calls += 1
            return mcpCallTool(session, tool.remoteName, args)
          },
        } as ToolDefinition)
        continue
      }
      definitions.push({
        name: tool.name,
        description: tool.description || `Remote tool ${tool.remoteName} from ${server.label}.`,
        permission: 'destructive',
        fields: {},
        external: true,
        maxCallsPerTurn: 4,
        prepare: async () => remoteTarget(server, tool),
        commit: async (_targetId, _ctx, args) => {
          calls += 1
          return mcpCallTool(session, tool.remoteName, args)
        },
      } as ToolDefinition)
    }
  }

  return { definitions, schemas, problems, called: () => calls }
}

/** The name a turn's pin or a model call uses for one remote tool. */
export function externalToolName(serverId: string, remoteName: string): string {
  return mcpToolName(serverId, remoteName)
}

/** True for anything this module could have produced, used when the turn's pins are filtered. */
export function isExternalToolName(name: string): boolean {
  return name.startsWith('mcp_')
}

export type { ToolContext }
