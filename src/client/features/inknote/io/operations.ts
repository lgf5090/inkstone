/** Browser-side file operations: insert media, import PDF pages and export the current note. */
import type { InknoteNoteMeta, InknotePage, InknotePageContent } from '@shared/inknote/types'
import { emptyPageContent, serializePageContent } from '@shared/inknote/parse'
import { fontStackFor } from '../../../lib/inknote/text-layout'
import { downloadBlob, safeFileName } from '../../../lib/export-note'
import { buildPdf, type PdfPageImage } from '../../../lib/inknote/pdf-writer'
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

export async function exportPdf(note: InknoteNoteMeta, pages: InknotePage[], settings: { fontFamily: string }): Promise<void> {
  if (!pages.length) return
  const images: PdfPageImage[] = []
  for (const page of pages) {
    const canvas = renderPageToCanvas(page.content, note.paper, {
      width: note.pageWidth, height: note.pageHeight, contentWidth: note.contentWidth, contentHeight: note.contentHeight,
    }, 1224, fontStackFor(settings.fontFamily as never))
    if (!canvas) continue
    const blob = await canvasBlob(canvas, 'image/jpeg', 0.9)
    if (!blob) continue
    images.push({
      width: canvas.width,
      height: canvas.height,
      jpeg: new Uint8Array(await blob.arrayBuffer()),
      pdfWidth: note.pageWidth >= note.pageHeight ? 792 : 612,
      pdfHeight: note.pageWidth >= note.pageHeight ? 612 : 792,
    })
  }
  if (!images.length) return
  downloadBlob(`${safeFileName(note.title) || 'inknote'}.pdf`, buildPdf(images))
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

export function exportTextFile(note: InknoteNoteMeta, pages: InknotePage[], format: 'txt' | 'md'): void {
  const title = note.title || 'Inknote'
  const sections = pages.map((page, index) => {
    const texts = page.content.texts.map((item) => item.text).filter(Boolean)
    if (!texts.length) return ''
    return format === 'md' ? `## Page ${index + 1}\n\n${texts.map((text) => `- ${text.replace(/\n/g, '\n  ')}`).join('\n')}` : `-- Page ${index + 1} --\n${texts.join('\n')}`
  }).filter(Boolean)
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
