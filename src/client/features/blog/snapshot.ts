import { parseWikiTarget, renderMarkdown } from '../../lib/markdown/renderer'
import { enhancePreview, renderPendingCharts, renderPendingMermaid } from '../../lib/markdown/enhance'
import { resolveNoteEmbeds } from '../../lib/markdown/embeds'
import { registerFenceBodies } from '../../lib/markdown/fence-bodies'
import { getLocale } from '../../lib/i18n'
import { api } from '../../lib/api'
import { findNoteByTitle, useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { readBlogFrontMatter } from '@shared/blog/frontmatter'
import { BLOG_RENDERER_VERSION } from '@shared/blog/renderer'
import { normalizeLinkKey, parseFrontMatter } from '@shared/markdown-utils'
import type { BlogEmbeddedNote, BlogRenderSnapshot } from '@shared/blog/model'

const RENDERER_VERSION = BLOG_RENDERER_VERSION
const IMAGE_MAX_WIDTH = 1600
const MAX_EMBED_DEPTH = 4
const EMBED_SYNTAX = /!\[\[([^\]\n]+)\]\]/g
const WIKI_SYNTAX = /(?<!!)\[\[([^\]\n]+)\]\]/g
const MAX_WIKI_LOOKUPS = 50

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
    assets: [],
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
