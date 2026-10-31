import type { GithubTab } from './components/ModuleTabs'

const GIST_ID = /^[a-f0-9]{8,64}$/i
const REPO_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/

export interface GithubRoute {
  tab: GithubTab
  repoFullName: string | null
  gistId: string | null
}

export function parseGithubRoute(pathname: string): GithubRoute {
  const rest = pathname.startsWith('/development/github')
    ? pathname.slice('/development/github'.length)
    : ''
  const segments = rest.split('/').filter(Boolean)
  if (segments[0] === 'gists') {
    const id = segments[1] && GIST_ID.test(segments[1]) ? segments[1].toLowerCase() : null
    return { tab: 'gists', repoFullName: null, gistId: id }
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1]!)
    const name = decodeURIComponent(segments[2]!)
    if (REPO_SEGMENT.test(owner) && REPO_SEGMENT.test(name)) {
      return { tab: 'repos', repoFullName: `${owner}/${name}`, gistId: null }
    }
  }
  return { tab: 'repos', repoFullName: null, gistId: null }
}

export function repoAddress(fullName: string): string {
  const [owner, name] = fullName.split('/')
  return `/development/github/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`
}

export function gistAddress(id: string): string {
  return `/development/github/gists/${encodeURIComponent(id)}`
}

export function tabAddress(tab: GithubTab): string {
  return tab === 'gists' ? '/development/github/gists' : '/development/github'
}
