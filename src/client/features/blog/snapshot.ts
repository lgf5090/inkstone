import { parseWikiTarget, renderMarkdown } from '../../lib/markdown/renderer'
import { enhancePreview, renderPendingCharts, renderPendingMermaid } from '../../lib/markdown/enhance'
import { resolveNoteEmbeds } from '../../lib/markdown/embeds'
import { isAttachmentTarget } from '../../lib/markdown/attachments'
import { registerFenceBodies } from '../../lib/markdown/fence-bodies'
import { getLocale } from '../../lib/i18n'
import { api } from '../../lib/api'
import { findNoteByTitle, useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { readBlogFrontMatter } from '@shared/blog/frontmatter'
import { BLOG_RENDERER_VERSION } from '@shared/blog/renderer'
import { normalizeLinkKey, parseFrontMatter } from '@shared/markdown-utils'
import type { BlogAssetRef, BlogEmbeddedNote, BlogRenderSnapshot } from '@shared/blog/model'

const RENDERER_VERSION = BLOG_RENDERER_VERSION
const IMAGE_MAX_WIDTH = 1600
const MAX_EMBED_DEPTH = 4
const EMBED_SYNTAX = /!\[\[([^\]\n]+)\]\]/g
const WIKI_SYNTAX = /(?<!!)\[\[([^\]\n]+)\]\]/g
const MAX_WIKI_LOOKUPS = 50
const MAX_SNAPSHOT_ASSETS = 50
const FILE_ATTACHMENT = /\/api\/files\/([A-Za-z0-9_-]{1,64})(?:[?#]|$)/
const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'application/zip': 'zip',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'video/mp4': 'mp4', 'video/webm': 'webm',
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashBlogContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

function darkTheme(): boolean {
  return document.documentElement.dataset.theme === 'dark'
}

function svgSize(svg: SVGSVGElement): { width: number; height: number } {
  const box = svg.viewBox?.baseVal
  const width = Math.max(1, Math.round(box?.width || Number(svg.getAttribute('width')) || 800))
  const height = Math.max(1, Math.round(box?.height || Number(svg.getAttribute('height')) || 600))
  const scale = Math.min(1, IMAGE_MAX_WIDTH / width)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function svgToPng(svg: SVGSVGElement): Promise<{ src: string; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const { width, height } = svgSize(svg)
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(width))
    clone.setAttribute('height', String(height))
    const source = new XMLSerializer().serializeToString(clone)
    const image = new Image()
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }))
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) {
          resolve(null)
          return
        }
        context.drawImage(image, 0, 0, width, height)
        resolve({ src: canvas.toDataURL('image/png'), width, height })
      } catch {
        resolve(null)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    image.src = url
  })
}

async function rasterizeSvgs(root: HTMLElement): Promise<number> {
  let converted = 0
  for (const svg of [...root.querySelectorAll('svg')]) {
    const image = await svgToPng(svg as SVGSVGElement)
    if (!image) continue
    const replacement = document.createElement('img')
    replacement.src = image.src
    replacement.width = image.width
    replacement.height = image.height
    replacement.loading = 'lazy'
    replacement.decoding = 'async'
    replacement.className = svg.getAttribute('class') ?? ''
    replacement.alt = svg.getAttribute('aria-label') ?? ''
    svg.replaceWith(replacement)
    converted += 1
  }
  return converted
}

function rasterizeCanvases(root: HTMLElement): number {
  let converted = 0
  for (const canvas of [...root.querySelectorAll('canvas')]) {
    if (canvas.width === 0 || canvas.height === 0) continue
    const replacement = document.createElement('img')
    replacement.src = canvas.toDataURL('image/png')
    replacement.width = canvas.width
    replacement.height = canvas.height
    replacement.loading = 'lazy'
    replacement.decoding = 'async'
    replacement.className = canvas.className
    replacement.alt = canvas.getAttribute('aria-label') ?? ''
    canvas.replaceWith(replacement)
    converted += 1
  }
  return converted
}

interface CapturedEmbeds {
  notes: BlogEmbeddedNote[]
  allowed: Set<string>
}

interface CapturedWikiLinks {
  links: Array<{ target: string; slug: string }>
  warnings: string[]
}

/**
 * Whether a note's body may leave the owner's workspace as part of a public article: published, not
 * password-protected, and not scheduled for later. A protected post is public only through its own
 * unlock page, so embedding it elsewhere would hand its body to anyone reading the host article.
 */
export function isPublicBlogNote(content: string): boolean {
  const meta = readBlogFrontMatter(content)
  if (!meta.isPublished || meta.protected) return false
  if (meta.publishedAt && Date.parse(meta.publishedAt) > Date.now()) return false
  return true
}

/** The body a public page may show for an embedded note, or null when it is not published. */
async function publishedEmbed(noteTitle: string): Promise<{ id: string; title: string; content: string } | null> {
  const summary = findNoteByTitle(noteTitle)
  if (!summary || summary.deletedAt) return null
  let content = useNotes.getState().contents[summary.id]
  if (content === undefined) {
    try {
      content = (await api.notes.get(summary.id)).content
    } catch {
      return null
    }
  }
  if (!isPublicBlogNote(content)) return null
  return { id: summary.id, title: summary.title, content: parseFrontMatter(content).body }
}

/**
 * The published notes an article may expand, starting from the embed syntax in its source.
 *
 * The note app resolves embeds against the whole vault; a public page must not, because the target of
 * an embed can be a private note. This walks only what the article actually embeds, keeps the ones
 * whose `isPublished` property is set, and hands the runtime the same bodies so its re-render and the
 * stored still agree. A private target is left out entirely, so the renderer paints the ordinary
 * missing-note notice instead of leaking its body into a snapshot.
 */
async function capturePublishedEmbeds(
  noteTitle: string,
  content: string,
): Promise<CapturedEmbeds> {
  const allowed = new Set<string>([normalizeLinkKey(noteTitle)])
  const notes = new Map<string, BlogEmbeddedNote>()
  const seen = new Set<string>()
  let frontier: Array<{ content: string; depth: number }> = [{ content, depth: 0 }]
  while (frontier.length > 0) {
    const next: Array<{ content: string; depth: number }> = []
    for (const source of frontier) {
      if (source.depth >= MAX_EMBED_DEPTH) continue
      for (const match of source.content.matchAll(EMBED_SYNTAX)) {
        const target = parseWikiTarget(match[1]!)
        if (!target.noteTitle) continue
        const key = normalizeLinkKey(target.noteTitle)
        if (allowed.has(key) || seen.has(key)) continue
        seen.add(key)
        const embed = await publishedEmbed(target.noteTitle)
        if (!embed) continue
        allowed.add(key)
        notes.set(embed.id, embed)
        next.push({ content: embed.content, depth: source.depth + 1 })
      }
    }
    frontier = next
  }
  return { notes: [...notes.values()], allowed }
}

/**
 * Wiki links that point at another published article.
 *
 * The note app follows a wiki link through its vault. A public page has no vault, so the only target
 * it may offer is a *published* note, and the address it can offer is that note's article slug. The
 * lookup is per unique target and capped: a page with two hundred links should not turn a publish
 * into two hundred admin calls.
 */
function attachmentName(element: Element): string {
  const head = element.closest('.note-embed')?.querySelector('.note-embed-head')?.textContent?.trim()
  if (head) return head
  if (element instanceof HTMLAnchorElement && element.download) return element.download
  if (element instanceof HTMLImageElement) return element.alt
  const text = element.textContent?.trim() ?? ''
  return text.startsWith('/') ? '' : text
}

function uploadFileName(name: string, mime: string, id: string): string {
  const clean = name.replace(/[\\/\u0000-\u001f]/g, '').slice(0, 160)
  if (/\.([A-Za-z0-9]{1,8})$/.test(clean)) return clean
  return `${clean || `attachment-${id}`}.${MIME_EXTENSION[mime] ?? 'bin'}`
}

function markAttachmentUnpublished(element: Element, attribute: string, name: string): void {
  if (element instanceof HTMLImageElement) {
    element.removeAttribute('src')
    element.alt = name || 'Attachment'
    element.classList.add('attachment-unpublished')
    return
  }
  if (element instanceof HTMLAnchorElement) {
    element.removeAttribute('href')
    element.setAttribute('aria-disabled', 'true')
    element.classList.add('attachment-unpublished')
    if (!element.textContent?.trim()) element.textContent = name || 'Attachment'
    return
  }
  element.removeAttribute(attribute)
}

/**
 * Publish the vault files an article embeds into the blog's own media library and rewrite their URLs.
 *
 * A note's `/api/files/<id>` address is private: it answers only the owner's session, so a public
 * article that kept it would show broken media (and hand out an address that must not be public).
 * Each referenced attachment is copied once through the admin media API — which hash-dedupes — and the
 * body is pointed at the same-origin blog media route. A file the media library refuses (an unsupported
 * type, too large, or a failed upload) becomes a named placeholder and a warning, never a private URL.
 */
async function publishSnapshotAssets(root: HTMLElement, warnings: string[]): Promise<BlogAssetRef[]> {
  const uploaded = new Map<string, BlogAssetRef | null>()
  const assets: BlogAssetRef[] = []
  // An attachment's display can differ from its file name: an `![[name]]` embed names the real file
  // in its head, while a plain image's alt is the author's caption. The head wins, because the runtime
  // resolves `![[name]]` by that name and a caption would not find the file.
  const preferredName = new Map<string, string>()
  const elements: Array<{ element: HTMLElement; matches: Array<{ attribute: string; attachmentId: string }> }> = []
  for (const element of [...root.querySelectorAll<HTMLElement>('[src], [href]')]) {
    const matches: Array<{ attribute: string; attachmentId: string }> = []
    for (const attribute of ['src', 'href']) {
      const value = element.getAttribute(attribute)
      if (!value) continue
      const match = FILE_ATTACHMENT.exec(value)
      if (!match) continue
      const attachmentId = match[1]!
      matches.push({ attribute, attachmentId })
      const head = element.closest('.note-embed')?.querySelector('.note-embed-head')?.textContent?.trim()
      if (head) preferredName.set(attachmentId, head)
      else if (!preferredName.has(attachmentId)) preferredName.set(attachmentId, attachmentName(element))
    }
    if (matches.length) elements.push({ element, matches })
  }
  for (const { element, matches } of elements) {
    for (const { attribute, attachmentId } of matches) {
      if (!uploaded.has(attachmentId)) {
        if (uploaded.size >= MAX_SNAPSHOT_ASSETS) {
          warnings.push(`asset: ${preferredName.get(attachmentId) || attachmentId} was not published (too many attachments)`)
          uploaded.set(attachmentId, null)
          markAttachmentUnpublished(element, attribute, attachmentName(element))
          continue
        }
        try {
          const response = await fetch(`/api/files/${attachmentId}`, {
            headers: { 'x-inkstone-client': '1' },
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error(`file request ${response.status}`)
          const blob = await response.blob()
          const mime = blob.type || response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream'
          const name = preferredName.get(attachmentId) ?? attachmentName(element)
          const uploadName = uploadFileName(name, mime, attachmentId)
          const file = new File([blob], uploadName, { type: mime })
          const item = await api.blog.media.upload(file)
          const asset: BlogAssetRef = {
            attachmentId,
            blogAssetId: item.id,
            url: `/_blog/media/${item.id}`,
            // The media library dedupes by content and may keep an older filename for the same bytes;
            // the article's resolver needs the name this article wrote in `![[…]]`.
            filename: uploadName,
            mime: item.mime,
            size: item.size,
          }
          uploaded.set(attachmentId, asset)
          assets.push(asset)
        } catch (error) {
          uploaded.set(attachmentId, null)
          warnings.push(`asset: ${preferredName.get(attachmentId) || attachmentId} was not published (${error instanceof Error ? error.message : String(error)})`)
        }
      }
      const asset = uploaded.get(attachmentId)
      if (asset) element.setAttribute(attribute, asset.url)
      else markAttachmentUnpublished(element, attribute, attachmentName(element))
    }
  }
  return assets
}

async function capturePublishedWikiLinks(content: string, noteTitle: string): Promise<CapturedWikiLinks> {
  const seen = new Set<string>([normalizeLinkKey(noteTitle)])
  const links: Array<{ target: string; slug: string }> = []
  const warnings: string[] = []
  let lookups = 0
  let skipped = 0
  for (const match of content.matchAll(WIKI_SYNTAX)) {
    const target = parseWikiTarget(match[1]!)
    if (!target.noteTitle) continue
    const key = normalizeLinkKey(target.noteTitle)
    if (seen.has(key)) continue
    seen.add(key)
    const summary = findNoteByTitle(target.noteTitle)
    if (!summary || summary.deletedAt) continue
    let noteContent = useNotes.getState().contents[summary.id]
    if (noteContent === undefined) {
      try {
        noteContent = (await api.notes.get(summary.id)).content
      } catch {
        continue
      }
    }
    if (!isPublicBlogNote(noteContent)) continue
    if (++lookups > MAX_WIKI_LOOKUPS) {
      skipped += 1
      continue
    }
    try {
      const post = await api.blog.postByNote(summary.id)
      if (post.slug) links.push({ target: target.noteTitle, slug: post.slug })
    } catch {
      continue
    }
  }
  if (skipped > 0) warnings.push(`wiki: ${skipped} link(s) were not resolved (too many targets)`)
  return { links, warnings }
}

export async function captureBlogSnapshot(noteId: string, content: string): Promise<BlogRenderSnapshot> {
  const settings = useSession.getState().settings
  const preview = settings.preview
  const emojiShortcodes = preview.emojiShortcodes
  const noteTitle = useNotes.getState().notes[noteId]?.title ?? ''
  const rendered = renderMarkdown(content, { hideFrontMatter: true, emojiShortcodes })
  const captured = await capturePublishedEmbeds(noteTitle, content)
  const wiki = await capturePublishedWikiLinks(content, noteTitle)
  const features: string[] = []
  if (rendered.hasMermaid) features.push('mermaid')
  if (rendered.hasMath) features.push('math')
  if (rendered.fences.kanban.length > 0) features.push('kanban')
  if (rendered.fences.excalidraw.length > 0) features.push('excalidraw')
  for (const [needle, feature] of [
    ['data-chart', 'chart'],
    ['data-mindmap', 'mindmap'],
    ['data-json', 'json'],
    ['data-dataview', 'dataview'],
  ] as const) {
    if (rendered.html.includes(needle)) features.push(feature)
  }

  const staging = document.createElement('div')
  staging.innerHTML = rendered.html
  registerFenceBodies(staging, rendered.fences)
  const warnings: string[] = [...wiki.warnings]
  try {
    if (rendered.hasEmbeds) {
      await resolveNoteEmbeds(staging, {
        currentContent: content,
        currentTitle: noteTitle,
        allowTarget: (target) => {
          if (!target.noteTitle) return true
          if (isAttachmentTarget(target.noteTitle)) return true
          return captured.allowed.has(normalizeLinkKey(target.noteTitle))
        },
      })
    }
    await enhancePreview(staging, {
      math: preview.math,
      mermaid: preview.mermaid,
      chart: preview.chart,
      kanban: 'snapshot',
      mindmap: 'snapshot',
      excalidraw: 'source',
      dataview: 'source',
      dark: darkTheme(),
      codeBlockCollapseLines: preview.codeBlockCollapse ? preview.codeBlockCollapseLines : 0,
    })
    if (preview.mermaid) await renderPendingMermaid(staging)
    if (preview.chart) await renderPendingCharts(staging, darkTheme(), { instant: true })
  } catch (error) {
    warnings.push(`enhance: ${error instanceof Error ? error.message : String(error)}`)
  }

  const pendingMermaid = staging.querySelectorAll('[data-mermaid]').length
  const convertedSvgs = await rasterizeSvgs(staging)
  const convertedCharts = rasterizeCanvases(staging)
  const assets = await publishSnapshotAssets(staging, warnings)
  if (rendered.hasMermaid && preview.mermaid && pendingMermaid > convertedSvgs) warnings.push('mermaid: some diagrams kept their source')
  if (features.includes('chart') && preview.chart && convertedCharts === 0) warnings.push('chart: no chart was drawn')

  return {
    version: 1,
    rendererVersion: RENDERER_VERSION,
    noteId,
    contentHash: await hashBlogContent(content),
    html: staging.innerHTML,
    headings: rendered.headings.map((heading) => ({
      depth: heading.level,
      slug: heading.slug,
      text: heading.text,
    })),
    fences: {
      kanban: [...rendered.fences.kanban],
      excalidraw: [...rendered.fences.excalidraw],
    },
    features,
    assets,
    wikiLinks: wiki.links,
    settings: {
      locale: getLocale(),
      emojiShortcodes,
      math: preview.math,
      mermaid: preview.mermaid,
      chart: preview.chart,
      codeBlockCollapse: preview.codeBlockCollapse,
      codeBlockCollapseLines: preview.codeBlockCollapseLines,
      jsonView: preview.jsonView,
      jsonFold: preview.jsonFold,
      jsonTolerant: preview.jsonTolerant,
    },
    embeds: captured.notes,
    generatedAt: Date.now(),
    warnings,
  }
}
