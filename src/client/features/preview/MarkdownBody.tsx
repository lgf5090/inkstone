/**
 * Read-only Markdown, drawn the way a note's preview draws it.
 *
 * Every surface that shows Markdown nobody is editing owes the reader the same document: highlighted
 * code behind a copy button that works, a formula drawn rather than spelled out, a diagram rather than
 * a placeholder that never resolves. `renderMarkdown` produces only the first half of that — the
 * enhancement pass is what draws the rest — and a surface that stops at the render ships code blocks
 * that look finished with buttons that answer nothing, which is what the chat's replies did.
 *
 * What a read-only surface cannot answer for itself is how much of a block it can host. A board or a
 * mind map is a live React root and only the preview pane has somewhere to mount one; a query block
 * reads notes the surface may not have. So those answers are fixed here, once, for every such surface:
 * a still instead of a root, the fence's own text instead of an answer nothing can fill. They are
 * written at the call rather than assembled behind a parameter because
 * `tests/kanban-render-channel.test.ts` reads this call site and fails if a channel stops being named.
 *
 * Two passes run at different cadences on purpose. The render itself is repainted on every token while
 * an answer streams, so the passes that draw a picture wait for the text to stop moving: a diagram
 * redrawn per token flickers through every half-written state, and the module behind it is the largest
 * thing either surface loads. The highlight a reader watches land, and the source fallbacks that keep a
 * block from sitting at "loading" forever, run with the render.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { DEBOUNCE } from '@shared/constants'
import { isSubscriptionMention, subscriptionMentionName } from '@shared/subscriptions/mention'
import { cn } from '../../lib/cn'
import { useDebounced, useThemeDark } from '../../lib/hooks'
import { t, useLocale } from '../../lib/i18n'
import { COPY_RESET_MS } from '../../lib/motion'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { resolveNoteEmbeds } from '../../lib/markdown/embeds'
import {
  destroyChartInstances,
  enhancePreview,
  renderPendingCharts,
  renderPendingMermaid,
  resetMermaidNode,
  toggleCodeBlockCollapse,
} from '../../lib/markdown/enhance'
import { registerFenceBodies } from '../../lib/markdown/fence-bodies'
import { parseWikiTarget, renderMarkdown } from '../../lib/markdown/renderer'
import { findNoteByTitle } from '../../store/notes'
import { useUi } from '../../store/ui'
import { moveMarkdownTabFocus, selectMarkdownTab } from './markdown-tabs'
import { useLinkHoverHost } from './link-hover-host'
import { WikiLinkHoverCard } from './wiki-link-hover-card'

/**
 * How far outside the room the reader is looking a held body starts drawing.
 *
 * The margin is what keeps the deferral invisible: a body two screens away draws while it is still
 * coming into view rather than as it lands, so the reader never watches a fence turn into a highlighted
 * one under their own scroll.
 */
const ENHANCE_APPROACH_PX = 600

/** Whether a body is near enough to where the reader is that waiting for it would be a flicker. */
function isNearViewport(node: HTMLElement): boolean {
  const box = node.getBoundingClientRect()
  // A host with no layout engine answers the origin for every rectangle, which reads as "in the room":
  // that is the honest fallback, because a surface that cannot tell where its own content is has no
  // off screen to hold back for.
  return box.bottom >= -ENHANCE_APPROACH_PX && box.top <= window.innerHeight + ENHANCE_APPROACH_PX
}

/** What a surface with a vault behind it does when the reader follows one of the document's own links. */
export interface MarkdownLinks {
  openNote: (noteId: string) => void
  /** A note the document names and the vault does not have; the surface decides whether to make one. */
  createNote?: (title: string) => void
  /**
   * A `[[sub:…]]` target. Without a handler of its own a subscription mention would be answered as a note
   * title, which is how a click on a plan the reader pays for creates a junk document called `sub:Netflix`.
   */
  openSubscription?: (name: string) => void
}

export interface MarkdownBodyProps {
  source: string
  className?: string
  /** Whether each channel is allowed to draw. A surface whose reader has settings passes them. */
  math?: boolean
  mermaid?: boolean
  chart?: boolean
  /** Folds a code block longer than this many lines; 0 never folds. */
  codeBlockCollapseLines?: number
  /**
   * Hold the drawing passes back until this body has been near the viewport, once.
   *
   * A transcript of four hundred turns is four hundred prism runs and four hundred katex passes for the
   * bubbles nobody is looking at, and the cost lands before the reader has scrolled anywhere. The flag
   * defers the first draw of a body that starts off screen; it does not defer the markup.
   *
   * That distinction is load-bearing, because four contracts in this app read the transcript through the
   * DOM that is already mounted, and all four break the moment a body that scrolls away is taken back
   * out: `thread-find.ts` marks hits inside rendered nodes (`ThreadFinder` promises the reader there are
   * turns still unloaded), `ChatView`'s `focusMessageId` finds its turn by
   * `querySelectorAll('[data-chat-anchor]')`, the scroll anchoring after "load earlier" assumes the nodes
   * above the reader stay where they are, and `ChatOutline` measures each anchor's rectangle. So this
   * gate is one-way — flip it on arrival and never off — and the element, its text and its anchor are
   * rendered by React either way. A surface that hands out bodies one at a time (a note, a draft, a
   * slide) passes nothing and draws as it always did.
   */
  deferOffscreen?: boolean
  /** Rewrites the markup before it is enhanced — a share page's own access rules. */
  transformHtml?: (html: string) => string
  /**
   * Reads `![[note]]` embeds standing in this document. A surface whose readers have no vault passes
   * nothing, and its own markup transform is what tells those placeholders so.
   */
  embeds?: { content: string, title: string }
  links?: MarkdownLinks
}

export function MarkdownBody({
  source,
  className,
  math = true,
  mermaid = true,
  chart = true,
  codeBlockCollapseLines = 24,
  deferOffscreen = false,
  transformHtml,
  embeds,
  links,
}: MarkdownBodyProps) {
  const locale = useLocale()
  const dark = useThemeDark()
  const toast = useUi((state) => state.toast)
  const host = useRef<HTMLDivElement>(null)
  // Every asynchronous pass stamps itself with this before it awaits: a token that arrives mid-draw
  // replaces the markup under it, and the answer that was being written belongs to the text that is gone.
  const revisionRef = useRef(0)
  const copyTimersRef = useRef(new Map<HTMLElement, number>())
  // The text that has stopped moving, which is the only text worth drawing a diagram for.
  const settled = useDebounced(source, DEBOUNCE.render)
  const embedContent = embeds?.content
  const embedTitle = embeds?.title
  // The one-way door of `deferOffscreen`: false only while this body has never been near the reader,
  // and nothing ever sets it back. The markup is rendered regardless — see the flag's own contract.
  const [seen, setSeen] = useState(!deferOffscreen)

  const rendered = useMemo(() => {
    const result = renderMarkdown(source)
    return {
      html: transformHtml ? transformHtml(result.html) : result.html,
      fences: result.fences,
      hasEmbeds: result.hasEmbeds,
    }
    // `locale` is what the renderer reads to name its own built-ins, and `transformHtml` is a decision
    // the caller makes about this document rather than about the string.
  }, [source, locale, transformHtml])
  // A fresh literal on every render would make React rewrite the host each time anything else in the
  // thread changed, which repaints the answer mid-stream.
  const html = useMemo(() => ({ __html: rendered.html }), [rendered])

  // Waits once, on arrival, and retires. An entry that leaves again is not observed for: the passes
  // below are what draw a picture into markup that is already on the page, and taking it back out would
  // break the four contracts the `deferOffscreen` flag names.
  useEffect(() => {
    if (seen) return
    const node = host.current
    // No observer to ask, or a body already near the room it will be read in: draw now. A host that
    // cannot answer "where am I" must never fall through to "then never draw", which is a thread of raw
    // fences and no formula for as long as it is open.
    if (!node || typeof IntersectionObserver === 'undefined' || isNearViewport(node)) {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
    }, { rootMargin: `${ENHANCE_APPROACH_PX}px 0px` })
    observer.observe(node)
    return () => observer.disconnect()
  }, [seen, deferOffscreen])

  useEffect(() => {
    if (!seen) return
    const node = host.current
    if (!node) return
    const revision = ++revisionRef.current
    let cancelled = false
    const isCurrent = () => !cancelled && revisionRef.current === revision && host.current === node
    // Registered before the pass below: a board's cards live in the render's fence set rather than in
    // the markup, and both a still and a live board read that set.
    registerFenceBodies(node, rendered.fences)
    void (async () => {
      if (rendered.hasEmbeds && embedContent !== undefined) {
        await resolveNoteEmbeds(node, { currentContent: embedContent, currentTitle: embedTitle ?? '', isCurrent })
        if (!isCurrent()) return
      }
      await enhancePreview(node, {
        math,
        mermaid,
        chart,
        kanban: 'snapshot',
        mindmap: 'snapshot',
        excalidraw: 'source',
        dataview: 'source',
        dark,
        codeBlockCollapseLines,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [seen, rendered, dark, math, mermaid, chart, codeBlockCollapseLines, embedContent, embedTitle])

  useEffect(() => {
    if (!seen) return
    const node = host.current
    if (!node) return
    const revision = revisionRef.current
    const isCurrent = () => revisionRef.current === revision && host.current === node
    if (mermaid) void renderPendingMermaid(node, dark, { isCurrent })
    if (chart) void renderPendingCharts(node, dark)
  }, [settled, dark, mermaid, chart])

  useEffect(() => () => {
    revisionRef.current++
    for (const timer of copyTimersRef.current.values()) window.clearTimeout(timer)
    copyTimersRef.current.clear()
    destroyChartInstances(host.current)
  }, [])

  const copyCode = useCallback((button: HTMLElement) => {
    const code = button.closest('.code-block')?.querySelector('pre')?.textContent ?? ''
    if (!navigator.clipboard?.writeText) {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' })
      return
    }
    void navigator.clipboard.writeText(code).then(() => {
      // The host may have been repainted between the press and the write, and a check mark on a button
      // that is no longer on screen would be a lie about a copy the reader cannot see.
      if (!host.current?.contains(button)) return
      const existing = copyTimersRef.current.get(button)
      if (existing !== undefined) window.clearTimeout(existing)
      button.textContent = t('common.copied')
      button.classList.add('copied')
      const timer = window.setTimeout(() => {
        if (host.current?.contains(button)) {
          button.textContent = t('common.copy')
          button.classList.remove('copied')
        }
        copyTimersRef.current.delete(button)
      }, COPY_RESET_MS)
      copyTimersRef.current.set(button, timer)
    }).catch(() => toast({ title: t('preview.could_not_copy'), tone: 'danger' }))
  }, [toast])

  const followWikiLink = useCallback((link: HTMLElement) => {
    const parsed = parseWikiTarget(decodeDataValue(link.dataset.wikilink))
    // A subscription is not a note with an odd name: it has its own app and its own resolver, so it is
    // handed over before anything tries to look the title up in the vault.
    if (isSubscriptionMention(parsed.raw)) {
      links!.openSubscription?.(subscriptionMentionName(parsed.raw))
      return
    }
    const note = parsed.noteTitle ? findNoteByTitle(parsed.noteTitle) : undefined
    if (note) {
      links!.openNote(note.id)
      return
    }
    if (parsed.noteTitle && links!.createNote)
      links!.createNote(parsed.noteTitle)
  }, [links])

  const onContentClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const mermaidRetry = target.closest<HTMLElement>('[data-mermaid-retry]')
    if (mermaidRetry) {
      const block = mermaidRetry.closest<HTMLElement>('[data-mermaid]')
      const node = host.current
      if (block && node) {
        const revision = ++revisionRef.current
        resetMermaidNode(block)
        void renderPendingMermaid(node, dark, {
          isCurrent: () => revisionRef.current === revision && host.current === node,
        })
      }
      return
    }
    const copyButton = target.closest<HTMLElement>('[data-copy]')
    if (copyButton) {
      copyCode(copyButton)
      return
    }
    const collapseButton = target.closest<HTMLButtonElement>('[data-code-collapse]')
    if (collapseButton) {
      toggleCodeBlockCollapse(collapseButton)
      return
    }
    const tabButton = target.closest<HTMLButtonElement>('[data-tab-button]')
    if (tabButton) {
      event.preventDefault()
      selectMarkdownTab(tabButton)
      return
    }
    const wikilink = links ? target.closest<HTMLElement>('[data-wikilink]') : null
    if (wikilink) {
      event.preventDefault()
      followWikiLink(wikilink)
    }
  }

  const onContentKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab-button]')
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    moveMarkdownTabFocus(tab, event.key)
  }

  // A card over a link is the vault answering "which note is this", so it is offered exactly where a
  // link can be followed; a share page's readers get neither.
  const { hover, handlePin, onMouseLeave, onFocus, onBlur } = useLinkHoverHost(null, { enabled: Boolean(links) })

  return (
    <>
      <div
        ref={host}
        onClick={onContentClick}
        onKeyDown={onContentKeyDown}
        onMouseMove={links ? hover.handleMouseMove : undefined}
        onMouseLeave={links ? onMouseLeave : undefined}
        onFocus={links ? onFocus : undefined}
        onBlur={links ? onBlur : undefined}
        className={cn('ink-prose', className)}
        dangerouslySetInnerHTML={html}
      />
      {hover.card && (
        <WikiLinkHoverCard
          card={hover.card}
          path={hover.card.noteId ? [hover.card.noteId] : []}
          depth={1}
          dark={dark}
          onClose={hover.hideNow}
          onEnter={hover.clearPendingHide}
          onLeave={hover.armHide}
          onPin={handlePin}
        />
      )}
    </>
  )
}
