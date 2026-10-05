import type { Attachment } from '@shared/types'

import { parseEmbedSizeSpec } from '@shared/markdown-utils'

const ASSET_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf|txt|md|json|zip|mp3|wav|m4a|ogg|flac|mp4|webm|mov|m4v)$/i


export interface EmbedSize {
  width: number | null
  height: number | null
}

export function isAttachmentTarget(target: string): boolean {
  const name = attachmentFileName(target)
  return Boolean(name) && ASSET_EXT.test(name)
}

export function attachmentFileName(target: string): string {
  return target.split(/[\\/]/).pop()?.trim() ?? ''
}

export function parseEmbedSize(value: string | null): EmbedSize | null {
  return parseEmbedSizeSpec(value)
}

export function splitAltSize(alt: string): { alt: string; size: EmbedSize | null } {
  const pipe = alt.lastIndexOf('|')
  if (pipe < 0)
    return { alt, size: null }
  const size = parseEmbedSize(alt.slice(pipe + 1))
  return size ? { alt: alt.slice(0, pipe).trim(), size } : { alt, size: null }
}

export function applyEmbedSize(img: HTMLElement, size: EmbedSize | null): void {
  if (!size)
    return
  if (size.width)
    img.setAttribute('width', String(size.width))
  if (size.height)
    img.setAttribute('height', String(size.height))
}

export function renderAttachmentEmbed(box: HTMLElement, file: Attachment, size: EmbedSize | null): void {
  box.className = 'note-embed attachment ready'
  box.removeAttribute('aria-busy')
  const head = box.querySelector<HTMLElement>('.note-embed-head')
  if (head) {
    head.textContent = file.filename
    head.removeAttribute('data-wikilink')
    head.removeAttribute('role')
    head.removeAttribute('tabindex')
  }
  const body = box.querySelector<HTMLElement>('.note-embed-body')
  if (!body)
    return
  if (file.mime.startsWith('image/')) {
    const img = document.createElement('img')
    img.src = file.url
    img.alt = file.filename
    img.loading = 'lazy'
    img.decoding = 'async'
    img.referrerPolicy = 'no-referrer'
    applyEmbedSize(img, size)
    body.replaceChildren(img)
    return
  }
  const link = document.createElement('a')
  link.className = 'attachment-open'
  link.href = file.url
  link.download = file.filename
  link.rel = 'noreferrer'
  link.textContent = file.url
  body.replaceChildren(link)
}
