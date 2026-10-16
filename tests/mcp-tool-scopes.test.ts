/**
 * The tools the Inkstone MCP server publishes, and the ones the reader has switched off.
 *
 * A switched-off tool has to be absent from `tools/list`, not merely refused when it is called: a tool the
 * model can see but never use is one it keeps choosing, and the refusal then reads as a broken server rather
 * than as a decision somebody made. That is why the switch is applied at registration, and why this file
 * speaks the real protocol over a linked transport instead of reading the registration table.
 */
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/worker/env'
import { createInkstoneMcpServer, mcpServerToolCatalog } from '../src/worker/mcp/server'
import { parseDisabledMcpTools, narrowMcpScopes, MCP_SCOPES } from '../src/worker/mcp/settings'

/** Construction does no I/O and `tools/list` touches no row, so the bindings are never reached. */
const env = {} as Env
const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext

interface JsonRpcMessage {
  id?: number | string
  result?: { tools?: { name: string }[] }
}

/** The tool names a fresh server offers, over a handshake the SDK would accept from any client. */
async function offeredTools(disabled: string[]): Promise<string[]> {
  const server = createInkstoneMcpServer({
    env,
    auth: { userId: 'user-a', role: 'owner', scopes: ['notes:read', 'notes:write', 'notes:trash'] },
    origin: 'https://inkstone.test',
    ftsEnabled: false,
    executionCtx,
    disabledTools: new Set(disabled),
  })
  const [client, serverSide] = InMemoryTransport.createLinkedPair()
  const waiting = new Map<number, (message: JsonRpcMessage) => void>()
  client.onmessage = (message) => {
    const id = (message as JsonRpcMessage).id
    if (typeof id === 'number') waiting.get(id)?.(message as JsonRpcMessage)
  }
  await server.connect(serverSide)
  await client.start()
  const ask = (id: number, method: string, params: unknown = {}) => new Promise<JsonRpcMessage>((resolve) => {
    waiting.set(id, resolve)
    void client.send({ jsonrpc: '2.0', id, method, params } as never)
  })
  await ask(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'inkstone-test', version: '1' },
  })
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never)
  const listed = await ask(2, 'tools/list')
  return (listed.result?.tools ?? []).map((tool) => tool.name)
}

describe('the tools the MCP server publishes', () => {
  it('offers the whole library when nothing has been switched off', async () => {
    const names = await offeredTools([])
    expect(names).toContain('search')
    expect(names).toContain('create_note')
    // The listing is what an MCP client builds its whole toolset from, so it has to be the full set.
    expect(names.length).toBeGreaterThan(20)
  })

  it('leaves a switched-off tool out of the listing entirely', async () => {
    const names = await offeredTools(['create_note'])
    expect(names).not.toContain('create_note')
    // One switch is one tool: the rest of the library is untouched.
    expect(names).toContain('search')
    expect(names).toContain('edit_note')
  })
})

describe('the catalog the settings screen draws', () => {
  it('names every tool this server can publish, with a title and a description', () => {
    const catalog = mcpServerToolCatalog({ env, origin: 'https://inkstone.test', ftsEnabled: false })
    const names = catalog.map((tool) => tool.name)
    expect(names).toContain('search')
    // The catalog is read before any switch is applied, which is what lets a switched-off tool still have a
    // switch drawn for it — the one thing the reader needs in order to switch it back on.
    expect(names).toContain('create_note')
    expect(catalog.every((tool) => tool.title.length > 0 && tool.description.length > 0)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('the stored switched-off list', () => {
  it('reads an unusable value as nothing switched off', () => {
    expect(parseDisabledMcpTools(null)).toEqual([])
    expect(parseDisabledMcpTools('')).toEqual([])
    expect(parseDisabledMcpTools('{')).toEqual([])
    expect(parseDisabledMcpTools('{"search":true}')).toEqual([])
  })

  it('keeps names, drops anything that is not one, and de-duplicates', () => {
    expect(parseDisabledMcpTools('["create_note","create_note",7,"",null," edit_note "]'))
      .toEqual(['create_note', 'edit_note'])
  })
})

describe('the scopes one API key carries', () => {
  const allowed = [MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.trash]

  it('carries everything the account allows when nothing was asked for', () => {
    // An absent request is what every key minted before the choice existed means, so it must not narrow.
    expect(narrowMcpScopes(allowed)).toEqual(allowed)
    expect(narrowMcpScopes(allowed, undefined)).toEqual(allowed)
  })

  it('keeps only what was asked for, in the account’s own order', () => {
    // Reads ride along whatever is asked for, so the trash-only request still yields a usable key.
    expect(narrowMcpScopes(allowed, [MCP_SCOPES.trash])).toEqual([MCP_SCOPES.read, MCP_SCOPES.trash])
    expect(narrowMcpScopes(allowed, [MCP_SCOPES.trash, MCP_SCOPES.read]))
      .toEqual([MCP_SCOPES.read, MCP_SCOPES.trash])
    expect(narrowMcpScopes(allowed, [MCP_SCOPES.write])).toEqual([MCP_SCOPES.read, MCP_SCOPES.write])
  })

  it('only ever removes: an allowance the account switched off cannot be asked for', () => {
    // Narrowing runs against the allowed list, so asking for more than the account has is not a way to get
    // it. Reads survive either way, which is why the second case keeps the one scope it may have.
    expect(narrowMcpScopes([MCP_SCOPES.read], [MCP_SCOPES.read, MCP_SCOPES.write])).toEqual([MCP_SCOPES.read])
    expect(narrowMcpScopes([MCP_SCOPES.read], [MCP_SCOPES.write])).toEqual([MCP_SCOPES.read])
  })

  it('keeps the read floor even when nothing at all was asked for', () => {
    // A key with no scopes is a key that fails at the far end; reads are what the endpoint is for.
    expect(narrowMcpScopes(allowed, [])).toEqual([MCP_SCOPES.read])
  })
})
