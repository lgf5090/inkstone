/** Browser-side file operations: insert media, import PDF pages and export the current note. */
import type { InknoteNoteMeta, InknotePage, InknotePageContent } from '@shared/inknote/types'
import { emptyPageContent, serializePageContent } from '@shared/inknote/parse'
import { fontStackFor } from '../../../lib/inknote/text-layout'
import { downloadBlob, safeFileName } from '../../../lib/export-note'
import { buildPdf, type PdfPageImage } from '../../../lib/inknote/pdf-writer'
import { parsePageRange } from '../../../lib/inknote/page-range'
import { renderPageToCanvas } from '../engine/renderer'
import { inknoteApi } from '../api'
import { useInknoteStore } from '../store'

function canvasBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.88): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality))
}

async function assetDataUrl(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Asset fetch failed: ${response.status}`)
  const blob = await response.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function insertImage(file: File, note: InknoteNoteMeta, page: InknotePage): Promise<void> {
  const asset = await inknoteApi.uploadAsset(file, 'image', note.id)
  const item = { id: crypto.randomUUID().replace(/-/g, ''), x: 0.28, y: 0.25, w: 0.44, h: 0.3, assetId: asset.id, url: asset.url, rot: 0 as const }
  page.content.images.push(item)
  useInknoteStore.getState().touchPage()
  window.dispatchEvent(new Event('inknote:invalidate'))
  await useInknoteStore.getState().savePage(page.id)
}

export interface ScanOptions {
  title: string
  onProgress?: (done: number, total: number) => void
  isCancelled?: () => boolean
}

async function rasterizeImage(file: File, maxSide: number): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, maxSide / Math.max(1, Math.max(bitmap.width, bitmap.height)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser cannot prepare a scan')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await canvasBlob(canvas, 'image/jpeg', 0.82)
    if (!blob) throw new Error('This browser cannot prepare a scan')
    return { blob, width: canvas.width, height: canvas.height }
  } finally {
    bitmap.close()
  }
}

/** Photos become one blank-paper note whose pages are the scanned images as backgrounds. */
export async function scanImages(files: File[], notebookId: string, options: ScanOptions): Promise<{ noteId: string | null; pages: number; cancelled: boolean }> {
  if (files.length === 0) return { noteId: null, pages: 0, cancelled: false }
  const created = await inknoteApi.createNote({ notebookId, title: options.title.slice(0, 200) })
  const note = created.note
  try {
    const first = await rasterizeImage(files[0]!, 1400)
    const pageHeight = Math.round(Math.min(1600, Math.max(400, 816 * first.height / Math.max(1, first.width))))
    await inknoteApi.updateNote(note.id, { pageWidth: 816, pageHeight, baseRev: note.rev })
    const firstPage = created.pages[0]!
    let reusedFirst = false
    for (const [index, file] of files.entries()) {
      if (options.isCancelled?.()) {
        await purgeImportedNote(note.id)
        return { noteId: null, pages: index, cancelled: true }
      }
      const raster = index === 0 ? first : await rasterizeImage(file, 1400)
      const asset = await inknoteApi.uploadAsset(new File([raster.blob], `scan-${index + 1}.jpg`, { type: 'image/jpeg' }), 'background', note.id)
      const content: InknotePageContent = {
        ...emptyPageContent(),
        bg: { kind: 'image', assetId: asset.id, url: asset.url, width: raster.width, height: raster.height, alpha: 1 },
      }
      if (!reusedFirst) {
        await inknoteApi.savePage(note.id, firstPage.id, serializePageContent(content), firstPage.rev)
        reusedFirst = true
      } else {
        await inknoteApi.createPage(note.id, { content: serializePageContent(content) })
      }
      options.onProgress?.(index + 1, files.length)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    }
    await useInknoteStore.getState().refreshLibrary()
    await useInknoteStore.getState().openNote(note.id)
    return { noteId: note.id, pages: files.length, cancelled: false }
  } catch (error) {
    await purgeImportedNote(note.id)
    throw error
  }
}

export interface PdfImportOptions {
  /** "1-3,7"; empty imports every page up to the sixty-page ceiling. */
  range?: string
  onProgress?: (done: number, total: number) => void
  isCancelled?: () => boolean
}

export interface PdfImportResult {
  noteId: string | null
  imported: number
  cancelled: boolean
}

const PDF_IMPORT_MAX_PAGES = 60
const PDF_IMPORT_MAX_BYTES = 50 * 1024 * 1024

export async function insertPdf(file: File, notebookId: string, options: PdfImportOptions = {}): Promise<PdfImportResult> {
  if (file.size > PDF_IMPORT_MAX_BYTES) throw new Error('The PDF exceeds the 50 MB limit')
  const { openPdfDocument } = await import('../../reading/engine/pdf')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const opened = await openPdfDocument(bytes)
  let noteId: string | null = null
  try {
    const pdf = opened.document
    const count = Math.min(pdf.numPages, PDF_IMPORT_MAX_PAGES)
    const indices = parsePageRange(options.range ?? '', count).map((index) => index + 1)
    if (!indices.length) return { noteId: null, imported: 0, cancelled: false }
    const firstIndex = indices[0]!
    const first = await pdf.getPage(firstIndex)
    const natural = first.getViewport({ scale: 1 })
    const ratio = natural.height / natural.width
    const created = await inknoteApi.createNote({ notebookId, title: file.name.replace(/\.[^.]+$/, '') })
    const note = created.note
    noteId = note.id
    const pageHeight = Math.round(Math.min(1600, Math.max(400, 816 * ratio)))
    await inknoteApi.updateNote(note.id, { pageWidth: 816, pageHeight, baseRev: note.rev })
    const firstPage = created.pages[0]!
    let reusedFirst = false
    for (const [order, index] of indices.entries()) {
      if (options.isCancelled?.()) {
        await purgeImportedNote(note.id)
        return { noteId: null, imported: order, cancelled: true }
      }
      const pdfPage = index === firstIndex ? first : await pdf.getPage(index)
      const viewport = pdfPage.getViewport({ scale: Math.min(2, 1400 / natural.width) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) { pdfPage.cleanup(); continue }
      await pdfPage.render({ canvas, viewport }).promise
      const blob = await canvasBlob(canvas)
      pdfPage.cleanup()
      if (!blob) continue
      const asset = await inknoteApi.uploadAsset(new File([blob], `page-${index}.jpg`, { type: 'image/jpeg' }), 'background', note.id)
      const content: InknotePageContent = {
        ...emptyPageContent(),
        bg: { kind: 'pdf', assetId: asset.id, url: asset.url, width: canvas.width, height: canvas.height, alpha: 1 },
      }
      if (!reusedFirst) {
        await inknoteApi.savePage(note.id, firstPage.id, serializePageContent(content), firstPage.rev)
        reusedFirst = true
      } else {
        await inknoteApi.createPage(note.id, { content: serializePageContent(content) })
      }
      options.onProgress?.(order + 1, indices.length)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    }
    await useInknoteStore.getState().refreshLibrary()
    await useInknoteStore.getState().openNote(note.id)
    return { noteId: note.id, imported: indices.length, cancelled: false }
  } catch (error) {
    if (noteId) await purgeImportedNote(noteId)
    throw error
  } finally {
    await opened.destroy()
  }
}

/** A cancelled or failed import leaves no half-note behind; its uploaded backgrounds go with it. */
async function purgeImportedNote(noteId: string): Promise<void> {
  await inknoteApi.purgeNote(noteId).catch((error) => { console.warn('[inkstone] Could not purge a failed PDF import:', error) })
}

export async function exportPagePng(note: InknoteNoteMeta, page: InknotePage, settings: { fontFamily: string }): Promise<void> {
  const canvas = renderPageToCanvas(page.content, note.paper, {
    width: note.pageWidth, height: note.pageHeight, contentWidth: note.contentWidth, contentHeight: note.contentHeight,
  }, 1224, fontStackFor(settings.fontFamily as never))
  if (!canvas) return
  const blob = await canvasBlob(canvas, 'image/png')
  if (blob) downloadBlob(`${safeFileName(note.title) || 'inknote'}-p${page.position + 1}.png`, blob)
}

export interface PdfExportOptions {
  /** "1-3,7", empty for every page. */
  range?: string
  cover?: boolean
  header?: boolean
  onProgress?: (done: number, total: number) => void
  isCancelled?: () => boolean
}

const PDF_LONG_SIDE = 792
const PDF_SHORT_SIDE = 612

function pagePointSize(note: InknoteNoteMeta): { width: number, height: number } {
  return note.pageWidth >= note.pageHeight
    ? { width: PDF_LONG_SIDE, height: PDF_SHORT_SIDE }
    : { width: PDF_SHORT_SIDE, height: PDF_LONG_SIDE }
}

function drawHeader(canvas: HTMLCanvasElement, title: string, index: number, total: number, font: string): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const strip = Math.max(24, Math.round(canvas.height * 0.05))
  context.save()
  context.fillStyle = 'rgba(255, 255, 255, 0.92)'
  context.fillRect(0, 0, canvas.width, strip)
  context.fillStyle = '#475569'
  context.font = `${Math.round(strip * 0.42)}px ${font}`
  context.textBaseline = 'middle'
  const label = title.trim().slice(0, 60) || 'Inknote'
  context.fillText(label, Math.round(strip * 0.4), strip / 2, canvas.width * 0.7)
  const pageLabel = `${index} / ${total}`
  const width = context.measureText(pageLabel).width
  context.fillText(pageLabel, canvas.width - width - Math.round(strip * 0.4), strip / 2)
  context.restore()
}

function coverCanvas(note: InknoteNoteMeta, total: number, font: string): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas')
  const width = 1224
  const height = Math.round(width * note.pageHeight / Math.max(1, note.pageWidth))
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#1e293b'
  context.textAlign = 'center'
  context.font = `bold ${Math.round(width * 0.05)}px ${font}`
  context.fillText(note.title.trim().slice(0, 60) || 'Inknote', width / 2, height * 0.42, width * 0.86)
  context.fillStyle = '#64748b'
  context.font = `${Math.round(width * 0.022)}px ${font}`
  context.fillText(new Date().toLocaleString(), width / 2, height * 0.52)
  context.fillText(`${total}`, width / 2, height * 0.57)
  return canvas
}

export async function exportPdf(note: InknoteNoteMeta, pages: InknotePage[], settings: { fontFamily: string }, options: PdfExportOptions = {}): Promise<boolean> {
  if (!pages.length) return false
  const indices = parsePageRange(options.range ?? '', pages.length)
  if (!indices.length) return false
  const font = fontStackFor(settings.fontFamily as never)
  const point = pagePointSize(note)
  const images: PdfPageImage[] = []
  if (options.cover) {
    const cover = coverCanvas(note, indices.length, font)
    const blob = cover ? await canvasBlob(cover, 'image/jpeg', 0.9) : null
    if (cover && blob) images.push({ width: cover.width, height: cover.height, jpeg: new Uint8Array(await blob.arrayBuffer()), pdfWidth: point.width, pdfHeight: point.height })
  }
  for (const [order, index] of indices.entries()) {
    if (options.isCancelled?.()) return false
    const page = pages[index]
    if (!page) continue
    const canvas = renderPageToCanvas(page.content, note.paper, {
      width: note.pageWidth, height: note.pageHeight, contentWidth: note.contentWidth, contentHeight: note.contentHeight,
    }, 1224, font)
    if (!canvas) continue
    if (options.header) drawHeader(canvas, note.title, order + 1, indices.length, font)
    const blob = await canvasBlob(canvas, 'image/jpeg', 0.9)
    if (!blob) continue
    images.push({
      width: canvas.width,
      height: canvas.height,
      jpeg: new Uint8Array(await blob.arrayBuffer()),
      pdfWidth: point.width,
      pdfHeight: point.height,
    })
    options.onProgress?.(order + 1, indices.length)
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
  if (!images.length || options.isCancelled?.()) return false
  downloadBlob(`${safeFileName(note.title) || 'inknote'}.pdf`, buildPdf(images))
  return true
}

export interface LibraryPdfOptions {
  title: string
  onProgress?: (done: number, total: number) => void
  isCancelled?: () => boolean
}

const LIBRARY_PDF_MAX_PAGES = 200

/** One cover page per note, then every page of every note, capped at two hundred pages. */
export async function exportLibraryPdf(notes: InknoteNoteMeta[], settings: { fontFamily: string }, options: LibraryPdfOptions): Promise<boolean> {
  if (notes.length === 0) throw new Error('The library has no notes to export')
  let planned = notes.length
  const details: { note: InknoteNoteMeta; pages: InknotePage[] }[] = []
  for (const note of notes) {
    const detail = await inknoteApi.note(note.id, 'all')
    planned += detail.pages.length
    details.push({ note, pages: detail.pages })
  }
  if (planned > LIBRARY_PDF_MAX_PAGES) throw new Error(`The library PDF would have ${planned} pages; export a notebook at a time (limit ${LIBRARY_PDF_MAX_PAGES})`)
  const font = fontStackFor(settings.fontFamily as never)
  const images: PdfPageImage[] = []
  let done = 0
  for (const { note, pages } of details) {
    if (options.isCancelled?.()) return false
    const point = pagePointSize(note)
    const cover = coverCanvas(note, pages.length, font)
    const coverBlob = cover ? await canvasBlob(cover, 'image/jpeg', 0.9) : null
    if (cover && coverBlob) images.push({ width: cover.width, height: cover.height, jpeg: new Uint8Array(await coverBlob.arrayBuffer()), pdfWidth: point.width, pdfHeight: point.height })
    done += 1
    options.onProgress?.(done, planned)
    for (const page of pages) {
      if (options.isCancelled?.()) return false
      const canvas = renderPageToCanvas(page.content, note.paper, {
        width: note.pageWidth, height: note.pageHeight, contentWidth: note.contentWidth, contentHeight: note.contentHeight,
      }, 1224, font)
      if (canvas) {
        const blob = await canvasBlob(canvas, 'image/jpeg', 0.9)
        if (blob) images.push({ width: canvas.width, height: canvas.height, jpeg: new Uint8Array(await blob.arrayBuffer()), pdfWidth: point.width, pdfHeight: point.height })
      }
      done += 1
      options.onProgress?.(done, planned)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    }
  }
  if (!images.length || options.isCancelled?.()) return false
  downloadBlob(`${safeFileName(options.title) || 'inknote-library'}.pdf`, buildPdf(images))
  return true
}

export interface LongImageOptions {
  title: string
  onProgress?: (done: number, total: number) => void
  isCancelled?: () => boolean
}

const LONG_IMAGE_MAX_PAGES = 12
const LONG_IMAGE_WIDTH = 1000
const LONG_IMAGE_GAP = 26

export async function exportLongImage(note: InknoteNoteMeta, pages: InknotePage[], settings: { fontFamily: string }, options: LongImageOptions): Promise<boolean> {
  if (pages.length === 0) return false
  if (pages.length > LONG_IMAGE_MAX_PAGES) throw new Error(`A long image holds at most ${LONG_IMAGE_MAX_PAGES} pages; export a PDF instead`)
  const font = fontStackFor(settings.fontFamily as never)
  const rendered: HTMLCanvasElement[] = []
  for (const page of pages) {
    if (options.isCancelled?.()) return false
    const canvas = renderPageToCanvas(page.content, note.paper, {
      width: note.pageWidth, height: note.pageHeight, contentWidth: note.contentWidth, contentHeight: note.contentHeight,
    }, LONG_IMAGE_WIDTH, font)
    if (canvas) rendered.push(canvas)
    options.onProgress?.(rendered.length, pages.length)
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
  if (!rendered.length || options.isCancelled?.()) return false
  const height = rendered.reduce((sum, canvas) => sum + canvas.height, 0) + LONG_IMAGE_GAP * (rendered.length - 1)
  const out = document.createElement('canvas')
  out.width = LONG_IMAGE_WIDTH
  out.height = height
  const context = out.getContext('2d')
  if (!context) return false
  context.fillStyle = '#cbd5e1'
  context.fillRect(0, 0, out.width, out.height)
  let top = 0
  for (const canvas of rendered) {
    context.drawImage(canvas, 0, top)
    top += canvas.height + LONG_IMAGE_GAP
  }
  const blob = await canvasBlob(out, 'image/png')
  if (!blob) return false
  downloadBlob(`${safeFileName(options.title) || 'inknote'}-long.png`, blob)
  return true
}

export async function exportNoteFile(note: InknoteNoteMeta, pages: InknotePage[]): Promise<void> {
  const exportedPages = []
  for (const page of pages) {
    const content = JSON.parse(serializePageContent(page.content)) as InknotePageContent
    for (const image of content.images) image.url = await assetDataUrl(image.url)
    if (content.bg) content.bg.url = await assetDataUrl(content.bg.url)
    exportedPages.push({ ...content, id: page.id, strokes: content.strokes, texts: content.texts, images: content.images, bg: content.bg })
  }
  const payload = {
    format: 'note2',
    version: 1,
    type: 'note',
    exportedAt: new Date().toISOString(),
    note: {
      id: note.id,
      title: note.title,
      paper: note.paper,
      pageW: note.pageWidth,
      pageH: note.pageHeight,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      pages: exportedPages,
    },
  }
  downloadBlob(`${safeFileName(note.title) || 'inknote'}.note`, new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
}

function rtfEscape(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\' || char === '{' || char === '}') out += `\\${char}`
    else if (char === '\n') out += '\\par '
    else if (code < 128) out += char
    else if (code <= 0xffff) out += `\\u${code}?`
    else {
      const high = Math.floor((code - 0x10000) / 0x400) + 0xd800
      const low = ((code - 0x10000) % 0x400) + 0xdc00
      out += `\\u${high}?\\u${low}?`
    }
  }
  return out
}

export function exportTextFile(note: InknoteNoteMeta, pages: InknotePage[], format: 'txt' | 'md' | 'rtf'): void {
  const title = note.title || 'Inknote'
  const sections = pages.map((page, index) => {
    const texts = page.content.texts.map((item) => item.text).filter(Boolean)
    if (!texts.length) return ''
    return format === 'md' ? `## Page ${index + 1}\n\n${texts.map((text) => `- ${text.replace(/\n/g, '\n  ')}`).join('\n')}` : `-- Page ${index + 1} --\n${texts.join('\n')}`
  }).filter(Boolean)
  if (format === 'rtf') {
    const body = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 sans-serif;}}\\f0\\fs32 ${rtfEscape(title)}\\par\\par ${rtfEscape(sections.join('\n\n') || title)}}`
    downloadBlob(`${safeFileName(title)}.rtf`, new Blob([body], { type: 'application/rtf;charset=utf-8' }))
    return
  }
  const body = format === 'md' ? `# ${title}\n\n${sections.join('\n\n')}` : `${title}\n\n${sections.join('\n\n')}`
  downloadBlob(`${safeFileName(title)}.${format}`, new Blob([body || title], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' }))
}

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return new File([blob], name, { type: blob.type || 'image/png' })
}

export interface ImportNoteOptions {
  onProgress?: (done: number, total: number) => void
  isCancelled?: () => boolean
}

/** A .note/.notebook import: snapshot first, then create; any failure rolls every created row back. */
export async function importNoteFile(file: File, notebookId: string, options: ImportNoteOptions = {}): Promise<{ notes: number }> {
  if (file.size > 64 * 1024 * 1024) throw new Error('The import file exceeds the 64 MB limit')
  const { parseNote2Envelope, normalizeLegacyPage } = await import('@shared/inknote/parse')
  const envelope = parseNote2Envelope(await file.text())
  if (!envelope) throw new Error('Unrecognised note file')
  const notes = envelope.notes.slice(0, 500)
  // The account can come back from this if the import goes wrong; a snapshot that cannot be taken stops it.
  await inknoteApi.createSnapshot('before-import')
  const existingTitles = new Set((useInknoteStore.getState().library?.notes ?? []).map((note) => note.title))
  const createdNotes: string[] = []
  const uploadedAssets: string[] = []
  let imported = 0
  try {
    for (const [noteIndex, raw] of notes.entries()) {
      if (options.isCancelled?.()) throw new Error('Import cancelled')
      const row = raw as Record<string, unknown>
      const base = typeof row.title === 'string' ? row.title.slice(0, 500) : file.name.replace(/\.[^.]+$/, '')
      let title = base
      for (let suffix = 2; existingTitles.has(title); suffix += 1) title = `${base} ${suffix}`
      existingTitles.add(title)
      const paper = row.paper && typeof row.paper === 'object' ? row.paper : undefined
      const created = await inknoteApi.createNote({ notebookId, title, paper })
      createdNotes.push(created.note.id)
      const note = created.note
      const pageW = typeof row.pageW === 'number' ? row.pageW : note.pageWidth
      const pageH = typeof row.pageH === 'number' ? row.pageH : note.pageHeight
      if (pageW !== note.pageWidth || pageH !== note.pageHeight) {
        await inknoteApi.updateNote(note.id, { pageWidth: pageW, pageHeight: pageH, baseRev: note.rev })
      }
      const rawPages = Array.isArray(row.pages) ? row.pages : []
      const pages = rawPages.length ? rawPages : [{}]
      for (const [pageIndex, rawPage] of pages.entries()) {
        const legacy = normalizeLegacyPage(rawPage)
        if (!legacy) continue
        for (const pending of legacy.pendingAssets) {
          const asset = await inknoteApi.uploadAsset(await dataUrlToFile(pending.dataUrl, `import-${noteIndex}-${pageIndex}.png`), 'image', note.id)
          uploadedAssets.push(asset.id)
          if (pending.path === 'bg.src' && legacy.content.bg) {
            legacy.content.bg.assetId = asset.id
            legacy.content.bg.url = asset.url
          } else {
            const match = /^images\.(\d+)\.src$/.exec(pending.path)
            if (match) {
              const image = legacy.content.images[Number(match[1])]
              if (image) { image.assetId = asset.id; image.url = asset.url }
            }
          }
        }
        const serialized = serializePageContent(legacy.content)
        if (pageIndex === 0) {
          await inknoteApi.savePage(note.id, created.pages[0]!.id, serialized, created.pages[0]!.rev)
        } else {
          await inknoteApi.createPage(note.id, { content: serialized })
        }
      }
      imported++
      options.onProgress?.(noteIndex + 1, notes.length)
    }
    await useInknoteStore.getState().refreshLibrary()
    if (createdNotes[0]) await useInknoteStore.getState().openNote(createdNotes[0])
    return { notes: imported }
  } catch (error) {
    for (const id of createdNotes) await inknoteApi.purgeNote(id).catch((reason) => { console.warn('[inkstone] Could not remove a half-imported note:', reason) })
    for (const id of uploadedAssets) await inknoteApi.deleteAsset(id).catch((reason) => { console.warn('[inkstone] Could not remove a half-imported asset:', reason) })
    await useInknoteStore.getState().refreshLibrary()
    throw new Error(`The import failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export async function exportNotebookFile(): Promise<void> {
  const library = await inknoteApi.library()
  const notes: Record<string, unknown> = {}
  for (const meta of library.notes) {
    const detail = await inknoteApi.note(meta.id, 'all')
    const pages = []
    for (const page of detail.pages) {
      const content = JSON.parse(serializePageContent(page.content)) as InknotePageContent
      for (const image of content.images) image.url = await assetDataUrl(image.url)
      if (content.bg) content.bg.url = await assetDataUrl(content.bg.url)
      pages.push(content)
    }
    notes[meta.id] = { id: meta.id, title: meta.title, paper: meta.paper, pageW: meta.pageWidth, pageH: meta.pageHeight, pages, createdAt: meta.createdAt, updatedAt: meta.updatedAt }
  }
  const payload = {
    format: 'note2',
    version: 1,
    type: 'library',
    exportedAt: new Date().toISOString(),
    library: {
      version: 4,
      settings: { noteSort: 'updated', defaultPaper: { style: 'line', color: 'white' }, tabs: [], favorites: [], favoritesBar: true },
      subjects: library.subjects.map((subject) => ({
        id: subject.id,
        name: subject.name,
        notebooks: library.notebooks.filter((notebook) => notebook.subjectId === subject.id).map((notebook) => ({
          id: notebook.id,
          name: notebook.name,
          color: notebook.coverColor || undefined,
          emoji: notebook.emoji || undefined,
          noteIds: library.notes.filter((note) => note.notebookId === notebook.id).map((note) => note.id),
        })),
      })),
      notes,
    },
  }
  downloadBlob(`inknote-library-${new Date().toISOString().slice(0, 10)}.notebook`, new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
}
