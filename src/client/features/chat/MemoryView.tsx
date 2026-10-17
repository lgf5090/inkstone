/**
 * What the assistant remembers, and what it is unsure about.
 *
 * The list is grouped by category because a reader scanning "where do I think I live" reads by topic,
 * not by the order things happened to be saved. The four row actions are the interesting part: an
 * update that changes a fact keeps the old one as history rather than overwriting it, so "what did I
 * used to say" still answers — and a plain edit stays a plain edit, for fixing a typo.
 */
import { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, GitCompare, History, NotebookPen, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { AssistantMemory } from '@shared/assistant'
import { ASSISTANT_MEMORY_CATEGORIES } from '@shared/assistant'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { useDebounced } from '../../lib/hooks'
import { Badge, Button, IconButton, Spinner } from '../../components/primitives'
import { Field, Input, Segmented, Select, Textarea } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { AssistantHeader } from './AssistantHeader'
import { LoadFailure } from './assistant-settings-shared'
import { useAssistant } from './assistant-store'
import { useNotes } from '../../store/notes'
import { navigateToPath } from '../../lib/app-history'
import { folderPathLabel } from '../../lib/folders'

const CATEGORY_LABELS: Record<string, () => string> = {
  preference: () => t('assistant.memory.category.preference'),
  fact: () => t('assistant.memory.category.fact'),
  goal: () => t('assistant.memory.category.goal'),
  habit: () => t('assistant.memory.category.habit'),
  person: () => t('assistant.memory.category.person'),
  place: () => t('assistant.memory.category.place'),
  other: () => t('assistant.memory.category.other'),
}

/**
 * Why the rules flagged this pair. The server stores a stable code, never prose, so the sentence is
 * the interface's own — and an unknown code (a model-written reason, or a rule this build does not
 * have) still says something true rather than printing a raw key.
 */
function reasonText(reason: string): string {
  if (reason.startsWith('both_about:')) {
    return t('assistant.memory.reason_both_about', { topic: reason.slice('both_about:'.length) })
  }
  const known: Record<string, 'assistant.memory.reason_names_change' | 'assistant.memory.reason_adds_detail'> = {
    names_change: 'assistant.memory.reason_names_change',
    adds_detail: 'assistant.memory.reason_adds_detail',
  }
  const key = known[reason]
  return key ? t(key) : t('assistant.memory.reason_generic')
}

const FILTERS = [
  { value: 'all', label: 'assistant.memory.filter_all' },
  { value: 'active', label: 'assistant.memory.filter_current' },
  { value: 'historical', label: 'assistant.memory.filter_past' },
  { value: 'review', label: 'assistant.memory.filter_review' },
] as const

export function MemoryView() {
  const memories = useAssistant((state) => state.memories)
  const counts = useAssistant((state) => state.memoryCounts)
  const total = useAssistant((state) => state.memoryTotal)
  const query = useAssistant((state) => state.memoryQuery)
  const status = useAssistant((state) => state.memoryStatus)
  const reviews = useAssistant((state) => state.reviews)
  const setFilter = useAssistant((state) => state.setMemoryFilter)
  const loadMemories = useAssistant((state) => state.loadMemories)
  const removeMemory = useAssistant((state) => state.removeMemory)
  const setStatus = useAssistant((state) => state.setMemoryStatus)
  const resolveReview = useAssistant((state) => state.resolveReview)
  const projects = useAssistant((state) => state.projects)
  const loadProjects = useAssistant((state) => state.loadProjects)
  const [editing, setEditing] = useState<AssistantMemory | 'new' | null>(null)
  const [correcting, setCorrecting] = useState<AssistantMemory | null>(null)
  const [historyOf, setHistoryOf] = useState<AssistantMemory | null>(null)
  const [writing, setWriting] = useState<AssistantMemory | null>(null)
  const [draft, setDraft] = useState(query)
  const debounced = useDebounced(draft, 250)

  useEffect(() => {
    void loadMemories()
  }, [loadMemories])

  useEffect(() => {
    // A fact filed under a project says so, and the names live on a slice another page loads. One request
    // on a page the reader opened to look at exactly this; without it the chip would be an id.
    if (!useAssistant.getState().projects.length) void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (debounced !== query) void setFilter({ query: debounced })
  }, [debounced, query, setFilter])

  const grouped = useMemo(() => {
    const map = new Map<string, AssistantMemory[]>()
    for (const memory of memories) {
      const list = map.get(memory.category) ?? []
      list.push(memory)
      map.set(memory.category, list)
    }
    return ASSISTANT_MEMORY_CATEGORIES.filter((category) => map.has(category)).map((category) => [category, map.get(category)!] as const)
  }, [memories])

  return (
    <div className="no-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-5 md:px-8">
        <AssistantHeader
          title={t('assistant.memory.title')}
          description={t('assistant.memory.description', { count: total })}
        />

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <Segmented
            size="sm"
            label={t('assistant.memory.filter_label')}
            value={status as typeof FILTERS[number]['value']}
            onChange={(value) => void setFilter({ status: value })}
            options={FILTERS.map((entry) => ({
              value: entry.value,
              label: entry.value === 'all'
                ? t(entry.label)
                : `${t(entry.label)} ${entry.value === 'active' ? counts.active : entry.value === 'historical' ? counts.historical : counts.review}`,
            }))}
          />
          {/* The box is the shared field; the wrapper is what gives it the row's remaining width, because
              the field hands its own `className` to the `<input>` rather than to the box around it. */}
          <div className="min-w-0 flex-1">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('assistant.memory.search')}
              aria-label={t('assistant.memory.search')}
              leading={<Search size={13} />}
              className="h-8 text-[length:var(--text-12)]"
            />
          </div>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
            {t('assistant.memory.add')}
          </Button>
        </div>

        {(status === 'review' || status === 'all') && reviews.length > 0 && (
          <section aria-label={t('assistant.memory.conflicts')} className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
              <GitCompare size={11} />
              {t('assistant.memory.conflicts')} · {reviews.length}
            </p>
            {reviews.map((review) => (
              <div key={review.id} className="rounded-[var(--r-lg)] border border-[color-mix(in_oklab,var(--warning)_40%,transparent)] bg-[var(--bg-surface)] px-3 py-2.5">
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{reasonText(review.reason)}</p>
                <dl className="mt-1.5 flex flex-col gap-1 text-[length:var(--text-12-5)]">
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 text-[var(--text-quaternary)]">{t('assistant.memory.newer')}</dt>
                    <dd className="min-w-0 text-[var(--text-primary)]">{review.memory.content}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 text-[var(--text-quaternary)]">{t('assistant.memory.older')}</dt>
                    <dd className="min-w-0 text-[var(--text-secondary)]">{review.other.content}</dd>
                  </div>
                </dl>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => void resolveReview(review.id, 'keep_both')}>{t('assistant.memory.keep_both')}</Button>
                  <Button size="sm" variant="secondary" onClick={() => void resolveReview(review.id, 'mark_historical')}>{t('assistant.memory.mark_past')}</Button>
                  <Button size="sm" variant="secondary" onClick={() => void resolveReview(review.id, 'replace')}>{t('assistant.memory.replace_older')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void resolveReview(review.id, 'discard')}>{t('assistant.memory.discard_newer')}</Button>
                </div>
              </div>
            ))}
          </section>
        )}

        {!grouped.length ? (
          <Empty
            art="search"
            title={query.trim() ? t('assistant.memory.none_match') : t('assistant.memory.empty_title')}
            description={query.trim() ? t('assistant.memory.none_match_hint') : t('assistant.memory.empty_hint')}
            action={!query.trim() && <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>{t('assistant.memory.add')}</Button>}
          />
        ) : (
          grouped.map(([category, items]) => (
            <section key={category}>
              <p className="mb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                {CATEGORY_LABELS[category]?.() ?? category} · {items.length}
              </p>
              <ul className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                {items.map((memory) => {
                  // A fact learned inside a project is only recalled there, so the row has to say which
                  // one: a reader wondering why the assistant forgot something is looking at this line.
                  const project = memory.projectId ? projects.find((entry) => entry.id === memory.projectId) : undefined
                  return (
                  <li key={memory.id} className="group flex items-start gap-2 border-b border-[var(--border-subtle)] px-3 py-2 transition-colors duration-[var(--dur-fast)] last:border-b-0 hover:bg-[var(--bg-hover)]">
                    <div className="min-w-0 flex-1">
                      <p className={memory.status === 'historical' ? 'text-[length:var(--text-13)] leading-relaxed text-[var(--text-tertiary)]' : 'text-[length:var(--text-13)] leading-relaxed text-[var(--text-primary)]'}>
                        {memory.content}
                        {memory.status === 'historical' && <Badge className="ml-1.5 align-[0.1em]">{t('assistant.memory.past')}</Badge>}
                        {memory.status === 'uncertain' && <Badge tone="warning" className="ml-1.5 align-[0.1em]">{t('assistant.memory.unsure')}</Badge>}
                      </p>
                      <p className="mt-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                        {t(memory.source === 'assistant' ? 'assistant.memory.source_agent' : memory.source === 'import' ? 'assistant.memory.source_import' : 'assistant.memory.source_manual')}
                        {' · '}
                        {relativeTime(memory.updatedAt)}
                        {memory.validFrom && ` · ${t('assistant.memory.since', { date: memory.validFrom })}`}
                        {memory.validUntil && ` · ${t('assistant.memory.until', { date: memory.validUntil })}`}
                        {project && (
                          <span
                            className="ml-1.5 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)]"
                            title={t('assistant.memory.in_project', { name: project.name })}
                          >
                            {project.name}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-px">
                      <IconButton label={t('assistant.memory.history')} size="xs" onClick={() => setHistoryOf(memory)}>
                        <History size={13} />
                      </IconButton>
                      {memory.status !== 'historical' && (
                        <IconButton label={t('assistant.memory.correct')} size="xs" onClick={() => setCorrecting(memory)}>
                          <RefreshCw size={13} />
                        </IconButton>
                      )}
                      <IconButton
                        label={memory.status === 'historical' ? t('assistant.memory.restore') : t('assistant.memory.mark_past')}
                        size="xs"
                        onClick={() => void setStatus(memory.id, memory.status === 'historical' ? 'active' : 'historical')}
                      >
                        {memory.status === 'historical' ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                      </IconButton>
                      <IconButton
                        label={memory.noteId ? t('assistant.memory.open_note') : t('assistant.memory.save_note')}
                        size="xs"
                        onClick={() => {
                          if (!memory.noteId) {
                            setWriting(memory)
                            return
                          }
                          // The note is the memory's own copy, so the way to change it is to go there.
                          navigateToPath('/notes')
                          void useNotes.getState().openNote(memory.noteId)
                        }}
                      >
                        <NotebookPen size={13} />
                      </IconButton>
                      <IconButton label={t('assistant.memory.edit')} size="xs" onClick={() => setEditing(memory)}>
                        <Pencil size={13} />
                      </IconButton>
                      <IconButton
                        label={t('assistant.memory.forget')}
                        size="xs"
                        onClick={() => {
                          void confirm({
                            title: t('assistant.memory.forget'),
                            description: t('assistant.memory.forget_hint', { content: memory.content }),
                            confirmLabel: t('assistant.memory.forget'),
                            tone: 'danger',
                          }).then((yes) => {
                            if (yes) void removeMemory(memory.id)
                          })
                        }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </div>
                  </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      <MemoryEditor memory={editing} onClose={() => setEditing(null)} />
      <CorrectDialog memory={correcting} onClose={() => setCorrecting(null)} />
      <HistoryDialog memory={historyOf} onClose={() => setHistoryOf(null)} />
      <SaveNoteDialog memory={writing} onClose={() => setWriting(null)} />
    </div>
  )
}

function MemoryEditor({ memory, onClose }: { memory: AssistantMemory | 'new' | null, onClose: () => void }) {
  const addMemory = useAssistant((state) => state.addMemory)
  const editMemory = useAssistant((state) => state.editMemory)
  const [content, setContent] = useState('')
  const [category, setCategory] = useState('preference')

  useEffect(() => {
    if (memory && memory !== 'new') {
      setContent(memory.content)
      setCategory(memory.category)
    } else {
      setContent('')
      setCategory('preference')
    }
  }, [memory])

  const save = () => {
    if (!content.trim()) return
    if (memory === 'new') void addMemory(content.trim(), category)
    else if (memory) void editMemory(memory.id, content.trim(), category)
    onClose()
  }

  return (
    <Modal
      open={!!memory}
      onClose={onClose}
      title={memory === 'new' ? t('assistant.memory.add') : t('assistant.memory.edit')}
      width={460}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={save} disabled={!content.trim()}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('assistant.memory.content_label')}>
          <Textarea
            rows={3}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={2000}
            autoFocus
            placeholder={t('assistant.memory.content_placeholder')}
          />
        </Field>
        <Field label={t('assistant.memory.category_label')}>
          <Select value={category} onChange={(event) => setCategory(event.target.value)}>
            {ASSISTANT_MEMORY_CATEGORIES.map((entry) => (
              <option key={entry} value={entry}>{CATEGORY_LABELS[entry]?.()}</option>
            ))}
          </Select>
        </Field>
        {memory && memory !== 'new' && (
          <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">{t('assistant.memory.edit_hint')}</p>
        )}
      </div>
    </Modal>
  )
}

function CorrectDialog({ memory, onClose }: { memory: AssistantMemory | null, onClose: () => void }) {
  const correctMemory = useAssistant((state) => state.correctMemory)
  const [content, setContent] = useState('')
  useEffect(() => {
    setContent(memory?.content ?? '')
  }, [memory])
  return (
    <Modal
      open={!!memory}
      onClose={onClose}
      title={t('assistant.memory.correct')}
      width={460}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            disabled={!content.trim() || content.trim() === memory?.content}
            onClick={() => {
              if (memory) void correctMemory(memory.id, content.trim())
              onClose()
            }}
          >
            {t('assistant.memory.save_version')}
          </Button>
        </>
      )}
    >
      <p className="mb-3 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
        {t('assistant.memory.correct_hint', { content: memory?.content ?? '' })}
      </p>
      <Field label={t('assistant.memory.what_now')}>
        <Textarea rows={3} value={content} onChange={(event) => setContent(event.target.value)} maxLength={2000} autoFocus />
      </Field>
    </Modal>
  )
}

function HistoryDialog({ memory, onClose }: { memory: AssistantMemory | null, onClose: () => void }) {
  const [data, setData] = useState<{ previous: AssistantMemory[], next: AssistantMemory[] } | null>(null)
  /**
   * The earlier page was refused. Kept apart from an empty page on purpose: the failure used to resolve to
   * `{ previous: [] }`, which this dialog then read out as "no earlier versions" — a sentence that tells a
   * reader their history is gone because one request failed.
   */
  const [refused, setRefused] = useState(false)
  /** Bumped by the refusal's own retry, so the request runs again through the guard below. */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!memory) {
      setData(null)
      setRefused(false)
      return
    }
    let cancelled = false
    setRefused(false)
    void api.assistant.memoryHistory(memory.id).then((result) => {
      if (!cancelled) setData({ previous: result.previous, next: result.next })
    }).catch(() => {
      if (cancelled) return
      setData({ previous: [], next: [] })
      setRefused(true)
    })
    return () => {
      cancelled = true
    }
  }, [memory, attempt])

  const retry = () => {
    setData(null)
    setAttempt((current) => current + 1)
  }

  return (
    <Modal open={!!memory} onClose={onClose} title={t('assistant.memory.history')} width={460}>
      {!data ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : (
        <div className="flex flex-col gap-3 text-[length:var(--text-12-5)]">
          <div>
            <p className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
              {t('assistant.memory.current')}
            </p>
            <p className="mt-1 leading-relaxed text-[var(--text-primary)]">{memory?.content}</p>
          </div>
          {refused ? (
            <LoadFailure messageKey="assistant.memory.history_failed" onRetry={retry} />
          ) : data.previous.length === 0 ? (
            <p className="text-[var(--text-quaternary)]">{t('assistant.memory.no_earlier')}</p>
          ) : (
            <div>
              <p className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                {t('assistant.memory.earlier')}
              </p>
              <ul className="mt-1 flex flex-col gap-1.5">
                {data.previous.map((entry) => (
                  <li key={entry.id} className="text-[var(--text-tertiary)]">
                    {entry.content}
                    <span className="block text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{relativeTime(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/**
 * Writing one memory out as a note.
 *
 * A remembered fact is a sentence the assistant wrote down; a note is where the reader can turn it into
 * something with paragraphs, links and a place in the vault. The dialog asks the two things only they can
 * answer — what it is called and where it lives — and the note's body is the memory itself, unedited, so
 * nothing is quietly rewritten on the way out.
 */
function SaveNoteDialog({ memory, onClose }: { memory: AssistantMemory | null, onClose: () => void }) {
  const save = useAssistant((state) => state.saveMemoryAsNote)
  const folders = useNotes((state) => state.folders)
  const [title, setTitle] = useState('')
  const [folderId, setFolderId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setTitle(memory ? memory.content.slice(0, 80) : '')
    setFolderId('')
    setBusy(false)
  }, [memory])

  if (!memory) return null
  const submit = async () => {
    if (busy) return
    setBusy(true)
    const noteId = await save(memory.id, folderId || null, title)
    setBusy(false)
    if (noteId) onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('assistant.memory.save_note')}
      description={t('assistant.memory.save_note_hint')}
      width={440}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !title.trim()} onClick={() => void submit()}>
            {t('assistant.memory.save_note')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('assistant.memory.save_note_title')}>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} autoFocus />
        </Field>
        <Field label={t('assistant.memory.save_note_folder')}>
          <Select value={folderId} onChange={(event) => setFolderId(event.target.value)}>
            <option value="">{t('assistant.memory.save_note_root')}</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>{folderPathLabel(folders, folder.id)}</option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}
