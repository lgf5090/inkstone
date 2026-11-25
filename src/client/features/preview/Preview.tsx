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
import { DEBOUNCE } from '@shared/constants'
import { useDebounced } from '../../lib/hooks'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { parseWikiTarget, renderMarkdown, type Heading } from '../../lib/markdown/renderer'
import { useEmojiUnicodeVersion } from '../../lib/emoji-unicode'
import { resolveNoteEmbeds, type EmbedAttachment } from '../../lib/markdown/embeds'
import { isAttachmentTarget } from '../../lib/markdown/attachments'
import { chatEmbedId } from '../../lib/markdown/chat-embed'
import { hasDynamicCommand } from '../../lib/templater/detection'
import { t, useLocale } from '../../lib/i18n'
import {
  destroyChartInstances,
  enhancePreview,
  renderPendingCharts,
  renderPendingMermaid,
  resetMermaidNode,
  toggleCodeBlockCollapse,
} from '../../lib/markdown/enhance'
import { KanbanFullscreen } from '../../lib/markdown/kanban'
import { registerFenceBodies, sameFenceBodies, type FenceBodies } from '../../lib/markdown/fence-bodies'
import { useKanbanBlocks } from './use-kanban-blocks'
import { mountDataview } from '../../lib/dataview/blocks'
import { useUi } from '../../store/ui'
import { useNotes, findNoteByTitle } from '../../store/notes'
import { useSession } from '../../store/session'
import { resolveLockedNoteAttachment } from '../../store/note-locks'
import { resolveEncryptedPreviewAttachments } from './preview-encrypted-attachments'
import { moveMarkdownTabFocus, revealPreviewTarget, selectMarkdownTab } from './markdown-tabs'
import { capturePreviewInteractionState, restorePreviewInteractionState } from './preview-state'
import { patchChildren } from './preview-dom-patch'
import { capturePreviewViewport, restorePreviewViewport, type PreviewViewport } from './preview-viewport'
import { rewriteAssetUrls, scrollElementIntoView, scrollToWikiTarget } from './preview-scroll'
import { closeBlockToolbarOverlay, enhanceBlockToolbars, handleBlockToolbarClick } from './block-actions'
import { attachMediaLayoutHost } from './media-layout-drag'
import { applyMediaEdit } from '../../lib/markdown/media-layout-source'
import type { BlockActionContext } from './block-overlay'
import { MindmapFullscreen } from './mindmap-fullscreen'
import { MindmapThemeMenu } from './mindmap-theme-menu'
import { useJsonBlocks } from './use-json-blocks'
import { useMindmapBlocks } from './use-mindmap-blocks'
import { useExcalidrawBlocks } from './use-excalidraw-blocks'
import { NoteProperties } from './NoteProperties'
import { WikiLinkHoverCard } from './wiki-link-hover-card'
import { useLinkHoverHost } from './link-hover-host'
import { TagContextMenuAt, tagMenuRequestFrom, type TagMenuRequest } from '../tags/TagContextMenuAt'
import { EditorContextMenu } from '../workspace/context-menu/EditorContextMenu'
import { detectPreviewContext } from '../workspace/context-menu/detect-preview'
import { useLongPress } from '../workspace/context-menu/use-long-press'
import { Button } from '../../components/primitives'
import type { ContextMenuHost, PreviewContext } from '../workspace/context-menu/types'

const PREVIEW_LARGE_DOCUMENT_CHARS = 200_000
const PREVIEW_VERY_LARGE_DOCUMENT_CHARS = 1_000_000
const PREVIEW_LARGE_DOCUMENT_DELAY_MS = 400
const PREVIEW_VERY_LARGE_DOCUMENT_DELAY_MS = 1000
import { TableBubbleLayer } from './table-bubble/TableBubbleLayer'
import { useTableBubble } from './table-bubble/use-table-bubble'
import { joinLines, splitLines } from '../../lib/markdown/fence-edit'
import type { ParsedTable } from '../../lib/markdown/table-editor'
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
  /**
   * A public reading surface. The body is the same renderer and the same live blocks, but nothing
   * here may write to a note or open a vault-only panel: properties are hidden, task boxes stay
   * read-only, and links are handed to the host's resolver instead of the note store.
   */
  readOnly?: boolean
  /** Where a wiki link goes on a public surface. Returning false leaves the link inert. */
  onWikiLink?: (target: ReturnType<typeof parseWikiTarget>) => boolean
  /** Where a tag goes on a public surface. Returning false leaves the tag inert. */
  onTagClick?: (name: string) => boolean
  /** The public page's copy of an attachment, when the host published one. */
  resolveAttachment?: (name: string) => EmbedAttachment | null
  /** Rewrites a vault file URL in the rendered body to the host's public asset URL. */
  rewriteAssetUrl?: (url: string) => string | null
  encryptedAttachments?: boolean
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
  readOnly = false,
  onWikiLink,
  onTagClick,
  resolveAttachment,
  rewriteAssetUrl,
  encryptedAttachments = false,
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
  const { hover, handlePin, onMouseLeave, onFocus, onBlur } = useLinkHoverHost(sourceNoteId ?? null, { enabled: !readOnly })

  // A tab block's remembered choice belongs to this account's reading of this note, so a shared
  // browser does not carry one person's open tab over to the next.
  const tabScope = useMemo(() => ({ noteId: sourceNoteId ?? null, userId: userId ?? null }), [sourceNoteId, userId])


  const renderDelay = content.length > PREVIEW_VERY_LARGE_DOCUMENT_CHARS
    ? PREVIEW_VERY_LARGE_DOCUMENT_DELAY_MS
    : content.length > PREVIEW_LARGE_DOCUMENT_CHARS
      ? PREVIEW_LARGE_DOCUMENT_DELAY_MS
      : DEBOUNCE.render
  const debounced = useDebounced(content, renderDelay)
  const emojiVersion = useEmojiUnicodeVersion()
  const rendered = useMemo(() => renderMarkdown(debounced, { hideFrontMatter: true, emojiShortcodes: preview.emojiShortcodes }), [debounced, locale, preview.emojiShortcodes, emojiVersion])
  const embedContextTitle = rendered.hasEmbeds ? currentTitle : ''
  const committedHtmlRef = useRef('')
  const committedFencesRef = useRef<FenceBodies | null>(null)
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
  const [prepareError, setPrepareError] = useState<string | null>(null)
  const [prepareRetry, setPrepareRetry] = useState(0)
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
  // Charts draw their colours from the accent, which is not a markup input: a theme pass redraws them
  // through its own effect, and the accent needs the same trigger or a switched palette stays on screen.
  const [paletteEpoch, setPaletteEpoch] = useState(0)
  // One scope per preview instance: two panes showing the same note must not claim each other's map.
  const instanceScope = useId()
  const mindmap = useMindmapBlocks({
    scope: `preview${instanceScope}`,
    noteId: sourceNoteId ?? null,
    hostRef,
    epoch: mermaidEpoch,
    dark: theme === 'dark',
    editable: !readOnly,
  })

  useJsonBlocks({
    hostRef,
    epoch: mermaidEpoch,
    context: () => blockActionContext(),
  })

  useExcalidrawBlocks({
    scope: `preview${instanceScope}`,
    noteId: sourceNoteId ?? null,
    hostRef,
    epoch: mermaidEpoch,
    dark: theme === 'dark',
    editable: !readOnly,
  })

  const kanban = useKanbanBlocks({
    scope: noteId ?? 'unsaved',
    noteId: noteId ?? null,
    hostRef,
    committedHtml: kanbanCommit?.html ?? '',
    fences: kanbanCommit?.fences ?? null,
    editable: !readOnly,
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
    const observer = new MutationObserver((records) => {
      const next = document.documentElement.dataset.theme ?? 'dark'
      setTheme((current) => (current === next ? current : next))
      if (records.some((record) => record.attributeName === 'data-accent')) {
        setPaletteEpoch((current) => current + 1)
      }
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] })
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
    void renderPendingMermaid<PreviewViewport | null>(host, {
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
  }, [onRendered, scrollerRef, preview.mermaid])

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
    setPrepareError(null)

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
          allowTarget: readOnly
            ? (target) => {
                if (chatEmbedId(target.noteTitle)) return false
                if (isAttachmentTarget(target.noteTitle)) return Boolean(resolveAttachment)
                return true
              }
            : undefined,
          resolveAttachment: readOnly ? resolveAttachment : undefined,
        })
      }
      if (readOnly && rewriteAssetUrl) rewriteAssetUrls(staging, rewriteAssetUrl)
      if (encryptedAttachments && sourceNoteId) {
        await resolveEncryptedPreviewAttachments(
          staging,
          (attachmentId) => resolveLockedNoteAttachment(sourceNoteId, attachmentId),
          t('notelock.attachment_unavailable'),
        )
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
        // The preview owns the canvas: useExcalidrawBlocks mounts it from the committed markup, so this
        // pass has to leave the placeholder standing rather than swap in source text.
        excalidraw: 'live',
        // A query block is filled by `renderDataviewBlocks` on this host after the diff, because its
        // answer depends on note bodies that may still be on their way — which staging cannot wait for.
        // A public surface has no vault index to answer from, so it shows the query itself.
        dataview: readOnly ? 'source' : 'live',
        dark: theme === 'dark',
        codeBlockCollapseLines: preview.codeBlockCollapse
          ? preview.codeBlockCollapseLines
          : 0,
      })
      // Every block head is built here rather than on the live host so it is part of the markup the
      // preview diffs against; a toolbar added after the swap would be wiped by the next keystroke.
      enhanceBlockToolbars(staging, {
        chart: preview.chart,
        mediaToolbar: preview.mediaToolbar && !readOnly,
        codeFormat: {
          enabled: preview.codeFormatButton && !readOnly,
          tabSize: editorSettings.tabSize,
          keywordCase: editorSettings.codeFormatKeywordCase,
        },
        tabScope,
        jsonView: preview.jsonView,
        jsonFold: preview.jsonFold,
        jsonEditable: preview.jsonEditable && !readOnly,
        jsonTolerant: preview.jsonTolerant,
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
      // Also outside the swap: a drawing's autosave changes only its fence body, and a block mounted into
      // the host resolves that body by walking up from itself to the nearest registered element. The
      // staging copy carries the same set for `patchChildren` above, which compares the two.
      if (hostRef.current) registerFenceBodies(hostRef.current, rendered.fences)
      committedSourceRef.current = debounced
      const markupMoved = nextHtml !== committedHtmlRef.current
      // A board re-mounts on either half moving. The markup string alone cannot tell: with the fence
      // bodies out of the attributes, an autosave leaves it byte-identical.
      const fencesMoved = !committedFencesRef.current || !sameFenceBodies(committedFencesRef.current, rendered.fences)
      if (fencesMoved) committedFencesRef.current = rendered.fences
      if (markupMoved) {
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
      // The epoch used to move on every prepared render, so a pass that changed nothing a block can read
      // still re-walked the host and re-mounted every mind map. Both halves are compared above because the
      // markup string is blind to a fence-body edit.
      if (markupMoved || fencesMoved) setMermaidEpoch((current) => current + 1)
      // A public page has no note to write a tick to. Disabling the boxes says so before the reader
      // clicks; the click guard above is the second half.
      if (readOnly && hostRef.current) {
        for (const input of hostRef.current.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) {
          input.disabled = true
        }
      }
      // Query blocks and inline fields are filled on the live host after the swap, because their answer
      // is a store read that may still be arriving; the guard in `patchChildren` above is what lets the
      // next keystroke keep whatever was already drawn.
      if (hostRef.current && !readOnly) mountDataview(hostRef.current, { originNoteId: sourceNoteId ?? null, editable: false })
      // `<%+ … %>` is the one syntax a note can ask its own preview to run, and this is the only surface that
      // lets it: the share page, an export, a hover card and a chat answer never reach here, so the same text
      // stays source there. Gated on the markup having moved, because the answers already in the DOM are the
      // cache — and on the source mentioning the syntax, so an ordinary note never loads the module at all.
      if (markupMoved && hostRef.current && hasDynamicCommand(debounced)) {
        const row = sourceNoteId ? useNotes.getState().notes[sourceNoteId] : undefined
        if (row) {
          const host = hostRef.current
          // The body the reader is looking at, not the one on the server: a run reads the note as rendered.
          const file = { ...row, content: debounced }
          void import('../templater/dynamic-commands')
            .then((module) => module.processDynamicCommands(host, file))
            .catch((error: unknown) => {
              console.warn('[templater] the preview could not run its dynamic commands', error)
            })
        }
      }
    }
    void prepare().catch((error: unknown) => {
      if (cancelled || revision !== preparationRef.current) return
      console.warn('[inkstone] preview preparation failed', error)
      setPrepareError(error instanceof Error ? error.message : String(error))
    })

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
    readOnly,
    resolveAttachment,
    rewriteAssetUrl,
    encryptedAttachments,
    sourceNoteId,
    locale,
    prepareRetry,
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
  }, [mermaidEpoch, paletteEpoch, startChartRender])


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
    jsonView: preview.jsonView,
    jsonFold: preview.jsonFold,
    jsonEditable: preview.jsonEditable,
    jsonTolerant: preview.jsonTolerant,
  })

  /**
   * The table bubble's write route: the same guard every preview toolbar uses, because rewriting a
   * fence the preview no longer shows would land the edit on a different block. Pure — the hook reads
   * it while rendering to decide whether a table is addressable, and says the "try again" part itself
   * when a press finds the preview behind.
   */
  const tableBubbleTarget = useCallback((): { noteId: string, source: string } | null => {
    if (!sourceNoteId) return null
    if (content !== committedSourceRef.current) return null
    return { noteId: sourceNoteId, source: committedSourceRef.current }
  }, [content, sourceNoteId])

  const tableBubble = useTableBubble({
    hostRef,
    scrollerRef,
    enabled: preview.tableBubbleMenu && Boolean(contextMenu),
    getTarget: tableBubbleTarget,
    onEditContent: editContent,
    onToast: toast,
  })

  const tableBubbleSource = (table: ParsedTable): string => {
    const { lines } = splitLines(tableBubbleTarget()?.source ?? '')
    return lines.slice(table.startLine, table.endLine + 1).join('\n')
  }

  const tableBubbleDelete = (table: ParsedTable) => {
    const target = tableBubbleTarget()
    if (!target) {
      toast({ title: t('preview.the_preview_is_updating_try_again_in_a_moment'), tone: 'warning' })
      return
    }
    const { lines, eol, trailingNewline } = splitLines(target.source)
    lines.splice(table.startLine, table.endLine - table.startLine + 1)
    editContent(target.noteId, joinLines(lines, eol, trailingNewline))
  }

  const copyPreviewText = (text: string) => {
    if (!text) return
    if (!navigator.clipboard?.writeText) {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' })
      return
    }
    void navigator.clipboard.writeText(text).catch(() => toast({ title: t('preview.could_not_copy'), tone: 'danger' }))
  }

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
    if (!contextMenu || readOnly) return
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
      // A published article has no note to write a tick back to, so the box keeps its state.
      if (readOnly) {
        event.preventDefault()
        return
      }

      const checked = checkbox.checked
      const line = Number(checkbox.dataset.taskLine)
      if (Number.isInteger(line) && line >= 0) {
        const committedSource = committedSourceRef.current
        if (content !== committedSource) {
          checkbox.checked = !checked
          toast({ title: t("preview.the_preview_is_updating_try_again_in_a_moment"), tone: 'warning' })
          return
        }
        // The same primitive the editor and the query results use, so a tick here advances the
        // reader's status cycle rather than forcing the box to `x` regardless of what it was.
        // Only the module import is async; the rewrite itself is a pure string function.
        void import('../../lib/tasks/service').then(({ toggleTaskLinesInSource }) => {
          const next = toggleTaskLinesInSource(committedSource, [line])
          if (next === null || !sourceNoteId) {
            checkbox.checked = !checked
            toast({ title: t("preview.could_not_update_this_task"), tone: 'warning' })
            return
          }
          editContent(sourceNoteId, next)
        })
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
      const parsed = parseWikiTarget(decodeDataValue(wikilink.dataset.wikilink))
      if (readOnly) {
        // A public page resolves note links through its host; a heading or block target points
        // inside this very article, so it scrolls exactly as it does in the note app.
        if (parsed.noteTitle) onWikiLink?.(parsed)
        else wikiScrollCleanupRef.current = scrollToWikiTarget(hostRef, parsed, () => true)
        return
      }
      wikiScrollCleanupRef.current()
      const navigation = ++wikiNavigationRef.current
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
      if (readOnly) {
        onTagClick?.(name)
        return
      }
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
        // A heading id is percent-encoded by the renderer, but a hand-written href may hold a bare
        // `%`, which is not a valid escape; falling back to the raw fragment is what a browser does,
        // so a failed decode is not worth reporting.
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
      {prepareError && (
        <div role="alert" className="mb-3 flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--danger)] bg-[var(--bg-surface)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          <span className="min-w-0 flex-1">{t('preview.prepare_failed')}: {prepareError}</span>
          <Button size="sm" variant="secondary" onClick={() => setPrepareRetry((value) => value + 1)}>{t('common.retry')}</Button>
        </div>
      )}
      <div className="pp-prose-column" onMouseMove={hover.handleMouseMove} onMouseLeave={onMouseLeave}>
        {!readOnly && <NoteProperties noteId={sourceNoteId ?? null}/>}
      </div>
      <div
        ref={hostRef}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          if (readOnly) return
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
      {contextMenu && (
        <TableBubbleLayer
          view={tableBubble}
          onJumpToLine={contextMenu.onJumpToLine}
          onCopyText={copyPreviewText}
          tableSource={tableBubbleSource}
          onDeleteTable={tableBubbleDelete}
        />
      )}
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
