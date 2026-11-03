import { describe, expect, it } from 'vitest'
import { approvalOffersAlways } from '../src/client/features/chat/approval-policy'

describe('the approval card’s always-allow option', () => {
  it('is offered for a built-in write but never for a destructive or external tool', () => {
    expect(approvalOffersAlways('create_task', 'write')).toBe(true)
    expect(approvalOffersAlways('delete_task', 'destructive')).toBe(false)
    expect(approvalOffersAlways('mcp_server_drop_everything', undefined)).toBe(false)
    expect(approvalOffersAlways('mcp_server_resolve_library_id', 'read')).toBe(false)
  })
})
