/**
 * The header vocabularies the CSV importer speaks.
 *
 * A generic importer reads column *names*, and the two apps people migrate from spell the same columns
 * differently — and, worse, number their priorities in opposite directions. Todoist's `4` is the most
 * urgent and its `CONTENT` is the title; TickTick's `5` is the most urgent and its `Content` is the note.
 * Reading either with the generic table would silently invert every priority and put the note where the
 * title goes, so the file is recognised first and read with that app's own vocabulary.
 *
 * The tables live here rather than in `worker/todos/import-csv.ts` because they are a vocabulary and not
 * a parser: a test can hold them against a real export without a database, and a third app is one more
 * entry rather than another branch inside the parser.
 */
import type { TaskPriority } from '../assistant'

/** The columns a row can be read into. Anything else in a file is ignored. */
export type TodoImportColumn = 'title' | 'notes' | 'due' | 'priority' | 'list' | 'tags' | 'completed'

export type TodoImportPresetId = 'generic' | 'todoist' | 'ticktick'

export interface TodoImportPreset {
  id: TodoImportPresetId
  /** The header cells, lowercased, that this app always writes — what identifies the file. */
  signature: readonly string[]
  /** Header spelling → column. `skip` names a column this app writes and this importer has no use for. */
  headers: Readonly<Record<string, TodoImportColumn | 'skip'>>
  /**
   * Priority cell → this app's four steps, lowercased.
   *
   * A table rather than a formula because the two scales are not a formula: one counts up to urgent and
   * the other counts down to it, and a shared `Number(cell)` would be the bug this exists to prevent.
   */
  priorities: Readonly<Record<string, TaskPriority>>
}

/** The spellings this app's own exports and hand-made files use. */
const GENERIC: TodoImportPreset = {
  id: 'generic',
  signature: [],
  headers: {
    title: 'title',
    notes: 'notes',
    description: 'notes',
    due: 'due',
    priority: 'priority',
    list: 'list',
    tags: 'tags',
    completed: 'completed',
  },
  priorities: {
    urgent: 'urgent',
    high: 'high',
    medium: 'medium',
    low: 'low',
    p1: 'urgent',
    p2: 'high',
    p3: 'medium',
    p4: 'low',
    '1': 'urgent',
    '2': 'high',
    '3': 'medium',
    '4': 'low',
  },
}

/**
 * A Todoist export: `TYPE,CONTENT,DESCRIPTION,PRIORITY,DUE DATE,LABELS,PROJECT`.
 *
 * `TYPE` is the row's kind ("task", "section", "note"); this importer has one kind of row, so a file
 * that carries sections imports them as tasks — the alternative, dropping rows the reader can see, is
 * the quieter of the two losses.
 */
const TODOIST: TodoImportPreset = {
  id: 'todoist',
  signature: ['type', 'content'],
  headers: {
    content: 'title',
    description: 'notes',
    'due date': 'due',
    labels: 'tags',
    project: 'list',
    priority: 'priority',
    type: 'skip',
  },
  priorities: {
    // Todoist's own scale: 1 is the lowest, 4 the highest.
    '1': 'low',
    '2': 'medium',
    '3': 'high',
    '4': 'urgent',
  },
}

/**
 * A TickTick export: `Title,Content,Priority,Due Date,Tags,List`.
 *
 * TickTick's `Content` is the note where Todoist's is the title, which is why the file has to be
 * identified before any header is read.
 */
const TICKTICK: TodoImportPreset = {
  id: 'ticktick',
  signature: ['title', 'content'],
  headers: {
    title: 'title',
    content: 'notes',
    'due date': 'due',
    tags: 'tags',
    list: 'list',
    priority: 'priority',
  },
  priorities: {
    // TickTick counts 0 none, 1 low, 3 medium, 5 high; the gaps are theirs, not a typo.
    '0': 'medium',
    '1': 'low',
    '3': 'medium',
    '5': 'high',
  },
}

/**
 * Every vocabulary, most specific first.
 *
 * Order is the whole detection: a file that carries Todoist's signature is read as Todoist even though
 * it also has a `title`-shaped header elsewhere, and the generic table — which has no signature — is
 * what is left when nothing matches.
 */
export const TODO_IMPORT_PRESETS: readonly TodoImportPreset[] = [TODOIST, TICKTICK, GENERIC]

/** The preset a header row speaks, judged by the cells it carries. */
export function presetFor(headers: readonly string[]): TodoImportPreset {
  const seen = new Set(headers.map((name) => name.trim().toLowerCase()))
  return TODO_IMPORT_PRESETS.find((preset) =>
    preset.signature.length > 0 && preset.signature.every((cell) => seen.has(cell))) ?? GENERIC
}

/** The column one header cell names, or null when the preset has nothing to say about it. */
export function columnFor(preset: TodoImportPreset, header: string): TodoImportColumn | null {
  const column = preset.headers[header.trim().toLowerCase()]
  return column === undefined || column === 'skip' ? null : column
}

/**
 * The priority one cell names.
 *
 * A cell outside the preset's table — a blank one, or a word from a language this file never saw — keeps
 * the app's default rather than being guessed at: an import that invented a priority would be worse than
 * one that left the row at `medium`.
 */
export function priorityFor(preset: TodoImportPreset, cell: string): TaskPriority {
  return preset.priorities[cell.trim().toLowerCase()] ?? 'medium'
}
