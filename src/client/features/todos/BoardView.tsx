/**
 * The board: every list as a card, the way the reference app opens.
 *
 * A card answers one question — what does this list still owe me — so it shows a few open tasks and
 * a `done / total` line, and nothing else. The chips above it are the same lists, because on a phone
 * the board is two columns wide and a list that is not on screen needs a way to be reached.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, ListChecks, Mic, Plus, Square } from 'lucide-react'
import { cn } from '../../lib/cn'
import { getLocale, t } from '../../lib/i18n'
import { useDropState } from '../../lib/drop-state'
import { KanbanIconBadge } from '../../lib/markdown/kanban/ui/kanban-icon-badge'
import { useTodos, listNamed, quickAddDraft, remindOffsetOf } from './store'
import { useUi } from '../../store/ui'
import { TodoPageFooter } from './TodoPageFooter'
import { Input } from '../../components/form'
import { listIconFor, priorityLabel, repeatLabel } from './todo-ui'
import { TaskCard, isTodoTaskDrag, moveTodoTask, readTodoTaskDrag, useTaskMoves } from './TaskCard'
import { parseQuickAdd, type QuickAddParse } from '@shared/todos/quick-parse'
import { toLocalMinute } from '@shared/assistant-time'
import type { MessageKey } from '@shared/locales/en-US'
import type { TaskList, TodoTask } from '@shared/todos/model'

interface BoardCard {
  id: string
  name: string
  icon: string | null
  color: string
  open: number
  done: number
  tasks: TodoTask[]
  listId: string | null
}

const INBOX_ID = 'inbox'

interface QuickAddChip {
  kind: 'date' | 'time' | 'repeat' | 'remind' | 'priority' | 'list' | 'tag'
  /** What the reader reads; every chip carries its own answer, never a colour alone. */
  label: string
  /** A list name the account does not have: shown, but not written anywhere. */
  unresolved?: boolean
}

/** A day as the account's own calendar reads it, not the machine's. */
function zonedDay(instant: number, timezone: string): string {
  return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric', timeZone: timezone }).format(new Date(instant))
}

/**
 * The preview row above the Enter key.
 *
 * It is built from the parser's answer rather than from the raw words, so it says what the task will
 * actually carry. A list name the account does not have stays visible with the reason attached: the
 * alternative is to drop a word the reader typed without ever saying so.
 */
function quickAddChips(parsed: QuickAddParse, timezone: string, lists: readonly TaskList[]): QuickAddChip[] {
  const chips: QuickAddChip[] = []
  if (parsed.dueAt !== null) {
    const minute = toLocalMinute(parsed.dueAt, timezone)
    chips.push({ kind: 'date', label: zonedDay(parsed.dueAt, timezone) })
    // A day written without a clock is stored as the end of that day; showing "23:59" would report
    // the implementation instead of the words.
    if (!minute.endsWith('T23:59')) chips.push({ kind: 'time', label: minute.slice(11) })
  }
  if (parsed.repeat) chips.push({ kind: 'repeat', label: repeatLabel(parsed.repeat)! })
  if (parsed.remindAt !== null) {
    const offset = remindOffsetOf({ dueAt: parsed.dueAt, remindAt: parsed.remindAt })
    if (offset !== 'none') chips.push({ kind: 'remind', label: t(`todo.remind.${offset}` as MessageKey) })
  }
  if (parsed.priority) chips.push({ kind: 'priority', label: priorityLabel(parsed.priority) })
  if (parsed.listName) {
    const list = listNamed(lists, parsed.listName)
    chips.push({ kind: 'list', label: `@${list?.name ?? parsed.listName}`, unresolved: !list })
  }
  for (const name of parsed.tags) chips.push({ kind: 'tag', label: `#${name}` })
  return chips
}

/** The live preview under an inline field: nothing until at least one word was understood. */
function QuickAddPreview({ input, timezone, lists }: {
  input: string
  timezone: string
  lists: readonly TaskList[]
}): ReactNode {
  if (!input.trim()) return null
  const chips = quickAddChips(parseQuickAdd(input, Date.now(), timezone), timezone, lists)
  if (chips.length === 0) return null
  return (
    <ul
      data-todo-quickadd-chips=""
      aria-label={t('todo.quickadd.preview')}
      className="mt-1 flex flex-wrap gap-1"
    >
      {chips.map((chip, index) => (
        <li
          key={`${chip.kind}-${index}`}
          className={cn(
            'rounded-full border px-1.5 py-0.5 text-[length:var(--text-10-5)]',
            chip.unresolved
              ? 'border-[var(--warning)] text-[var(--warning)]'
              : 'border-[var(--border-subtle)] text-[var(--text-secondary)]',
          )}
        >
          {chip.label}
          {chip.unresolved && <span> · {t('todo.quickadd.list_missing')}</span>}
        </li>
      ))}
    </ul>
  )
}

/** The three states the voice button can be in. Absence of the API is not one of them. */
type VoiceState = 'idle' | 'listening' | 'error'

/** The one result shape this code reads: the first alternative of the first utterance. */
interface SpeechResultEvent {
  results: { 0: { 0: { transcript: string } } }
}

/** The slice of `SpeechRecognition` this button uses, declared because the API is not in jsdom. */
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort?(): void
  onresult: ((event: SpeechResultEvent) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/**
 * The browser's own recogniser, or null where there is none.
 *
 * Chromium and Safari expose it under the `webkit` prefix, and Firefox exposes neither. Returning
 * null rather than a stub is what lets the button say "not available here" instead of pretending to
 * listen — a press that silently does nothing is the failure this branch exists to avoid.
 */
function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

const VOICE_HINT_ID = 'todo-voice-hint'

export function BoardView({ onOpenList }: { onOpenList: (listId: string) => void }) {
  const tasks = useTodos((state) => state.tasks)
  const lists = useTodos((state) => state.lists)
  const counts = useTodos((state) => state.counts)
  const dayEnd = useTodos((state) => state.dayEnd)
  const timezone = useTodos((state) => state.timezone)
  const createTask = useTodos((state) => state.createTask)
  const openEditor = useTodos((state) => state.openEditor)
  const updateTask = useTodos((state) => state.updateTask)
  const sort = useTodos((state) => state.sort)
  const query = useTodos((state) => state.query)
  const dueFrom = useTodos((state) => state.dueFrom)
  const dueTo = useTodos((state) => state.dueTo)
  // A due window or a search narrows the rows themselves, unlike paging: an empty card under one has
  // no match to show, even while the server's account-wide count is still above zero.
  const filtered = query.trim().length > 0 || dueFrom !== null || dueTo !== null
  const [adding, setAdding] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // The card a drag is hovering, so the whole collection lights up as the drop target it is. A drop
  // on a row is handled by the row itself and never reaches this; a drop on the card appends.
  const [dropCard, setDropCard] = useDropState<string | null>(null)
  const moveFor = useTaskMoves(!sort)
  /**
   * Voice input for the inline field.
   *
   * The recogniser is created per attempt rather than kept: a browser may refuse the microphone, a
   * card may close, and an instance that has ended is not reusable. Support is read every render so
   * a test (or a browser that gained the API) sees the truth; the three states below are the run's
   * own — idle, listening, and an error that stays visible until the next attempt.
   */
  const voiceSupported = speechRecognitionCtor() !== null
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [voiceError, setVoiceError] = useState<MessageKey | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  useEffect(() => () => {
    recognitionRef.current?.abort?.()
    recognitionRef.current = null
  }, [])

  /** Ends a run without waiting for `onend`, which a stopped browser may never fire. */
  const stopVoice = (): void => {
    const recognition = recognitionRef.current
    recognitionRef.current = null
    recognition?.stop()
    setVoiceState('idle')
  }

  const startVoice = (): void => {
    if (voiceState === 'listening') {
      stopVoice()
      return
    }
    const Recognizer = speechRecognitionCtor()
    if (!Recognizer) return
    const recognition = new Recognizer()
    recognition.lang = getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US'
    recognition.interimResults = false
    recognition.continuous = false
    recognition.maxAlternatives = 1
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim() ?? ''
      if (!transcript) return
      // The words join whatever the reader had typed, separated by one space: a spoken correction is
      // appended to the line rather than replacing it, and the same preview parses the result.
      setDraft((previous) => (previous.trim() ? `${previous.trimEnd()} ${transcript}` : transcript))
    }
    recognition.onerror = (event) => {
      setVoiceState('error')
      setVoiceError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'todo.voice.denied'
        : 'todo.voice.failed')
    }
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null
      // An error keeps its message on screen; a clean finish returns the button to idle.
      setVoiceState((state) => (state === 'error' ? 'error' : 'idle'))
    }
    try {
      recognition.start()
      recognitionRef.current = recognition
      setVoiceError(null)
      setVoiceState('listening')
    } catch {
      setVoiceError('todo.voice.failed')
      setVoiceState('error')
    }
  }

  const voiceStatus = voiceState === 'listening'
    ? t('todo.voice.listening')
    : voiceState === 'error' && voiceError ? t(voiceError) : ''

  const bounds = { dayEnd, now: Date.now() }
  // A card keeps the order the page arrived in: the server read it in the order the sort control
  // states, and sorting each card again in the browser would quietly overrule that choice.
  const cards: BoardCard[] = [
    {
      id: INBOX_ID,
      name: t('todo.smart.inbox'),
      icon: null,
      color: 'var(--text-tertiary)',
      open: counts?.inbox ?? 0,
      done: counts?.byList[INBOX_ID]?.done ?? 0,
      tasks: tasks.filter((task) => task.listId === null),
      listId: null,
    },
    ...lists.map((list) => ({
      id: list.id,
      name: list.name,
      icon: list.icon,
      color: list.color ?? 'var(--accent)',
      open: list.openCount,
      done: list.doneCount,
      tasks: tasks.filter((task) => task.listId === list.id),
      listId: list.id,
    })),
  ]

  const submit = async (card: BoardCard): Promise<void> => {
    // The parser answers what the line meant; the card is the list unless the line named another one
    // the account actually has. A title it did not find is not a task, and the row stays open on the
    // words so the reader can add one instead of losing what they typed.
    const quick = quickAddDraft(draft, Date.now(), timezone, lists, card.listId)
    const title = quick?.title?.trim() ?? ''
    if (!quick || !title) {
      if (!draft.trim()) { setDraft(''); setAdding(null) }
      return
    }
    const { remindAt, ...body } = quick
    const remind = remindAt != null && typeof body.dueAt === 'number'
      ? remindOffsetOf({ dueAt: body.dueAt, remindAt })
      : 'none'
    setDraft('')
    setAdding(null)
    stopVoice()
    // A card shows at most three rows, so a new undated task usually lands below the fold: without this
    // the reader gets no acknowledgement at all for a save that did work. The toast is that receipt.
    const created = await createTask({
      ...body,
      title,
      ...(remind !== 'none' ? { remind } : {}),
    })
    if (created) useUi.getState().toast({ title: t('todo.toast.created'), tone: 'success' })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto px-3 py-2 md:px-5">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => onOpenList(card.id)}
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[length:var(--text-12)] md:min-h-0',
              'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]',
              'hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
            )}
          >
            {listIconFor(card.icon) ? <KanbanIconBadge icon={listIconFor(card.icon)} size={12} /> : <ListChecks size={12} style={{ color: card.color }} />}
            <span className="max-w-[140px] truncate">{card.name}</span>
          </button>
        ))}
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-1 md:px-5 md:pb-6">
        {/* No standalone first-run note here: the inbox is always one of the cards below, so a centred
            "create your first list" line beside it reads as a contradiction. The card's own empty body
            and the sidebar's + carry that guidance instead. */}
        <div className="grid grid-cols-1 gap-2.5 min-[360px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" role="list" aria-label={t('todo.a11y.list_cards')}>
          {cards.map((card) => (
            <section
              key={card.id}
              aria-label={card.name}
              data-todo-card-drop={dropCard === card.id ? '' : undefined}
              onDragOver={(event) => {
                if (!isTodoTaskDrag(event)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropCard(card.id)
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget
                if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropCard(null)
              }}
              onDrop={(event) => {
                if (!isTodoTaskDrag(event)) return
                event.preventDefault()
                setDropCard(null)
                const draggedId = readTodoTaskDrag(event)
                // A card is a collection, not a place: dropping on it appends to that list, which is
                // also the only cross-list gesture the board offers without opening a list.
                if (draggedId) void moveTodoTask(draggedId, { beforeId: null, listId: card.listId })
              }}
              className={cn(
                'flex min-w-0 flex-col overflow-hidden rounded-[var(--r-lg)] border bg-[var(--bg-surface)]',
                dropCard === card.id ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border-subtle)]',
              )}
            >
              <button
                type="button"
                onClick={() => onOpenList(card.id)}
                className="flex min-h-11 items-center gap-1.5 px-2.5 py-2 text-left"
                style={{ backgroundColor: `color-mix(in oklab, ${card.color} 10%, transparent)` }}
              >
                {listIconFor(card.icon)
                  ? <KanbanIconBadge icon={listIconFor(card.icon)} size={14} />
                  : <ListChecks size={14} style={{ color: card.color }} />}
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{card.name}</span>
                <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-tertiary)]">{card.done}/{card.open + card.done}</span>
                <ChevronRight size={12} className="shrink-0 text-[var(--text-quaternary)]" />
              </button>

              <div className="flex min-h-0 flex-col px-0.5 py-1">
                {card.tasks.slice(0, 3).map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    lists={lists}
                    bounds={bounds}
                    timezone={timezone}
                    compact
                    move={moveFor(task) ?? undefined}
                    onOpen={() => openEditor({ id: task.id })}
                    onStar={() => { void updateTask(task.id, { starred: !task.starred }) }}
                  />
                ))}
                {card.tasks.length === 0 && (filtered || card.open + card.done === 0) && (
                  // The page on hand can miss rows a card still has, so an unfiltered empty card is one
                  // the server's own count says is empty rather than one this page happens to hold
                  // nothing of. A filter narrowed the rows themselves, so its empty card says so.
                  <p className="px-2.5 py-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                    {filtered ? t('todo.empty.search') : t('todo.empty.list')}
                  </p>
                )}
              </div>

              {adding === card.id ? (
                <div className="px-1.5 pb-1.5">
                  {/* The row commits when focus leaves the whole group, not the field: the voice
                      button is part of the same line, and focusing it must not submit the draft
                      the reader is about to speak into. */}
                  <div
                    className="flex items-center gap-1"
                    onBlur={(event) => {
                      const next = event.relatedTarget
                      if (next instanceof Node && event.currentTarget.contains(next)) return
                      void submit(card)
                    }}
                  >
                    <Input
                      autoFocus
                      value={draft}
                      placeholder={t('todo.task.title_label')}
                      aria-label={t('todo.action.add_task')}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(card) }
                        if (event.key === 'Escape') { stopVoice(); setAdding(null); setDraft('') }
                      }}
                      className="h-9 min-w-0 flex-1 text-[length:var(--text-12)]"
                    />
                    <button
                      type="button"
                      data-todo-voice=""
                      disabled={!voiceSupported}
                      aria-label={voiceState === 'listening' ? t('todo.voice.stop') : t('todo.voice.start')}
                      aria-pressed={voiceState === 'listening'}
                      aria-describedby={voiceSupported ? undefined : VOICE_HINT_ID}
                      onClick={startVoice}
                      className={cn(
                        'flex size-11 shrink-0 items-center justify-center rounded-full md:size-9',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                        voiceSupported
                          ? voiceState === 'listening'
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                          : 'cursor-not-allowed text-[var(--text-quaternary)] opacity-50',
                      )}
                    >
                      {voiceState === 'listening'
                        ? <Square size={13} fill="currentColor" aria-hidden="true" />
                        : <Mic size={14} aria-hidden="true" />}
                    </button>
                  </div>
                  {!voiceSupported && (
                    <p id={VOICE_HINT_ID} className="mt-1 text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">
                      {t('todo.voice.unsupported')}
                    </p>
                  )}
                  {/* Listening and a refused microphone are states the reader has to hear, not only
                      see: the same line is the live region a screen reader announces. */}
                  <p
                    role="status"
                    aria-live="polite"
                    className={cn(
                      'mt-1 text-[length:var(--text-10-5)] leading-snug',
                      voiceState === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]',
                      voiceStatus ? '' : 'sr-only',
                    )}
                  >
                    {voiceStatus}
                  </p>
                  <QuickAddPreview input={draft} timezone={timezone} lists={lists} />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { stopVoice(); setAdding(card.id); setDraft('') }}
                  className="m-1.5 mt-0 flex min-h-11 items-center justify-center gap-1 rounded-[var(--r-md)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] md:min-h-9"
                  style={{ backgroundColor: `color-mix(in oklab, ${card.color} 8%, transparent)` }}
                >
                  <Plus size={12} />{t('todo.action.add_task')}
                </button>
              )}
            </section>
          ))}
        </div>
        {/* A board is a page of the open set too: it says what it left out rather than reading as whole. */}
        <TodoPageFooter />
      </div>
    </div>
  )
}

