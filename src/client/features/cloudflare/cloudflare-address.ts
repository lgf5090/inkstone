/**
 * The Cloudflare app's address space, parsed into the screen it names.
 *
 * `/cloudflare` is one tab on the notebook's rail; every screen under it belongs to the app. A path
 * this app never links to answers the dashboard rather than a not-found card: the rail has already
 * told the reader they are in the Cloudflare app, and there is nothing behind them to go back to.
 */
export const CLOUDFLARE_BASE = '/cloudflare'

export type CloudflareScreen =
  | 'dashboard'
  | 'accounts'
  | 'dns'
  | 'workers'
  | 'storage'
  | 'tunnels'
  | 'ai'
  | 'browser-render'
  | 'store'
  | 'settings'

export const CLOUDFLARE_SCREENS: readonly CloudflareScreen[] = [
  'dashboard',
  'accounts',
  'dns',
  'workers',
  'storage',
  'tunnels',
  'ai',
  'browser-render',
  'store',
  'settings',
]

export type CloudflareAiTab = 'stats' | 'chat' | 'image' | 'audio' | 'translate'

export const CLOUDFLARE_AI_TABS: readonly CloudflareAiTab[] = ['stats', 'chat', 'image', 'audio', 'translate']

export interface CloudflareAddress {
  screen: CloudflareScreen
  aiTab: CloudflareAiTab
}

function segment(pathname: string): string {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (!trimmed.startsWith(`${CLOUDFLARE_BASE}/`)) return ''
  return trimmed.slice(CLOUDFLARE_BASE.length + 1)
}

export function parseCloudflareAddress(pathname: string, search = ''): CloudflareAddress {
  const name = segment(pathname)
  const screen = (CLOUDFLARE_SCREENS as readonly string[]).includes(name)
    ? (name as CloudflareScreen)
    : 'dashboard'
  const requestedTab = new URLSearchParams(search).get('tab')
  const aiTab = (CLOUDFLARE_AI_TABS as readonly string[]).includes(requestedTab ?? '')
    ? (requestedTab as CloudflareAiTab)
    : 'stats'
  return { screen, aiTab }
}

/** The address one screen answers to; the tab links and the rail both use it. */
export function cloudflareScreenPath(screen: CloudflareScreen): string {
  return screen === 'dashboard' ? CLOUDFLARE_BASE : `${CLOUDFLARE_BASE}/${screen}`
}
