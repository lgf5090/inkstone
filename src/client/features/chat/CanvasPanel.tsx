/**
 * The side panel: the drafts a conversation keeps.
 *
 * A reply is where a document usually starts, and the thread is the wrong place to work on one — a message
 * is a record of what was said, so editing it in place would leave the transcript disagreeing with itself.
 * The panel is where the copy that *is* meant to change lives. It edits with the notebook's own editor
 * rather than a text box, so a `[[link]]` completes and a fence highlights the way they do everywhere else,
 * and the body is drawn back through the same Markdown renderer a note's preview uses.
 *
 * The draft is the panel's own state on the way in and the server's on the way out: keystrokes settle
 * locally and are committed on a debounce, and the title is committed the same way, so a reader typing a
 * paragraph makes one write rather than one per character. It is not synced back into the thread — the
 * reply stays what it was, which is the whole reason the draft is a copy.
 *
 * The preview is the part a reader cannot edit their way out of, so it owes them two things: the document
 * drawn with the notebook's own code blocks, tables and highlight, and — when the renderer cannot produce
 * that — the text itself beside a sentence saying it was not drawn. A panel that goes white on a failed
 * render is indistinguishable from a draft that is empty, and an assistant draft is never empty when the
 * reader is looking at it. Drawing it is `ArtifactBody`'s job; this file is the panel, the draft's two
 * modes, and the writes between them.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowLeft, Check, Copy, FileText, Link2Off, Loader2, NotebookPen, PanelRight, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { AssistantArtifact } from '@shared/assistant'
import { DEBOUNCE } from '@shared/constants'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { useDebounced, useMediaQuery } from '../../lib/hooks'
import { COPY_RESET_MS } from '../../lib/motion'
import { relativeTime } from '../../lib/time'
import { api, ApiError } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Input } from '../../components/form'
import { Drawer, confirm } from '../../components/overlay'
import { DeferredCodeEditor } from '../../editor/CodeEditor'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import type { EditorSelectionInfo } from '../../editor/CodeEditor'
import { ArtifactBody } from './ArtifactBody'
import { ArtifactHistory, HistoryButton } from './ArtifactHistory'
import { CanvasAiPreview } from './CanvasAiPreview'
import { CanvasSelectionBar } from './CanvasSelectionBar'
import { runCanvasAi, type CanvasAiRequest } from './canvas-ai'
import { CANVAS_DEFAULT_WIDTH, CANVAS_MAX_DOCK_WIDTH, CANVAS_MIN_DOCK_WIDTH, CANVAS_WIDTH_KEY, clampCanvasWidth, stepCanvasWidth } from './canvas-width'
import { editorAiAnchor, quotePassage, type EditorAiAction } from './editor-ai'
import { useAssistant } from './assistant-store'
import { LoadFailure } from './assistant-settings-shared'
import { saveReplyAsNote } from './save-to-note'
import { loadLinkedNote, pullFromNote, pushToNote } from './canvas-sync'

/**
 * How many notes and tags the editor's completions may offer.
 *
 * The same ceiling the notebook's own editor uses: the completion list is filtered as the reader types, so
 * handing it the whole vault would only make the first keystroke slower to answer.
 */
const COMPLETION_LIMIT = 300

/**
 * The width the panel docks beside the thread at — Tailwind's own `md`.
 *
 * UI2-03: below it, `w-[min(420px,42vw)]` is not a proportion of anything worth keeping. On a 390px phone
 * the canvas took 164px and the conversation was left with 226px, which is a thread you read in two
 * swipes. So the same content is handed to the drawer the notebook's outline already uses: full-height,
 * dismissed by Escape or its backdrop, and it takes no room from the thread at all.
 */
const DOCK_QUERY = '(min-width: 768px)'

/** The dock's own ceiling, reused as the drawer's width so neither is wider than the panel was. */
const CANVAS_MAX_WIDTH = 420

function storedCanvasWidth(): number {
  const stored = Number(window.localStorage.getItem(CANVAS_WIDTH_KEY))
  return Number.isFinite(stored) && stored > 0
    ? clampCanvasWidth(stored, window.innerWidth)
    : clampCanvasWidth(CANVAS_DEFAULT_WIDTH, window.innerWidth)
}

/** What the panel shows a draft as: the editor the reader types into, or the document they read. */
type DraftMode = 'write' | 'preview'

export function CanvasPanel() {
  const artifacts = useAssistant((state) => state.artifacts)
  const ready = useAssistant((state) => state.artifactsReady)
  const activeId = useAssistant((state) => state.activeArtifactId)
  const setOpen = useAssistant((state) => state.setCanvasOpen)
  const select = useAssistant((state) => state.selectArtifact)
  const save = useAssistant((state) => state.saveArtifact)
  const remove = useAssistant((state) => state.removeArtifact)
  const createDraft = useAssistant((state) => state.createDraft)
  const docked = useMediaQuery(DOCK_QUERY)
  const active = useMemo(() => artifacts.find((entry) => entry.id === activeId) ?? null, [artifacts, activeId])
  const [width, setWidth] = useState(storedCanvasWidth)
  const widthRef = useRef(width)
  widthRef.current = width
  const drag = useRef<{ startX: number, startWidth: number } | null>(null)

  const rememberWidth = (next: number): void => {
    try {
      window.localStorage.setItem(CANVAS_WIDTH_KEY, String(next))
    } catch (error) {
      // Storage can be unavailable (private mode, a blocked origin). The width still works for this
      // session; losing it on reload is not worth a visible failure.
      console.warn('[inkstone] could not remember the canvas width', error)
    }
  }

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = { startX: event.clientX, startWidth: widthRef.current }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (!current) return
    setWidth(clampCanvasWidth(current.startWidth + (current.startX - event.clientX), window.innerWidth))
  }

  const onResizeEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    drag.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    rememberWidth(widthRef.current)
  }

  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0
    let next: number | null = null
    if (delta) next = stepCanvasWidth(width, delta, window.innerWidth)
    else if (event.key === 'Home') next = clampCanvasWidth(CANVAS_MIN_DOCK_WIDTH, window.innerWidth)
    else if (event.key === 'End') next = clampCanvasWidth(CANVAS_MAX_DOCK_WIDTH, window.innerWidth)
    if (next === null) return
    event.preventDefault()
    setWidth(next)
    rememberWidth(next)
  }

  const label = t('assistant.canvas.title')
  const body = (
    <>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2">
        {active ? (
          <IconButton label={t('assistant.canvas.back')} size="sm" onClick={() => select(null)}>
            <ArrowLeft size={13} />
          </IconButton>
        ) : (
          <PanelRight size={13} className="ml-1 shrink-0 text-[var(--text-quaternary)]" />
        )}
        <span className="min-w-0 truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {active ? (active.title || t('assistant.canvas.untitled')) : t('assistant.canvas.drafts')}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {!active && (
            <IconButton label={t('assistant.canvas.new')} size="sm" onClick={() => void createDraft()}>
              <Plus size={13} />
            </IconButton>
          )}
          <IconButton label={t('assistant.canvas.close')} size="sm" onClick={() => setOpen(false)}>
            <X size={13} />
          </IconButton>
        </div>
      </div>
      {active
        ? <ArtifactEditor key={active.id} artifact={active} onSave={save} onRemove={remove} />
        : <ArtifactList artifacts={artifacts} ready={ready} onSelect={select} />}
    </>
  )

  // The chat mounts this panel only while `canvasOpen` holds, so closing the drawer *is* clearing the flag:
  // the panel unmounts with it, and the drawer's own trap returns the focus to the toggle that opened it.
  if (!docked) {
    return (
      <Drawer open onClose={() => setOpen(false)} side="right" width={CANVAS_MAX_WIDTH} ariaLabel={label}>
        <div className="flex h-full min-h-0 flex-1 flex-col">{body}</div>
      </Drawer>
    )
  }

  return (
    <aside
      aria-label={label}
      data-canvas-dock="1"
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('assistant.canvas.resize')}
        aria-valuenow={Math.round(width)}
        aria-valuemin={CANVAS_MIN_DOCK_WIDTH}
        aria-valuemax={CANVAS_MAX_DOCK_WIDTH}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onKeyDown={onResizeKey}
        className="absolute inset-y-0 left-0 z-[var(--z-sticky)] w-1 cursor-col-resize touch-none transition-colors duration-[var(--dur-fast)] hover:bg-[var(--accent)] focus-visible:bg-[var(--accent)] focus-visible:outline-none"
      />
      {body}
    </aside>
  )
}

function ArtifactList({ artifacts, ready, onSelect }: {
  artifacts: AssistantArtifact[]
  ready: boolean
  onSelect: (id: string) => void
}) {
  if (!ready) {
    return <div className="flex flex-1 items-center justify-center"><Spinner /></div>
  }
  if (!artifacts.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-10 text-center">
        <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-quaternary)]">
          {t('assistant.canvas.empty')}
        </p>
        <NewDraftButton />
      </div>
    )
  }
  return (
    <nav aria-label={t('assistant.canvas.drafts')} className="min-h-0 flex-1 overflow-y-auto p-1.5">
      <ul className="flex flex-col gap-px">
        {artifacts.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onSelect(entry.id)}
              className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-[var(--bg-hover)]"
            >
              <span className="w-full min-w-0 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">
                {entry.title || t('assistant.canvas.untitled')}
              </span>
              <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{relativeTime(entry.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type SyncState = 'synced' | 'syncing' | 'diverged' | 'failed'

/** The one control an empty panel offers: start a document rather than explaining why there is none. */
function NewDraftButton() {
  const createDraft = useAssistant((state) => state.createDraft)
  return (
    <Button size="sm" variant="secondary" icon={<Plus size={12} />} onClick={() => void createDraft()}>
      {t('assistant.canvas.new')}
    </Button>
  )
}

function ArtifactEditor({ artifact, onSave, onRemove }: {
  artifact: AssistantArtifact
  onSave: (
    id: string,
    patch: { title?: string, content?: string, noteId?: string | null },
    options?: { baseVersion?: number, source?: 'user' | 'assistant', messageId?: string | null },
  ) => Promise<AssistantArtifact>
  onRemove: (id: string) => Promise<void>
}) {
  const settings = useSession((state) => state.settings.editor)
  const [title, setTitle] = useState(artifact.title)
  const [content, setContent] = useState(artifact.content)
  const [mode, setMode] = useState<DraftMode>('write')
  const [copied, setCopied] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selection, setSelection] = useState<EditorSelectionInfo | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiResult, setAiResult] = useState<{ request: CanvasAiRequest, answer: string, messageId: string | null } | null>(null)
  const stop = useAssistant((state) => state.stop)
  const [retryTick, setRetryTick] = useState(0)
  const [conflict, setConflict] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>(artifact.noteId ? 'syncing' : 'synced')
  // The "Copied" countdown, held so that closing the panel takes the timer with the button it was drawn
  // on rather than leaving it to run against a surface the reader already walked away from.
  const copyTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])
  const linkedNoteId = artifact.noteId
  const linkedTitle = useNotes((state) => (linkedNoteId ? state.notes[linkedNoteId]?.title ?? null : null))

  // What the server already has. A settled value equal to it is the echo of our own write coming back
  // through the store, and committing it again would be a second request for the same bytes.
  const committed = useRef({ title: artifact.title, content: artifact.content })
  // The version this editor's text is based on. Every write names it so the server can refuse a save
  // that would replace a version the reader has not seen.
  const baseVersion = useRef(artifact.version)
  // The last version this editor wrote, so the store echoing it back is not mistaken for someone else's.
  const ownVersion = useRef<number | null>(null)
  // Whether the reader has typed here. The note read below is in flight from the first paint, and its
  // answer is what the note said *before* they started — so it may say where the body came from, but it
  // must not become the body under their cursor.
  const edited = useRef(false)
  // The version whose content the editor has already accounted for. Bumped on our own save and on an
  // external version the editor adopted, so the adoption effect does not run twice for one row.
  const seenVersion = useRef(artifact.version)
  // One writer at a time. Two saves in the air would both carry the same base version, and the second
  // would come back as a conflict created by this editor itself.
  const inFlight = useRef(false)
  const saveSeq = useRef(0)
  // The order the two writers of one document have to keep: nothing is committed until the linked note
  // has been read. A write that jumped the queue had no baseline to be checked against, so it either
  // reported a note that had not moved as a conflict or, when the note was open in the notebook,
  // overwrote it with the copy this draft was saved as.
  const [noteRead, setNoteRead] = useState(!linkedNoteId)
  // A read that did not answer, with what the request said. Distinct from a note that is gone: this one is
  // worth asking again, and the panel that says nothing has simply lost the reader's document.
  const [noteReadFailed, setNoteReadFailed] = useState<string | null>(null)
  // Bumped by the retry: the read below is the effect's own work, so asking again is asking the effect.
  const [readAttempt, setReadAttempt] = useState(0)
  const pending = useMemo(() => ({ title, content }), [title, content])
  const settled = useDebounced(pending, DEBOUNCE.persist)
  // What the reader last typed, read after a save settles: the save in flight used an older snapshot,
  // and if the text moved again while it was away the new snapshot is what has to go out next.
  const latest = useRef(settled)
  latest.current = settled

  // A linked draft no longer opens on the note. The draft may be an assistant edit written while the panel
  // was closed, and the note may have moved in the notebook: copying either over the other would silently
  // discard the other side's work. The read is still needed before the first write, and what it finds is
  // said as a divergence the reader resolves.
  useEffect(() => {
    if (!linkedNoteId) {
      setNoteRead(true)
      setSyncState('synced')
      return
    }
    let alive = true
    setNoteRead(false)
    setSyncState('syncing')
    void loadLinkedNote(artifact.id, linkedNoteId).then((read) => {
      if (!alive) return
      if (read.status === 'ok') {
        setNoteReadFailed(null)
        // The reader's own edits will be pushed when the read clears the gate; only a clean editor can
        // say the two documents have parted ways.
        setSyncState(!edited.current && read.content !== committed.current.content ? 'diverged' : 'synced')
      }
      else if (read.status === 'missing') {
        useUi.getState().toast({ title: t('assistant.canvas.note_missing'), tone: 'warning' })
        setSyncState('failed')
      }
      // No toast here: the panel keeps the reader's text on screen, and the failure has to stay where they
      // can act on it rather than vanish behind a toast they did not ask for.
      else {
        setNoteReadFailed(read.reason)
        setSyncState('failed')
      }
      setNoteRead(true)
    })
    return () => {
      alive = false
    }
  }, [artifact.id, linkedNoteId, readAttempt])

  // An external version, or the echo of our own save. A clean editor adopts it; a dirty one keeps the
  // reader's words and asks which side wins. This is the half of "the model writes the draft" that keeps
  // a keystroke from silently overwriting what the model just wrote.
  useEffect(() => {
    if (artifact.version === seenVersion.current) return
    seenVersion.current = artifact.version
    baseVersion.current = artifact.version
    const ownEcho = artifact.version === ownVersion.current
    const localMatchesIncoming = artifact.title === title && artifact.content === content
    const clean = localMatchesIncoming || (title === committed.current.title && content === committed.current.content)
    if (!clean) {
      setConflict(true)
      return
    }
    setTitle(artifact.title)
    setContent(artifact.content)
    edited.current = false
    committed.current = { title: artifact.title, content: artifact.content }
    setSaveState('saved')
    setConflict(false)
    if (!ownEcho && !localMatchesIncoming) {
      if (linkedNoteId) setSyncState('diverged')
      useUi.getState().toast({ title: t('assistant.canvas.loaded_new_version'), tone: 'success' })
    }
  }, [artifact.version, artifact.title, artifact.content, linkedNoteId, title, content])

  useEffect(() => {
    if (!noteRead || inFlight.current) return
    if (settled.title === committed.current.title && settled.content === committed.current.content) return
    const seq = ++saveSeq.current
    const snapshot = settled
    let savedOk = false
    inFlight.current = true
    setSaveState('saving')
    setSaveError(null)
    void (async () => {
      try {
        // Draft first: the row is where the body survives a refresh, so a note write that lands before it
        // would leave a conflict in the notebook and the reader's paragraph nowhere but on screen.
        const saved = await onSave(artifact.id, snapshot, { baseVersion: baseVersion.current, source: 'user' })
        if (seq !== saveSeq.current) return
        savedOk = true
        ownVersion.current = saved.version
        seenVersion.current = saved.version
        baseVersion.current = saved.version
        committed.current = snapshot
        setSaveState('saved')
        setConflict(false)
        if (!linkedNoteId) return
        // The note takes the same body: one document, two surfaces. A conflict is reported and the panel
        // keeps the reader's text — losing a paragraph to a silent overwrite is the one outcome to avoid.
        setSyncState('syncing')
        const result = await pushToNote(artifact.id, linkedNoteId, snapshot.content)
        if (seq !== saveSeq.current) return
        if (result === 'ok') {
          setSyncState('synced')
          return
        }
        setSyncState('failed')
        useUi.getState().toast({
          title: t(result === 'conflict' ? 'assistant.canvas.sync_conflict' : 'assistant.canvas.note_missing'),
          tone: 'warning',
        })
      } catch (error) {
        if (seq !== saveSeq.current) return
        setSaveState('error')
        setSaveError(error instanceof Error ? error.message : String(error))
        if (error instanceof ApiError && error.status === 409) {
          setConflict(true)
          void useAssistant.getState().loadArtifacts()
        }
      } finally {
        inFlight.current = false
        // The reader kept typing while the save was away. The next snapshot has to go out with the version
        // that save just produced, so it waits for this one rather than racing it.
        if (savedOk && (latest.current.title !== committed.current.title || latest.current.content !== committed.current.content)) {
          setRetryTick((tick) => tick + 1)
        }
      }
    })()
  }, [settled, artifact.id, onSave, linkedNoteId, noteRead, retryTick])

  /**
   * Save the editor's current text now, on the version it is based on.
   *
   * Used by the two explicit conflict choices: keeping the reader's text over an incoming version names
   * the incoming version as the baseline; a retry names whatever the editor last knew. The incoming
   * version is not deleted either way — it is still in history.
   */
  const commitLocal = async (base = baseVersion.current) => {
    if (inFlight.current) return
    inFlight.current = true
    setSaveState('saving')
    setSaveError(null)
    try {
      const saved = await onSave(artifact.id, { title, content }, { baseVersion: base, source: 'user' })
      ownVersion.current = saved.version
      seenVersion.current = saved.version
      baseVersion.current = saved.version
      committed.current = { title, content }
      setSaveState('saved')
      setConflict(false)
      if (linkedNoteId) {
        setSyncState('syncing')
        const result = await pushToNote(artifact.id, linkedNoteId, content)
        setSyncState(result === 'ok' ? 'synced' : 'failed')
      }
    } catch (error) {
      setSaveState('error')
      setSaveError(error instanceof Error ? error.message : String(error))
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true)
        void useAssistant.getState().loadArtifacts()
      }
    } finally {
      inFlight.current = false
    }
  }

  // The editor completes `[[links]]` and `#tags` from the vault, the same two sources the notebook's own
  // editor is given. The upload handler drops a pasted file into the reader's library; a draft has no note
  // to attach it to, so the attachment is stored unfiled and linked by URL like any other.
  const sources = useMemo(() => ({
    notes: () => Object.values(useNotes.getState().notes ?? {})
      .filter((note) => !note.deletedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, COMPLETION_LIMIT)
      .map((note) => ({ id: note.id, title: note.title, excerpt: note.excerpt })),
    tags: () => useNotes.getState().tags.map((tag) => ({ name: tag.name, count: tag.count })),
  }), [])
  const handlers = useMemo(() => ({
    uploadFile: async (file: File) => {
      try {
        const uploaded = await api.files.upload(file)
        return { url: uploaded.url, filename: uploaded.filename, isImage: uploaded.mime.startsWith('image/') }
      } catch (error) {
        useUi.getState().toast({
          title: t('workspace.upload_failed'),
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        })
        return null
      }
    },
  }), [])

  /**
   * Copies the whole draft, and says which of the two things just happened.
   *
   * `copyText` answers whether the clipboard took the text — it has the legacy path for a plain-http
   * install, where `navigator.clipboard` is not offered at all — so a press that claimed success whatever
   * it did would be a lie about a paste the reader is about to make somewhere else, and they would only
   * find out there.
   */
  const copy = () => {
    void copyText(content).then((taken) => {
      if (!taken) {
        useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
        return
      }
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
      }, COPY_RESET_MS)
    })
  }

  /**
   * One action from the selection bar.
   *
   * `ask` is the one action whose question the reader writes, so it seeds the composer and stops there.
   * The rest become a chat turn; the answer is not written back until the reader has seen the diff.
   */
  const onSelectionAction = (action: EditorAiAction): void => {
    if (!selection) return
    if (action === 'ask') {
      useAssistant.getState().seedComposer(quotePassage(selection.text))
      setSelection(null)
      return
    }
    const request: CanvasAiRequest = {
      artifactId: artifact.id,
      version: artifact.version,
      title,
      action,
      from: selection.from,
      to: selection.to,
      source: selection.text,
      anchor: editorAiAnchor(content, selection.from, selection.to),
    }
    setSelection(null)
    setAiBusy(true)
    setAiError(null)
    void runCanvasAi(request)
      .then((result) => {
        if (result.status === 'ok') {
          setAiResult({ request, answer: result.text, messageId: result.messageId ?? null })
          return
        }
        if (result.status === 'busy') setAiError(t('assistant.canvas.ai_busy_other'))
        else if (result.status === 'failed') setAiError(result.error || t('assistant.canvas.ai_failed'))
        else setAiError(t('assistant.canvas.ai_empty'))
      })
      .finally(() => setAiBusy(false))
  }

  /**
   * Write the previewed text into the draft.
   *
   * The content is updated before the request and `committed` moves with it, so the debounce does not
   * fire a second, user-sourced save for the same words. A failed save puts the baseline back and lets
   * the panel's error line own the retry.
   */
  const applyAiResult = async (next: string, messageId: string | null): Promise<void> => {
    const previous = committed.current
    setAiResult(null)
    setContent(next)
    edited.current = true
    committed.current = { title, content: next }
    try {
      const saved = await onSave(
        artifact.id,
        { content: next },
        { baseVersion: artifact.version, source: 'assistant', messageId },
      )
      ownVersion.current = saved.version
      seenVersion.current = saved.version
      baseVersion.current = saved.version
      setSaveState('saved')
      setConflict(false)
      useUi.getState().toast({ title: t('assistant.canvas.ai_applied'), tone: 'success' })
    } catch (error) {
      committed.current = previous
      reportSaveError(error)
    }
  }

  const reportSaveError = (error: unknown) => {
    setSaveState('error')
    setSaveError(error instanceof Error ? error.message : String(error))
    if (error instanceof ApiError && error.status === 409) {
      setConflict(true)
      void useAssistant.getState().loadArtifacts()
    }
  }

  /** File the draft, then remember which note it became — the two are one document from then on. */
  const saveAsNote = async () => {
    const noteId = await saveReplyAsNote(content)
    if (!noteId) return
    try {
      const saved = await onSave(artifact.id, { noteId }, { baseVersion: baseVersion.current })
      ownVersion.current = saved.version
      seenVersion.current = saved.version
      baseVersion.current = saved.version
      setSyncState('synced')
    } catch (error) {
      reportSaveError(error)
    }
  }

  const pull = async () => {
    if (!linkedNoteId) return
    const read = await pullFromNote(artifact.id, linkedNoteId)
    if (read.status === 'missing') {
      useUi.getState().toast({ title: t('assistant.canvas.note_missing'), tone: 'warning' })
      setSyncState('failed')
      return
    }
    // The same sentence and the same retry as the read on open: a Load that did not answer is a request
    // worth pressing again, not a note the reader has lost.
    if (read.status === 'failed') {
      setNoteReadFailed(read.reason)
      setSyncState('failed')
      return
    }
    setNoteReadFailed(null)
    try {
      const saved = await onSave(artifact.id, { content: read.content }, { baseVersion: baseVersion.current, source: 'user' })
      ownVersion.current = saved.version
      seenVersion.current = saved.version
      baseVersion.current = saved.version
      committed.current = { title: committed.current.title, content: read.content }
      setContent(read.content)
      setSaveState('saved')
      setConflict(false)
      setSyncState('synced')
      useUi.getState().toast({ title: t('assistant.canvas.pulled'), tone: 'success' })
    } catch (error) {
      reportSaveError(error)
    }
  }

  const push = async () => {
    if (!linkedNoteId) return
    try {
      // Save first, so the row the note is compared against and the words sent to it are the same.
      const saved = await onSave(artifact.id, { title, content }, { baseVersion: baseVersion.current, source: 'user' })
      ownVersion.current = saved.version
      seenVersion.current = saved.version
      baseVersion.current = saved.version
      committed.current = { title, content }
      setSaveState('saved')
      setConflict(false)
    } catch (error) {
      reportSaveError(error)
      return
    }
    setSyncState('syncing')
    const result = await pushToNote(artifact.id, linkedNoteId, content)
    setSyncState(result === 'ok' ? 'synced' : 'failed')
    useUi.getState().toast({
      title: t(result === 'ok' ? 'assistant.canvas.synced' : result === 'conflict' ? 'assistant.canvas.sync_conflict' : 'assistant.canvas.note_missing'),
      tone: result === 'ok' ? 'success' : 'warning',
    })
  }

  const unlink = async () => {
    try {
      const saved = await onSave(artifact.id, { noteId: null }, { baseVersion: baseVersion.current })
      ownVersion.current = saved.version
      seenVersion.current = saved.version
      baseVersion.current = saved.version
      setSyncState('synced')
    } catch (error) {
      reportSaveError(error)
    }
  }

  /** Take the incoming version, discarding the local text — the reader's explicit choice in the banner. */
  const adoptNew = () => {
    setTitle(artifact.title)
    setContent(artifact.content)
    edited.current = false
    committed.current = { title: artifact.title, content: artifact.content }
    baseVersion.current = artifact.version
    seenVersion.current = artifact.version
    setConflict(false)
    setSaveState('saved')
    setSyncState(linkedNoteId ? 'diverged' : 'synced')
  }

  /** Keep the local text over the incoming version; the incoming one stays restorable in history. */
  const keepMine = () => {
    void commitLocal(artifact.version)
  }

  const saveAsNew = () => {
    void useAssistant.getState().createArtifactFromReply(content)
    setConflict(false)
  }

  const removeDraft = () => {
    void confirm({
      title: t('assistant.canvas.remove_title'),
      description: t('assistant.canvas.remove_hint'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    }).then((agreed) => {
      if (agreed) void onRemove(artifact.id)
    })
  }

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--border-subtle)] px-2 py-2">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('assistant.canvas.title_placeholder')}
          aria-label={t('assistant.canvas.title_placeholder')}
          className="h-8 text-[length:var(--text-12-5)]"
        />
        {linkedNoteId && (
          <div className="flex flex-wrap items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <FileText size={11} className="shrink-0 text-[var(--text-quaternary)]" />
            <span className="min-w-0 truncate">
              {t('assistant.canvas.linked', { title: linkedTitle || t('common.untitled_note') })}
            </span>
            {syncState === 'syncing' && (
              <span className="shrink-0 text-[var(--text-quaternary)]">{t('assistant.canvas.syncing')}</span>
            )}
            {syncState === 'failed' && (
              <span className="shrink-0 text-[var(--warning)]">{t('assistant.canvas.sync_failed')}</span>
            )}
            <Button size="sm" variant="ghost" className="ml-auto shrink-0" icon={<RefreshCw size={11} />} onClick={() => void pull()}>
              {t('assistant.canvas.pull_note')}
            </Button>
            <IconButton label={t('assistant.canvas.unlink')} size="sm" onClick={() => void unlink()}>
              <Link2Off size={11} />
            </IconButton>
          </div>
        )}
        <div className="flex items-center gap-2">
          <ModeTabs
            artifactId={artifact.id}
            mode={mode}
            onSelect={(next) => {
              setMode(next)
              if (next !== 'write') setSelection(null)
            }}
          />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <HistoryButton onOpen={() => { setSelection(null); setHistoryOpen(true) }} />
            <span aria-live="polite" className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {saveState === 'saving'
                ? t('assistant.canvas.saving')
                : saveState === 'saved'
                  ? t('assistant.canvas.saved')
                  : saveState === 'error'
                    ? t('assistant.canvas.unsaved')
                    : null}
            </span>
            {saveState === 'error' && !conflict && (
              <button
                type="button"
                onClick={() => setRetryTick((tick) => tick + 1)}
                className="shrink-0 text-[length:var(--text-10-5)] font-medium text-[var(--accent-on-soft)] hover:underline"
              >
                {t('assistant.canvas.retry_save')}
              </button>
            )}
          </div>
        </div>
      </div>
      {linkedNoteId && syncState === 'diverged' && (
        <div role="status" className="shrink-0 border-b border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] px-2 py-1.5">
          <p className="text-[length:var(--text-11-5)] font-medium text-[var(--text-primary)]">{t('assistant.canvas.diverged')}</p>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('assistant.canvas.diverged_hint')}</p>
        </div>
      )}
      {conflict && (
        <div role="alert" className="shrink-0 border-b border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] px-2 py-1.5">
          <p className="text-[length:var(--text-11-5)] font-medium text-[var(--text-primary)]">{t('assistant.canvas.conflict_title')}</p>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('assistant.canvas.conflict_hint')}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Button size="sm" variant="secondary" onClick={adoptNew}>{t('assistant.canvas.adopt')}</Button>
            <Button size="sm" variant="secondary" onClick={keepMine}>{t('assistant.canvas.overwrite')}</Button>
            <Button size="sm" variant="ghost" onClick={saveAsNew}>{t('assistant.canvas.save_as_new')}</Button>
          </div>
        </div>
      )}
      {saveState === 'error' && saveError && (
        <div role="alert" className="shrink-0 border-b border-[var(--border-subtle)] px-2 py-1.5">
          <p className="text-[length:var(--text-11)] text-[var(--danger)]">{t('assistant.canvas.save_failed')}</p>
          <p className="mt-0.5 break-words text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{saveError}</p>
        </div>
      )}
      {noteReadFailed && (
        <div className="shrink-0 px-2 py-2">
          <LoadFailure
            messageKey="assistant.canvas.note_read_failed"
            detail={noteReadFailed}
            onRetry={() => setReadAttempt((attempt) => attempt + 1)}
          />
        </div>
      )}
      {(aiBusy || aiError) && (
        <div
          role={aiError ? 'alert' : 'status'}
          className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-2 py-1.5"
        >
          {aiBusy ? (
            <>
              <Loader2 size={12} className="shrink-0 animate-spin text-[var(--text-quaternary)]" />
              <span className="min-w-0 flex-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.canvas.ai_busy')}</span>
              <button
                type="button"
                onClick={stop}
                className="shrink-0 text-[length:var(--text-11)] font-medium text-[var(--accent-on-soft)] hover:underline"
              >
                {t('assistant.canvas.ai_stop')}
              </button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 text-[length:var(--text-11)] leading-relaxed text-[var(--warning)]">{aiError}</span>
              <IconButton label={t('assistant.edit.dismiss')} size="sm" onClick={() => setAiError(null)}>
                <X size={12} />
              </IconButton>
            </>
          )}
        </div>
      )}
      <div
        role="tabpanel"
        id={modePanelId(artifact.id, mode)}
        aria-labelledby={modeTabId(artifact.id, mode)}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {mode === 'write' ? (
          <DeferredCodeEditor
            visible
            value={content}
            onChange={(next) => {
              edited.current = true
              setContent(next)
            }}
            settings={settings}
            sources={sources}
            handlers={handlers}
            onSelectionChange={setSelection}
            placeholder={t('assistant.canvas.placeholder')}
            className="h-full"
          />
        ) : (
          <ArtifactBody content={content} title={title} />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t border-[var(--border-subtle)] px-2 py-1.5">
        <Button size="sm" variant="ghost" icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={copy}>
          {copied ? t('assistant.canvas.copied') : t('assistant.canvas.copy')}
        </Button>
        {linkedNoteId ? (
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void push()}>
            {t('assistant.canvas.sync_note')}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon={<NotebookPen size={12} />} onClick={() => void saveAsNote()}>
            {t('assistant.canvas.save_note')}
          </Button>
        )}
        <IconButton label={t('assistant.canvas.remove')} size="sm" className="ml-auto" onClick={removeDraft}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      {mode === 'write' && selection && !historyOpen && !aiResult && (
        <CanvasSelectionBar
          selection={selection}
          onAction={onSelectionAction}
          onDismiss={() => setSelection(null)}
        />
      )}
      {aiResult && (
        <CanvasAiPreview
          request={aiResult.request}
          answer={aiResult.answer}
          content={content}
          saving={saveState === 'saving'}
          onClose={() => setAiResult(null)}
          onApply={(next) => void applyAiResult(next, aiResult.messageId)}
        />
      )}
      {historyOpen && <ArtifactHistory artifact={artifact} onClose={() => setHistoryOpen(false)} />}
    </>
  )
}

/**
 * The DOM names of one draft's two modes.
 *
 * A tab and the region it shows are only the same control to a screen reader when they name each other,
 * and two drafts open in this panel in sequence would collide on a bare `canvas-write` id.
 */
const modeTabId = (artifactId: string, mode: DraftMode): string => `canvas-mode-tab-${artifactId}-${mode}`
const modePanelId = (artifactId: string, mode: DraftMode): string => `canvas-mode-panel-${artifactId}-${mode}`

const MODE_ORDER: readonly DraftMode[] = ['write', 'preview']
const MODE_KEYS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/**
 * The two modes, as the single control they are.
 *
 * A tab pair is one stop in the tab sequence — the mode that is showing — and the arrows move between the
 * two. Without that, Tab lands on a tab that is not selected and the reader has to activate it just to find
 * out what it does; and without the ids naming each other, `role="tab"` is a decoration: a screen reader
 * announces "selected, 1 of 2" and never says which region the selection belongs to.
 */
function ModeTabs({ artifactId, mode, onSelect }: {
  artifactId: string
  mode: DraftMode
  onSelect: (mode: DraftMode) => void
}) {
  const refs = useRef(new Map<DraftMode, HTMLButtonElement | null>())

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = MODE_ORDER.indexOf(mode)
    const last = MODE_ORDER.length - 1
    const step = MODE_KEYS[event.key]
    if (step === undefined && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next = event.key === 'Home'
      ? MODE_ORDER[0]!
      : event.key === 'End'
        ? MODE_ORDER[last]!
        : MODE_ORDER[(index + step! + MODE_ORDER.length) % MODE_ORDER.length]!
    if (next !== mode) onSelect(next)
    refs.current.get(next)?.focus()
  }

  return (
    <div role="tablist" aria-label={t('assistant.canvas.modes')} className="flex items-center gap-1" onKeyDown={onKeyDown}>
      {MODE_ORDER.map((id) => {
        const active = id === mode
        return (
          <button
            key={id}
            ref={(node) => { refs.current.set(id, node) }}
            type="button"
            role="tab"
            id={modeTabId(artifactId, id)}
            aria-selected={active}
            aria-controls={modePanelId(artifactId, id)}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(id)}
            className={cn(
              'rounded-[var(--r-sm)] px-2 py-0.5 text-[length:var(--text-11)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              active ? 'bg-[var(--bg-inset)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
            )}
          >
            {t(id === 'write' ? 'assistant.canvas.write' : 'assistant.canvas.preview')}
          </button>
        )
      })}
    </div>
  )
}
