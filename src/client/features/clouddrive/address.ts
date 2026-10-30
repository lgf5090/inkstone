import { useMemo } from 'react'
import { usePathname, useSearch } from '../../lib/app-history'

export type CloudDrivePage =
  | 'files'
  | 'album'
  | 'recent'
  | 'starred'
  | 'offline'
  | 'trash'
  | 'shares'
  | 'requests'
  | 'mounts'
  | 'storage'
  | 'dashboard'
  | 'files-admin'
  | 'index'
  | 'preview-settings'
  | 'jobs'
  | 'tasks'
  | 'sync'
  | 'keys'
  | 'maintenance'
  | 'settings'

export interface CloudDriveAddress {
  page: CloudDrivePage
  mountId: string
  path: string
}

const PAGES: readonly [string, CloudDrivePage][] = [
  ['/clouddrive/album', 'album'],
  ['/clouddrive/recent', 'recent'],
  ['/clouddrive/starred', 'starred'],
  ['/clouddrive/offline', 'offline'],
  ['/clouddrive/trash', 'trash'],
  ['/clouddrive/shares', 'shares'],
  ['/clouddrive/requests', 'requests'],
  ['/clouddrive/mounts', 'mounts'],
  ['/clouddrive/storage', 'storage'],
  ['/clouddrive/dashboard', 'dashboard'],
  ['/clouddrive/files-admin', 'files-admin'],
  ['/clouddrive/index', 'index'],
  ['/clouddrive/settings/preview', 'preview-settings'],
  ['/clouddrive/jobs', 'jobs'],
  ['/clouddrive/tasks', 'tasks'],
  ['/clouddrive/sync', 'sync'],
  ['/clouddrive/keys', 'keys'],
  ['/clouddrive/maintenance', 'maintenance'],
  ['/clouddrive/settings', 'settings'],
]

export function parseCloudDriveAddress(pathname: string, search: string): CloudDriveAddress {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const params = new URLSearchParams(search)
  const mountId = params.get('mount') ?? 'primary'
  for (const [prefix, page] of PAGES) {
    if (path === prefix) return { page, mountId, path: '/' }
  }
  const filesPrefix = '/clouddrive/files/'
  if (path.startsWith(filesPrefix)) {
    const rest = path.slice(filesPrefix.length)
    const slash = rest.indexOf('/')
    const mount = slash < 0 ? rest : rest.slice(0, slash)
    const inner = slash < 0 ? '/' : `/${rest.slice(slash + 1)}`
    return { page: 'files', mountId: decodeSegment(mount) || 'primary', path: decodePath(inner) || '/' }
  }
  const innerPath = params.get('path')
  return { page: 'files', mountId, path: innerPath && innerPath.startsWith('/') ? innerPath : '/' }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function decodePath(value: string): string {
  return value.split('/').map(decodeSegment).join('/')
}

export function cloudDrivePath(page: CloudDrivePage, mountId: string, path = '/'): string {
  if (page === 'files') {
    const encoded = path === '/' ? '' : path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    return mountId === 'primary' && !encoded
      ? '/clouddrive'
      : `/clouddrive/files/${encodeURIComponent(mountId)}${encoded ? `/${encoded}` : ''}`
  }
  const base = {
    album: '/clouddrive/album',
    recent: '/clouddrive/recent',
    starred: '/clouddrive/starred',
    offline: '/clouddrive/offline',
    trash: '/clouddrive/trash',
    shares: '/clouddrive/shares',
    requests: '/clouddrive/requests',
    mounts: '/clouddrive/mounts',
    storage: '/clouddrive/storage',
    dashboard: '/clouddrive/dashboard',
    'files-admin': '/clouddrive/files-admin',
    index: '/clouddrive/index',
    'preview-settings': '/clouddrive/settings/preview',
    jobs: '/clouddrive/jobs',
    tasks: '/clouddrive/tasks',
    sync: '/clouddrive/sync',
    keys: '/clouddrive/keys',
    maintenance: '/clouddrive/maintenance',
    settings: '/clouddrive/settings',
  }[page]
  return mountId === 'primary' ? base : `${base}?mount=${encodeURIComponent(mountId)}`
}

export function useCloudDriveAddress(): CloudDriveAddress {
  const pathname = usePathname()
  const search = useSearch()
  return useMemo(() => parseCloudDriveAddress(pathname, search), [pathname, search])
}
