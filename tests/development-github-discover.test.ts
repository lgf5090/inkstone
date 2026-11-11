import { describe, expect, it } from 'vitest'
import { buildDiscoverQuery } from '../src/worker/development/github/discover'
import type { GithubDiscoverQuery } from '../src/shared/development/github/types'

const NOW = new Date('2026-11-11T00:00:00Z')

function query(patch: Partial<GithubDiscoverQuery> = {}): GithubDiscoverQuery {
  return {
    chart: 'trending',
    platform: 'all',
    topic: '',
    category: 'all',
    query: '',
    language: '',
    updated: 'any',
    tracked: 'any',
    installerOnly: false,
    updateStatus: 'any',
    sort: 'stars',
    order: 'desc',
    page: 1,
    perPage: 20,
    ...patch,
  }
}

describe('github discover query', () => {
  it('builds the trending chart from recent activity', () => {
    const built = buildDiscoverQuery(query(), NOW)
    expect(built.sort).toBe('stars')
    expect(built.order).toBe('desc')
    expect(built.q).toContain('stars:>50')
    expect(built.q).toContain('pushed:>=2026-10-12')
    expect(built.q).toContain('fork:false')
    expect(built.q).toContain('archived:false')
  })

  it('sorts the releases chart by the last update', () => {
    const built = buildDiscoverQuery(query({ chart: 'releases' }), NOW)
    expect(built.sort).toBe('updated')
    expect(built.q).toContain('pushed:>=2026-10-28')
    expect(built.q).toContain('stars:>10')
  })

  it('keeps the popular chart to established repositories', () => {
    const built = buildDiscoverQuery(query({ chart: 'popular' }), NOW)
    expect(built.q).toContain('stars:>1000')
    expect(built.q).toContain('created:<=2026-05-15')
    expect(built.q).toContain('pushed:>=2025-11-11')
  })

  it('maps platforms to the topics GitHub search understands', () => {
    expect(buildDiscoverQuery(query({ platform: 'android' }), NOW).q).toContain('topic:android')
    expect(buildDiscoverQuery(query({ platform: 'windows' }), NOW).q).toContain('topic:desktop')
    expect(buildDiscoverQuery(query({ platform: 'macos' }), NOW).q).toContain('topic:macos')
    expect(buildDiscoverQuery(query({ platform: 'linux' }), NOW).q).toContain('topic:linux')
    expect(buildDiscoverQuery(query(), NOW).q).not.toContain('topic:')
  })

  it('appends a selected topic', () => {
    expect(buildDiscoverQuery(query({ topic: 'self-hosted' }), NOW).q).toContain('topic:self-hosted')
  })

  it('narrows a category to its representative topic', () => {
    expect(buildDiscoverQuery(query({ category: 'ai' }), NOW).q).toContain('topic:ai')
    expect(buildDiscoverQuery(query({ category: 'reading' }), NOW).q).toContain('topic:reader')
    expect(buildDiscoverQuery(query({ category: 'all' }), NOW).q).not.toContain('topic:')
  })

  it('adds language and update-range filters', () => {
    const built = buildDiscoverQuery(query({ language: 'Rust', updated: 'week' }), NOW)
    expect(built.q).toContain('language:Rust')
    expect(built.q).toContain('pushed:>=')
    expect(built.q).not.toBe(buildDiscoverQuery(query(), NOW).q)
  })

  it('turns a store search into a name and description query with the platform topic', () => {
    const built = buildDiscoverQuery(query({ query: 'git', platform: 'linux', sort: 'best-match' }), NOW)
    expect(built.q).toContain('git in:name,description')
    expect(built.q).toContain('topic:linux')
    expect(built.sort).toBeNull()
  })
})
