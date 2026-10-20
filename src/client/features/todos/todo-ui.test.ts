/**
 * What a list icon may be, before it reaches the badge.
 *
 * The badge draws an unknown value as text clipped to three graphemes — right for a kanban fence, whose
 * author typed the value and should see the misspelling, and wrong for a list card, where "Bri" beside
 * a list named Work reads as a typo. So the to-do screens ask this first.
 */
import { describe, expect, it } from 'vitest'
import { listIconFor } from './todo-ui'

describe('listIconFor', () => {
  it('keeps the identifier the picker writes', () => {
    expect(listIconFor('lucide:CheckCircle')).toBe('lucide:CheckCircle')
  })

  it('keeps an emoji the reader picked', () => {
    expect(listIconFor('📅')).toBe('📅')
    expect(listIconFor('🇨🇳')).toBe('🇨🇳')
  })

  it('drops a bare word, which the badge would draw as its first three letters', () => {
    expect(listIconFor('Briefcase')).toBeNull()
  })

  it('treats no icon as no icon', () => {
    expect(listIconFor(null)).toBeNull()
    expect(listIconFor('')).toBeNull()
  })
})
