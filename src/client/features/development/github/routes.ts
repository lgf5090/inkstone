import type { GithubViewId } from '@shared/development/github/types'
import type { GithubTab } from './components/ModuleTabs'

const GIST_ID = /^[a-f0-9]{8,64}$/i
const REPO_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/
const VIEW_ID = /^[A-Za-z0-9_-]{1,100}$/

export type GithubStoreView = 'discover' | 'apps' | 'favorites'

export interface GithubRoute {
  tab: GithubTab
  repoFullName: string | null
  gistId: string | null
  storeView: GithubStoreView
  viewId: GithubViewId | null
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
    return { tab: 'gists', repoFullName: null, gistId: id, storeView: 'discover', viewId: null }
  }
  if (segments[0] === 'store') {
    const view = segments[1] === 'apps' ? 'apps' : segments[1] === 'favorites' ? 'favorites' : 'discover'
    return { tab: 'store', repoFullName: null, gistId: null, storeView: view, viewId: null }
  }
  if ((segments[0] === 'tags' || segments[0] === 'collections') && segments[1] && VIEW_ID.test(segments[1])) {
    const prefix = segments[0] === 'tags' ? 'tag:' : 'collection:'
    return { tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: `${prefix}${segments[1]}` }
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeSegment(segments[1]!)
    const name = decodeSegment(segments[2]!)
    if (owner && name && REPO_SEGMENT.test(owner) && REPO_SEGMENT.test(name)) {
      return { tab: 'repos', repoFullName: `${owner}/${name}`, gistId: null, storeView: 'discover', viewId: null }
    }
  }
  return { tab: 'repos', repoFullName: null, gistId: null, storeView: 'discover', viewId: null }
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
  if (view === 'apps') return '/development/github/store/apps'
  if (view === 'favorites') return '/development/github/store/favorites'
  return '/development/github/store'
}

export function tagAddress(id: string): string {
  return `/development/github/tags/${encodeURIComponent(id)}`
}

export function collectionAddress(id: string): string {
  return `/development/github/collections/${encodeURIComponent(id)}`
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
