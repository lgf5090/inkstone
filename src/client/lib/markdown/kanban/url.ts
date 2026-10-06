/**
 * Protocol whitelist for URLs that come from kanban fence content. Fence JSON is
 * user-authored (and arrives via shares/imports), so covers and file urls are
 * rendered from data we do not trust.
 */

// `blob:` stays because the demo backend answers kanban uploads with object
// urls (`demo/backend/routes/files.ts` → `browserFileUrl`): a blob url is
// runtime-created, origin-scoped and unforgeable by a fence author, and it is
// session-local, so it can never point at anything the writer did not just
// upload. `kanbanFileLocation` below still rejects it, so it buys no delete or
// read path — it is a render whitelist, not an authority grant.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'blob:'])

export function safeKanbanUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '') return null
  // A leading slash is same-site; '//' would be a protocol-relative external request.
  if (value.startsWith('/') && !value.startsWith('//')) return value
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (ALLOWED_PROTOCOLS.has(parsed.protocol)) return value
  return null
}

/**
 * A cover is the one URL field the browser never follows — it is drawn as an `<img src>`, where a
 * data url carries the pixels and any script inside it cannot run. A file's url, by contrast, is a
 * link the reader can press and a body the panel can fetch, so it keeps the stricter list; a cover
 * may additionally be an inline image.
 */
export function safeKanbanCoverUrl(raw: string | undefined): string | null {
  const shared = safeKanbanUrl(raw)
  if (shared !== null) return shared
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value.toLowerCase().startsWith('data:image/')) return null
  try {
    return new URL(value).protocol === 'data:' ? value : null
  } catch {
    return null
  }
}

const API_FILE_URL = /^\/api\/files\/([^/?#]+)$/

/**
 * The attachment a board card links to, addressed the way this app stores attachments: by id, read
 * back out of the URL the upload answered with. Anything else — a link to somebody else's server, a
 * session-local blob — is not ours to delete, and the caller offers no delete for it.
 */
export function kanbanFileId(file: { url?: string }): string | null {
  const fromUrl = API_FILE_URL.exec(file.url ?? '')
  if (!fromUrl) return null
  const id = decodeURIComponent(fromUrl[1]!)
  return id === '' ? null : id
}
