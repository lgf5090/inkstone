/**
 * A PDF's words, read in the browser.
 *
 * The worker cannot pull text out of a PDF — it has no parser and no DOM — so the browser reads it at
 * upload time, where PDF.js already runs for the reading app, and sends the words along with the bytes.
 * The library is imported lazily so an attachment that is not a PDF never pays for it, and the
 * extraction is bounded so a nine-hundred-page manual does not arrive as one enormous prompt.
 */

/** How much text a document may contribute; the worker clamps again on its side. */
export const PDF_TEXT_CHAR_CAP = 48_000

/** How many pages are read before the cap is trusted to have been reached. */
const MAX_PAGES = 400

export async function extractPdfText(file: File): Promise<string> {
  const { openPdfDocument, readPdfPageText } = await import('../reading/engine/pdf')
  let opened: Awaited<ReturnType<typeof openPdfDocument>> | null = null
  try {
    opened = await openPdfDocument(new Uint8Array(await file.arrayBuffer()))
    const pages = Math.min(opened.document.numPages, MAX_PAGES)
    const parts: string[] = []
    let used = 0
    for (let number = 1; number <= pages; number++) {
      if (used >= PDF_TEXT_CHAR_CAP) break
      const page = await opened.document.getPage(number).catch(() => null)
      if (!page) continue
      const text = (await readPdfPageText(page)).text.trim()
      if (!text) continue
      parts.push(text)
      used += text.length
    }
    return parts.join('\n\n').slice(0, PDF_TEXT_CHAR_CAP)
  } catch {
    // A scanned page, an encrypted file, or one this browser cannot open: no text is a real answer, and
    // the file is still attached and named rather than the upload failing.
    return ''
  } finally {
    await opened?.destroy().catch(() => undefined)
  }
}
