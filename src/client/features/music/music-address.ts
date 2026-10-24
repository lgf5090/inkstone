/**
 * The music app's address space, parsed into the screen it names.
 *
 * The shell owns this shape rather than the tab table: `/music` is one tab, and every screen under it
 * — a playlist, an album, a podcast — is the container's own sub-address. Keeping the parse pure means
 * a deep link can be read in a test, and the back button works without a router.
 */
export type MusicPage =
  | { kind: 'home' }
  | { kind: 'search'; query: string }
  | { kind: 'playlist'; id: string }
  | { kind: 'album'; id: string }
  | { kind: 'artist'; id: string }
  | { kind: 'toplist'; id: string }
  | { kind: 'mv' }
  | { kind: 'mvDetail'; id: string }
  | { kind: 'podcast' }
  | { kind: 'podcastDetail'; id: string }
  | { kind: 'favorites' }
  | { kind: 'history' }
  | { kind: 'uploads' }
  | { kind: 'downloads' }
  | { kind: 'user'; id: string }
  | { kind: 'login' }
  | { kind: 'settings' }
  | { kind: 'notFound'; path: string }

const BASE = '/music'

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A malformed escape is not an id this app produced; the raw segment is the most useful answer
    // for a not-found screen, and the API will reject it as unknown anyway.
    return value
  }
}

function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(decodeSegment)
}

/**
 * Read a `/music` address.
 *
 * A missing id on a detail screen is not a detail screen with an empty id; it is an address this app
 * never links to, so it answers `notFound` rather than asking the server for `/albums/`.
 */
export function parseMusicAddress(pathname: string, search = ''): MusicPage {
  const segments = segmentsOf(pathname)
  const base = segments[0]
  if (base !== 'music') return { kind: 'notFound', path: pathname }
  const rest = segments.slice(1)
  if (rest.length === 0) return { kind: 'home' }

  const [head, id] = rest
  switch (head) {
    case 'search':
      if (rest.length > 1) return { kind: 'notFound', path: pathname }
      return { kind: 'search', query: new URLSearchParams(search).get('q') ?? '' }
    case 'playlist':
      return id ? { kind: 'playlist', id } : { kind: 'notFound', path: pathname }
    case 'album':
      return id ? { kind: 'album', id } : { kind: 'notFound', path: pathname }
    case 'artist':
      return id ? { kind: 'artist', id } : { kind: 'notFound', path: pathname }
    case 'toplist':
      return id ? { kind: 'toplist', id } : { kind: 'notFound', path: pathname }
    case 'mv':
      if (rest.length === 1) return { kind: 'mv' }
      return rest.length === 2 && id ? { kind: 'mvDetail', id } : { kind: 'notFound', path: pathname }
    case 'podcast':
      if (rest.length === 1) return { kind: 'podcast' }
      return rest.length === 2 && id ? { kind: 'podcastDetail', id } : { kind: 'notFound', path: pathname }
    case 'favorites':
      return rest.length === 1 ? { kind: 'favorites' } : { kind: 'notFound', path: pathname }
    case 'history':
      return rest.length === 1 ? { kind: 'history' } : { kind: 'notFound', path: pathname }
    case 'uploads':
      return rest.length === 1 ? { kind: 'uploads' } : { kind: 'notFound', path: pathname }
    case 'downloads':
      return rest.length === 1 ? { kind: 'downloads' } : { kind: 'notFound', path: pathname }
    case 'login':
      return rest.length === 1 ? { kind: 'login' } : { kind: 'notFound', path: pathname }
    case 'settings':
      return rest.length === 1 ? { kind: 'settings' } : { kind: 'notFound', path: pathname }
    case 'user':
      return id ? { kind: 'user', id } : { kind: 'notFound', path: pathname }
    default:
      return { kind: 'notFound', path: pathname }
  }
}

/** The address a screen is linked with, so a rail button and a pasted URL say the same thing. */
export function musicPathFor(page: MusicPage): string {
  switch (page.kind) {
    case 'home':
      return BASE
    case 'search':
      return page.query ? `${BASE}/search?q=${encodeURIComponent(page.query)}` : `${BASE}/search`
    case 'playlist':
    case 'album':
    case 'artist':
    case 'toplist':
    case 'user':
      return `${BASE}/${page.kind}/${encodeURIComponent(page.id)}`
    case 'mv':
      return `${BASE}/mv`
    case 'mvDetail':
      return `${BASE}/mv/${encodeURIComponent(page.id)}`
    case 'podcast':
      return `${BASE}/podcast`
    case 'podcastDetail':
      return `${BASE}/podcast/${encodeURIComponent(page.id)}`
    case 'favorites':
    case 'history':
    case 'uploads':
    case 'downloads':
    case 'login':
    case 'settings':
      return `${BASE}/${page.kind}`
    case 'notFound':
      return BASE
  }
}

/** Whether an address belongs to the music container at all. */
export function isMusicAddress(pathname: string): boolean {
  return pathname === BASE || pathname.startsWith(`${BASE}/`)
}
