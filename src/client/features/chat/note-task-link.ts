/**
 * A note's checkbox, offered to the assistant's task list — one way, and only one way.
 *
 * The notebook keeps its tasks as checkboxes in the body of a note; the assistant keeps its own task
 * list (`chat_tasks`). Those are two different things, and they are deliberately not kept in step: a
 * checkbox and a task row both own "is this done", and the moment both sides can move, a sync has to
 * pick a winner for every disagreement and loses the reader's intent either way.
 *
 * So this file does the one direction that has a clear answer — the reader looking at a checkbox and
 * deciding it belongs on their task list — and nothing else. It creates an assistant task that carries
 * the note back-reference as its description, so whoever picks the task up can get to the page it came
 * from. It never writes the checkbox: the note stays the authority for that box, and the task is a copy
 * with a thread to follow, not a mirror.
 *
 * The due date rides along when the checkbox line carries one. The Tasks-plugin convention the vault
 * already parses (`[due:: 2024-01-01]`, or a 📅 date) is reused rather than reinvented, so the day the
 * reader wrote is the day the task lands on.
 */
import { createElement } from 'react'
import { CheckSquare } from 'lucide-react'
import type { MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { extractDate, extractInlineFields } from '../../lib/dataview/metadata'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'

/** A task checkbox line: optional blockquote/list marker, a `[ ]`/`[x]` box, then the text. */
const TASK_MARKER = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/

/**
 * A Tasks-plugin emoji date with its day. Matched with the `u` flag so the surrogate pair of each emoji
 * is one token, not two halves: `extractInlineFields` reports these emoji fields by byte index without
 * the flag, which is fine for reading the date but not for cutting the token back out of the title.
 */
const EMOJI_DATE = /[⌛⌚🛫✕✅📅📆🗓]️?\s*\d{4}-\d{2}-\d{2}/gu

export interface NoteTaskCheckbox {
  /** The checkbox's own words, with the marker and any inline date fields stripped. */
  title: string
  /** The due date written on the line, as the same end-of-day-local milliseconds the task list sorts by, or null. */
  dueAt: number | null
}

/** Whether the line is a task checkbox at all, and if so its title and any due date. */
export function parseNoteTaskCheckbox(line: string): NoteTaskCheckbox | null {
  const marker = TASK_MARKER.exec(line)
  if (!marker) return null
  const markerEnd = marker[0].length
  const content = line.slice(markerEnd)

  // One scan covers both spellings the vault reads (`[due:: …]` and the emoji dates), and the same ranges
  // are then cut out of the title — a task's words should not carry the field markers they were parsed from.
  const fields = extractInlineFields(line, true)
  const due = fields.find((hit) => hit.key.toLowerCase() === 'due')
  const dueDate = due ? extractDate(due.value) : null
  const dueAt = dueDate
    ? new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate(), 23, 59, 59, 999).getTime()
    : null

  let title = content
  for (const hit of fields.filter((entry) => entry.wrapping === '[' || entry.wrapping === '(').sort((a, b) => b.start - a.start)) {
    // Only the bracketed fields that live inside the text after the box, so nothing negative is spliced at.
    if (hit.start < markerEnd || hit.end <= markerEnd) continue
    title = `${title.slice(0, hit.start - markerEnd)}${title.slice(hit.end - markerEnd)}`
  }
  // The emoji dates are removed as whole tokens rather than by index (see EMOJI_DATE above).
  title = title.replace(EMOJI_DATE, ' ').replace(/\s+/g, ' ').trim()
  return { title, dueAt }
}

export interface NoteTaskInput {
  line: string
  noteId: string
  noteTitle: string
}

/** The create-task payload for one checkbox, or null when the line is not a task or says nothing. */
export function buildNoteTaskPayload(input: NoteTaskInput): { title: string, description: string, dueAt: number | null } | null {
  const checkbox = parseNoteTaskCheckbox(input.line)
  if (!checkbox || !checkbox.title) return null
  return {
    title: checkbox.title,
    // The way back to the page this came from. The task list shows `description` as plain text, so the
    // note's own deep link is spelled out next to its title rather than left as an unclickable wikilink.
    description: t('assistant.task.from_note', {
      title: input.noteTitle || t('common.untitled_note'),
      id: input.noteId,
    }),
    dueAt: checkbox.dueAt,
  }
}

/**
 * Creates the assistant task. One-way by construction: it writes a `chat_tasks` row and reloads the list,
 * and it never touches the note's content, so the checkbox keeps being whatever the note says it is.
 */
export async function createTaskFromNoteCheckbox(input: NoteTaskInput): Promise<boolean> {
  const payload = buildNoteTaskPayload(input)
  if (!payload) return false
  try {
    await api.assistant.createTask(payload)
    await useAssistant.getState().loadTasks()
    useUi.getState().toast({ title: t('assistant.task.made_from_note'), tone: 'success' })
    return true
  } catch (error) {
    useUi.getState().toast({
      title: t('assistant.toast.failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return false
  }
}

/**
 * The "turn into a task" row for the note's task context menu.
 *
 * It lives here, next to the parsing it depends on, so the menu builder that shows it is a single spread
 * (`...buildNoteTaskMenuItem(...)`) rather than a second copy of this logic. Returns null when the line
 * the menu was opened on is not a task with something to say, so the caller just omits the row.
 */
export function buildNoteTaskMenuItem(ctx: NoteTaskInput): MenuItem | null {
  const payload = buildNoteTaskPayload(ctx)
  if (!payload) return null
  return {
    id: 'task-to-assistant',
    label: t('contextmenu.task_to_assistant'),
    icon: createElement(CheckSquare, { size: 14 }),
    onSelect: () => {
      // The note title is read at press time, not when the menu was built, so a rename while the menu sat
      // open does not stamp the task with the page's older name.
      const note = useNotes.getState().notes[ctx.noteId]
      void createTaskFromNoteCheckbox({ line: ctx.line, noteId: ctx.noteId, noteTitle: note?.title ?? ctx.noteTitle })
    },
  }
}
