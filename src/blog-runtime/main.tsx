/**
 * The blog's reading runtime.
 *
 * This is not a second renderer. It mounts the note app's own `Preview` — the same markdown parser,
 * the same enhancement pass, the same live block mounts, the same reading interactions — so a format
 * added to the note app reaches published articles without blog-side changes. The blog keeps the
 * stored snapshot as its no-JS and first-paint surface and replaces it with this runtime when it is
 * available; a failed load leaves the still standing.
 */
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { NoteSummary } from '@shared/types'
import type { BlogAssetRef, BlogEmbeddedNote, BlogReadingSettings } from '@shared/blog/model'
import { BLOG_RENDERER_VERSION } from '@shared/blog/renderer'
import { initI18nForReading, t } from '../client/lib/i18n'
import { setAssetBase } from '../client/lib/asset-base'
import { useNotes } from '../client/store/notes'
import { useSession } from '../client/store/session'
import { Preview } from '../client/features/preview/Preview'
import { Lightbox } from '../client/features/preview/Lightbox'
import { Toaster } from '../client/components/feedback'
import type { Heading } from '../client/lib/markdown/renderer'
import { slugifyHeading } from '@shared/markdown-utils'

export interface BlogWikiHref {
  target: string
  href: string
}

export interface BlogReadingMountOptions {
  container: HTMLElement
  content: string
  noteTitle?: string
  embeds?: BlogEmbeddedNote[]
  /** Vault attachments published alongside the article, keyed by their original names and ids. */
  assets?: BlogAssetRef[]
  settings?: Partial<BlogReadingSettings>
  /** Blog locale; the note app ships zh-CN and en-US reading labels. */
  locale?: string
  /** Prefix for `/vendor/…` files, because this runtime is served through the blog's proxy. */
  assetBase?: string
  wikiLinks?: BlogWikiHref[]
  /** Where a tag press goes. Without a resolver the tag stays inert. */
  tagHref?: (name: string) => string | null
  onHeadings?: (headings: Heading[]) => void
  onRendered?: () => void
}

export interface BlogReadingHandle {
  unmount: () => void
}

function normalizeTarget(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function stubNote(id: string, title: string): NoteSummary {
  const now = Date.now()
  return {
    id,
    title,
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 0,
    position: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }
}

function readingLocale(locale: string | undefined): 'zh-CN' | 'en-US' {
  return locale && /^zh/i.test(locale) ? 'zh-CN' : 'en-US'
}

/**
 * Put the published notes where the shared embed resolver looks for them.
 *
 * Only the article itself and the published notes it embeds are present. Anything else is absent by
 * construction, so a wiki link or embed that points at a private note resolves to nothing rather than
 * reaching the owner's API.
 */
function hydrateNotes(options: BlogReadingMountOptions): void {
  const notes: Record<string, NoteSummary> = {}
  const contents: Record<string, string> = {}
  const articleId = `blog:${normalizeTarget(options.noteTitle ?? '')}`
  if (options.noteTitle) {
    notes[articleId] = stubNote(articleId, options.noteTitle)
    contents[articleId] = options.content
  }
  for (const embed of options.embeds ?? []) {
    notes[embed.id] = stubNote(embed.id, embed.title)
    contents[embed.id] = embed.content
  }
  useNotes.setState({ notes, contents })
}

function applyReadingSettings(settings: Partial<BlogReadingSettings> | undefined): void {
  const preview = {
    ...DEFAULT_SETTINGS.preview,
    ...(settings?.emojiShortcodes === undefined ? {} : { emojiShortcodes: settings.emojiShortcodes }),
    ...(settings?.math === undefined ? {} : { math: settings.math }),
    ...(settings?.mermaid === undefined ? {} : { mermaid: settings.mermaid }),
    ...(settings?.chart === undefined ? {} : { chart: settings.chart }),
    ...(settings?.codeBlockCollapse === undefined ? {} : { codeBlockCollapse: settings.codeBlockCollapse }),
    ...(settings?.codeBlockCollapseLines === undefined ? {} : { codeBlockCollapseLines: settings.codeBlockCollapseLines }),
    ...(settings?.jsonView === undefined ? {} : { jsonView: settings.jsonView }),
    ...(settings?.jsonFold === undefined ? {} : { jsonFold: settings.jsonFold }),
    ...(settings?.jsonTolerant === undefined ? {} : { jsonTolerant: settings.jsonTolerant }),
    // Surfaces a public page cannot offer: writes, drag handles and editor menus.
    contextMenu: false,
    mediaToolbar: false,
    codeFormatButton: false,
    tableBubbleMenu: false,
    jsonEditable: false,
    linkHover: false,
  }
  useSession.setState((state) => ({
    settings: {
      ...state.settings,
      preview,
      appearance: {
        ...state.settings.appearance,
        proseFont: 'sans',
      },
    },
  }))
}

/**
 * Write actions a read-only board can still draw.
 *
 * The board's data layer already refuses every write when `editable` is false, and the marked
 * controls are removed by CSS; the add/rename affordances the board builds inside its views carry
 * only their label, so they are recognised by it here. New labels mean a new entry, not a write:
 * the writer above is what makes the page safe.
 */
const READ_ONLY_ACTIONS = new Set([
  t('preview.kanban_new_item'),
  t('preview.kanban_new_group'),
  t('preview.kanban_rename_card'),
  t('preview.kanban_new_view'),
  t('preview.kanban_view_actions'),
  t('preview.kanban_more_actions'),
  t('common.undo'),
  t('common.redo'),
])

function hideWriteActions(root: HTMLElement): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('.is-readonly button')) {
    const text = (button.textContent ?? '').replace(/^\+\s*/, '').trim()
    const label = (button.getAttribute('aria-label') ?? '').trim()
    if (READ_ONLY_ACTIONS.has(text) || READ_ONLY_ACTIONS.has(label)) button.style.display = 'none'
  }
}

function attachmentIndex(assets: BlogAssetRef[] | undefined): {
  byName: Map<string, BlogAssetRef>
  byId: Map<string, BlogAssetRef>
} {
  const byName = new Map<string, BlogAssetRef>()
  const byId = new Map<string, BlogAssetRef>()
  for (const asset of assets ?? []) {
    if (asset.filename) byName.set(normalizeTarget(asset.filename), asset)
    if (asset.attachmentId) byId.set(asset.attachmentId, asset)
  }
  return { byName, byId }
}

function currentHref(links: BlogWikiHref[] | undefined, target: string): string | null {
  if (!links?.length) return null
  const key = normalizeTarget(target)
  return links.find((link) => normalizeTarget(link.target) === key)?.href ?? null
}

async function mount(options: BlogReadingMountOptions): Promise<BlogReadingHandle> {
  await import('./runtime.css')
  setAssetBase(options.assetBase ?? '')
  await initI18nForReading(readingLocale(options.locale ?? options.settings?.locale))
  hydrateNotes(options)
  applyReadingSettings(options.settings)

  const attachments = attachmentIndex(options.assets)
  const root: Root = createRoot(options.container)
  let hideObserver: MutationObserver | null = null
  root.render(
    <div className="blog-reading-runtime" data-blog-reading>
      <Preview
        content={options.content}
        noteTitle={options.noteTitle}
        readOnly
        className="blog-reading-surface"
        onHeadings={options.onHeadings}
        onRendered={options.onRendered}
        onWikiLink={(target) => {
          const href = target.noteTitle ? currentHref(options.wikiLinks, target.noteTitle) : null
          if (!href) return false
          const anchor = target.heading
            ? `#${slugifyHeading(target.heading)}`
            : target.blockId ? `#${encodeURIComponent(`^${target.blockId}`)}` : ''
          window.location.assign(`${href}${anchor}`)
          return true
        }}
        onTagClick={(name) => {
          const href = options.tagHref?.(name) ?? null
          if (!href) return false
          window.location.assign(href)
          return true
        }}
        resolveAttachment={(name) => {
          const asset = attachments.byName.get(normalizeTarget(name))
          if (!asset) return null
          return {
            filename: asset.filename ?? name,
            mime: asset.mime ?? '',
            url: asset.url,
            size: asset.size ?? 0,
            width: asset.width ?? null,
            height: asset.height ?? null,
          }
        }}
        rewriteAssetUrl={(url) => {
          const match = /\/api\/files\/([A-Za-z0-9_-]{1,64})(?:[?#]|$)/.exec(url)
          const asset = match ? attachments.byId.get(match[1]!) : undefined
          return asset?.url ?? null
        }}
      />
      <Lightbox />
      <Toaster />
    </div>,
  )
  // Views are mounted asynchronously after the first paint, so a one-shot sweep would run before
  // the board has buttons to sweep.
  hideObserver = new MutationObserver(() => hideWriteActions(options.container))
  hideObserver.observe(options.container, { childList: true, subtree: true })
  const sweep = window.setTimeout(() => hideWriteActions(options.container), 600)
  return {
    unmount: () => {
      window.clearTimeout(sweep)
      hideObserver?.disconnect()
      hideObserver = null
      root.unmount()
    },
  }
}

;(globalThis as typeof globalThis & {
  InkstoneReading?: {
    version: string
    mount: (options: BlogReadingMountOptions) => Promise<BlogReadingHandle>
  }
}).InkstoneReading = { version: BLOG_RENDERER_VERSION, mount }
