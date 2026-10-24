/**
 * The two drafts the to-do tools answer with, read off a tool result.
 *
 * `plan_today` and `decompose_task` write nothing: they answer with a proposal the reader accepts or
 * edits. Until now those proposals arrived as JSON in the transcript and stopped there, so the reader
 * had to retype what the model had already spelled. This reads them into the one shape the chat can
 * offer a button for.
 *
 * A draft is data, not an instruction: the reader's press is what writes, and the answer says which
 * rows it touched rather than claiming a save it did not make.
 */

/** Why a row is on a plan, in the order the rule takes them. */
export type TodoDraftPlanReason = 'overdue' | 'starred_due' | 'unscheduled'

export interface TodoPlanDraftRow {
  id: string
  title: string
  reason: TodoDraftPlanReason
}

export type TodoToolDraft =
  | { kind: 'plan'; today: string; rows: TodoPlanDraftRow[] }
  | { kind: 'steps'; taskId: string; taskTitle: string; steps: string[] }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function day(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/** The shape every task id in this app has, so a row that is not one is never offered as a press. */
const TASK_ID = /^[0-9a-hjkmnp-tv-z]{26}$/

function taskId(value: unknown): string | null {
  return typeof value === 'string' && TASK_ID.test(value) ? value : null
}

/**
 * The draft one tool result carries, or null when it carries none.
 *
 * Read defensively: the payload is JSON a model produced, so every field is checked before it is
 * offered as a button. A row whose id is not an id is dropped rather than rendered as a press that
 * would fail.
 */
export function todoDraftFromToolResult(name: string, result: unknown): TodoToolDraft | null {
  const body = record(result)
  if (!body) return null

  if (name === 'plan_today' && Array.isArray(body.suggestions)) {
    const today = day(body.today)
    if (!today) return null
    const rows = body.suggestions.flatMap((entry) => {
      const row = record(entry)
      const id = taskId(row?.id)
      const title = text(row?.title, 300)
      const reason = row?.reason
      if (!id || !title) return []
      if (reason !== 'overdue' && reason !== 'starred_due' && reason !== 'unscheduled') return []
      return [{ id, title, reason: reason as TodoDraftPlanReason }]
    })
    return rows.length ? { kind: 'plan', today, rows } : null
  }

  if (name === 'decompose_task') {
    const task = record(body.task)
    const taskIdValue = taskId(task?.id)
    const steps = Array.isArray(body.steps)
      ? body.steps.flatMap((entry) => {
          const line = text(entry, 300)
          return line ? [line] : []
        })
      : []
    if (!taskIdValue || !steps.length) return null
    return { kind: 'steps', taskId: taskIdValue, taskTitle: text(task?.title, 300) ?? '', steps }
  }

  return null
}
