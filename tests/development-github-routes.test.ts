import { describe, expect, it } from 'vitest'
import { collectionAddress, gistAddress, parseGithubRoute, parseRepoInput, repoAddress, storeAddress, tabAddress, tagAddress } from '../src/client/features/development/github/routes'

describe('GitHub addresses', () => {
  it('parses tab, repository and gist routes', () => {
    expect(parseGithubRoute('/development/github')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: null })
    expect(parseGithubRoute('/development/github/gists')).toEqual({ tab: 'gists', repoFullName: null, gistId: null, storeView: 'discover', viewId: null })
    expect(parseGithubRoute('/development/github/gists/ABCDEF12')).toEqual({ tab: 'gists', repoFullName: null, gistId: 'abcdef12', storeView: 'discover', viewId: null })
    expect(parseGithubRoute('/development/github/repos/Octo/Repo.js')).toEqual({ tab: 'repos', repoFullName: 'Octo/Repo.js', gistId: null, storeView: 'discover', viewId: null })
    expect(parseGithubRoute('/development/github/store')).toEqual({ tab: 'store', repoFullName: null, gistId: null, storeView: 'discover', viewId: null })
    expect(parseGithubRoute('/development/github/store/apps')).toEqual({ tab: 'store', repoFullName: null, gistId: null, storeView: 'apps', viewId: null })
    expect(parseGithubRoute('/development/github/store/unknown')).toEqual({ tab: 'store', repoFullName: null, gistId: null, storeView: 'discover', viewId: null })
  })

  it('refuses segments that cannot be a repository', () => {
    expect(parseGithubRoute('/development/github/repos/../x')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: null })
    expect(parseGithubRoute('/development/github/repos/owner')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: null })
  })

  it('survives malformed percent encoding in a deep link', () => {
    expect(parseGithubRoute('/development/github/repos/%/x')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: null })
    expect(parseGithubRoute('/development/github/repos/octo/%E0%A4%A')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: null })
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

  it('parses and builds tag and collection deep links', () => {
    expect(parseGithubRoute('/development/github/tags/gtag-abc')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: 'tag:gtag-abc' })
    expect(parseGithubRoute('/development/github/collections/gh-collection-1')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: 'collection:gh-collection-1' })
    expect(parseGithubRoute('/development/github/tags/bad%2Fid')).toEqual({ tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: null })
    expect(tagAddress('gtag-abc')).toBe('/development/github/tags/gtag-abc')
    expect(collectionAddress('gh collection')).toBe('/development/github/collections/gh%20collection')
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
