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
 * reader is looking at it.
 */

import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft, Check, Copy, FileText, Link2Off, NotebookPen, PanelRight, RefreshCw, TriangleAlert, Trash2, X } from 'lucide-react'
import type { AssistantArtifact } from '@shared/assistant'
import { DEBOUNCE } from '@shared/constants'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { useDebounced, useMediaQuery } from '../../lib/hooks'
import { COPY_RESET_MS } from '../../lib/motion'
import { relativeTime } from '../../lib/time'
import { api } from '../../lib/api'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Input } from '../../components/form'
import { Drawer, confirm } from '../../components/overlay'
import { DeferredCodeEditor } from '../../editor/CodeEditor'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { MarkdownBody } from '../preview/MarkdownBody'
import { useAssistant } from './assistant-store'
import { LoadFailure } from './assistant-settings-shared'
import { CHAT_NOTE_LINKS } from './note-links'
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
  const docked = useMediaQuery(DOCK_QUERY)
  const active = useMemo(() => artifacts.find((entry) => entry.id === activeId) ?? null, [artifacts, activeId])

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
        <IconButton label={t('assistant.canvas.close')} size="sm" className="ml-auto" onClick={() => setOpen(false)}>
          <X size={13} />
        </IconButton>
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
      className="flex h-full w-[min(420px,42vw)] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
    >
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
      <p className="px-5 py-10 text-center text-[length:var(--text-12)] leading-relaxed text-[var(--text-quaternary)]">
        {t('assistant.canvas.empty')}
      </p>
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

function ArtifactEditor({ artifact, onSave, onRemove }: {
  artifact: AssistantArtifact
  onSave: (id: string, patch: { title?: string, content?: string, noteId?: string | null }) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const settings = useSession((state) => state.settings.editor)
  const [title, setTitle] = useState(artifact.title)
  const [content, setContent] = useState(artifact.content)
  const [mode, setMode] = useState<DraftMode>('write')
  const [copied, setCopied] = useState(false)
  const linkedNoteId = artifact.noteId
  const linkedTitle = useNotes((state) => (linkedNoteId ? state.notes[linkedNoteId]?.title ?? null : null))

  // What the server already has. A settled value equal to it is the echo of our own write coming back
  // through the store, and committing it again would be a second request for the same bytes.
  const committed = useRef({ title: artifact.title, content: artifact.content })
  // Whether the reader has typed here. The note read below is in flight from the first paint, and its
  // answer is what the note said *before* they started — so it may say where the body came from, but it
  // must not become the body under their cursor.
  const edited = useRef(false)
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

  // A linked draft opens on the note, not on the copy it was last saved as: the notebook is where the
  // document has been living, and the panel showing a stale copy would invite a write over the top of it.
  useEffect(() => {
    if (!linkedNoteId) {
      setNoteRead(true)
      return
    }
    let alive = true
    setNoteRead(false)
    void loadLinkedNote(artifact.id, linkedNoteId).then((read) => {
      if (!alive) return
      if (read.status === 'ok') {
        setNoteReadFailed(null)
        if (!edited.current) {
          setContent(read.content)
          committed.current = { title: committed.current.title, content: read.content }
        }
      }
      else if (read.status === 'missing') {
        useUi.getState().toast({ title: t('assistant.canvas.note_missing'), tone: 'warning' })
      }
      // No toast here: the panel keeps the reader's text on screen, and the failure has to stay where they
      // can act on it rather than vanish behind a toast they did not ask for.
      else setNoteReadFailed(read.reason)
      setNoteRead(true)
    })
    return () => {
      alive = false
    }
  }, [artifact.id, linkedNoteId, readAttempt])

  useEffect(() => {
    if (!noteRead) return
    if (settled.title === committed.current.title && settled.content === committed.current.content) return
    committed.current = settled
    void (async () => {
      // One writer after the other, draft first: the row is where the body survives a refresh, so a note
      // write that lands before it would leave a conflict in the notebook and the reader's paragraph
      // nowhere but on screen.
      await onSave(artifact.id, settled)
      if (!linkedNoteId) return
      // The note takes the same body: one document, two surfaces. A conflict is reported and the panel
      // keeps the reader's text — losing a paragraph to a silent overwrite is the one outcome to avoid.
      const result = await pushToNote(artifact.id, linkedNoteId, settled.content)
      if (result === 'ok') return
      useUi.getState().toast({
        title: t(result === 'conflict' ? 'assistant.canvas.sync_conflict' : 'assistant.canvas.note_missing'),
        tone: 'warning',
      })
    })()
  }, [settled, artifact.id, onSave, linkedNoteId, noteRead])

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

  const copy = () => {
    void navigator.clipboard?.writeText(content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), COPY_RESET_MS)
  }

  /** File the draft, then remember which note it became — the two are one document from then on. */
  const saveAsNote = async () => {
    const noteId = await saveReplyAsNote(content)
    if (noteId) await onSave(artifact.id, { noteId })
  }

  const pull = async () => {
    if (!linkedNoteId) return
    const read = await pullFromNote(artifact.id, linkedNoteId)
    if (read.status === 'missing') {
      useUi.getState().toast({ title: t('assistant.canvas.note_missing'), tone: 'warning' })
      return
    }
    // The same sentence and the same retry as the read on open: a Load that did not answer is a request
    // worth pressing again, not a note the reader has lost.
    if (read.status === 'failed') {
      setNoteReadFailed(read.reason)
      return
    }
    setNoteReadFailed(null)
    setContent(read.content)
    committed.current = { title: committed.current.title, content: read.content }
    useUi.getState().toast({ title: t('assistant.canvas.pulled'), tone: 'success' })
  }

  const push = async () => {
    if (!linkedNoteId) return
    const result = await pushToNote(artifact.id, linkedNoteId, content)
    useUi.getState().toast({
      title: t(result === 'ok' ? 'assistant.canvas.synced' : result === 'conflict' ? 'assistant.canvas.sync_conflict' : 'assistant.canvas.note_missing'),
      tone: result === 'ok' ? 'success' : 'warning',
    })
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
          <div className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <FileText size={11} className="shrink-0 text-[var(--text-quaternary)]" />
            <span className="min-w-0 truncate">
              {t('assistant.canvas.linked', { title: linkedTitle || t('common.untitled_note') })}
            </span>
            <Button size="sm" variant="ghost" className="ml-auto shrink-0" icon={<RefreshCw size={11} />} onClick={() => void pull()}>
              {t('assistant.canvas.pull_note')}
            </Button>
            <IconButton label={t('assistant.canvas.unlink')} size="sm" onClick={() => void onSave(artifact.id, { noteId: null })}>
              <Link2Off size={11} />
            </IconButton>
          </div>
        )}
        <ModeTabs artifactId={artifact.id} mode={mode} onSelect={setMode} />
      </div>
      {noteReadFailed && (
        <div className="shrink-0 px-2 py-2">
          <LoadFailure
            messageKey="assistant.canvas.note_read_failed"
            detail={noteReadFailed}
            onRetry={() => setReadAttempt((attempt) => attempt + 1)}
          />
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
            placeholder={t('assistant.canvas.placeholder')}
            className="h-full"
          />
        ) : (
          <DraftPreview content={content} />
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

/**
 * The preview, and what it says when it cannot draw.
 *
 * The body is handed to the notebook's own Markdown surface — the one that gives a fence its highlight and
 * its copy button, and a table its wrapper and its rules — under the class that carries those into a narrow
 * panel. `MarkdownBody` builds its markup while it renders, so a document the renderer chokes on is a render
 * error rather than a return value, and the only honest thing left to show the reader is the text they came
 * to read. The boundary resets itself when the text changes: a reader who fixes the Markdown that broke the
 * render should see the fix without closing the panel.
 */
function DraftPreview({ content }: { content: string }) {
  return (
    <PreviewBoundary source={content}>
      <div className="h-full overflow-y-auto px-3 py-2">
        <MarkdownBody source={content} className="ink-chat-prose min-w-0" links={CHAT_NOTE_LINKS} />
      </div>
    </PreviewBoundary>
  )
}

class PreviewBoundary extends Component<{ source: string, children: ReactNode }, { failed: boolean }> {
  state: { failed: boolean } = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Not a silent downgrade: what failed has to reach the console with the document it failed on, or the
    // reader's report of a blank draft has nothing to be traced to.
    console.error('[inkstone] canvas draft preview failed', error, info.componentStack)
  }

  componentDidUpdate(previous: { source: string }): void {
    if (previous.source !== this.props.source && this.state.failed) this.setState({ failed: false })
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 px-3 py-2">
        <p role="alert" className="flex shrink-0 items-start gap-1.5 text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
          <TriangleAlert size={13} className="mt-px shrink-0 text-[var(--warning)]" aria-hidden="true" />
          <span>{t('assistant.canvas.render_failed')}</span>
        </p>
        <pre
          role="region"
          aria-label={t('assistant.canvas.raw_text')}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] bg-[var(--bg-inset)] p-2 font-mono text-[length:var(--text-12)] leading-[var(--code-line)] text-[var(--text-primary)]"
        >
          {this.props.source}
        </pre>
      </div>
    )
  }
}
