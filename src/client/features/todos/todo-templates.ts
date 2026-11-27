/**
 * A task's shape, kept under a name.
 *
 * Two pure functions and one rule. `draftToTemplate` reads a form into a shape, `templateToDraft`
 * writes a shape back into a form, and the rule between them is what a template deliberately does not
 * carry: no due date, no start date, no plan day, no reminders, no completion. Those are facts about
 * one occasion, and a template that kept them would file today's work in the past the first time it
 * was used — which is the one mistake the feature exists to prevent.
 *
 * Both live here rather than inside the editor because they are the whole contract, and a contract that
 * can be read on its own is one a test can pin without rendering a dialog.
 */
import type { TodoTemplate } from '@shared/types'
import type { TaskDraft } from './store'

/**
 * The form fields a template keeps, read off the editor's own state.
 *
 * The draft's fields are optional because a draft may be half-written; a template is only ever saved
 * from a form the reader filled in, so what this reads is the settled shape rather than the draft's.
 */
type TemplateSource = {
  title: string
  description: string
  priority: NonNullable<TaskDraft['priority']>
  listId: string | null
  timeEstimate: number | null
}

/**
 * The shape of a task on screen, under a name.
 *
 * The steps come from the editor's own list rather than from the row: the row's `steps` is a count,
 * and the text of each step is the thing a template is worth keeping for.
 */
export function draftToTemplate(
  source: TemplateSource,
  extra: { name: string; steps: readonly string[]; tags: readonly string[] },
): TodoTemplate {
  return {
    // The id is the name's own slug plus a stamp, so two templates may share a name without one
    // silently replacing the other: a reader who saves "Weekly report" twice gets two rows.
    id: `${slugOf(extra.name)}-${Date.now().toString(36)}`,
    name: extra.name.trim(),
    title: source.title.trim(),
    description: source.description,
    priority: source.priority,
    listId: source.listId,
    tags: [...extra.tags],
    steps: [...extra.steps],
    timeEstimate: source.timeEstimate ?? null,
  }
}

/** The draft a template fills a form with. No dates, no reminders — see this file's header. */
export function templateToDraft(template: TodoTemplate): TaskDraft {
  return {
    title: template.title,
    description: template.description,
    priority: template.priority,
    listId: template.listId,
    tags: [...template.tags],
    steps: [...template.steps],
    timeEstimate: template.timeEstimate,
  }
}

/** A name that survives being used as an id: lowercase, ascii letters and digits, hyphen-joined. */
function slugOf(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  // A name made entirely of characters an id cannot hold still has to produce one; `template` is the
  // neutral fallback rather than an empty string the settings merge would then reject.
  return slug || 'template'
}
