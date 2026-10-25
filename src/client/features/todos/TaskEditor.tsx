/**
 * The task editor: one dialog for a new task and for an existing one.
 *
 * It is a `Modal`, which already renders as a bottom sheet on a phone and a centred dialog on a
 * desktop — the two shapes the reference app has, without a second component. Fields are saved
 * together rather than on every keystroke: a title is edited in one pass, and a save per character
 * would be a write per character.
 *
 * Steps are the exception, and only for a task that already exists: adding a step is its own request
 * because the row it produces has to come back with an id the panel can tick.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, MessagesSquare, Plus, Sparkles, Star, Trash2, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { addDaysKey } from '../../lib/time'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input, Segmented, Textarea, Field } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { TagPill } from '../../components/TagChip'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { DatePicker } from '../../components/date-picker'
import { Menu, Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { useTodos, remindOffsetOf } from './store'
import { dueValue, priorityDot, priorityLabel } from './todo-ui'
import { EstimatePicker } from './estimate-picker'
import { ListIcon } from './list-icons'
import { ColorPicker } from './OrganizerEditors'
import { ListIconPicker } from './ListIconPicker'
import { openConversationInChat, startChatAboutTask } from '../chat/start-chat'
import { sendForAnswerDetailed, type AnswerResult } from '../chat/editor-ai'
import { parseLocalTime, localDate } from '@shared/assistant-time'
import { daysInMonth, getZonedParts } from '@shared/assistant-schedule'
import type { MessageKey } from '@shared/locales/en-US'
import {
  MAX_REPEAT_COUNT,
  MAX_REPEAT_INTERVAL,
  MAX_REMINDERS_PER_TASK,
  MIN_REPEAT_COUNT,
  MIN_REPEAT_INTERVAL,
  REPEAT_FREQUENCIES,
  REMIND_OFFSETS,
  nextOccurrence,
  normalizeReminderTimes,
  remindAtFor,
  type RemindOffset,
  type RepeatFrequency,
  type RepeatMonthlyMode,
  type RepeatRule,
  type TaskStep,
} from '@shared/todos/model'

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

/** How much of the task's note an inline question carries, the same clip the chat seed uses. */
const ASK_CONTEXT_CHARS = 400
/** How many steps ride along before the prompt stops growing. */
const ASK_STEP_LIMIT = 20

/**
 * The question the inline window asks, with the task put in front of the model.
 *
 * Built the way `startChatAboutTask` seeds the composer — the title, the id and a clipped note — and
 * then the steps, because "what should I do next" asked from this panel is a question about the steps
 * on screen. The reader's own words close the prompt; nothing is sent until they press Ask.
 */
export function taskAskPrompt(
  task: { id: string, title: string, notes: string, steps: readonly string[] },
  question: string,
): string {
  const excerpt = task.notes.replace(/\s+/g, ' ').trim().slice(0, ASK_CONTEXT_CHARS)
  const head = t('todo.chat.about_task', { title: task.title.trim() || t('todo.task.untitled'), id: task.id })
  const steps = task.steps.map((step) => step.trim()).filter(Boolean).slice(0, ASK_STEP_LIMIT)
  return [
    `${head}${excerpt}`,
    steps.length ? `${t('todo.task.steps_label')}:\n${steps.map((step) => `- ${step}`).join('\n')}` : '',
    question.trim(),
  ].filter(Boolean).join('\n\n')
}

/**
 * What the inline window is showing.
 *
 * The answer and the three non-answers are separate states rather than one nullable string: a turn
 * still running, a refusal, and a reply with no words in it each need their own sentence, and folding
 * them together is how "nothing came back" gets said while the assistant is still writing.
 */
type TaskAskState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'answer', text: string }
  | { status: 'failed', message: string }
  | { status: 'empty' }

/**
 * The weekday buttons, Monday first as a calendar reads. The values are the rule's own: 0 is Sunday.
 * The labels are the assistant's weekday names, which are already translated and short enough for a
 * row of seven.
 */
const WEEKDAY_CHOICES: readonly { day: number, label: MessageKey }[] = [
  { day: 1, label: 'assistant.weekday.1' },
  { day: 2, label: 'assistant.weekday.2' },
  { day: 3, label: 'assistant.weekday.3' },
  { day: 4, label: 'assistant.weekday.4' },
  { day: 5, label: 'assistant.weekday.5' },
  { day: 6, label: 'assistant.weekday.6' },
  { day: 0, label: 'assistant.weekday.7' },
]

/** The positions a monthly nth-weekday rule can name: a month holds a given weekday at most five times. */
const NTH_CHOICES = [1, 2, 3, 4, 5] as const

/** The words one of those positions reads as. */
const NTH_LABELS: Record<(typeof NTH_CHOICES)[number], MessageKey> = {
  1: 'todo.repeat.nth_1',
  2: 'todo.repeat.nth_2',
  3: 'todo.repeat.nth_3',
  4: 'todo.repeat.nth_4',
  5: 'todo.repeat.nth_5',
}

/** The nth weekday of a month that its `day` is, as the repeat rule counts it. */
function nthOfMonth(day: number): number {
  return Math.ceil(day / 7)
}

/** The day of `month` that is the nth `weekday`, falling back to the month's last one when it has four. */
function dayOfNthWeekday(year: number, month: number, weekday: number, nth: number): number {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const day = 1 + (weekday - firstWeekday + 7) % 7 + (nth - 1) * 7
  return day <= daysInMonth(year, month) ? day : day - 7
}

/**
 * The half of a rule this panel edits: the series rather than the rhythm.
 *
 * `produced` rides with them although no control shows it. The counter is what makes a bounded series
 * end where the reader said, and a save writes the rule whole, so a panel that dropped it would start
 * a series again from its first occurrence every time it edited the title.
 */
type RepeatSeries = Pick<RepeatRule, 'untilAt' | 'count' | 'produced' | 'paused' | 'fromCompletionDate' | 'excludedDays'>

const NO_SERIES: RepeatSeries = {}

/** The series a row or a quick-add draft already carries; an absent limit reads as no limit. */
function seriesOf(rule: RepeatRule | null | undefined): RepeatSeries {
  if (!rule) return NO_SERIES
  return {
    untilAt: rule.untilAt ?? null,
    count: rule.count ?? null,
    produced: rule.produced,
    paused: rule.paused,
    fromCompletionDate: rule.fromCompletionDate,
    excludedDays: rule.excludedDays,
  }
}

/**
 * The last instant of a day the picker names.
 *
 * The ceiling is compared against the instants the occurrences land on, so a day stored at its own
 * midnight would stop a series an occurrence the reader asked to include: "until the 31st" means the
 * report owed at nine on the 31st still comes.
 */
function endOfLocalDay(key: string, timeZone: string): number | null {
  if (!key) return null
  const nextDay = parseLocalTime(addDaysKey(key, 1), timeZone)
  return nextDay === null ? parseLocalTime(key, timeZone) : nextDay - 1
}

/** The number the occurrences box holds; empty text is the reader clearing the ceiling. */
function countOrNull(text: string): number | null {
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return Math.max(MIN_REPEAT_COUNT, Math.min(MAX_REPEAT_COUNT, Math.trunc(value)))
}

/**
 * The series as the row stores it: the fields that carry an answer, and only those.
 *
 * The controls hold `null` for "no ceiling" because a box needs something to show, but a rule that
 * reads `untilAt: null, count: null, paused: undefined` states five absences the reader would have to
 * decode, and every one of them is already what a missing field means to the server, to the counter
 * and to the next time this panel opens. Keeping the stored shape minimal is also what makes the rule
 * this panel writes read back as the rule it wrote.
 */
function storedSeries(series: RepeatSeries): RepeatSeries {
  const stored: RepeatSeries = {}
  if (series.untilAt != null) stored.untilAt = series.untilAt
  if (series.count != null) stored.count = series.count
  if (series.produced != null) stored.produced = series.produced
  if (series.paused) stored.paused = true
  if (series.fromCompletionDate) stored.fromCompletionDate = true
  if (series.excludedDays?.length) stored.excludedDays = series.excludedDays
  return stored
}

/**
 * The due field's wall-clock reading, in the one shape the field and the route both take.
 *
 * The time is carried only when the date being replaced had one: a task nobody has owed at an hour
 * yet stays a day, and picking a weekday does not quietly invent a 00:00 it will remind at.
 */
function dueKey(year: number, month: number, day: number, hour: number, minute: number, timed: boolean): string {
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return timed ? `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : date
}

/**
 * What the start field opens with.
 *
 * An existing task reads its own start; a draft carries one of the two shapes `dueAt` does — an
 * instant, or a local `YYYY-MM-DD[THH:MM]` the picker wrote — and a draft that names neither opens
 * empty, exactly as the due field beside it does. The calendar's box-select seeds a draft with the
 * local shape, so a selection drawn at 09:00–10:30 arrives in the field as those two clock times.
 */
export function seedStartText(
  source: { startAt?: number | string | null },
  task: { startAt?: number | null } | null | undefined,
  timezone: string,
): string {
  if (task) return dueValue(task.startAt ?? null, timezone)
  if (typeof source.startAt === 'string') return source.startAt
  return source.startAt ? dueValue(source.startAt, timezone) : ''
}

export function TaskEditor() {
  const open = useTodos((state) => state.editorOpen)
  const draft = useTodos((state) => state.draft)
  const lists = useTodos((state) => state.lists)
  const tags = useTodos((state) => state.tags)
  const tasks = useTodos((state) => state.tasks)
  const completed = useTodos((state) => state.completed)
  const timezone = useTodos((state) => state.timezone)
  const saving = useTodos((state) => state.saving)
  const close = useTodos((state) => state.closeEditor)
  const createTask = useTodos((state) => state.createTask)
  const updateTask = useTodos((state) => state.updateTask)
  const removeTask = useTodos((state) => state.removeTask)
  const addStep = useTodos((state) => state.addStep)
  const updateStep = useTodos((state) => state.updateStep)
  const removeStep = useTodos((state) => state.removeStep)

  const existing = useMemo(() => {
    if (!draft?.id) return null
    return tasks.find((task) => task.id === draft.id) ?? completed.find((task) => task.id === draft.id) ?? null
  }, [draft?.id, tasks, completed])

  /**
   * The three days a reader sets most often, as one press each.
   *
   * They write the same `YYYY-MM-DD` the picker writes — an all-day due date — so the chips and the
   * field can never disagree about what "tomorrow" means.
   */
  const quickDates = useMemo(() => {
    const today = localDate(Date.now(), timezone)
    return [
      { key: 'today', label: t('todo.date.today'), value: today },
      { key: 'tomorrow', label: t('todo.date.tomorrow'), value: addDaysKey(today, 1) },
      { key: 'nextWeek', label: t('todo.date.next_week'), value: addDaysKey(today, 7) },
    ]
  }, [timezone])

  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [notesMode, setNotesMode] = useState<'edit' | 'preview'>('edit')
  const [priority, setPriority] = useState<TodoPriority>('medium')
  const [starred, setStarred] = useState(false)
  const [dueText, setDueText] = useState('')
  const [startText, setStartText] = useState('')
  /**
   * What the reader plans the task to take, and whether the words in the box can be honoured.
   *
   * The number is the picker's own ladder read back through the shared duration grammar, so the panel and
   * the row's chip never disagree about what `1h20m` means. `estimateInvalid` is kept beside it rather
   * than folded in because "no plan" (`null`) and "words nobody has read yet" are different answers: the
   * first is a value a save must write, the second is a save that must not happen at all.
   */
  const [estimate, setEstimate] = useState<number | null>(null)
  const [estimateInvalid, setEstimateInvalid] = useState(false)
  /**
   * How many times this panel has read the row it was opened on.
   *
   * The picker holds its own draft of the number — it is the control the chip's dialog mounts per opening,
   * keyed by what changed — so this panel re-keys it on the same event that re-reads every other field.
   * Keying it by the estimate itself would be the other mistake: the reader's own pick moves that state,
   * and remounting then would wipe the custom box mid-word.
   */
  const [seed, setSeed] = useState(0)
  const [listId, setListId] = useState('')
  /**
   * The task's own face: a glyph and a colour of its own, or null to wear the list's.
   *
   * Both start empty rather than on a default, because "not set" is the ordinary case — a task
   * without a face of its own reads as its list, which is what every row did before tasks could
   * carry one.
   */
  const [icon, setIcon] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)
  const [repeat, setRepeat] = useState<'none' | RepeatFrequency>('none')
  const [interval, setInterval] = useState(1)
  /** The named weekdays of a weekly rule, and which day a monthly rule lands on. */
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [monthlyMode, setMonthlyMode] = useState<RepeatMonthlyMode>('day')
  /**
   * What the series around the rhythm does: when it ends, whether it is paused, which days it steps
   * over. One object rather than five fields, because the five are one answer — the shape of the
   * series — and every one of them is saved or dropped together.
   */
  const [series, setSeries] = useState<RepeatSeries>(NO_SERIES)
  /**
   * The preset picker is an "add" control, not the value: the list on the right of it is what the task
   * saves. The select stays in the form because it is the fastest way to add the common four, and its
   * value is reset after each add so picking the same preset twice adds it twice rather than doing
   * nothing.
   */
  const [remind, setRemind] = useState<RemindOffset>('none')
  const [reminders, setReminders] = useState<number[]>([])
  const [tagNames, setTagNames] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  /** The account's tags this task does not wear yet — the menu's rows. */
  const tagRef = useRef<HTMLInputElement>(null)
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const [steps, setSteps] = useState<TaskStep[]>([])
  const [stepInput, setStepInput] = useState('')
  /** One move at a time: two presses in flight would each resolve against the order before the other. */
  const [ordering, setOrdering] = useState(false)
  const [askQuestion, setAskQuestion] = useState('')
  const [askState, setAskState] = useState<TaskAskState>({ status: 'idle' })
  /** The turn outlives the panel's re-renders; a write after unmount is the one thing it must not do. */
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!open) return
    const source = draft ?? {}
    const task = source.id ? tasks.find((entry) => entry.id === source.id) ?? completed.find((entry) => entry.id === source.id) : null
    const sourceDueAt = task ? task.dueAt : typeof source.dueAt === 'number' ? source.dueAt : null
    setTitle(task?.title ?? source.title ?? '')
    setNotes(task?.description ?? source.description ?? '')
    setNotesMode('edit')
    setPriority(task?.priority ?? source.priority ?? 'medium')
    setStarred(task?.starred ?? source.starred ?? false)
    setDueText(task
      ? dueValue(task.dueAt, timezone)
      : typeof source.dueAt === 'string' ? source.dueAt : source.dueAt ? dueValue(source.dueAt, timezone) : '')
    setStartText(seedStartText(source, task, timezone))
    // Both doors hand the same number in milliseconds — the row's own column, or the estimate a
    // quick-add line wrote into the draft — so the panel opens on it without parsing anything.
    setEstimate(task?.timeEstimateMs ?? source.timeEstimate ?? null)
    setEstimateInvalid(false)
    setSeed((count) => count + 1)
    setListId(task?.listId ?? source.listId ?? '')
    setIcon(task?.icon ?? source.icon ?? null)
    setColor(task?.color ?? source.color ?? null)
    setRepeat(task?.repeat?.freq ?? source.repeat?.freq ?? 'none')
    setInterval(task?.repeat?.interval ?? source.repeat?.interval ?? 1)
    setWeekdays(task?.repeat?.weekdays ?? source.repeat?.weekdays ?? [])
    setMonthlyMode(task?.repeat?.monthlyMode ?? source.repeat?.monthlyMode ?? 'day')
    setSeries(seriesOf(task?.repeat ?? source.repeat))
    // An existing task brings its pending list; a quick-add draft brings one instant. The select shows
    // the preset that instant equals, so a line typed as "15 minutes before" arrives with the same
    // words in the panel, while the list below is what will actually be saved.
    const initialReminders = task
      ? task.reminders ?? []
      : source.reminders ?? (typeof source.remindAt === 'number' ? [source.remindAt] : [])
    setReminders(normalizeReminderTimes(initialReminders))
    setRemind(remindOffsetOf({ dueAt: sourceDueAt, remindAt: initialReminders[0] ?? null }))
    setTagNames(task ? task.tags.map((tag) => tag.name) : source.tags ?? [])
    setStepInput('')
    setTagInput('')
    setTagMenuOpen(false)
    setSteps([])
    setAskQuestion('')
    setAskState({ status: 'idle' })
    if (task) {
      let alive = true
      void api.todos.get(task.id).then(({ steps: rows }) => { if (alive) setSteps(rows) }).catch((error: unknown) => {
        if (!alive) return
        // An empty list and a list that could not be read are different answers: the panel keeps the
        // empty one but says which it is, rather than letting a failed read read as "no steps".
        setSteps([])
        useUi.getState().toast({
          title: t('todo.task.steps_failed'),
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        })
      })
      return () => { alive = false }
    }
    return undefined
  }, [open, draft, tasks, completed, timezone])

  // Rendered only while the preview face is up: a note is prose, so the sanitized pipeline is the
  // only thing allowed to produce markup for it, and there is no reason to run it per keystroke on
  // the editing face.
  const notesHtml = useMemo(
    () => (notesMode === 'preview' && notes.trim() ? renderMarkdown(notes).html : ''),
    [notesMode, notes],
  )

  /** The tags the account already has and this task does not: the rows the field offers. */
  const tagSuggestions = useMemo(
    () => tags.filter((tag) => !tagNames.some((name) => name.toLowerCase() === tag.name.toLowerCase())),
    [tags, tagNames],
  )

  /**
   * The date a monthly nth-weekday rule reads, in the reader's own calendar.
   *
   * The rule names no position of its own — `nextOccurrence` takes both the nth and the weekday out of
   * the due date — so this is that same reading, and the two controls below move the due date rather
   * than keeping a second answer a save would have to reconcile. With no due date yet, the reader's own
   * today names the month, and the day the picker writes stays without an hour: nothing was owed at one.
   */
  const nthWeekday = useMemo(() => {
    const at = dueText ? parseLocalTime(dueText, timezone) : null
    const parts = getZonedParts(new Date(at ?? Date.now()), timezone)
    return {
      year: parts.year,
      month: parts.month,
      nth: nthOfMonth(parts.day),
      weekday: parts.weekday,
      hour: parts.hour,
      minute: parts.minute,
      timed: at !== null && dueText.includes('T'),
    }
  }, [dueText, timezone])

  /** Makes the due date the nth weekday of its own month, keeping the time it was owed at. */
  const pickNthWeekday = (nth: number, weekday = nthWeekday.weekday): void => {
    const { year, month, hour, minute, timed } = nthWeekday
    setDueText(dueKey(year, month, dayOfNthWeekday(year, month, weekday, nth), hour, minute, timed))
  }

  const patchSeries = (patch: Partial<RepeatSeries>): void => {
    setSeries((current) => ({ ...current, ...patch }))
  }

  /**
   * The whole rule as the panel reads it: the rhythm and the series together.
   *
   * Built once and used twice — the save writes it, and the day below is found by running it — so the
   * two cannot disagree about what pressing Save stores. Nothing is left out of it, because the server
   * replaces the stored rule with exactly this: a field the panel forgot is a field that is gone.
   */
  const rule: RepeatRule | null = repeat === 'none' ? null : {
    freq: repeat,
    interval: Math.max(MIN_REPEAT_INTERVAL, Math.min(MAX_REPEAT_INTERVAL, interval)),
    ...(repeat === 'weekly' && weekdays.length ? { weekdays: [...weekdays].sort((a, b) => a - b) } : {}),
    ...(repeat === 'monthly' && monthlyMode !== 'day' ? { monthlyMode } : {}),
    ...storedSeries(series),
  }

  /**
   * The day the next occurrence would land on, and so the one the skip button lets go of.
   *
   * Counted the way the server counts it — from the old due date, or from today when the series runs
   * from the day the reader finishes — because "the next one" has to mean the occurrence the reader is
   * about to be owed, not whichever day the panel happens to open on.
   */
  const nextOccurrenceDay = (() => {
    if (!rule) return null
    const fromForm = dueText ? parseLocalTime(dueText, timezone) : null
    const anchor = rule.fromCompletionDate ? Date.now() : (fromForm ?? Date.now())
    return localDate(nextOccurrence(anchor, rule, timezone), timezone)
  })()

  const excludedDays = series.excludedDays ?? []

  const excludeDay = (day: string): void => {
    patchSeries({ excludedDays: [...new Set([...excludedDays, day])].sort() })
  }

  const save = async (): Promise<void> => {
    const body = {
      title: title.trim(),
      description: notes,
      priority,
      starred,
      dueAt: dueText ? dueText : null,
      startAt: startText ? startText : null,
      // The plan rides the same write as every other field of this panel. `null` is sent rather than
      // left out because taking an estimate away is an answer the reader gave, not an absence.
      timeEstimate: estimate,
      listId: listId || null,
      icon,
      color,
      repeat: rule,
      reminders,
      tags: tagNames,
    }
    // Refused rather than half-written: the words in the estimate box are not a duration, and saving the
    // rest would drop what the reader typed without saying so. The field itself says it (role="alert"),
    // and the footer's save is disabled for the same reason, so the panel is never left with a press that
    // quietly does nothing.
    if (!body.title || estimateInvalid) return
    if (existing) await updateTask(existing.id, body)
    // The spent half of a quick-add pair is the one thing this panel hands on without owning it: no
    // field of the form shows it, because it is a ledger span rather than a column of the row. Reading
    // it off the opening draft — and only off a draft that names no row — is what keeps this door the
    // same shape as the board's inline enter, which forwards the same field to the same ledger write.
    else await createTask({
      ...body,
      steps: steps.map((step) => step.text),
      ...(draft?.id === undefined && draft?.timeLoggedMs !== undefined
        ? { timeLoggedMs: draft.timeLoggedMs }
        : {}),
    })
    close()
  }

  /**
   * Delete this row at once.
   *
   * One row needs no question: the store's toast already carries the way back — the same stamped row
   * restored, not a copy — and a reader who misses the window still has the trash. A group of more than
   * one asks first, and that question lives with the batch bar (`task-menu.ts`'s `confirmBatchDelete`).
   */
  const remove = async (): Promise<void> => {
    if (!existing) return
    await removeTask(existing.id)
    close()
  }

  /**
   * Adds one preset from the due date the form currently reads.
   *
   * The instant is computed now rather than at save: a reminder is an absolute time, and moving the
   * due date afterwards must not drag it along. With no readable due date there is nothing to count
   * back from, so the select simply returns to "off" — the add-row below still works.
   */
  const addPreset = (offset: RemindOffset): void => {
    const dueAt = parseLocalTime(dueText, timezone)
    const at = remindAtFor(dueAt, offset)
    if (at !== null) setReminders((current) => normalizeReminderTimes([...current, at]))
    setRemind('none')
  }

  const addTag = (): void => {
    const name = tagInput.replace(/^#+/, '').trim()
    if (!name) return
    setTagNames((current) => (current.some((entry) => entry.toLowerCase() === name.toLowerCase()) ? current : [...current, name]))
    setTagInput('')
    setTagMenuOpen(false)
  }

  /**
   * Moves one step up or down in the panel.
   *
   * Buttons rather than a drag, so every row is reachable from the keyboard and the two ends disable
   * instead of wrapping. A draft has no row to patch yet and moves in the local list it saves with;
   * an existing task sends the index the step should land on and reads the order back, because the
   * server resolves that index against the order it currently holds.
   */
  const moveStep = async (index: number, delta: -1 | 1): Promise<void> => {
    const target = index + delta
    if (ordering || target < 0 || target >= steps.length) return
    const moving = steps[index]!
    if (!existing) {
      setSteps((current) => {
        const next = [...current]
        const [step] = next.splice(index, 1)
        next.splice(target, 0, step!)
        return next
      })
      return
    }
    setOrdering(true)
    try {
      // The route takes the zero-based landing index; the shared client type still describes the
      // text/tick patch, so the body is widened here rather than cast at the call.
      const body: { text?: string; done?: boolean; position?: number } = { position: target }
      await api.todos.updateStep(existing.id, moving.id, body)
      const { steps: rows } = await api.todos.get(existing.id)
      setSteps(rows)
    } catch (error) {
      useUi.getState().toast({
        title: t('todo.toast.failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setOrdering(false)
    }
  }

  /**
   * Ask about the task as the panel currently reads it.
   *
   * `sendForAnswerDetailed` is the existing single-turn transport: it streams through the assistant's
   * own channel and hands back this question's answer, or names why there is none. Nothing is opened
   * or navigated — the reader stays in the editor and the answer lands under the field.
   */
  const ask = async (): Promise<void> => {
    const question = askQuestion.trim()
    if (!existing || !question || askState.status === 'loading') return
    setAskState({ status: 'loading' })
    let result: AnswerResult
    try {
      result = await sendForAnswerDetailed(taskAskPrompt({
        id: existing.id,
        title,
        notes,
        steps: steps.map((step) => step.text),
      }, question))
    } catch (error) {
      if (!mounted.current) return
      setAskState({
        status: 'failed',
        message: error instanceof Error && error.message ? error.message : t('todo.task.ai_failed'),
      })
      return
    }
    if (!mounted.current) return
    switch (result.status) {
      case 'ok':
        setAskState({ status: 'answer', text: result.text })
        return
      case 'empty':
        setAskState({ status: 'empty' })
        return
      case 'busy':
        setAskState({ status: 'failed', message: t('assistant.edit.busy') })
        return
      default:
        setAskState({ status: 'failed', message: result.error ?? t('todo.task.ai_failed') })
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={existing ? t('todo.task.edit_title') : t('todo.task.new_title')}
      width={560}
      footer={(
        <div className="flex w-full items-center gap-2">
          {existing && (
            <Button variant="danger" size="sm" onClick={() => { void remove() }}>
              <Trash2 size={14} />{t('todo.action.delete')}
            </Button>
          )}
          <span className="ml-auto" />
          <Button variant="ghost" size="sm" onClick={close}>{t('todo.action.cancel')}</Button>
          <Button size="sm" disabled={!title.trim() || saving || estimateInvalid} onClick={() => { void save() }}>{t('todo.action.save')}</Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <IconButton
            label={starred ? t('todo.task.unstar') : t('todo.task.star')}
            active={starred}
            size="sm"
            onClick={() => setStarred((value) => !value)}
          >
            <Star size={15} className={starred ? 'text-[var(--warning)]' : 'text-[var(--text-quaternary)]'} fill={starred ? 'currentColor' : 'none'} />
          </IconButton>
          <Input
            autoFocus
            value={title}
            placeholder={t('todo.task.title_label')}
            aria-label={t('todo.task.title_label')}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save() }}
            className="flex-1"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.task.notes_label')}</span>
            <Segmented
              size="sm"
              value={notesMode}
              onChange={setNotesMode}
              label={t('todo.task.notes_view')}
              options={[
                { value: 'edit', label: t('todo.action.edit') },
                { value: 'preview', label: t('common.preview') },
              ]}
            />
          </div>
          {notesMode === 'edit' ? (
            <Textarea
              value={notes}
              rows={3}
              placeholder={t('todo.task.notes_label')}
              aria-label={t('todo.task.notes_label')}
              onChange={(event) => setNotes(event.target.value)}
            />
          ) : (
            // `notesHtml` is what `renderMarkdown` sanitized, never the note text: the same hand-off
            // every chat message and preview card makes.
            <div
              role="region"
              aria-label={t('todo.task.notes_preview')}
              className="min-h-10 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2"
            >
              {notesHtml
                ? <div className="ink-prose text-[length:var(--text-12-5)] text-[var(--text-primary)]" dangerouslySetInnerHTML={{ __html: notesHtml }} />
                : <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.task.notes_preview_empty')}</span>}
            </div>
          )}
        </div>

        {/* Where the task came from, and the way back into a conversation about it. Both close the
            panel first: the chat tab is a different container, and a dialog left open over it would
            cover the composer the reader was just handed. */}
        {existing && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => { close(); startChatAboutTask(existing) }}>
              <Sparkles size={13} />{t('todo.task.ask_ai')}
            </Button>
            {existing.conversationId && (
              <Button variant="ghost" size="sm" onClick={() => { close(); openConversationInChat(existing.conversationId!) }}>
                <MessagesSquare size={13} />{t('todo.task.from_chat')}
              </Button>
            )}
          </div>
        )}

        {/* The question stays in the panel: the task is the context, and the answer belongs beside the
            fields it is about rather than in a tab the reader has to leave the edit for. */}
        {existing && (
          <section
            aria-label={t('todo.task.ai_title')}
            className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5">
              <Sparkles size={13} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
                {t('todo.task.ai_title')}
              </span>
              {askState.status !== 'idle' && (
                <IconButton
                  label={t('todo.task.ai_clear')}
                  size="sm"
                  onClick={() => { setAskState({ status: 'idle' }); setAskQuestion('') }}
                >
                  <X size={12} />
                </IconButton>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                value={askQuestion}
                placeholder={t('todo.task.ai_placeholder')}
                aria-label={t('todo.task.ai_placeholder')}
                onChange={(event) => setAskQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void ask() }
                }}
                className="flex-1"
              />
              <Button
                size="sm"
                aria-label={t('todo.task.ai_send')}
                loading={askState.status === 'loading'}
                disabled={!askQuestion.trim()}
                onClick={() => { void ask() }}
              >
                {t('todo.task.ai_send')}
              </Button>
            </div>
            {askState.status === 'loading' && (
              <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {t('todo.task.ai_thinking')}
              </p>
            )}
            {askState.status === 'failed' && (
              <p role="alert" className="break-words text-[length:var(--text-11-5)] text-[var(--danger)]">
                {askState.message}
              </p>
            )}
            {askState.status === 'empty' && (
              <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {t('todo.task.ai_empty')}
              </p>
            )}
            {askState.status === 'answer' && (
              <div
                role="region"
                aria-label={t('todo.task.ai_answer')}
                aria-live="polite"
                className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1.5 text-[length:var(--text-12-5)] leading-[1.65] text-[var(--text-primary)]"
              >
                {askState.text}
              </div>
            )}
          </section>
        )}

        {/* One column on a phone: two date pickers across 360px leave each one too narrow to read. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label={t('todo.task.priority_label')}>
            <Segmented<TodoPriority>
              value={priority}
              onChange={setPriority}
              label={t('todo.task.priority_label')}
              className="w-full [&_button]:flex-1"
              options={PRIORITIES.map((entry) => ({
                value: entry,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn('size-1.5 shrink-0 rounded-full', priorityDot(entry))} aria-hidden="true" />
                    {priorityLabel(entry)}
                  </span>
                ),
              }))}
            />
          </Field>
          <Field label={t('todo.task.list_label')}>
            <SelectMenu
              label={t('todo.task.list_label')}
              value={listId}
              onChange={setListId}
              options={[
                { value: '', label: t('todo.smart.inbox') },
                ...lists.map((list) => ({
                  value: list.id,
                  label: list.name,
                  icon: list.icon
                    ? <ListIcon icon={list.icon} size={13} />
                    : <span className="size-2 rounded-full" style={{ backgroundColor: list.color ?? 'var(--accent)' }} aria-hidden="true" />,
                })),
              ]}
            />
          </Field>
          <Field label={t('todo.task.due_label')}>
            <div className="flex flex-col gap-1.5">
              <DatePicker label={t('todo.task.due_label')} value={dueText} withTime onChange={setDueText} />
              <div className="flex flex-wrap items-center gap-1">
                {quickDates.map((choice) => (
                  <button
                    key={choice.key}
                    type="button"
                    onClick={() => setDueText(choice.value)}
                    className={cn(
                      'inline-flex min-h-9 items-center rounded-full border px-2.5 text-[length:var(--text-11)] transition-colors',
                      dueText.slice(0, 10) === choice.value
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                        : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {choice.label}
                  </button>
                ))}
                {dueText && (
                  <button
                    type="button"
                    onClick={() => setDueText('')}
                    className="inline-flex min-h-9 items-center rounded-full px-2 text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:text-[var(--danger)]"
                  >
                    {t('todo.date.clear')}
                  </button>
                )}
              </div>
            </div>
          </Field>
          {/* The day the work becomes available, separate from the day it is owed. Left empty is the
              ordinary case: a task is actionable from the moment it is filed. */}
          <Field label={t('todo.task.start_label')}>
            <DatePicker label={t('todo.task.start_label')} value={startText} withTime onChange={setStartText} />
          </Field>
          {/* How long the reader plans the work to take, on the row's own ladder and in the row's own
              grammar: the same `EstimatePicker` the chip on the listing opens, so one screen never says
              `90` while the other means an hour and a half. This is the other door to the plan — the one
              a task reaches when it is being written up rather than timed. */}
          <Field label={t('todo.time.label')}>
            <div className="flex flex-col gap-1.5">
              <EstimatePicker
                key={seed}
                estimate={estimate}
                onChange={(edit) => {
                  setEstimate(edit.value)
                  setEstimateInvalid(edit.invalid)
                }}
              />
            </div>
          </Field>
          {/* The select sits where the single-reminder field always did and adds one instant to the
              list below; the list, not the select, is what the task saves. */}
          <Field label={t('todo.task.reminder_preset')}>
            <SelectMenu
              label={t('todo.task.reminder_preset')}
              value={remind}
              onChange={(next) => addPreset(next as RemindOffset)}
              options={REMIND_OFFSETS.map((entry) => ({ value: entry, label: t(`todo.remind.${entry}`) }))}
            />
          </Field>
          <Field label={t('todo.task.repeat_label')}>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <SelectMenu
                  className="flex-1"
                  label={t('todo.task.repeat_label')}
                  value={repeat}
                  onChange={(next) => setRepeat(next as 'none' | RepeatFrequency)}
                  options={[
                    { value: 'none', label: t('todo.repeat.none') },
                    ...REPEAT_FREQUENCIES.map((entry) => ({ value: entry, label: t(`todo.repeat.${entry}`) })),
                  ]}
                />
                {repeat !== 'none' && (
                  <Input
                    type="number"
                    min={MIN_REPEAT_INTERVAL}
                    max={MAX_REPEAT_INTERVAL}
                    value={interval}
                    aria-label={t('todo.repeat.every', { count: interval, unit: '' })}
                    onChange={(event) => setInterval(Number(event.target.value) || 1)}
                    className="w-16"
                  />
                )}
              </div>
              {/* No day picked is the plain "every N weeks" rhythm; picking days narrows it to those
                  days, which is what "every Monday, Wednesday and Friday" is. */}
              {repeat === 'weekly' && (
                <div role="group" aria-label={t('todo.repeat.weekdays')} className="flex flex-wrap items-center gap-1">
                  {WEEKDAY_CHOICES.map((choice) => {
                    const active = weekdays.includes(choice.day)
                    return (
                      <button
                        key={choice.day}
                        type="button"
                        aria-pressed={active}
                        aria-label={t(choice.label)}
                        onClick={() => setWeekdays((current) => (active
                          ? current.filter((day) => day !== choice.day)
                          : [...current, choice.day]))}
                        className="flex size-9 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] aria-pressed:border-[var(--accent)] aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-[var(--accent-on-soft)] md:size-7"
                      >
                        {t(choice.label)}
                      </button>
                    )
                  })}
                </div>
              )}
              {repeat === 'monthly' && (
                <SelectMenu
                  label={t('todo.repeat.monthly_mode')}
                  value={monthlyMode}
                  onChange={(next) => setMonthlyMode(next as RepeatMonthlyMode)}
                  options={[
                    { value: 'day', label: t('todo.repeat.monthly_day') },
                    { value: 'lastDay', label: t('todo.repeat.last_day') },
                    { value: 'nthWeekday', label: t('todo.repeat.nth_weekday') },
                  ]}
                />
              )}
              {repeat === 'monthly' && monthlyMode === 'nthWeekday' && (
                // The rule reads its position off the due date, so these two controls move that date
                // rather than storing a third answer: picking "the 3rd Friday" makes the task owed on
                // the 3rd Friday, and every month after it lands on the same one.
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SelectMenu
                      className="w-auto min-w-[96px]"
                      label={t('todo.repeat.nth')}
                      value={String(nthWeekday.nth)}
                      onChange={(next) => pickNthWeekday(Number(next))}
                      options={NTH_CHOICES.map((entry) => ({ value: String(entry), label: t(NTH_LABELS[entry]) }))}
                    />
                    <div role="group" aria-label={t('todo.repeat.weekdays')} className="flex flex-wrap items-center gap-1">
                      {WEEKDAY_CHOICES.map((choice) => (
                        <button
                          key={choice.day}
                          type="button"
                          aria-pressed={choice.day === nthWeekday.weekday}
                          aria-label={t(choice.label)}
                          onClick={() => pickNthWeekday(nthWeekday.nth, choice.day)}
                          className="flex size-9 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] aria-pressed:border-[var(--accent)] aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-[var(--accent-on-soft)] md:size-7"
                        >
                          {t(choice.label)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {repeat !== 'none' && (
                // The series around the rhythm: how often comes from the four controls above, how long
                // is set here. A reader who asks for "every Monday for six weeks" sets both, and the
                // two are stored in the one rule the server replaces whole.
                <div
                  role="group"
                  aria-label={t('todo.repeat.series')}
                  className="flex flex-col gap-1.5 border-t border-[var(--border-subtle)] pt-1.5"
                >
                  <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
                    {t('todo.repeat.series')}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <DatePicker
                      className="flex-1"
                      label={t('todo.repeat.until')}
                      value={series.untilAt != null ? localDate(series.untilAt, timezone) : ''}
                      onChange={(value) => patchSeries({ untilAt: endOfLocalDay(value, timezone) })}
                    />
                    <Input
                      type="number"
                      min={MIN_REPEAT_COUNT}
                      max={MAX_REPEAT_COUNT}
                      value={series.count ?? ''}
                      aria-label={t('todo.repeat.count')}
                      onChange={(event) => patchSeries({ count: countOrNull(event.target.value) })}
                      className="w-16"
                    />
                  </div>
                  <Checkbox
                    checked={series.fromCompletionDate === true}
                    onChange={(next) => patchSeries({ fromCompletionDate: next })}
                    label={t('todo.repeat.from_completion')}
                  />
                  <Checkbox
                    checked={series.paused === true}
                    onChange={(next) => patchSeries({ paused: next })}
                    label={t('todo.repeat.paused')}
                  />
                  <div className="flex flex-col gap-1">
                    <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
                      {t('todo.repeat.excluded_label')}
                    </span>
                    {!excludedDays.length && (
                      <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                        {t('todo.repeat.excluded_none')}
                      </span>
                    )}
                    {!!excludedDays.length && (
                      <div role="group" aria-label={t('todo.repeat.excluded_label')} className="flex flex-wrap items-center gap-1">
                        {excludedDays.map((day) => (
                          <button
                            key={day}
                            type="button"
                            aria-label={t('todo.repeat.excluded_remove', { day })}
                            onClick={() => patchSeries({ excludedDays: excludedDays.filter((entry) => entry !== day) })}
                            className="flex h-7 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-1.5 text-[length:var(--text-11)] tabular-nums text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                          >
                            {day}
                            <X size={11} />
                          </button>
                        ))}
                      </div>
                    )}
                    {nextOccurrenceDay && (
                      <Button variant="ghost" size="sm" onClick={() => excludeDay(nextOccurrenceDay)}>
                        {t('todo.repeat.skip_next')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Field>
        </div>

        {/* The task's own face, in the two fields that set it. Neither is required: a task that names
            neither wears its list's, which is what every row showed before a task could have one of
            its own — so the colour panel leads with "none of its own" instead of a default. */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.task.color')}</span>
          <ColorPicker value={color} onChange={setColor} allowNone />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.task.icon')}</span>
            {icon && (
              <IconButton label={t('todo.list.icon_clear')} size="sm" onClick={() => setIcon(null)}>
                <X size={12} />
              </IconButton>
            )}
          </div>
          <ListIconPicker value={icon} onChange={setIcon} />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.task.reminders_label')}</span>
            <span className="text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
              {reminders.length}/{MAX_REMINDERS_PER_TASK}
            </span>
          </div>
          {reminders.length === 0 && (
            <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.task.reminder_none')}</span>
          )}
          {reminders.map((at, index) => (
            <div key={`${at}-${index}`} className="flex items-center gap-1.5">
              <DatePicker
                label={t('todo.task.reminder_add')}
                value={dueValue(at, timezone)}
                withTime
                onChange={(value) => {
                  const parsed = parseLocalTime(value, timezone)
                  setReminders((current) => normalizeReminderTimes(parsed === null
                    ? current.filter((_, position) => position !== index)
                    : current.map((entry, position) => (position === index ? parsed : entry))))
                }}
              />
              <IconButton
                label={t('todo.task.reminder_remove')}
                size="sm"
                onClick={() => setReminders((current) => current.filter((_, position) => position !== index))}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          {reminders.length < MAX_REMINDERS_PER_TASK && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // A row has to start somewhere: the due date when there is one, otherwise an hour
                  // from now. The picker that appears is the reader's to change.
                  const fallback = parseLocalTime(dueText, timezone) ?? Date.now() + 60 * 60_000
                  setReminders((current) => normalizeReminderTimes([...current, fallback]))
                }}
              >
                <Plus size={13} />{t('todo.task.reminder_add')}
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.task.tags_label')}</span>
          <div className="flex flex-wrap items-center gap-1">
            {tagNames.map((name) => {
              const known = tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase())
              return (
                <TagPill
                  key={name}
                  tone="tinted"
                  label={name}
                  color={known?.color ?? 'var(--text-secondary)'}
                  trailing={(
                    <button
                      type="button"
                      aria-label={`${t('todo.action.delete')} ${name}`}
                      onClick={() => setTagNames((current) => current.filter((entry) => entry !== name))}
                      className="ml-0.5 flex size-4 items-center justify-center rounded-full text-current opacity-60 hover:opacity-100"
                    >
                      <X size={10} />
                    </button>
                  )}
                />
              )
            })}
            <Input
              ref={tagRef}
              value={tagInput}
              placeholder={t('todo.task.tags_label')}
              aria-label={t('todo.task.tags_label')}
              aria-expanded={tagMenuOpen && tagSuggestions.length > 0}
              aria-haspopup="menu"
              onChange={(event) => { setTagInput(event.target.value); setTagMenuOpen(true) }}
              onFocus={() => setTagMenuOpen(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addTag(); setTagMenuOpen(false) }
                if (event.key === 'Escape') setTagMenuOpen(false)
              }}
              className="w-32"
            />
            {/* The notebook's tag list, offered as the menu a `<datalist>` could not be: real rows with
                the tag's colour, reachable by keyboard, and no native popup in the middle of a dialog. */}
            <Menu
              anchor={tagRef}
              open={tagMenuOpen && tagSuggestions.length > 0}
              onClose={() => setTagMenuOpen(false)}
              align="start"
              width={200}
              label={t('todo.task.tags_label')}
              items={tagSuggestions.map((tag) => ({
                id: tag.id,
                label: tag.name,
                icon: <span className="size-2 rounded-full" style={{ backgroundColor: tag.color ?? 'var(--accent)' }} aria-hidden="true" />,
                onSelect: () => {
                  setTagNames((current) => [...current, tag.name])
                  setTagInput('')
                  setTagMenuOpen(false)
                },
              }))}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.task.steps_label')}</span>
          {steps.length === 0 && <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.task.no_steps')}</span>}
          {steps.map((step, index) => (
            <div key={step.id} className="flex items-center gap-2">
              <Checkbox
                checked={step.done}
                onChange={(done) => {
                  setSteps((current) => current.map((entry) => (entry.id === step.id ? { ...entry, done } : entry)))
                  if (existing) void updateStep(existing.id, step.id, { done })
                }}
                label={<span className={cn('block min-w-0 truncate text-[length:var(--text-12-5)]', step.done && 'text-[var(--text-tertiary)] line-through')}>{step.text}</span>}
                className="min-w-0 flex-1"
              />
              <IconButton
                label={t('quickadd.move_step_up')}
                size="sm"
                disabled={index === 0 || ordering}
                onClick={() => { void moveStep(index, -1) }}
              >
                <ChevronUp size={12} />
              </IconButton>
              <IconButton
                label={t('quickadd.move_step_down')}
                size="sm"
                disabled={index === steps.length - 1 || ordering}
                onClick={() => { void moveStep(index, 1) }}
              >
                <ChevronDown size={12} />
              </IconButton>
              <IconButton
                label={t('todo.action.delete')}
                size="sm"
                onClick={() => {
                  setSteps((current) => current.filter((entry) => entry.id !== step.id))
                  if (existing) void removeStep(existing.id, step.id)
                }}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <Input
              value={stepInput}
              placeholder={t('todo.task.step_add')}
              aria-label={t('todo.task.step_add')}
              onChange={(event) => setStepInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                const text = stepInput.trim()
                if (!text) return
                setStepInput('')
                if (existing) {
                  void addStep(existing.id, text).then((step) => {
                    if (step) setSteps((current) => [...current, step])
                  })
                } else {
                  setSteps((current) => [...current, {
                    id: `draft-${current.length}`, taskId: '', text, done: false, position: current.length, createdAt: Date.now(),
                  }])
                }
              }}
            />
            <IconButton label={t('todo.task.step_add')} size="sm" onClick={() => {
              const text = stepInput.trim()
              if (!text) return
              setStepInput('')
              if (existing) {
                void addStep(existing.id, text).then((step) => { if (step) setSteps((current) => [...current, step]) })
              } else {
                setSteps((current) => [...current, {
                  id: `draft-${current.length}`, taskId: '', text, done: false, position: current.length, createdAt: Date.now(),
                }])
              }
            }}>
              <Plus size={13} />
            </IconButton>
          </div>
        </div>
      </div>
    </Modal>
  )
}

type TodoPriority = 'low' | 'medium' | 'high' | 'urgent'
