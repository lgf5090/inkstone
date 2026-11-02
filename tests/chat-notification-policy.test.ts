import { describe, expect, it } from 'vitest'
import { notificationWanted } from '../src/client/features/chat/chat-notify'

const base = {
  notifyChannel: 'both' as const,
  notifyOnlyUnfocused: true,
  notifyApproval: true,
  notifyFinish: true,
}

describe('chat notification policy', () => {
  it('stays silent when the channel is off', () => {
    expect(notificationWanted({ ...base, notifyChannel: 'off' }, 'approval', false)).toBe(false)
  })

  it('respects the kind switches', () => {
    expect(notificationWanted({ ...base, notifyApproval: false }, 'approval', false)).toBe(false)
    expect(notificationWanted({ ...base, notifyFinish: false }, 'finish', false)).toBe(false)
    expect(notificationWanted({ ...base, notifyApproval: false }, 'finish', false)).toBe(true)
  })

  it('holds the announcement while the tab is already in front', () => {
    expect(notificationWanted(base, 'approval', true)).toBe(false)
    expect(notificationWanted({ ...base, notifyOnlyUnfocused: false }, 'approval', true)).toBe(true)
  })
})
