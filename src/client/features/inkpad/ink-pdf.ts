export interface PdfRenderInfo {
    pageCount: number
    pageAspect: number
}

export interface PdfRenderRequest {
    url: string
    width: number
    allPages: boolean
    container: HTMLElement
    isCurrent: () => boolean
    pageLabel: (page: number) => string
}

/**
 * PDF.js is reached with a dynamic import so an ink note without a PDF card never pays for the
 * parser. The worker, CMaps and fonts are the ones the reader already serves from /vendor/pdfjs.
 */
export async function renderPdfPages({ url, width, allPages, container, isCurrent, pageLabel }: PdfRenderRequest): Promise<PdfRenderInfo> {
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`PDF fetch failed: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const { openPdfDocument } = await import('../reading/engine/pdf')
    const opened = await openPdfDocument(bytes)
    try {
        const pdf = opened.document
        const firstPage = await pdf.getPage(1)
        const natural = firstPage.getViewport({ scale: 1 })
        const pageAspect = natural.height / natural.width
        const count = allPages ? pdf.numPages : 1
        for (let index = 1; index <= count; index++) {
            if (!isCurrent()) break
            const page = index === 1 ? firstPage : await pdf.getPage(index)
            const cssScale = Math.max(0.2, width / natural.width)
            const pixelRatio = pdfPagePixelRatio(natural.width, natural.height, cssScale, allPages, count, window.devicePixelRatio || 1)
            const viewport = page.getViewport({ scale: cssScale * pixelRatio })
            const canvas = container.ownerDocument.createElement('canvas')
            canvas.className = 'inkpad-card-pdf-page'
            canvas.setAttribute('aria-label', pageLabel(index))
            canvas.width = Math.ceil(viewport.width)
            canvas.height = Math.ceil(viewport.height)
            container.append(canvas)
            const context = canvas.getContext('2d', { alpha: false })
            if (context) await page.render({ canvas, viewport }).promise
            page.cleanup()
            if (index < count) await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
        }
        return { pageCount: pdf.numPages, pageAspect }
    } finally {
        await opened.destroy()
    }
}

/** The per-page pixel ceiling the renderer uses; exported so the boundary is unit-tested. */
export function pdfPagePixelRatio(
    naturalWidth: number,
    naturalHeight: number,
    cssScale: number,
    allPages: boolean,
    pageCount: number,
    dpr: number,
): number {
    const requested = allPages ? 0.8 : Math.min(dpr || 1, 1.5)
    const maxPixels = allPages
        ? Math.max(120_000, Math.min(350_000, Math.floor(4_000_000 / Math.max(1, pageCount))))
        : 1_600_000
    return Math.min(requested, Math.sqrt(maxPixels / Math.max(1, naturalWidth * naturalHeight * cssScale * cssScale)))
}
