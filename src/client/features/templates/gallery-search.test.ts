import { describe, expect, it } from 'vitest'
import { templateMatchesQuery } from './gallery-derived'

function item(overrides: Partial<{ name: string; description: string; content: string; tags: string[] }> = {}) {
  return {
    name: 'Weekly review',
    description: 'KPT retrospective',
    content: '# Wins\n\n- shipped the gallery',
    tags: ['review', 'weekly'],
    ...overrides,
  }
}

describe('templateMatchesQuery', () => {
  it('matches every field a template can carry text in', () => {
    expect(templateMatchesQuery(item(), 'WEEKLY')).toBe(true)
    expect(templateMatchesQuery(item(), 'retrospective')).toBe(true)
    expect(templateMatchesQuery(item(), 'shipped')).toBe(true)
    expect(templateMatchesQuery(item({ tags: ['zebra'] }), 'zebra')).toBe(true)
  })

  it('treats a blank query as no filter at all', () => {
    expect(templateMatchesQuery(item(), '')).toBe(true)
    expect(templateMatchesQuery(item(), '   ')).toBe(true)
  })

  it('rejects a template that says nothing about the query', () => {
    expect(templateMatchesQuery(item(), 'no Such Word')).toBe(false)
  })

  it('works for a community card, which has no star or pin to fall back on', () => {
    const community = {
      name: 'Sprint board',
      description: '',
      content: '```kanban\n[]\n```',
      tags: [],
    }
    expect(templateMatchesQuery(community, 'kanban')).toBe(true)
    expect(templateMatchesQuery(community, 'sprint')).toBe(true)
    expect(templateMatchesQuery(community, 'empty field')).toBe(false)
  })

  it('survives a template with the optional fields missing', () => {
    expect(templateMatchesQuery({ name: 'Bare', content: 'body' }, 'bare')).toBe(true)
    expect(templateMatchesQuery({ name: 'Bare', content: 'body' }, 'nope')).toBe(false)
  })
})
