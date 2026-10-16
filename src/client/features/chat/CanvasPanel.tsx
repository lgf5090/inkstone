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
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Copy, NotebookPen, PanelRight, Trash2, X } from 'lucide-react'
import type { AssistantArtifact } from '@shared/assistant'
import { DEBOUNCE } from '@shared/constants'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { useDebounced } from '../../lib/hooks'
import { COPY_RESET_MS } from '../../lib/motion'
import { relativeTime } from '../../lib/time'
import { api } from '../../lib/api'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Input } from '../../components/form'
import { confirm } from '../../components/overlay'
import { DeferredCodeEditor } from '../../editor/CodeEditor'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { MarkdownBody } from '../preview/MarkdownBody'
import { useAssistant } from './assistant-store'
import { CHAT_NOTE_LINKS } from './note-links'
import { saveReplyAsNote } from './save-to-note'

/**
 * How many notes and tags the editor's completions may offer.
 *
 * The same ceiling the notebook's own editor uses: the completion list is filtered as the reader types, so
 * handing it the whole vault would only make the first keystroke slower to answer.
 */
const COMPLETION_LIMIT = 300

export function CanvasPanel() {
  const artifacts = useAssistant((state) => state.artifacts)
  const ready = useAssistant((state) => state.artifactsReady)
  const activeId = useAssistant((state) => state.activeArtifactId)
  const setOpen = useAssistant((state) => state.setCanvasOpen)
  const select = useAssistant((state) => state.selectArtifact)
  const save = useAssistant((state) => state.saveArtifact)
  const remove = useAssistant((state) => state.removeArtifact)
  const active = useMemo(() => artifacts.find((entry) => entry.id === activeId) ?? null, [artifacts, activeId])

  return (
    <aside
      aria-label={t('assistant.canvas.title')}
      className="flex h-full w-[min(420px,42vw)] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
    >
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
  onSave: (id: string, patch: { title?: string, content?: string }) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const settings = useSession((state) => state.settings.editor)
  const [title, setTitle] = useState(artifact.title)
  const [content, setContent] = useState(artifact.content)
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [copied, setCopied] = useState(false)

  // What the server already has. A settled value equal to it is the echo of our own write coming back
  // through the store, and committing it again would be a second request for the same bytes.
  const committed = useRef({ title: artifact.title, content: artifact.content })
  const pending = useMemo(() => ({ title, content }), [title, content])
  const settled = useDebounced(pending, DEBOUNCE.persist)
  useEffect(() => {
    if (settled.title === committed.current.title && settled.content === committed.current.content) return
    committed.current = settled
    void onSave(artifact.id, settled)
  }, [settled, artifact.id, onSave])

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
        <div className="flex items-center gap-1" role="tablist" aria-label={t('assistant.canvas.title')}>
          <ModeTab id="write" current={mode} onSelect={setMode} label={t('assistant.canvas.write')} />
          <ModeTab id="preview" current={mode} onSelect={setMode} label={t('assistant.canvas.preview')} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'write' ? (
          <DeferredCodeEditor
            visible
            value={content}
            onChange={setContent}
            settings={settings}
            sources={sources}
            handlers={handlers}
            placeholder={t('assistant.canvas.placeholder')}
            className="h-full"
          />
        ) : (
          <div className="h-full overflow-y-auto px-3 py-2">
            <MarkdownBody source={content} className="ink-chat-prose min-w-0" links={CHAT_NOTE_LINKS} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t border-[var(--border-subtle)] px-2 py-1.5">
        <Button size="sm" variant="ghost" icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={copy}>
          {copied ? t('assistant.canvas.copied') : t('assistant.canvas.copy')}
        </Button>
        <Button size="sm" variant="ghost" icon={<NotebookPen size={12} />} onClick={() => saveReplyAsNote(content)}>
          {t('assistant.canvas.save_note')}
        </Button>
        <IconButton label={t('assistant.canvas.remove')} size="sm" className="ml-auto" onClick={removeDraft}>
          <Trash2 size={13} />
        </IconButton>
      </div>
    </>
  )
}

function ModeTab({ id, current, onSelect, label }: {
  id: 'write' | 'preview'
  current: 'write' | 'preview'
  onSelect: (id: 'write' | 'preview') => void
  label: string
}) {
  const active = current === id
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(id)}
      className={cn(
        'rounded-[var(--r-sm)] px-2 py-0.5 text-[length:var(--text-11)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        active ? 'bg-[var(--bg-inset)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
      )}
    >
      {label}
    </button>
  )
}
