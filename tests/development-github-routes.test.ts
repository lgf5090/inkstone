import { describe, expect, it } from 'vitest'
import { gistAddress, parseGithubRoute, repoAddress, tabAddress } from '../src/client/features/development/github/routes'

describe('GitHub addresses', () => {
  it('parses tab, repository and gist routes', () => {
    expect(parseGithubRoute('/development/github')).toEqual({ tab: 'repos', repoFullName: null, gistId: null })
    expect(parseGithubRoute('/development/github/gists')).toEqual({ tab: 'gists', repoFullName: null, gistId: null })
    expect(parseGithubRoute('/development/github/gists/ABCDEF12')).toEqual({ tab: 'gists', repoFullName: null, gistId: 'abcdef12' })
    expect(parseGithubRoute('/development/github/repos/Octo/Repo.js')).toEqual({ tab: 'repos', repoFullName: 'Octo/Repo.js', gistId: null })
  })

  it('refuses segments that cannot be a repository', () => {
    expect(parseGithubRoute('/development/github/repos/../x')).toEqual({ tab: 'repos', repoFullName: null, gistId: null })
    expect(parseGithubRoute('/development/github/repos/owner')).toEqual({ tab: 'repos', repoFullName: null, gistId: null })
  })

  it('builds the addresses it parses', () => {
    expect(repoAddress('Octo/Repo.js')).toBe('/development/github/repos/Octo/Repo.js')
    expect(gistAddress('abcdef12')).toBe('/development/github/gists/abcdef12')
    expect(tabAddress('repos')).toBe('/development/github')
    expect(tabAddress('gists')).toBe('/development/github/gists')
  })
})
