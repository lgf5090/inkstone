/**
 * What the assistant remembers, and what it is unsure about.
 *
 * The list is grouped by category because a reader scanning "where do I think I live" reads by topic,
 * not by the order things happened to be saved. The four row actions are the interesting part: an
 * update that changes a fact keeps the old one as history rather than overwriting it, so "what did I
 * used to say" still answers — and a plain edit stays a plain edit, for fixing a typo.
 */
import { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, GitCompare, History, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { AssistantMemory } from '@shared/assistant'
import { ASSISTANT_MEMORY_CATEGORIES } from '@shared/assistant'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { useDebounced } from '../../lib/hooks'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Field, Input, Segmented, Select, Textarea } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { useAssistant } from './assistant-store'

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
  const [editing, setEditing] = useState<AssistantMemory | 'new' | null>(null)
  const [correcting, setCorrecting] = useState<AssistantMemory | null>(null)
  const [historyOf, setHistoryOf] = useState<AssistantMemory | null>(null)
  const [draft, setDraft] = useState(query)
  const debounced = useDebounced(draft, 250)

  useEffect(() => {
    void loadMemories()
  }, [loadMemories])

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
        <header>
          <h2 className="font-serif text-[18px] font-semibold tracking-[var(--tracking-title)] text-[var(--text-primary)]">
            {t('assistant.memory.title')}
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            {t('assistant.memory.description', { count: total })}
          </p>
        </header>

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
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('assistant.memory.search')}
              aria-label={t('assistant.memory.search')}
              className="h-8 pl-8 text-[12px]"
            />
          </div>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
            {t('assistant.memory.add')}
          </Button>
        </div>

        {(status === 'review' || status === 'all') && reviews.length > 0 && (
          <section aria-label={t('assistant.memory.conflicts')} className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
              <GitCompare size={11} />
              {t('assistant.memory.conflicts')} · {reviews.length}
            </p>
            {reviews.map((review) => (
              <div key={review.id} className="rounded-[var(--r-lg)] border border-[color-mix(in_oklab,var(--warning)_40%,transparent)] bg-[var(--bg-surface)] px-3 py-2.5">
                <p className="text-[11px] text-[var(--text-tertiary)]">{reasonText(review.reason)}</p>
                <dl className="mt-1.5 flex flex-col gap-1 text-[12.5px]">
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
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                {CATEGORY_LABELS[category]?.() ?? category} · {items.length}
              </p>
              <ul className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                {items.map((memory) => (
                  <li key={memory.id} className="group flex items-start gap-2 border-b border-[var(--border-subtle)] px-3 py-2 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <p className={memory.status === 'historical' ? 'text-[13px] leading-relaxed text-[var(--text-tertiary)]' : 'text-[13px] leading-relaxed text-[var(--text-primary)]'}>
                        {memory.content}
                        {memory.status === 'historical' && <span className="ml-1.5 rounded-full bg-[var(--bg-inset)] px-1.5 py-px text-[10px] text-[var(--text-quaternary)]">{t('assistant.memory.past')}</span>}
                        {memory.status === 'uncertain' && <span className="ml-1.5 rounded-full bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] px-1.5 py-px text-[10px] text-[var(--warning)]">{t('assistant.memory.unsure')}</span>}
                      </p>
                      <p className="mt-0.5 text-[10.5px] text-[var(--text-quaternary)]">
                        {t(memory.source === 'assistant' ? 'assistant.memory.source_agent' : memory.source === 'import' ? 'assistant.memory.source_import' : 'assistant.memory.source_manual')}
                        {' · '}
                        {relativeTime(memory.updatedAt)}
                        {memory.validFrom && ` · ${t('assistant.memory.since', { date: memory.validFrom })}`}
                        {memory.validUntil && ` · ${t('assistant.memory.until', { date: memory.validUntil })}`}
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
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <MemoryEditor memory={editing} onClose={() => setEditing(null)} />
      <CorrectDialog memory={correcting} onClose={() => setCorrecting(null)} />
      <HistoryDialog memory={historyOf} onClose={() => setHistoryOf(null)} />
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
          <p className="text-[11px] leading-relaxed text-[var(--text-quaternary)]">{t('assistant.memory.edit_hint')}</p>
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
      <p className="mb-3 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
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
  useEffect(() => {
    if (!memory) {
      setData(null)
      return
    }
    let cancelled = false
    void api.assistant.memoryHistory(memory.id).then((result) => {
      if (!cancelled) setData({ previous: result.previous, next: result.next })
    }).catch(() => {
      if (!cancelled) setData({ previous: [], next: [] })
    })
    return () => {
      cancelled = true
    }
  }, [memory])

  return (
    <Modal open={!!memory} onClose={onClose} title={t('assistant.memory.history')} width={460}>
      {!data ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : (
        <div className="flex flex-col gap-3 text-[12.5px]">
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
              {t('assistant.memory.current')}
            </p>
            <p className="mt-1 leading-relaxed text-[var(--text-primary)]">{memory?.content}</p>
          </div>
          {data.previous.length === 0 ? (
            <p className="text-[var(--text-quaternary)]">{t('assistant.memory.no_earlier')}</p>
          ) : (
            <div>
              <p className="text-[10.5px] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                {t('assistant.memory.earlier')}
              </p>
              <ul className="mt-1 flex flex-col gap-1.5">
                {data.previous.map((entry) => (
                  <li key={entry.id} className="text-[var(--text-tertiary)]">
                    {entry.content}
                    <span className="block text-[10.5px] text-[var(--text-quaternary)]">{relativeTime(entry.createdAt)}</span>
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
