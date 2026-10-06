/**
 * The one answer to "does this URL leave this origin?" that the board reads for a cover, an
 * attachment preview and an attachment link.
 *
 * A note can be shared, so a file served by whoever wrote it is a different trust case from one this
 * app stored: an attachment link wearing `download` would navigate the app's own tab away rather than
 * save the file, and a preview of it is a fetch to somewhere the reader never chose.
 */
export function isCrossOriginUrl(src: string): boolean {
  if (!/^https?:/i.test(src))
    return false
  try {
    const base = typeof location === 'undefined' ? 'http://localhost/' : location.href
    const origin = typeof location === 'undefined' ? 'http://localhost/' : location.origin
    return new URL(src, base).origin !== origin
  }
  catch {
    return false
  }
}
