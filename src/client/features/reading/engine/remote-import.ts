const BOOK_EXTENSIONS = new Set(['epub', 'pdf', 'cbz'])

export interface RemoteBook {
  url: string
  filename: string
  extension: 'epub' | 'pdf' | 'cbz'
}

export function parseRemoteBookUrl(value: string): RemoteBook {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('invalid_url')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url')
  let filename: string
  try {
    filename = decodeURIComponent(url.pathname.split('/').pop() ?? '')
  } catch {
    throw new Error('invalid_url')
  }
  filename = filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200)
  const extension = filename.split('.').pop()?.toLowerCase()
  if (!filename || !BOOK_EXTENSIONS.has(extension ?? '')) throw new Error('unsupported_format')
  return { url: url.toString(), filename, extension: extension as RemoteBook['extension'] }
}
