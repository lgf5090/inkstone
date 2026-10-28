/**
 * A minimal PDF 1.4 writer for page images.
 *
 * Each page is one JPEG XObject painted over a MediaBox sized like the logical page, so the PDF keeps
 * the note's page proportions instead of the pixel size of the render. The reference hard-coded
 * `/Parent 2 0 R` and allocated the Pages object last; here every reference is assigned before the
 * bodies are written. No canvas, font or DOM is involved: callers hand in DCT bytes.
 */

export interface PdfPageImage {
  /** Pixel dimensions of the JPEG. */
  width: number
  height: number
  /** JPEG bytes, already DCT-encoded. */
  jpeg: Uint8Array
  /** MediaBox size in PDF points. Falls back to the document options, then to the pixel size. */
  pdfWidth?: number
  pdfHeight?: number
}

export interface PdfWriteOptions {
  /** Default MediaBox width for pages that do not carry their own. */
  pdfWidth?: number
  /** Default MediaBox height for pages that do not carry their own. */
  pdfHeight?: number
}

const PDF_HEADER = '%PDF-1.4\n'
const encoder = new TextEncoder()

/** Build a PDF whose page count equals `pages.length`; an empty list is a valid zero-page file. */
export function buildPdf(pages: readonly PdfPageImage[], opts: PdfWriteOptions = {}): Blob {
  validateOptionalSize(opts.pdfWidth, 'options.pdfWidth')
  validateOptionalSize(opts.pdfHeight, 'options.pdfHeight')
  const resolved = pages.map((page, index) => resolvePage(page, opts, index))
  const pageCount = resolved.length
  const objectCount = 2 + pageCount * 3
  const objects: Uint8Array[][] = Array.from({ length: objectCount }, () => [])

  objects[0]!.push(bytes(`<< /Type /Catalog /Pages 2 0 R >>`))
  objects[1]!.push(bytes(`<< /Type /Pages /Kids [${pageIds(pageCount)}] /Count ${pageCount} >>`))

  for (let i = 0; i < pageCount; i++) {
    const page = resolved[i]!
    const pageId = 3 + i
    const imageId = 3 + pageCount + i * 2
    const contentId = imageId + 1
    const content = `q\n${formatNumber(page.mediaWidth)} 0 0 ${formatNumber(page.mediaHeight)} 0 0 cm\n/Im0 Do\nQ`
    const contentBytes = bytes(content)
    objects[pageId - 1]!.push(bytes(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatNumber(page.mediaWidth)} ${formatNumber(page.mediaHeight)}]`
      + ` /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ))
    objects[imageId - 1]!.push(bytes(
      `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight}`
      + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    ))
    objects[imageId - 1]!.push(page.jpeg)
    objects[imageId - 1]!.push(bytes('\nendstream'))
    objects[contentId - 1]!.push(bytes(`<< /Length ${contentBytes.length} >>\nstream\n`))
    objects[contentId - 1]!.push(contentBytes)
    objects[contentId - 1]!.push(bytes('\nendstream'))
  }

  const parts: Uint8Array[] = []
  const header = bytes(PDF_HEADER)
  parts.push(header)
  let offset = header.length
  const offsets: number[] = []
  for (let i = 0; i < objectCount; i++) {
    offsets.push(offset)
    const open = bytes(`${i + 1} 0 obj\n`)
    parts.push(open)
    offset += open.length
    for (const part of objects[i]!) {
      parts.push(part)
      offset += part.length
    }
    const close = bytes('\nendobj\n')
    parts.push(close)
    offset += close.length
  }

  const xrefOffset = offset
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`
  for (const objectOffset of offsets) {
    xref += `${String(objectOffset).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  parts.push(bytes(xref))
  // A Uint8Array is a valid BlobPart; its buffer type is wider than BlobPart's in TypeScript 5.9.
  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}

interface ResolvedPage {
  jpeg: Uint8Array
  pixelWidth: number
  pixelHeight: number
  mediaWidth: number
  mediaHeight: number
}

function resolvePage(page: PdfPageImage, opts: PdfWriteOptions, index: number): ResolvedPage {
  if (!(page.jpeg instanceof Uint8Array) || page.jpeg.length === 0) {
    throw new TypeError(`buildPdf: page ${index} needs non-empty JPEG bytes`)
  }
  validateSize(page.width, `page ${index} width`)
  validateSize(page.height, `page ${index} height`)
  const mediaWidth = page.pdfWidth ?? opts.pdfWidth ?? page.width
  const mediaHeight = page.pdfHeight ?? opts.pdfHeight ?? page.height
  validateSize(mediaWidth, `page ${index} pdfWidth`)
  validateSize(mediaHeight, `page ${index} pdfHeight`)
  return {
    jpeg: page.jpeg,
    pixelWidth: Math.max(1, Math.round(page.width)),
    pixelHeight: Math.max(1, Math.round(page.height)),
    mediaWidth,
    mediaHeight,
  }
}

function validateSize(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`buildPdf: ${label} must be a positive finite number`)
  }
}

function validateOptionalSize(value: number | undefined, label: string): void {
  if (value !== undefined) validateSize(value, label)
}

function pageIds(pageCount: number): string {
  const ids: string[] = []
  for (let i = 0; i < pageCount; i++) ids.push(`${3 + i} 0 R`)
  return ids.join(' ')
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)))
}

function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}
