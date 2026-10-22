// @vitest-environment node
/**
 * What the consent screen actually draws.
 *
 * The server has honoured `todos:read`, `todos:write` and `todos:danger` since the to-do tools landed, but
 * a scope this page never renders is a scope nobody can grant: the POST re-reads the boxes, so an
 * invisible permission is silently dropped, and a reader who ticked nothing gets exactly what they ticked.
 * That asymmetry is the whole reason these cases exist — the four `permission(...)` calls and the strings
 * beside them are the product, not decoration.
 *
 * Two directions are pinned: a requested to-do scope appears as an unchecked box carrying the scope
 * itself, and a request that never named one draws no to-do box at all. The second is the quiet-widening
 * guard from `mcp/settings.ts` seen from the other side.
 *
 * The two inputs come from `@cloudflare/workers-oauth-provider` and this screen reads exactly one field
 * from each — `client.clientName` and `request.scope`/`request.clientId` — so they are built from what the
 * page touches rather than from a fabricated copy of the SDK's shape.
 */
import { describe, expect, it } from 'vitest'
import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider'
import { consentPage } from '../src/worker/routes/mcp-authorize'
import { MCP_SCOPES } from '../src/worker/mcp/settings'

function render(scope: string[], locale: 'en-US' | 'zh-CN'): string {
  return consentPage({
    client: { clientName: 'Calendar on the couch' } as unknown as ClientInfo,
    request: { scope, clientId: '' } as unknown as AuthRequest,
    csrf: 'csrf-token',
    userName: 'lgf',
    action: '/authorize/mcp',
    locale,
    currentUrl: 'https://example.test/authorize',
  })
}

/** The box a screen offers for one scope: same value, unchecked, and a name the form can submit. */
function box(scope: string): string {
  return `name="scope" value="${scope}"`
}

describe('the consent screen', () => {
  it('draws a to-do box for every to-do scope the client asked for', () => {
    const html = render([MCP_SCOPES.todoRead, MCP_SCOPES.todoWrite, MCP_SCOPES.todoDanger], 'en-US')

    for (const scope of [MCP_SCOPES.todoRead, MCP_SCOPES.todoWrite, MCP_SCOPES.todoDanger]) {
      expect(html, `${scope} was requested but never offered`).toContain(box(scope))
      expect(html, `${scope} arrived pre-checked`).not.toContain(`${box(scope)} checked`)
    }
    expect(html).toContain('Read and search to-dos')
    expect(html).toContain('Delete to-dos for good')
    // The hard-delete row has to say it is hard: a reader who believes there is a trash to restore from
    // consented to something they did not see.
    expect(html).toContain('no trash to restore a task from')
  })

  it('draws no to-do box for a request that never named one', () => {
    const html = render([MCP_SCOPES.read, MCP_SCOPES.write], 'en-US')

    expect(html, 'a notes-only consent offered to-do permissions').not.toContain('todos:')
    expect(html).toContain(box(MCP_SCOPES.write))
    expect(html).toContain('Modify the note library')
  })

  it('answers in the reader’s own language', () => {
    const html = render([MCP_SCOPES.todoRead, MCP_SCOPES.todoDanger], 'zh-CN')

    expect(html).toContain('读取与搜索待办')
    expect(html).toContain('永久删除待办')
    // The line that tells the reader what the whole grant reaches — it now covers two data domains.
    expect(html).toContain('仅可访问此账户的笔记与待办')
  })

  it('keeps the note floor visible while adding the to-do family beside it', () => {
    const html = render([MCP_SCOPES.read, MCP_SCOPES.todoRead], 'en-US')

    // Reads are the floor every key stands on: forced, checked, disabled, and carried by a hidden field.
    expect(html).toContain(`type="checkbox" checked disabled`)
    expect(html).toContain(`<input type="hidden" name="scope" value="${MCP_SCOPES.read}">`)
    expect(html).toContain(box(MCP_SCOPES.todoRead))
    expect(html).not.toContain(box(MCP_SCOPES.todoDanger))
  })
})
