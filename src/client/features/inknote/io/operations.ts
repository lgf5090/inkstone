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

export async function insertPdf(file: File, notebookId: string): Promise<string | null> {
  const { openPdfDocument } = await import('../../reading/engine/pdf')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const opened = await openPdfDocument(bytes)
  try {
    const pdf = opened.document
    const count = Math.min(pdf.numPages, 60)
    const first = await pdf.getPage(1)
    const natural = first.getViewport({ scale: 1 })
    const ratio = natural.height / natural.width
    const created = await inknoteApi.createNote({ notebookId, title: file.name.replace(/\.[^.]+$/, '') })
    const note = created.note
    const pageHeight = Math.round(Math.min(1600, Math.max(400, 816 * ratio)))
    await inknoteApi.updateNote(note.id, { pageWidth: 816, pageHeight, baseRev: note.rev })
    const firstPage = created.pages[0]!
    const pages: InknotePage[] = []
    for (let index = 1; index <= count; index++) {
      const pdfPage = index === 1 ? first : await pdf.getPage(index)
      const viewport = pdfPage.getViewport({ scale: Math.min(2, 1400 / natural.width) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) continue
      await pdfPage.render({ canvas, viewport }).promise
      const blob = await canvasBlob(canvas)
      if (!blob) continue
      const asset = await inknoteApi.uploadAsset(new File([blob], `page-${index}.jpg`, { type: 'image/jpeg' }), 'background', note.id)
      const content: InknotePageContent = {
        ...emptyPageContent(),
        bg: { kind: 'pdf', assetId: asset.id, url: asset.url, width: canvas.width, height: canvas.height, alpha: 1 },
      }
      if (index === 1) {
        await inknoteApi.savePage(note.id, firstPage.id, serializePageContent(content), firstPage.rev)
        pages.push({ ...firstPage, content })
      } else {
        const page = await inknoteApi.createPage(note.id, { content: serializePageContent(content) })
        pages.push(page)
      }
      pdfPage.cleanup()
    }
    await useInknoteStore.getState().refreshLibrary()
    await useInknoteStore.getState().openNote(note.id)
    return note.id
  } finally {
    await opened.destroy()
  }
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

export async function importNoteFile(file: File, notebookId: string): Promise<number> {
  const { parseNote2Envelope, normalizeLegacyPage } = await import('@shared/inknote/parse')
  const envelope = parseNote2Envelope(await file.text())
  if (!envelope) throw new Error('Unrecognised note file')
  const notes = envelope.notes.slice(0, 500)
  let imported = 0
  for (const [noteIndex, raw] of notes.entries()) {
    const row = raw as Record<string, unknown>
    const title = typeof row.title === 'string' ? row.title.slice(0, 512) : file.name.replace(/\.[^.]+$/, '')
    const paper = row.paper && typeof row.paper === 'object' ? row.paper : undefined
    const created = await inknoteApi.createNote({ notebookId, title, paper })
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
    if (noteIndex === 0) await useInknoteStore.getState().openNote(note.id)
  }
  await useInknoteStore.getState().refreshLibrary()
  return imported
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
