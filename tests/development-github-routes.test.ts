import { describe, expect, it } from 'vitest'
import { gistAddress, parseGithubRoute, parseRepoInput, repoAddress, storeAddress, tabAddress } from '../src/client/features/development/github/routes'

describe('GitHub addresses', () => {
  it('parses tab, repository and gist routes', () => {
    expect(parseGithubRoute('/development/github')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover' })
    expect(parseGithubRoute('/development/github/gists')).toEqual({ tab: 'gists', repoFullName: null, gistId: null, storeView: 'discover' })
    expect(parseGithubRoute('/development/github/gists/ABCDEF12')).toEqual({ tab: 'gists', repoFullName: null, gistId: 'abcdef12', storeView: 'discover' })
    expect(parseGithubRoute('/development/github/repos/Octo/Repo.js')).toEqual({ tab: 'repos', repoFullName: 'Octo/Repo.js', gistId: null, storeView: 'discover' })
    expect(parseGithubRoute('/development/github/store')).toEqual({ tab: 'store', repoFullName: null, gistId: null, storeView: 'discover' })
    expect(parseGithubRoute('/development/github/store/apps')).toEqual({ tab: 'store', repoFullName: null, gistId: null, storeView: 'apps' })
    expect(parseGithubRoute('/development/github/store/unknown')).toEqual({ tab: 'store', repoFullName: null, gistId: null, storeView: 'discover' })
  })

  it('refuses segments that cannot be a repository', () => {
    expect(parseGithubRoute('/development/github/repos/../x')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover' })
    expect(parseGithubRoute('/development/github/repos/owner')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover' })
  })

  it('survives malformed percent encoding in a deep link', () => {
    expect(parseGithubRoute('/development/github/repos/%/x')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover' })
    expect(parseGithubRoute('/development/github/repos/octo/%E0%A4%A')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover' })
  })

  it('builds the addresses it parses', () => {
    expect(repoAddress('Octo/Repo.js')).toBe('/development/github/repos/Octo/Repo.js')
    expect(gistAddress('abcdef12')).toBe('/development/github/gists/abcdef12')
    expect(tabAddress('repos')).toBe('/development/github')
    expect(tabAddress('gists')).toBe('/development/github/gists')
    expect(tabAddress('store')).toBe('/development/github/store')
    expect(storeAddress('discover')).toBe('/development/github/store')
    expect(storeAddress('apps')).toBe('/development/github/store/apps')
  })

  it('accepts repository URLs and owner/name input', () => {
    expect(parseRepoInput('https://github.com/Octo/Repo.git')).toBe('Octo/Repo')
    expect(parseRepoInput('http://github.com/Octo/Repo/')).toBe('Octo/Repo')
    expect(parseRepoInput('git@github.com:Octo/Repo.git')).toBe('Octo/Repo')
    expect(parseRepoInput(' Octo/Repo ')).toBe('Octo/Repo')
    expect(parseRepoInput('https://gitlab.com/octo/repo')).toBeNull()
    expect(parseRepoInput('octo')).toBeNull()
  })
})
