import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { cn } from '../../lib/cn'
import { truncateText } from '@shared/text-utils'
import { useDebounced } from '../../lib/hooks'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { parseWikiTarget, renderMarkdown, type Heading } from '../../lib/markdown/renderer'
import { useEmojiUnicodeVersion } from '../../lib/emoji-unicode'
import { resolveNoteEmbeds } from '../../lib/markdown/embeds'
import { t, useLocale } from '../../lib/i18n'
import { slugifyHeading } from '@shared/markdown-utils'
import {
  destroyChartInstances,
  enhancePreview,
  renderPendingCharts,
  renderPendingMermaid,
  resetMermaidNode,
  toggleCodeBlockCollapse,
} from '../../lib/markdown/enhance'
import { KanbanFullscreen } from '../../lib/markdown/kanban'
import { kanbanIndex } from '../../lib/markdown/kanban/view'
import { fenceBody, registerFenceBodies, type FenceBodies } from '../../lib/markdown/fence-bodies'
import { useKanbanBlocks } from './use-kanban-blocks'
import { updateTaskAtSourceLine } from '../../editor/commands'
import { useUi } from '../../store/ui'
import { useNotes, findNoteByTitle } from '../../store/notes'
import { useSession } from '../../store/session'
import { previewSourceAnchors } from './preview-anchors'
import { moveMarkdownTabFocus, revealPreviewTarget, selectMarkdownTab } from './markdown-tabs'
import { capturePreviewInteractionState, restorePreviewInteractionState } from './preview-state'
import { closeBlockToolbarOverlay, enhanceBlockToolbars, handleBlockToolbarClick } from './block-actions'
import { attachMediaLayoutHost } from './media-layout-drag'
import { applyMediaEdit } from '../../lib/markdown/media-layout-source'
import type { BlockActionContext } from './block-overlay'
import { MindmapFullscreen } from './mindmap-fullscreen'
import { MindmapThemeMenu } from './mindmap-theme-menu'
import { useMindmapBlocks } from './use-mindmap-blocks'
import { NoteProperties } from './NoteProperties'
import { WikiLinkHoverCard } from './wiki-link-hover-card'
import { useLinkHoverHost } from './link-hover-host'
import { TagContextMenuAt, tagMenuRequestFrom, type TagMenuRequest } from '../tags/TagContextMenuAt'
import { EditorContextMenu } from '../workspace/context-menu/EditorContextMenu'
import { detectPreviewContext } from '../workspace/context-menu/detect-preview'
import { useLongPress } from '../workspace/context-menu/use-long-press'
import type { ContextMenuHost, PreviewContext } from '../workspace/context-menu/types'
import { openTagPageByName, wantsTagPage } from '../tags/tagMutations'
import { beginTagDrag, endTagDrag } from '../tags/tagDrag'
import { preferredScrollBehavior } from '../../lib/motion'

export interface PreviewProps {
  content: string
  noteId?: string
  noteTitle?: string
  onHeadings?: (headings: Heading[]) => void
  scrollerRef?: RefObject<HTMLDivElement | null>
  onRendered?: () => void
  onInitialRender?: (scroller: HTMLDivElement) => void
  onScroll?: (scroller: HTMLDivElement) => void
  className?: string
  /** The note's context menu, which only an editing host can supply. */
  contextMenu?: ContextMenuHost
}

export const Preview = memo(function Preview({
  content,
  noteId,
  noteTitle,
  onHeadings,
  scrollerRef: externalScrollerRef,
  onRendered,
  onInitialRender,
  onScroll,
  className,
  contextMenu,
}: PreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const internalScrollerRef = useRef<HTMLDivElement>(null)
  const scrollerRef = externalScrollerRef ?? internalScrollerRef
  const preview = useSession((s) => s.settings.preview)
  const editorSettings = useSession((s) => s.settings.editor)
  const appearance = useSession((s) => s.settings.appearance)
  const userId = useSession((s) => s.user?.id)
  const locale = useLocale()
  const setLightbox = useUi((s) => s.setLightbox)
  const openView = useUi((s) => s.openView)
  const toast = useUi((s) => s.toast)
  const openNote = useNotes((s) => s.openNote)
  const createNote = useNotes((s) => s.createNote)
  const editContent = useNotes((s) => s.editContent)
  const activeNoteId = useUi((s) => s.activeNoteId)
  const fallbackTitle = useNotes((s) => (activeNoteId ? s.notes[activeNoteId]?.title ?? '' : ''))
  const sourceNoteId = noteId ?? activeNoteId
  const currentTitle = noteTitle ?? fallbackTitle
  const { hover, handlePin, onMouseLeave, onFocus, onBlur } = useLinkHoverHost(sourceNoteId ?? null)

  // A tab block's remembered choice belongs to this account's reading of this note, so a shared
  // browser does not carry one person's open tab over to the next.
  const tabScope = useMemo(() => ({ noteId: sourceNoteId ?? null, userId: userId ?? null }), [sourceNoteId, userId])


  const debounced = useDebounced(content, 90)
  const emojiVersion = useEmojiUnicodeVersion()
  const rendered = useMemo(() => renderMarkdown(debounced, { hideFrontMatter: true, emojiShortcodes: preview.emojiShortcodes }), [debounced, locale, preview.emojiShortcodes, emojiVersion])
  const embedContextTitle = rendered.hasEmbeds ? currentTitle : ''
  const committedHtmlRef = useRef('')
  const committedSourceRef = useRef(debounced)
  const preparationRef = useRef(0)
  const mermaidRevisionRef = useRef(0)
  const initialRenderRestoredRef = useRef(false)
  const copyResetTimersRef = useRef(new Map<HTMLElement, number>())
  // The pointer surface is attached once per host and must not be torn down mid-drag by a keystroke, so it
  // reads the note's current text and identity through these rather than closing over a render's props.
  const liveContentRef = useRef(content)
  const liveNoteIdRef = useRef(sourceNoteId)
  const wikiNavigationRef = useRef(0)
  const wikiScrollCleanupRef = useRef<() => void>(() => {})
  const [mermaidEpoch, setMermaidEpoch] = useState(0)
  const [tagMenu, setTagMenu] = useState<TagMenuRequest | null>(null)
  const [previewMenu, setPreviewMenu] = useState<{ x: number; y: number; context: PreviewContext } | null>(null)
  // The markup the host is *holding*, not the markup about to be drawn: a board is a React root and
  // can only be mounted into the live tree. It also carries the fence bodies, because with the bodies
  // out of the attributes an edit to a board leaves the markup string identical — so the markup alone
  // would never say the board changed.
  const [kanbanCommit, setKanbanCommit] = useState<{ html: string, fences: FenceBodies } | null>(null)

  useLayoutEffect(() => {
    if (hostRef.current && !hostRef.current.hasChildNodes() && rendered.html) {
      hostRef.current.innerHTML = rendered.html
    }
  }, [])
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'dark')
  // One scope per preview instance: two panes showing the same note must not claim each other's map.
  const instanceScope = useId()
  const mindmap = useMindmapBlocks({
    scope: `preview${instanceScope}`,
    noteId: sourceNoteId ?? null,
    hostRef,
    epoch: mermaidEpoch,
    dark: theme === 'dark',
  })

  const kanban = useKanbanBlocks({
    scope: noteId ?? 'unsaved',
    noteId: noteId ?? null,
    hostRef,
    committedHtml: kanbanCommit?.html ?? '',
    fences: kanbanCommit?.fences ?? null,
  })

  useEffect(() => {
    onHeadings?.(rendered.headings)
  }, [rendered.headings, onHeadings])

  useEffect(() => {
    liveContentRef.current = content
  }, [content])

  useEffect(() => {
    liveNoteIdRef.current = sourceNoteId
  }, [sourceNoteId])


  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = document.documentElement.dataset.theme ?? 'dark'
      setTheme((current) => (current === next ? current : next))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(
    () => () => {
      wikiNavigationRef.current++
      wikiScrollCleanupRef.current()
      for (const timer of copyResetTimersRef.current.values()) window.clearTimeout(timer)
      copyResetTimersRef.current.clear()
      // A chart is an instance plus a ResizeObserver, and neither is reachable from the note once this
      // host is thrown away, so nothing else would ever run their teardown.
      destroyChartInstances(hostRef.current)
    },
    [],
  )

  const startMermaidRender = useCallback(() => {
    const host = hostRef.current
    if (!host || !preview.mermaid) return

    const revision = ++mermaidRevisionRef.current
    void renderPendingMermaid<PreviewViewport | null>(host, theme === 'dark', {
      isCurrent: () => revision === mermaidRevisionRef.current && hostRef.current === host,
      beforeUpdate: () => {
        const scroller = scrollerRef.current
        return scroller ? capturePreviewViewport(scroller, host) : null
      },
      afterUpdate: (snapshot) => {
        const scroller = scrollerRef.current
        if (snapshot && scroller && hostRef.current === host) {
          restorePreviewViewport(scroller, host, snapshot)
        }
        onRendered?.()
      },
    })
  }, [onRendered, scrollerRef, preview.mermaid, theme])

  // Charts draw on the live host rather than in the staged copy: a canvas is pixels and an instance, and
  // neither survives the serialization and cloning the swap does.
  const startChartRender = useCallback(() => {
    const host = hostRef.current
    if (!host || !preview.chart) return
    void renderPendingCharts(host, theme === 'dark')
  }, [preview.chart, theme])


  useEffect(() => {
    const revision = ++preparationRef.current
    let cancelled = false

    const staging = document.createElement('div')
    staging.innerHTML = rendered.html
    // Registered before the swap so the patch below can read a staged block's body: the copy in the
    // host still resolves against the previous set, and the two are what say whether a board changed.
    registerFenceBodies(staging, rendered.fences)

    const prepare = async () => {
      if (rendered.hasEmbeds) {
        await resolveNoteEmbeds(staging, {
          currentContent: debounced,
          currentTitle: embedContextTitle,
          isCurrent: () => !cancelled && revision === preparationRef.current,
        })
      }
      await enhancePreview(staging, {
        math: preview.math,
        mermaid: preview.mermaid,
        chart: preview.chart,
        // 'live' says the board is somebody else's job: a React root cannot be drawn into detached
        // staging, so this pass leaves the block's placeholder standing and the mount below replaces it.
        kanban: 'live',
        // The map itself is mounted from the committed markup by `useMindmapBlocks`, so this pass has
        // to leave the placeholder standing: a snapshot drawn here would be swapped in over the live
        // canvas by the next diff, and the registry would then re-parent into a block holding an image.
        mindmap: 'live',
        dark: theme === 'dark',
        codeBlockCollapseLines: preview.codeBlockCollapse
          ? preview.codeBlockCollapseLines
          : 0,
      })
      // Every block head is built here rather than on the live host so it is part of the markup the
      // preview diffs against; a toolbar added after the swap would be wiped by the next keystroke.
      enhanceBlockToolbars(staging, {
        chart: preview.chart,
        mediaToolbar: preview.mediaToolbar,
        codeFormat: {
          enabled: preview.codeFormatButton,
          tabSize: editorSettings.tabSize,
          keywordCase: editorSettings.codeFormatKeywordCase,
        },
        tabScope,
      })
      if (cancelled || revision !== preparationRef.current) return

      restorePreviewInteractionState(staging, capturePreviewInteractionState(hostRef.current))

      const nextHtml = staging.innerHTML
      // Outside the swap below on purpose: a fence-body edit leaves this markup string identical, so
      // gating the mount on a changed string would leave the board showing the old cards. Returning the
      // same object keeps React from re-rendering when neither half moved.
      setKanbanCommit((current) =>
        current && current.html === nextHtml && current.fences === rendered.fences
          ? current
          : { html: nextHtml, fences: rendered.fences },
      )
      committedSourceRef.current = debounced
      if (nextHtml !== committedHtmlRef.current) {
        const scroller = scrollerRef.current
        const host = hostRef.current
        const snapshot = scroller && host ? capturePreviewViewport(scroller, host) : null
        committedHtmlRef.current = nextHtml
        hover.hideNow()
        if (host) {
          if (!host.hasChildNodes()) {
            host.replaceChildren(...staging.cloneNode(true).childNodes)
          } else {
            patchChildren(host, staging)
          }
          if (snapshot && scroller) restorePreviewViewport(scroller, host, snapshot)
        }
        if (!initialRenderRestoredRef.current && scroller) {
          initialRenderRestoredRef.current = true
          onInitialRender?.(scroller)
        }
        onRendered?.()
      }
      setMermaidEpoch((current) => current + 1)
    }
    void prepare()

    return () => {
      cancelled = true
    }
  }, [
    debounced,
    embedContextTitle,
    tabScope,
    rendered.hasEmbeds,
    rendered.html,
    scrollerRef,
    preview.math,
    preview.mermaid,
    preview.chart,
    preview.codeBlockCollapse,
    preview.codeBlockCollapseLines,
    preview.codeFormatButton,
    preview.mediaToolbar,
    editorSettings.tabSize,
    editorSettings.codeFormatKeywordCase,
    theme,
  ])


  useEffect(() => {
    if (!mermaidEpoch || !preview.mermaid) return
    const timer = window.setTimeout(startMermaidRender, 60)
    return () => {
      window.clearTimeout(timer)
      mermaidRevisionRef.current++
    }
  }, [mermaidEpoch, preview.mermaid, startMermaidRender])

  useEffect(() => {
    if (!mermaidEpoch) return
    const timer = window.setTimeout(startChartRender, 60)
    return () => window.clearTimeout(timer)
  }, [mermaidEpoch, startChartRender])


  const blockActionContext = (): BlockActionContext => ({
    content,
    sourceNoteId,
    committedSourceRef,
    api: { editContent, toast },
    codeFormat: {
      enabled: preview.codeFormatButton,
      tabSize: editorSettings.tabSize,
      keywordCase: editorSettings.codeFormatKeywordCase,
    },
    mindmap: { fullscreen: mindmap.openFullscreen, themeMenu: mindmap.openThemeMenu },
  })

  /**
   * The layout block's pointer surface, on the host rather than on each block.
   *
   * One delegated listener answers for every block in the note and survives the child patching the
   * preview does on each typing pause, which a per-block listener would not. The surface reads the note
   * through the same committed-source guard the toolbars use: a drag that ended while the preview was
   * showing an older document would otherwise move a row that is no longer there.
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host || !preview.mediaToolbar) return
    return attachMediaLayoutHost(host, () => {
      const noteIdFor = liveNoteIdRef.current
      if (!noteIdFor) return null
      return {
        source: () => (liveContentRef.current === committedSourceRef.current ? committedSourceRef.current : null),
        commit: (edit) => {
          const current = committedSourceRef.current
          if (liveContentRef.current !== current) return false
          const next = applyMediaEdit(current, edit)
          if (next === current) return true
          useNotes.getState().editContent(noteIdFor, next)
          return true
        },
        toast: (title, tone) => useUi.getState().toast({ title, tone }),
      }
    })
  }, [preview.mediaToolbar])

  /**
   * The rendered block's own controls, reached through the hooks that already own them. A menu row
   * that opened a mind map in full screen by rebuilding the session would disagree with the block's
   * button the moment either side learned something new, so it calls the same opener instead.
   */
  const handleBlockAction = (name: 'mindmap-fullscreen' | 'mindmap-theme' | 'kanban-fullscreen' | 'mermaid-rerender', target: HTMLElement) => {
    if (name === 'mindmap-fullscreen') mindmap.openFullscreen(target)
    else if (name === 'mindmap-theme') mindmap.openThemeMenu(target)
    else if (name === 'kanban-fullscreen') kanban.openFullscreen(target)
    else if (name === 'mermaid-rerender') {
      const block = target.closest<HTMLElement>('[data-mermaid]')
      if (!block) return
      const scroller = scrollerRef.current
      const host = hostRef.current
      const snapshot = scroller && host ? capturePreviewViewport(scroller, host) : null
      resetMermaidNode(block)
      if (snapshot && scroller && host) restorePreviewViewport(scroller, host, snapshot)
      startMermaidRender()
    }
  }

  const longPress = useLongPress((point, target) => {
    if (!contextMenu) return
    const tag = tagMenuRequestFrom(target, point.x, point.y)
    if (tag) {
      setTagMenu(tag)
      return
    }
    setPreviewMenu({ x: point.x, y: point.y, context: detectPreviewContext(target) })
  })

  const onClick = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement

    if (handleBlockToolbarClick(event, target, blockActionContext())) return

    const mermaidRetry = target.closest<HTMLElement>('[data-mermaid-retry]')
    if (mermaidRetry) {
      const block = mermaidRetry.closest<HTMLElement>('[data-mermaid]')
      if (block) {
        const scroller = scrollerRef.current
        const host = hostRef.current
        const snapshot =
          scroller && host ? capturePreviewViewport(scroller, host) : null
        resetMermaidNode(block)
        if (snapshot && scroller && host) restorePreviewViewport(scroller, host, snapshot)
        startMermaidRender()
      }
      return
    }

    const copyButton = target.closest<HTMLElement>('[data-copy]')
    if (copyButton) {
      const code = copyButton.closest('.code-block')?.querySelector('pre')?.textContent ?? ''
      if (!navigator.clipboard?.writeText) {
        toast({ title: t("preview.could_not_copy"), tone: 'danger' })
        return
      }
      void navigator.clipboard
        .writeText(code)
        .then(() => {
          if (!hostRef.current?.contains(copyButton)) return
          const existingTimer = copyResetTimersRef.current.get(copyButton)
          if (existingTimer !== undefined) window.clearTimeout(existingTimer)
          copyButton.textContent = t("common.copied")
          copyButton.classList.add('copied')
          const timer = window.setTimeout(() => {
            if (hostRef.current?.contains(copyButton)) {
              copyButton.textContent = t("common.copy")
              copyButton.classList.remove('copied')
            }
            copyResetTimersRef.current.delete(copyButton)
          }, 900)
          copyResetTimersRef.current.set(copyButton, timer)
        })
        .catch(() => toast({ title: t("preview.could_not_copy"), tone: 'danger' }))
      return
    }

    const collapseButton = target.closest<HTMLButtonElement>('[data-code-collapse]')
    if (collapseButton) {
      toggleCodeBlockCollapse(collapseButton)
      return
    }

    const checkbox = target.closest<HTMLInputElement>('input[type="checkbox"]')
    if (checkbox) {
      if (checkbox.disabled || checkbox.closest('.note-embed-body')) return


      const checked = checkbox.checked
      const line = Number(checkbox.dataset.taskLine)
      if (Number.isInteger(line) && line >= 0) {
        const committedSource = committedSourceRef.current
        if (content !== committedSource) {
          checkbox.checked = !checked
          toast({ title: t("preview.the_preview_is_updating_try_again_in_a_moment"), tone: 'warning' })
          return
        }
        const next = updateTaskAtSourceLine(committedSource, line, checked)
        if (next == null || !sourceNoteId) {
          checkbox.checked = !checked
          toast({ title: t("preview.could_not_update_this_task"), tone: 'warning' })
          return
        }
        editContent(sourceNoteId, next)
      }
      return
    }

    const tabButton = target.closest<HTMLButtonElement>('[data-tab-button]')
    if (tabButton) {
      event.preventDefault()
      selectMarkdownTab(tabButton, tabScope)
      return
    }

    const wikilink = target.closest<HTMLElement>('[data-wikilink]')
    if (wikilink) {
      event.preventDefault()
      wikiScrollCleanupRef.current()
      const navigation = ++wikiNavigationRef.current
      const parsed = parseWikiTarget(decodeDataValue(wikilink.dataset.wikilink))
      const note = parsed.noteTitle ? findNoteByTitle(parsed.noteTitle) : sourceNoteId ? useNotes.getState().notes[sourceNoteId] : undefined
      if (note) {
        void openNote(note.id).then(() => {
          const isCurrent = () =>
            navigation === wikiNavigationRef.current &&
            useUi.getState().activeNoteId === note.id
          if (!isCurrent()) return
          wikiScrollCleanupRef.current = scrollToWikiTarget(hostRef, parsed, isCurrent)
        })
      } else if (parsed.noteTitle) {
        void createNote({ title: parsed.noteTitle, open: false }).then((id) => {
          if (!id) return
          toast({ title: t("preview.created_title", { title: parsed.noteTitle }), tone: 'success' })
          if (
            navigation === wikiNavigationRef.current &&
            useUi.getState().activeNoteId === sourceNoteId
          ) {
            void openNote(id)
          }
        })
      }
      return
    }

    const blockReference = target.closest<HTMLElement>('[data-block-ref]')
    if (blockReference) {
      event.preventDefault()
      scrollElementIntoView(hostRef.current?.querySelector(`#${CSS.escape(`^${blockReference.dataset.blockRef ?? ''}`)}`))
      return
    }

    const tag = target.closest<HTMLElement>('[data-tag]')
    if (tag) {
      event.preventDefault()
      const name = decodeDataValue(tag.dataset.tag)
      // Alt/opt or cmd/ctrl turns a tag in the reading view into its tag page, the way the
      // reference plugin does; a plain click still just filters.
      if (wantsTagPage(event)) {
        void openTagPageByName(name)
        return
      }
      openView('tag', { tag: name })
      return
    }

    const image = target.closest<HTMLImageElement>('img')
    if (image?.src) {
      event.preventDefault()
      setLightbox({ src: image.src, alt: image.alt })
      return
    }

    const anchor = target.closest<HTMLAnchorElement>('a[href^="#"]')
    if (anchor) {
      event.preventDefault()
      const rawId = anchor.getAttribute('href')!.slice(1)
      let id = rawId
      try {
        id = decodeURIComponent(rawId)
      } catch {

      }
      const heading = hostRef.current?.querySelector(`#${CSS.escape(id)}`)
      revealPreviewTarget(heading)
      heading?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' })
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      const trigger = closeBlockToolbarOverlay(event.target as HTMLElement)
      if (trigger) {
        event.preventDefault()
        trigger.focus()
        return
      }
    }
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab-button]')
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      moveMarkdownTabFocus(tab, event.key, tabScope)
      return
    }
    const interactiveLink = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-wikilink], [data-block-ref], [data-tag]',
    )
    if (interactiveLink && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      interactiveLink.click()
    }
  }

  return (
    <div
      ref={scrollerRef}
      className={cn('h-full overflow-y-auto overscroll-contain px-4 py-3', className)}
      data-preview-scroller
      onScroll={(event) => onScroll?.(event.currentTarget)}
    >
      <div onMouseMove={hover.handleMouseMove} onMouseLeave={onMouseLeave}>
        <NoteProperties noteId={sourceNoteId ?? null}/>
      </div>
      <div
        ref={hostRef}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          const request = tagMenuRequestFrom(event.target, event.clientX, event.clientY)
          if (request) {
            event.preventDefault()
            event.stopPropagation()
            setTagMenu(request)
            return
          }
          if (!contextMenu || !(event.target instanceof Element)) return
          if (longPress.justLongPressed()) return
          event.preventDefault()
          event.stopPropagation()
          setPreviewMenu({ x: event.clientX, y: event.clientY, context: detectPreviewContext(event.target) })
        }}
        onDragStart={(event) => {
          const source = (event.target as HTMLElement).closest<HTMLElement>('[data-tag]')
          if (!source?.dataset.tag) return
          beginTagDrag(decodeDataValue(source.dataset.tag), event.dataTransfer)
        }}
        onDragEnd={endTagDrag}
        onMouseMove={hover.handleMouseMove}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        {...longPress.handlers}
        data-font={appearance.proseFont}
        data-preview-content
        className="ink-prose"
      />
      {kanban.fullscreen && (
        <KanbanFullscreen session={kanban.fullscreen.session} onClose={kanban.closeFullscreen}/>
      )}
      <TagContextMenuAt request={tagMenu} onClose={() => setTagMenu(null)}/>
      {contextMenu && previewMenu && (
        <EditorContextMenu
          point={previewMenu}
          onClose={() => setPreviewMenu(null)}
          editorView={null}
          editor={null}
          preview={previewMenu.context}
          content={content}
          noteId={sourceNoteId ?? null}
          onEditContent={(next) => sourceNoteId && editContent(sourceNoteId, next)}
          onJumpToLine={contextMenu.onJumpToLine}
          onPickImage={contextMenu.onPickImage}
          onPickFile={contextMenu.onPickFile}
          onSwitchLayout={contextMenu.onSwitchLayout}
          layout={contextMenu.layout}
          onExport={contextMenu.onExport}
          onPresent={contextMenu.onPresent}
          onOpenNote={(id) => void openNote(id)}
          onCreateNote={(input) => void createNote(input)}
          onOpenInSecondary={contextMenu.onOpenInSecondary}
          onToast={toast}
          onLightbox={setLightbox}
          onBlockAction={handleBlockAction}
          previewScroller={scrollerRef.current}
          showToolbar={contextMenu.showToolbar}
          searchable={contextMenu.searchable}
        />
      )}
      {mindmap.fullscreen && (
        <MindmapFullscreen session={mindmap.fullscreen.session} onClose={mindmap.closeFullscreen}/>
      )}
      {mindmap.themeMenu && (
        <MindmapThemeMenu state={mindmap.themeMenu} onClose={mindmap.closeThemeMenu}/>
      )}
      {hover.card && (
        <WikiLinkHoverCard
          card={hover.card}
          path={hover.card.noteId ? [hover.card.noteId] : []}
          depth={1}
          dark={theme === 'dark'}
          onClose={hover.hideNow}
          onEnter={hover.clearPendingHide}
          onLeave={hover.armHide}
          onPin={handlePin}
        />
      )}
    </div>
  )
})

function scrollToWikiTarget(
  hostRef: RefObject<HTMLDivElement | null>,
  target: ReturnType<typeof parseWikiTarget>,
  isCurrent: () => boolean,
): () => void {
  if (!target.heading && !target.blockId) return () => {}
  const id = target.blockId ? `^${target.blockId}` : slugifyHeading(target.heading!)
  let attempts = 0
  let timer = 0
  let cancelled = false
  const find = () => {
    if (cancelled || !isCurrent()) return
    const element = hostRef.current?.querySelector(`#${CSS.escape(id)}`)
    if (element) scrollElementIntoView(element)
    else if (++attempts < 12) timer = window.setTimeout(find, 50)
  }
  find()
  return () => {
    cancelled = true
    window.clearTimeout(timer)
  }
}

function scrollElementIntoView(element: Element | null | undefined): void {
  revealPreviewTarget(element)
  element?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' })
}

interface PreviewViewport {
  atTop: boolean
  atBottom: boolean
  scrollTop: number
  line: number | null
  tagName: string | null
  signature: string | null
  offset: number
}

function capturePreviewViewport(scroller: HTMLElement, host: HTMLElement): PreviewViewport {
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const atTop = scroller.scrollTop <= 2
  const atBottom = maxScroll > 0 && scroller.scrollTop >= maxScroll - 4
  const scrollerRect = scroller.getBoundingClientRect()
  const viewportTop = scrollerRect.top + previewPaddingTop(scroller)
  const anchors = previewSourceAnchors(host)
  const anchor =
    anchors.reduce<HTMLElement | null>((closest, candidate) => {
      if (!closest) return candidate
      const closestDistance = Math.abs(closest.getBoundingClientRect().top - viewportTop)
      const candidateDistance = Math.abs(candidate.getBoundingClientRect().top - viewportTop)
      return candidateDistance < closestDistance ? candidate : closest
    }, null)

  return {
    atTop,
    atBottom,
    scrollTop: scroller.scrollTop,
    line: anchor ? sourceLine(anchor) : null,
    tagName: anchor?.tagName ?? null,
    signature: anchor ? previewAnchorSignature(anchor) : null,
    offset: anchor ? anchor.getBoundingClientRect().top - scrollerRect.top : 0,
  }
}

function restorePreviewViewport(
  scroller: HTMLElement,
  host: HTMLElement,
  snapshot: PreviewViewport,
): void {
  if (snapshot.atTop) {
    if (snapshot.scrollTop > 0.5) scroller.scrollTop = 0
    return
  }
  if (snapshot.atBottom) {
    const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (Math.abs(scroller.scrollTop - bottom) > 0.5) scroller.scrollTop = bottom
    return
  }

  const anchors = previewSourceAnchors(host)
  let anchor: HTMLElement | null = null

  if (snapshot.signature) {
    const matches = anchors.filter(
      (candidate) => previewAnchorSignature(candidate) === snapshot.signature,
    )
    anchor = closestSourceLine(matches, snapshot.line)
  }
  if (!anchor && snapshot.line != null) {
    const sameLine = anchors.filter(
      (candidate) =>
        sourceLine(candidate) === snapshot.line &&
        (!snapshot.tagName || candidate.tagName === snapshot.tagName),
    )
    anchor = sameLine[0] ?? closestSourceLine(anchors, snapshot.line)
  }

  if (!anchor) {
    const fallback = Math.min(
      snapshot.scrollTop,
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    )
    if (Math.abs(scroller.scrollTop - fallback) > 0.5) scroller.scrollTop = fallback
    return
  }

  const currentOffset =
    anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const correction = currentOffset - snapshot.offset
  if (Math.abs(correction) > 0.5) scroller.scrollTop += correction
}

function closestSourceLine(
  elements: HTMLElement[],
  targetLine: number | null,
): HTMLElement | null {
  if (!elements.length) return null
  if (targetLine == null) return elements[0]!
  return elements.reduce((closest, candidate) => {
    const closestDistance = Math.abs((sourceLine(closest) ?? targetLine) - targetLine)
    const candidateDistance = Math.abs((sourceLine(candidate) ?? targetLine) - targetLine)
    return candidateDistance < closestDistance ? candidate : closest
  })
}

function sourceLine(element: HTMLElement): number | null {
  const value = Number(element.dataset.line)
  return Number.isFinite(value) ? value : null
}

function previewAnchorSignature(element: HTMLElement): string {
  const kind =
    element.dataset.lang ??
    (element.dataset.math ? decodeDataValue(element.dataset.math) : undefined) ??
    (element.dataset.mermaid ? decodeDataValue(element.dataset.mermaid) : undefined) ??
    element.tagName
  const text = truncateText((element.textContent ?? '').replace(/\s+/g, ' ').trim(), 240)
  return `${element.tagName}\u0000${kind}\u0000${text}`
}

function previewPaddingTop(scroller: HTMLElement): number {
  const value = Number.parseFloat(getComputedStyle(scroller).paddingTop)
  return Number.isFinite(value) ? value : 0
}

export function patchChildren(destEl: HTMLElement, srcEl: HTMLElement): void {
  const destChildren = destEl.childNodes
  const srcChildren = srcEl.childNodes
  const srcLen = srcChildren.length
  let destLen = destChildren.length

  while (destLen > srcLen) {
    destEl.removeChild(destChildren[destLen - 1]!)
    destLen--
  }

  for (let i = 0; i < srcLen; i++) {
    const srcChild = srcChildren[i]!
    if (i < destLen) {
      const destChild = destChildren[i]!
      if (destChild.nodeType === srcChild.nodeType && destChild.nodeName === srcChild.nodeName) {
        patchDom(destChild, srcChild)
      } else {
        destEl.replaceChild(srcChild.cloneNode(true), destChild)
      }
    } else {
      destEl.appendChild(srcChild.cloneNode(true))
    }
  }
}

export function patchDom(dest: Node, src: Node): void {
  if (dest.nodeType !== src.nodeType || dest.nodeName !== src.nodeName) {
    dest.parentElement?.replaceChild(src.cloneNode(true), dest)
    return
  }

  if (dest.nodeType === Node.TEXT_NODE) {
    if (dest.nodeValue !== src.nodeValue) {
      dest.nodeValue = src.nodeValue
    }
    return
  }

  if (dest.nodeType === Node.ELEMENT_NODE) {
    const destEl = dest as HTMLElement
    const srcEl = src as HTMLElement

    if (destEl.hasAttribute('data-mermaid') && srcEl.hasAttribute('data-mermaid')) {
      if (destEl.getAttribute('data-mermaid') === srcEl.getAttribute('data-mermaid') && destEl.dataset.rendered) {
        return
      }
    }

    // A drawn chart is a canvas plus a live instance, and neither is in innerHTML, so re-syncing this
    // subtree from the staging copy would put the placeholder text back over a chart that did not change.
    // The stated format is compared beside the body: which reader draws a chart is not written anywhere
    // in its body text, so a note that only moved `style=` has to look changed here.
    if (destEl.hasAttribute('data-chart') && srcEl.hasAttribute('data-chart')) {
      if (destEl.getAttribute('data-chart') === srcEl.getAttribute('data-chart') &&
        destEl.getAttribute('data-chart-style') === srcEl.getAttribute('data-chart-style') &&
        destEl.dataset.rendered &&
        !srcEl.classList.contains('chart-source')) {
        // The body did not change, so the picture still stands. Except when the staged copy is showing
        // its source instead: that is the renderer switch having been turned off, and the note text is
        // identical either way, so the class is the only thing that says the block must stop being a
        // canvas. Preserving it there left an off switch with a chart still drawn on screen.
        // The line is still re-stamped: a format toggle changes how many lines a block above occupies,
        // which moves this one, and the line is what the toolbar resolves its write against.
        if (destEl.dataset.line !== srcEl.dataset.line) destEl.dataset.line = srcEl.dataset.line
        return
      }
    }

    // A mounted board is a React root living inside this element, and none of it is in innerHTML:
    // re-syncing the subtree would put the renderer's placeholder back over a board that did not
    // change, and the reader would lose the column they had scrolled to. The two bodies are compared
    // through the fence set each copy was registered with, because the body is deliberately not an
    // attribute here — and an empty answer on either side means unregistered markup, which is never
    // a match worth preserving.
    if (destEl.hasAttribute('data-kanban') && srcEl.hasAttribute('data-kanban') &&
      destEl.querySelector('[data-kanban-canvas]') &&
      !srcEl.classList.contains('kanban-source')) {
      const live = fenceBody(destEl, 'kanban', kanbanIndex(destEl))
      if (live !== '' && live === fenceBody(srcEl, 'kanban', kanbanIndex(srcEl))) {
        // The line is still re-stamped: a block above changing its line count moves this one, and the
        // line is what a write resolves its fence against.
        if (destEl.dataset.line !== srcEl.dataset.line) destEl.dataset.line = srcEl.dataset.line
        return
      }
    }

    // A live map is an instance whose element the registry re-parents into this block's placeholder,
    // and none of that is in `innerHTML`. Re-syncing the subtree from the staged copy would put the
    // loading text back over a map that did not change, and the registry would then find its own
    // container detached from the document on the next keystroke. The palette annotation is compared
    // beside the body for the same reason a chart's stated format is: which palette a map draws with
    // is not written anywhere inside its body text.
    if (destEl.hasAttribute('data-mindmap') && srcEl.hasAttribute('data-mindmap')) {
      if (destEl.getAttribute('data-mindmap') === srcEl.getAttribute('data-mindmap') &&
        destEl.getAttribute('data-mindmap-theme') === srcEl.getAttribute('data-mindmap-theme') &&
        destEl.classList.contains('is-ready')) {
        if (destEl.dataset.line !== srcEl.dataset.line) destEl.dataset.line = srcEl.dataset.line
        return
      }
    }

    const srcAttrs = srcEl.attributes
    const destAttrs = destEl.attributes

    for (let i = destAttrs.length - 1; i >= 0; i--) {
      const attr = destAttrs[i]!
      if (!srcEl.hasAttribute(attr.name)) {
        destEl.removeAttribute(attr.name)
      }
    }
    for (let i = 0; i < srcAttrs.length; i++) {
      const attr = srcAttrs[i]!
      if (destEl.getAttribute(attr.name) !== attr.value) {
        destEl.setAttribute(attr.name, attr.value)
      }
    }

    patchChildren(destEl, srcEl)
  }
}
