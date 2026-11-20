import { describe, expect, it } from 'vitest'
import { projectCardFromNotificationLink } from './notification-link'

describe('project notification links', () => {
  it('resolves the board and card pair a notice was written with', () => {
    expect(projectCardFromNotificationLink('project:board123:card456')).toEqual({ boardId: 'board123', cardId: 'card456' })
  })

  it('does not invent a target for another app or a single token', () => {
    expect(projectCardFromNotificationLink('todo:task42')).toBeNull()
    expect(projectCardFromNotificationLink('project:card456')).toBeNull()
    expect(projectCardFromNotificationLink(null)).toBeNull()
  })
})
