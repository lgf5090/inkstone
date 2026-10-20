/**
 * The reader's external MCP servers, turned into tools the assistant can be offered.
 *
 * A remote tool is not trusted because it came from a URL the reader pasted. Two rules do most of the work:
 * the tool's own mode — the reader's answer for that one tool, or the server's for all of them — decides
 * whether every call needs an Approve press, and the arguments the model proposed are stored with the
 * proposal so what runs after approval is exactly what was shown.
 *
 * One session is opened per server per turn, and a server that will not answer is reported as a problem
 * rather than failing the turn: a dead third party must not stop the assistant from replying about notes.
 */
import {
  MAX_MCP_SCHEMA_CHARS,
  MAX_MCP_TOOLS_PER_SERVER,
  mcpToolModeFor,
  mcpToolName,
  type AssistantMcpCatalogEntry,
  type AssistantMcpProblem,
  type AssistantMcpServer,
  type AssistantMcpTool,
} from '@shared/assistant'
import type { AssistantStore } from './store'
import type { PreparedTarget, ToolContext, ToolDefinition } from './tools'
import { McpError, mcpCallTool, mcpInitialize, mcpListTools, type McpSession, type McpToolListing } from './mcp-client'
import { withMcpOAuthHeaders } from './mcp-oauth'

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
  problems: AssistantMcpProblem[]
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
 * One session per server, handed to the visitor with its listing.
 *
 * Both callers need the same three steps — decrypt the token, handshake, list — and they differ only in
 * what they keep: the turn keeps definitions it can call, the settings screen keeps a catalogue to draw.
 * A server that will not answer is recorded instead of thrown, so one dead third party never hides the
 * tools of the others.
 */
async function visitListings(
  store: AssistantStore,
  servers: AssistantMcpServer[],
  visit: (server: AssistantMcpServer, session: McpSession, listing: McpToolListing) => void,
): Promise<{ problems: AssistantMcpProblem[] }> {
  const problems: AssistantMcpProblem[] = []
  for (const server of servers) {
    const record = await store.mcpServerRecord(server.id)
    if (!record) continue
    let session: McpSession
    try {
      // The reader's own headers plus whatever token this server's authorization produced, resolved per
      // server: an expired token is exchanged here, before the handshake, rather than failing the turn.
      const headers = await withMcpOAuthHeaders(store, server.id, server.url, record.headers)
      session = await mcpInitialize(server.url, headers, server.timeoutSeconds, server.transport)
    } catch (error) {
      // A refusal is not one thing: a server that answered 401 is asking for a login, and that is the one
      // case this screen has a button for. The message goes to the reader; the status goes to the interface.
      problems.push({
        serverId: server.id,
        label: server.label,
        error: error instanceof Error ? error.message : 'unreachable',
        needsAuthorization: error instanceof McpError && error.status === 401,
      })
      continue
    }
    visit(server, session, await mcpListTools(session, server.id, server.label))
  }
  return { problems }
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
  let calls = 0
  const full = () => definitions.length >= MAX_EXTERNAL_TOOLS_PER_TURN
  const problems: ExternalToolsResult['problems'] = []

  const { problems: failures } = await visitListings(store, await store.enabledMcpServers(), (server, session, listing) => {
    if (full()) {
      problems.push({ serverId: server.id, label: server.label, error: 'Skipped: the turn already offers enough tools.', needsAuthorization: false })
      return
    }
    for (const tool of listing.tools.slice(0, MAX_MCP_TOOLS_PER_SERVER)) {
      if (full()) break
      const mode = mcpToolModeFor(server, tool.remoteName)
      // A tool the reader switched off is not offered at all: no schema, no definition, so the model cannot
      // name it and nothing has to be refused later.
      if (mode === 'off') continue
      schemas[tool.name] = asSchema(listing.schemas[tool.name])
      if (mode === 'auto') {
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
  })
  problems.push(...failures)

  return { definitions, schemas, problems, called: () => calls }
}

/**
 * Every server's tools for the settings screen, switched-off ones included.
 *
 * A server that is off at its own level is still listed: that is where its per-tool answers live, and a
 * reader who has just switched a server back on wants what they had already decided about its tools to
 * still be there. It is not called, though: a switched-off third party must not stall the screen or take
 * the worker down with it, so its rows come from the modes already stored on the server. An enabled
 * server is listed live, and its rows carry the argument form the server published, because "what would
 * this one be allowed to do, and what would it take" is the question the card exists to answer.
 */
export async function listMcpCatalog(store: AssistantStore): Promise<{ servers: AssistantMcpCatalogEntry[], problems: AssistantMcpProblem[] }> {
  const all = await store.listMcpServers()
  const servers: AssistantMcpCatalogEntry[] = []
  for (const server of all) {
    if (server.enabled) continue
    servers.push({
      serverId: server.id,
      serverLabel: server.label,
      tools: Object.entries(server.toolModes).map(([remoteName, mode]) => ({
        name: mcpToolName(server.id, remoteName),
        remoteName,
        serverId: server.id,
        serverLabel: server.label,
        description: '',
        mode,
        inputSchema: '',
      })),
    })
  }
  const { problems } = await visitListings(store, all.filter((server) => server.enabled), (server, _session, listing) => {
    servers.push({
      serverId: server.id,
      serverLabel: server.label,
      tools: listing.tools.slice(0, MAX_MCP_TOOLS_PER_SERVER).map((tool) => ({
        name: tool.name,
        remoteName: tool.remoteName,
        serverId: server.id,
        serverLabel: server.label,
        description: tool.description,
        mode: mcpToolModeFor(server, tool.remoteName),
        inputSchema: schemaText(listing.schemas[tool.name]),
      })),
    })
  })
  return { servers, problems }
}

/**
 * A tool's published argument form, as text for the card.
 *
 * Capped rather than refused: a schema is shown, never parsed here, and one long enough to matter is
 * still worth showing its opening. Empty is a tool that published none, which is legal MCP.
 */
function schemaText(schema: Record<string, unknown> | undefined): string {
  if (!schema) return ''
  try {
    const text = JSON.stringify(schema, null, 2)
    return text.length > MAX_MCP_SCHEMA_CHARS ? `${text.slice(0, MAX_MCP_SCHEMA_CHARS)}\n…` : text
  } catch {
    // A schema with a cycle in it is not JSON at all; the card says nothing rather than failing the listing.
    return ''
  }
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
