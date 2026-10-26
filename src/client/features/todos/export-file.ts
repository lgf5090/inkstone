/**
 * Handing an exported file to the browser.
 *
 * The to-do app keeps its own copy of this ten-line idiom rather than importing `downloadBlob` from
 * `lib/export-note`, because that module is the *note* exporter and its imports come with it: the Markdown
 * pipeline, the KaTeX stylesheet inlined for the print frame, the diagram CSS, the embed resolver. Pulling
 * it into a to-do screen would put all of that behind a button on a page that renders none of it, and it
 * breaks the module's own test environment, which cannot resolve a `?inline` stylesheet. `stats-csv.ts`
 * already downloads this way for the same reason; this is that rule written once for the whole feature.
 */

/** How long a spent object URL is kept alive: a browser may start reading the blob after the click returns. */
const REVOKE_DELAY_MS = 1000

export function saveFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}
