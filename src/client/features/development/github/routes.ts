import type { GithubTab } from './components/ModuleTabs'

const GIST_ID = /^[a-f0-9]{8,64}$/i
const REPO_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/

export type GithubStoreView = 'discover' | 'apps'

export interface GithubRoute {
  tab: GithubTab
  repoFullName: string | null
  gistId: string | null
  storeView: GithubStoreView
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function parseGithubRoute(pathname: string): GithubRoute {
  const rest = pathname.startsWith('/development/github')
    ? pathname.slice('/development/github'.length)
    : ''
  const segments = rest.split('/').filter(Boolean)
  if (segments[0] === 'gists') {
    const id = segments[1] && GIST_ID.test(segments[1]) ? segments[1].toLowerCase() : null
    return { tab: 'gists', repoFullName: null, gistId: id, storeView: 'discover' }
  }
  if (segments[0] === 'store') {
    return { tab: 'store', repoFullName: null, gistId: null, storeView: segments[1] === 'apps' ? 'apps' : 'discover' }
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeSegment(segments[1]!)
    const name = decodeSegment(segments[2]!)
    if (owner && name && REPO_SEGMENT.test(owner) && REPO_SEGMENT.test(name)) {
      return { tab: 'repos', repoFullName: `${owner}/${name}`, gistId: null, storeView: 'discover' }
    }
  }
  return { tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover' }
}

export function repoAddress(fullName: string): string {
  const [owner, name] = fullName.split('/')
  return `/development/github/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`
}

export function gistAddress(id: string): string {
  return `/development/github/gists/${encodeURIComponent(id)}`
}

export function tabAddress(tab: GithubTab): string {
  if (tab === 'gists') return '/development/github/gists'
  if (tab === 'store') return '/development/github/store'
  return '/development/github'
}

export function storeAddress(view: GithubStoreView): string {
  return view === 'apps' ? '/development/github/store/apps' : '/development/github/store'
}

export function parseRepoInput(value: string): string | null {
  let trimmed = value.trim()
  if (!trimmed) return null
  trimmed = trimmed.replace(/^https?:\/\/github\.com\//i, '').replace(/^git@github\.com:/i, '')
  trimmed = trimmed.replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = trimmed.split('/')
  if (parts.length !== 2) return null
  const owner = parts[0]!
  const name = parts[1]!
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) return null
  return `${owner}/${name}`
}
