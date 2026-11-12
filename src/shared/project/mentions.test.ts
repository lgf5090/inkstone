import { describe, expect, it } from 'vitest'
import { projectCommentNotificationTargets } from './mentions'

describe('comment notification targets (D-7)', () => {
  it('notifies mentioned members and watchers, never the author', () => {
    const targets = projectCommentNotificationTargets(['u1', 'u2', 'u3'], ['u2', 'u4'], 'hey @u2 and @u3 plus @nobody', 'u1')
    expect(targets.sort()).toEqual(['u2', 'u3', 'u4'])
  })

  it('drops the author even when mentioned or watching', () => {
    expect(projectCommentNotificationTargets(['u1'], ['u1'], '@u1 self', 'u1')).toEqual([])
  })

  it('ignores non-member mentions and returns watchers when no mention', () => {
    expect(projectCommentNotificationTargets(['u1'], ['u9'], '@stranger', 'u1')).toEqual(['u9'])
    expect(projectCommentNotificationTargets(['u1'], [], 'plain comment', 'u1')).toEqual([])
  })
})