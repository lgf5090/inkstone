/**
 * PDF.js, wired to this app rather than to a viewer.
 *
 * A PDF is a page description, not a flowing text, so the reader keeps each page as the source of
 * visual truth: PDF.js paints the page to a canvas and its own `TextLayer` is laid over the top,
 * visually transparent but selectable, searchable and highlightable. That is also what decides what a
 * page can do — a scan has no text layer, so it gets progress and nothing that needs words.
 *
 * Everything here sits behind a dynamic import from the reader: the library, its worker, its CMaps and
 * its image decoders are the heaviest thing the reading app can load, and an EPUB-only reader should
 * never pay for them. The files themselves are served by `pdfjsVendorPlugin` in `vite.config.ts`.
 */
import * as pdfjs from 'pdfjs-dist'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from 'pdfjs-dist'

/** What a page hands back from `getTextContent`, named once so three signatures can share it. */
export type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>

const VENDOR_BASE = '/vendor/pdfjs/'

let configured = false

function configurePdfjs(): void {
  if (configured) return
  configured = true
  pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR_BASE}build/pdf.worker.min.mjs`
}

export interface OpenedPdf {
  document: PDFDocumentProxy
  /**
   * The loading task owns the worker, and `PDFDocumentProxy` has no `destroy` of its own: dropping the
   * document without this leaves a worker thread and its decoded page caches alive for the tab's life.
   */
  destroy: () => Promise<void>
}

export async function openPdfDocument(data: Uint8Array, password?: string): Promise<OpenedPdf> {
  configurePdfjs()
  const task: PDFDocumentLoadingTask = pdfjs.getDocument({
    data,
    password,
    cMapUrl: `${VENDOR_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${VENDOR_BASE}standard_fonts/`,
    wasmUrl: `${VENDOR_BASE}wasm/`,
    // A scanned page is the common case for a Chinese book that arrived as a PDF, and both decoders
    // are served from the vendor directory above; without the URL PDF.js paints those pages blank.
    useWorkerFetch: false,
    verbosity: 0,
  })
  const document = await task.promise
  return { document, destroy: () => task.destroy() }
}

export interface PdfOutlineEntry {
  title: string
  page: number | null
  level: number
}

export interface PdfSummary {
  title: string
  author: string
  pages: number
  outline: PdfOutlineEntry[]
  /** True when a sampled page gave up any text, which is what gates selection, search and Q&A. */
  hasText: boolean
}

/**
 * The document's own title, then the file name the reader chose, then nothing. PDF metadata is
 * frequently the name of whatever printed the file, so `info.Title` is only trusted when it is not
 * blank.
 */
export async function readPdfSummary(document: PDFDocumentProxy, fallbackTitle: string): Promise<PdfSummary> {
  const info = await document.getMetadata().catch(() => null)
  const raw = info?.info as { Title?: string; Author?: string } | undefined
  const outline = await readPdfOutline(document)
  return {
    title: (raw?.Title ?? '').trim() || fallbackTitle,
    author: (raw?.Author ?? '').trim(),
    pages: document.numPages,
    outline,
    hasText: await probePdfText(document),
  }
}

type OutlineNode = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number]

async function readPdfOutline(document: PDFDocumentProxy): Promise<PdfOutlineEntry[]> {
  const tree = await document.getOutline().catch(() => null)
  if (!tree?.length) return []
  const out: PdfOutlineEntry[] = []
  const walk = async (items: OutlineNode[], level: number): Promise<void> => {
    for (const item of items) {
      const title = (item.title ?? '').trim()
      let page: number | null = null
      if (item.dest) {
        try {
          const resolved = typeof item.dest === 'string'
            ? await document.getDestination(item.dest)
            : item.dest
          const reference = resolved?.[0]
          if (reference) page = (await document.getPageIndex(reference)) + 1
        } catch {
          page = null
        }
      }
      // An entry with no target is a section heading the author left dangling; showing it would
      // promise a jump that cannot happen.
      if (title && page) out.push({ title, page, level })
      if (item.items?.length && level < 5) await walk(item.items as OutlineNode[], level + 1)
    }
  }
  await walk(tree, 0)
  return out
}

/**
 * Whether this document can be read as text at all. Sampling every page of a 900-page manual would
 * cost seconds, so the probe looks at a spread and reports what it saw.
 */
async function probePdfText(document: PDFDocumentProxy): Promise<boolean> {
  const total = document.numPages
  const samples = [...new Set([1, Math.ceil(total / 2), total])]
  for (const pageNumber of samples) {
    const page = await document.getPage(pageNumber).catch(() => null)
    if (!page) continue
    const content = await page.getTextContent().catch(() => null)
    if ((content?.items.length ?? 0) > 0) return true
  }
  return false
}

export interface PdfTextItem {
  text: string
  start: number
  end: number
  /**
   * The index of the span PDF.js's text layer paints for this run. Selection and search both end up on
   * a span, so carrying the index is what keeps a stored offset and a visible mark on the same words.
   */
  span: number
}

export interface PdfPageText {
  /** The page's words as one string, which is the coordinate space a highlight lives in. */
  text: string
  items: PdfTextItem[]
}

/**
 * A page's text in the order the reader meets it.
 *
 * `hasEOL` becomes a real newline because PDF.js reports a wrapped line as separate runs, and a search
 * for a sentence that wraps would otherwise find nothing.
 */
export function readPdfTextContent(content: PdfTextContent): PdfPageText {
  const items: PdfTextItem[] = []
  let text = ''
  let span = -1
  for (const raw of content.items) {
    if (!('str' in raw) || typeof raw.str !== 'string') continue
    span += 1
    const start = text.length
    text += raw.str
    items.push({ text: raw.str, start, end: text.length, span })
    if ('hasEOL' in raw && raw.hasEOL) text += '\n'
  }
  return { text, items }
}

export async function readPdfPageText(page: PDFPageProxy): Promise<PdfPageText> {
  return readPdfTextContent(await page.getTextContent())
}

/** Lay PDF.js's transparent, selectable text over a painted page. */
export function buildPdfTextLayer(container: HTMLElement, content: PdfTextContent, viewport: PageViewport): pdfjs.TextLayer {
  return new pdfjs.TextLayer({ textContentSource: content, container, viewport })
}

export interface PdfPageRender {
  task: RenderTask
  viewport: PageViewport
}

/**
 * Paint one page into a canvas the caller owns.
 *
 * The render task is handed back rather than awaited because a fast reader turns pages faster than a
 * large page paints, and PDF.js cannot cancel a render it was never given the handle to.
 */
export function renderPdfPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  rotation = 0,
): PdfPageRender {
  const viewport = page.getViewport({ scale, rotation })
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
  canvas.style.width = `${Math.round(viewport.width)}px`
  canvas.style.height = `${Math.round(viewport.height)}px`
  const task = page.render({
    canvas,
    viewport,
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
  })
  return { task, viewport }
}

/** A cover for the shelf: the first page, small, as PNG bytes. */
export async function renderPdfThumbnail(pdf: PDFDocumentProxy, maxHeight = 480): Promise<Uint8Array | null> {
  const page = await pdf.getPage(1).catch(() => null)
  if (!page) return null
  const base = page.getViewport({ scale: 1 })
  if (!base.width || !base.height) return null
  const canvas = document.createElement('canvas')
  const viewport = page.getViewport({ scale: maxHeight / base.height })
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  try {
    await page.render({ canvas, viewport }).promise
  } catch {
    return null
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}
