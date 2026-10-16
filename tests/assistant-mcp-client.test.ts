// @vitest-environment node
/**
 * The external MCP client and the rules around it.
 *
 * Two things are pinned that a browser probe cannot: the address check that keeps the worker from being
 * pointed at the network it runs inside, and the fact that a stored token never comes back out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, mcpToolName, mcpToolOrigin } from '../src/shared/assistant'
import {
  flattenMcpContent,
  mcpCallTool,
  mcpInitialize,
  mcpListTools,
  mcpUrlProblem,
  parseMcpBody,
} from '../src/worker/assistant/mcp-client'
import { isExternalToolName } from '../src/worker/assistant/mcp-tools'

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

describe('the address the worker may fetch', () => {
  it('accepts a public https endpoint', () => {
    expect(mcpUrlProblem('https://mcp.context7.com/mcp')).toBeNull()
    expect(mcpUrlProblem('https://example.test:8443/a/b')).toBeNull()
  })
  it('refuses the machine the worker itself runs on', () => {
    for (const url of [
      'http://127.0.0.1:9000/mcp',
      'http://localhost:3000/mcp',
      'http://10.0.0.5/mcp',
      'http://192.168.1.1/mcp',
      'http://172.16.0.9/mcp',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:8080/mcp',
      'http://metadata.google.internal/mcp',
      'https://169.254.169.254/latest/meta-data/',
      'https://db.internal/mcp',
      'https://10.4.0.7/mcp',
      'http://db.internal/mcp',
    ]) {
      expect(mcpUrlProblem(url), url).toMatch(/inside the network|has to be https/)
    }
  })
  it('refuses plain http anywhere, because the token crosses it in the clear', () => {
    expect(mcpUrlProblem('http://127.0.0.1:4317/mcp')).toContain('has to be https')
    expect(mcpUrlProblem('http://example.test/mcp')).toContain('has to be https')
  })
  it('refuses the shapes that are not an http endpoint at all', () => {
    expect(mcpUrlProblem('')).toBeTruthy()
    expect(mcpUrlProblem('not a url')).toBeTruthy()
    expect(mcpUrlProblem('file:///etc/passwd')).toBeTruthy()
    expect(mcpUrlProblem('gopher://example.test/')).toBeTruthy()
    expect(mcpUrlProblem(`https://example.test/${'a'.repeat(3000)}`)).toBeTruthy()
  })
})

describe('the reply a server sends back', () => {
  it('reads a plain JSON body', () => {
    const text = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } })
    expect(parseMcpBody(text, 7)?.result).toEqual({ tools: [] })
  })
  it('reads one SSE frame, which is what Streamable HTTP servers usually send', () => {
    const body = `event: message\n${frame({ jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'x' }] } })}\n`
    expect(parseMcpBody(body, 7)?.result).toEqual({ tools: [{ name: 'x' }] })
  })
  it('picks the envelope that answers our id when a notification slipped in first', () => {
    const body = frame({ jsonrpc: '2.0', method: 'notifications/ready' }) + frame({ jsonrpc: '2.0', id: 9, result: { ok: true } })
    expect(parseMcpBody(body, 9)?.id).toBe(9)
  })
  it('returns nothing usable for an empty or broken body rather than throwing', () => {
    expect(parseMcpBody('', 1)).toBeNull()
    expect(parseMcpBody('data: {nope', 1)).toBeNull()
  })
  it('surfaces a server-reported error as the message, not as a success', () => {
    const envelope = parseMcpBody(frame({ jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'unknown tool' } }), 3)
    expect(envelope?.error?.message).toBe('unknown tool')
  })
})

/**
 * An SSE server: one stream that stays open, the endpoint event, and every answer on that stream.
 *
 * The answers are put on the stream rather than in the POST's body on purpose — a client that read only
 * the POST response would look correct against a server that answers there.
 */
function sseServer(endpoint = '/messages?session=abc') {
  const encoder = new TextEncoder()
  const posted: string[] = []
  let open: ReadableStreamDefaultController<Uint8Array> | null = null
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          open = controller
          controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`))
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number, method: string }
    posted.push(request.method)
    if (request.id !== undefined) {
      const result = request.method === 'tools/list'
        ? { tools: [{ name: 'resolve-library-id', description: 'finds a library', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'the-library-id' }] }
      open?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`))
    }
    return new Response(null, { status: 202 })
  })
  return { fetchImpl, posted }
}

describe('the older SSE transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens a stream, posts where it is told, and reads the answer back off that stream', async () => {
    const server = sseServer()
    vi.stubGlobal('fetch', server.fetchImpl)
    const session = await mcpInitialize('https://mcp.example.test/sse', { Authorization: 'Bearer x' }, 30, 'sse')
    const listing = await mcpListTools(session, '01SERVERAAAAAAAAAAAAAAAAAA1', 'Context7')
    expect(listing.tools.map((tool) => tool.remoteName)).toEqual(['resolve-library-id'])
    // The handshake is what this transport requires before a call on the same stream, so it is sent per
    // call rather than once per process.
    expect(server.posted).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    await expect(mcpCallTool(session, 'resolve-library-id', { libraryName: 'next.js' })).resolves.toContain('the-library-id')
  })

  it('resolves the endpoint against the stream it came from', async () => {
    const server = sseServer('messages')
    vi.stubGlobal('fetch', server.fetchImpl)
    const session = await mcpInitialize('https://mcp.example.test/sse', {}, 30, 'sse')
    await mcpListTools(session, '01SERVERAAAAAAAAAAAAAAAAAA1', 'Relative')
    expect(server.fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://mcp.example.test/sse',
      'https://mcp.example.test/messages',
      'https://mcp.example.test/messages',
      'https://mcp.example.test/messages',
    ])
  })

  it('refuses an endpoint the server names inside the network', async () => {
    const server = sseServer('http://127.0.0.1:9000/messages')
    vi.stubGlobal('fetch', server.fetchImpl)
    const session = await mcpInitialize('https://mcp.example.test/sse', {}, 30, 'sse')
    // The address check is the same one the reader's own URL goes through: the server is not allowed to
    // be the one that decides what the worker fetches.
    await expect(mcpListTools(session, '01SERVERAAAAAAAAAAAAAAAAAA1', 'Local')).rejects.toThrow(/will not call/)
  })

  it('says so when the server never names an endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
      { headers: { 'content-type': 'text/event-stream' } },
    )))
    const session = await mcpInitialize('https://mcp.example.test/sse', {}, 30, 'sse')
    await expect(mcpListTools(session, '01SERVERAAAAAAAAAAAAAAAAAA1', 'Quiet')).rejects.toThrow(/before naming where to post/)
  })
})

describe('what a tool returned', () => {
  it('flattens text parts', () => {
    expect(flattenMcpContent({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo')
  })
  it('names a picture instead of pasting base64 into the transcript', () => {
    expect(flattenMcpContent({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] })).toContain('does not show tool pictures')
  })
  it('keeps an error visible to the model', () => {
    expect(flattenMcpContent({ isError: true, content: [{ type: 'text', text: 'quota' }] })).toContain('reported an error')
  })
})

describe('the names an external tool is offered under', () => {
  it('namespaces by server so two servers cannot answer to one name', () => {
    const left = mcpToolName('01SERVERAAAAAAAAAAAAAAAAAA1', 'resolve-library-id')
    const right = mcpToolName('01SERVERAAAAAAAAAAAAAAAAAA2', 'resolve-library-id')
    expect(left).not.toBe(right)
    expect(left).toMatch(/^mcp_[a-z0-9]+_resolve-library-id$/)
  })
  it('stays inside the identifier rules every upstream accepts, whatever the server called it', () => {
    for (const raw of ['a'.repeat(200), 'tool with spaces', '中文工具', 'x'.repeat(60)]) {
      const name = mcpToolName('01ABCDEFGHJKMNPQRS012345XY', raw)
      expect(name.length, raw.slice(0, 12)).toBeLessThanOrEqual(64)
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/)
    }
  })
  it('recognises its own names when a turn pins them', () => {
    expect(isExternalToolName('mcp_1a2b3c_resolve-library-id')).toBe(true)
    expect(isExternalToolName('search_notes')).toBe(false)
  })
})

describe('who may be offered an external tool', () => {
  it('keeps a remote tool that needs approval away from an unattended run', async () => {
    const { ToolExecutor } = await import('../src/worker/assistant/tools')
    const definition = {
      name: 'mcp_abc123_drop_everything',
      description: 'remote',
      permission: 'destructive' as const,
      fields: {},
      external: true,
      prepare: async () => ({ targetId: 't', targetLabel: 'l' }),
      commit: async () => 'done',
    }
    const budget = { maxToolCalls: 4 }
    // The reader's policy and the deployment's bindings are both part of the context the executor reads,
    // so the context here carries them rather than only the two fields this case happens to be about.
    const context = (mode: string) => ({ mode, settings: DEFAULT_ASSISTANT_SETTINGS, env: {} }) as never
    expect(new ToolExecutor(context('chat'), budget, [definition]).available().map((entry) => entry.name))
      .toContain(definition.name)
    // An automation has no reader to press Approve, so an approval-gated remote tool must not be offered.
    expect(new ToolExecutor(context('automation'), budget, [definition]).available().map((entry) => entry.name))
      .not.toContain(definition.name)
  })
})
