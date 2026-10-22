/**
 * The board: every list as a card, the way the reference app opens.
 *
 * A card answers one question — what does this list still owe me — so it shows a few open tasks and
 * a `done / total` line, and nothing else. The chips above it are the same lists, because on a phone
 * the board is two columns wide and a list that is not on screen needs a way to be reached.
 */

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ChevronRight, ListChecks, Mic, Plus, Square } from 'lucide-react'
import { cn } from '../../lib/cn'
import { getLocale, t } from '../../lib/i18n'
import { useDropState } from '../../lib/drop-state'
import { useTodos, listNamed, quickAddDraft, remindOffsetOf } from './store'
import { useUi } from '../../store/ui'
import { TodoPageFooter } from './TodoPageFooter'
import { Input } from '../../components/form'
import { ListIcon } from './list-icons'
import { priorityLabel, repeatLabel } from './todo-ui'
import { quickAddHighlights } from './quick-add-highlight'
import { TaskCard, isTodoTaskDrag, moveTodoTask, readTodoTaskDrag, useTaskMoves } from './TaskCard'
import { parseQuickAdd, type QuickAddParse, type QuickAddToken, type QuickAddTokenKind } from '@shared/todos/quick-parse'
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
function QuickAddPreview({ parsed, timezone, lists }: {
  parsed: QuickAddParse | null
  timezone: string
  lists: readonly TaskList[]
}): ReactNode {
  if (!parsed) return null
  const chips = quickAddChips(parsed, timezone, lists)
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

/**
 * The box the inline field and its mirror share, spelled once.
 *
 * A highlight lands where the field's glyphs are only if the two wear the same font size, the same
 * padding and the same one-pixel border. The height deliberately is not in here: the mirror stretches to
 * the field's box instead of carrying its own copy, because the field's height changes at a breakpoint
 * and a second list of those values is how a mirror ends up a pixel away from the words it colours.
 */
const QUICK_ADD_FIELD = 'w-full rounded-[var(--r-md)] border px-2.5 text-[length:var(--text-12)]'

/** One flex item, holding the spaces the reader typed exactly where they were typed. */
const QUICK_ADD_SEGMENT = 'shrink-0 whitespace-pre'

/**
 * Which of the two families a recognised span belongs to.
 *
 * The words that name *when* a task is due, and the words that name where it belongs: two tints is what
 * a line of prose can carry without turning into a rainbow, and both are background only. The reader's
 * own glyphs stay the field's colour, because the mirror's job is to say which words were read, not to
 * re-render them in a second typeface of the theme.
 */
const QUICK_ADD_TINT: Record<QuickAddTokenKind, string> = {
  date: 'bg-[var(--accent-soft)]',
  time: 'bg-[var(--accent-soft)]',
  repeat: 'bg-[var(--accent-soft)]',
  remind: 'bg-[var(--accent-soft)]',
  priority: 'bg-[var(--bg-active)]',
  list: 'bg-[var(--bg-active)]',
  tag: 'bg-[var(--bg-active)]',
}

/** The line, cut into the words the parser read and the words it left as prose. */
function quickAddSegments(input: string, tokens: readonly QuickAddToken[]): ReactNode[] {
  const segments: ReactNode[] = []
  let cursor = 0
  for (const [index, range] of quickAddHighlights(input, tokens).entries()) {
    if (range.start > cursor) {
      segments.push(<span key={`rest-${index}`} className={QUICK_ADD_SEGMENT}>{input.slice(cursor, range.start)}</span>)
    }
    segments.push(
      <span
        key={`${range.kind}-${index}`}
        data-quickadd-kind={range.kind}
        className={cn(QUICK_ADD_SEGMENT, QUICK_ADD_TINT[range.kind])}
      >
        {input.slice(range.start, range.end)}
      </span>,
    )
    cursor = range.end
  }
  if (cursor < input.length) {
    segments.push(<span key="rest-tail" className={QUICK_ADD_SEGMENT}>{input.slice(cursor)}</span>)
  }
  return segments
}

/**
 * The mirror under the inline field.
 *
 * It paints the same line the field holds, one layer down, and adds a tint wherever the parser read a
 * field: what a reader sees while typing is the word they typed, coloured, rather than a second row of
 * answers under it. Its own text is transparent, so the field above it owns every glyph, caret and
 * selection — and if the two ever came apart by a pixel, the colour would shift without the words
 * doubling. `aria-hidden` because a copy of the field is not a second thing a screen reader should be
 * told; the sentence beside it is.
 */
function QuickAddMirror({ input, tokens, mirrorRef }: {
  input: string
  tokens: readonly QuickAddToken[]
  mirrorRef: Ref<HTMLDivElement>
}): ReactNode {
  return (
    <div
      ref={mirrorRef}
      aria-hidden="true"
      data-todo-quickadd-mirror=""
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center overflow-hidden',
        'border-transparent bg-[var(--bg-inset)] text-transparent',
        QUICK_ADD_FIELD,
      )}
    >
      {quickAddSegments(input, tokens)}
    </div>
  )
}

/**
 * The same answer the tint gives, said in the order the words were written.
 *
 * Colour is a thing a screen reader never receives, and the chip row below is grouped by field rather
 * than read as a sentence: the parser's array puts the day before the tag no matter where either was
 * typed. So this walks `start`, which is the order a person typed in and the only order a sentence can
 * be heard in.
 */
function quickAddSummary(parsed: QuickAddParse): string {
  const items = [...parsed.tokens]
    .sort((a, b) => a.start - b.start)
    .map((token) => t(`todo.quickadd.kind.${token.kind}` as MessageKey, { text: token.text }))
  if (items.length === 0) return ''
  return t('todo.quickadd.summary', { items: items.join(t('todo.quickadd.summary.join')) })
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

/** One open inline row at a time, so one id is enough to name its spoken summary. */
const QUICK_ADD_SUMMARY_ID = 'todo-quickadd-summary'

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
  /**
   * The line, read once per render for the row that is open.
   *
   * The mirror's tints, the chips under it and the sentence a screen reader hears are three answers
   * about the same words, and three calls to the parser would be three chances to answer differently
   * about a line that changed in between. The mirror is the one node that outlives a render, so its
   * scroll position is held in a ref rather than worked out again.
   */
  const quick = adding === null || !draft.trim() ? null : parseQuickAdd(draft, Date.now(), timezone)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
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
            {card.icon ? <ListIcon icon={card.icon} size={12} /> : <ListChecks size={12} style={{ color: card.color }} />}
            <span className="max-w-[140px] truncate">{card.name}</span>
          </button>
        ))}
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-1 md:px-5 md:pb-6">
        {/* No standalone first-run note here: the inbox is always one of the cards below, so a centred
            "create your first list" line beside it reads as a contradiction. The card's own empty body
            and the sidebar's + carry that guidance instead. */}
        <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" role="list" aria-label={t('todo.a11y.list_cards')}>
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
                {card.icon
                  ? <ListIcon icon={card.icon} size={14} />
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
                    <div className="relative min-w-0 flex-1">
                      <QuickAddMirror input={draft} tokens={quick?.tokens ?? []} mirrorRef={mirrorRef} />
                      {/* The field wears no background of its own: the line under it is the box, and the
                          caret and the selection the browser draws stay legible over the tint. */}
                      <Input
                        autoFocus
                        value={draft}
                        placeholder={t('todo.task.title_label')}
                        aria-label={t('todo.action.add_task')}
                        aria-describedby={quick && quick.tokens.length > 0 ? QUICK_ADD_SUMMARY_ID : undefined}
                        onChange={(event) => setDraft(event.target.value)}
                        // A line longer than the card scrolls inside the field, and the tint has to
                        // scroll with it: the mirror is told where the field is looking.
                        onScroll={(event) => {
                          if (mirrorRef.current) mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(card) }
                          if (event.key === 'Escape') { stopVoice(); setAdding(null); setDraft('') }
                        }}
                        className={cn(QUICK_ADD_FIELD, 'relative z-10 h-9 bg-transparent')}
                      />
                    </div>
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
                  {/* What the tint under the caret means, said in the order the words were typed: the
                      chips below are grouped by field, and a colour says nothing to a screen reader. */}
                  <p id={QUICK_ADD_SUMMARY_ID} role="status" className="sr-only">
                    {quick ? quickAddSummary(quick) : ''}
                  </p>
                  <QuickAddPreview parsed={quick} timezone={timezone} lists={lists} />
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

