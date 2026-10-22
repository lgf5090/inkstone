/**
 * One quick-add line filed as a to-do instead of a note.
 *
 * The parse is the board's own `quickAddDraft`, so a due date, a priority, a tag and a list name mean
 * exactly what they mean in the board's quick-add field — two parsers would drift the day one learned
 * a word the other did not. The reminder is carried the way the board carries it: the parser answers
 * an instant, the store stores an offset from the due date, and `remindOffsetOf` is the one place that
 * translation lives. A line with no title is not a task; the caller turns the null into a visible
 * failure rather than dropping what the reader typed.
 */
import { quickAddDraft, remindOffsetOf, useTodos } from '../../features/todos/store'

export interface CreatedTodo {
  id: string
  title: string
}

export async function createTodoFromQuickAdd(text: string): Promise<CreatedTodo | null> {
  const state = useTodos.getState()
  const draft = quickAddDraft(text, Date.now(), state.timezone, state.lists)
  const title = draft?.title?.trim() ?? ''
  if (!draft || !title) return null
  const { remindAt, ...body } = draft
  const remind = remindAt != null && typeof body.dueAt === 'number'
    ? remindOffsetOf({ dueAt: body.dueAt, remindAt })
    : 'none'
  const task = await state.createTask({ ...body, title, ...(remind !== 'none' ? { remind } : {}) })
  return task ? { id: task.id, title: task.title } : null
}
