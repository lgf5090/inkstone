/**
 * The blog's reading runtime.
 *
 * This is not a second renderer. It mounts the note app's own `Preview` — the same markdown parser,
 * the same enhancement pass, the same live block mounts, the same reading interactions — so a format
 * added to the note app reaches published articles without blog-side changes. The blog keeps the
 * stored snapshot as its no-JS and first-paint surface and replaces it with this runtime when it is
 * available; a failed load leaves the still standing.
 */
import { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createPortal } from 'react-dom'
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

export interface BlogReadingLabels {
  copyTable: string
  copied: string
  copyFailed: string
  copySelection: string
  copyLink: string
  openImage: string
  copyImage: string
  backToTop: string
  article: string
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
  labels: BlogReadingLabels
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

interface HoverState {
  x: number
  y: number
  title: string
  detail: string
  anchor: HTMLElement
}

interface CopyTableState {
  x: number
  y: number
  table: HTMLTableElement
}

interface MenuState {
  x: number
  y: number
  target: HTMLElement
  selection: string
  href: string | null
  image: HTMLImageElement | null
}

function tableText(table: HTMLTableElement): string {
  return [...table.rows].map((row) => [...row.cells].map((cell) => cell.textContent?.trim() ?? '').join('\t')).join('\n')
}

function copyToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) return Promise.reject(new Error('clipboard unavailable'))
  return navigator.clipboard.writeText(text)
}

function ReadingSurface({ options }: { options: BlogReadingMountOptions }) {
  const [hover, setHover] = useState<HoverState | null>(null)
  const [tableCopy, setTableCopy] = useState<CopyTableState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    const root = options.container
    const hide = () => {
      setHover(null)
      setTableCopy(null)
    }
    const onPointerOver = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const wiki = target.closest<HTMLElement>('[data-wikilink]')
      if (wiki) {
        const targetName = wiki.dataset.wikilink ?? ''
        const href = currentHref(options.wikiLinks, targetName)
        const rect = wiki.getBoundingClientRect()
        setHover({ x: rect.left, y: rect.bottom + 6, title: wiki.textContent?.trim() || targetName, detail: href ? options.labels.article : '', anchor: wiki })
        setTableCopy(null)
        return
      }
      const anchor = target.closest<HTMLAnchorElement>('a[href^="http"]')
      if (anchor) {
        const rect = anchor.getBoundingClientRect()
        setHover({ x: rect.left, y: rect.bottom + 6, title: anchor.textContent?.trim() || anchor.href, detail: anchor.href, anchor })
        setTableCopy(null)
        return
      }
      const table = target.closest<HTMLTableElement>('table')
      if (table && !table.closest('.kanban-block')) {
        const rect = table.getBoundingClientRect()
        setTableCopy({ x: rect.right - 20, y: rect.top + 6, table })
        setHover(null)
        return
      }
      if (!target.closest('.blog-hover-card') && !target.closest('.blog-table-copy')) {
        hide()
      }
    }
    const onPointerOut = (event: PointerEvent) => {
      const related = event.relatedTarget
      if (related instanceof Element && (related.closest('.blog-hover-card') || related.closest('.blog-table-copy'))) return
      hide()
    }
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const host = target.closest('[data-preview-content]')
      if (!host) return
      event.preventDefault()
      const selection = window.getSelection()?.toString().trim() ?? ''
      const anchor = target.closest<HTMLAnchorElement>('a[href]')
      const image = target.closest<HTMLImageElement>('img')
      setMenu({ x: event.clientX, y: event.clientY, target: target as HTMLElement, selection, href: anchor?.href ?? null, image: image ?? null })
      setHover(null)
      setTableCopy(null)
    }
    const onScroll = () => {
      setMenu(null)
      setHover((current) => {
        if (!current || !document.contains(current.anchor)) return null
        const rect = current.anchor.getBoundingClientRect()
        return { ...current, x: rect.left, y: rect.bottom + 6 }
      })
      setTableCopy((current) => {
        if (!current || !document.contains(current.table)) return null
        const rect = current.table.getBoundingClientRect()
        return { ...current, x: rect.right - 20, y: rect.top + 6 }
      })
    }
    root.addEventListener('pointerover', onPointerOver)
    root.addEventListener('pointerout', onPointerOut)
    root.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('pointerover', onPointerOver)
      root.removeEventListener('pointerout', onPointerOut)
      root.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('scroll', onScroll)
    }
  }, [options])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const first = document.querySelector<HTMLButtonElement>('.blog-context-menu button')
    first?.focus()
  }, [menu])

  const run = (action: () => Promise<void> | void) => {
    setMenu(null)
    try {
      void Promise.resolve(action()).then(() => {
        setCopied(options.labels.copied)
        window.setTimeout(() => setCopied(''), 1200)
      }).catch(() => setCopied(options.labels.copyFailed))
    } catch {
      setCopied(options.labels.copyFailed)
    }
  }

  return (
    <>
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
          const asset = options.assets?.find((item) => item.filename && normalizeTarget(item.filename) === normalizeTarget(name))
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
          const asset = match ? options.assets?.find((item) => item.attachmentId === match[1]) : undefined
          return asset?.url ?? null
        }}
      />
      <Lightbox />
      <Toaster />
      {hover && createPortal(
        <div className="blog-hover-card" role="tooltip" style={{ left: hover.x, top: hover.y }}>
          <strong>{hover.title}</strong>
          {hover.detail && <span>{hover.detail}</span>}
        </div>,
        document.body,
      )}
      {tableCopy && createPortal(
        <button
          type="button"
          className="blog-table-copy"
          style={{ left: tableCopy.x, top: tableCopy.y }}
          onPointerEnter={() => setTableCopy(tableCopy)}
          onPointerLeave={() => setTableCopy(null)}
          onClick={() => run(() => copyToClipboard(tableText(tableCopy.table)))}
        >
          {copied || options.labels.copyTable}
        </button>,
        document.body,
      )}
      {menu && createPortal(
        <div
          className="blog-context-menu"
          role="menu"
          aria-label={options.labels.article}
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setMenu(null)
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length
            buttons[next]?.focus()
          }}
        >
          {menu.selection && <button type="button" role="menuitem" onClick={() => run(() => copyToClipboard(menu.selection))}>{options.labels.copySelection}</button>}
          {menu.href && <button type="button" role="menuitem" onClick={() => run(() => copyToClipboard(menu.href!))}>{options.labels.copyLink}</button>}
          {menu.image && <button type="button" role="menuitem" onClick={() => { setMenu(null); menu.image!.click() }}>{options.labels.openImage}</button>}
          {menu.image && <button type="button" role="menuitem" onClick={() => run(() => copyToClipboard(menu.image!.src))}>{options.labels.copyImage}</button>}
          <button type="button" role="menuitem" onClick={() => { setMenu(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>{options.labels.backToTop}</button>
        </div>,
        document.body,
      )}
      <span className="sr-only" aria-live="polite">{copied}</span>
    </>
  )
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

  const root: Root = createRoot(options.container)
  let hideObserver: MutationObserver | null = null
  root.render(
    <div className="blog-reading-runtime" data-blog-reading>
      <ReadingSurface options={options} />
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
