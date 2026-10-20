import type { Task } from '../model/task'
import type { StatusType } from '../status/status'
import { Field, TextField } from './field'
import { compareGroupKeys, invalidFilter, type Comparator, type FilterOrErrorMessage, type GrouperFunction } from './values'

const STATUS_TYPES: StatusType[] = ['TODO', 'DONE', 'IN_PROGRESS', 'ON_HOLD', 'CANCELLED', 'NON_TASK']

/**
 * `done` and `not done`, the two instructions almost every task query opens with.
 *
 * `not done` is the complement of the status's own "finished" answer, so a cancelled task is *not*
 * listed: the two are finished to a reader's eye, and the list a `not done` query feeds is the one of
 * things still to act on. A reader who wants cancelled work back asks for it directly with
 * `status.type is not CANCELLED`, or filters on the `cancelled` date.
 */
class DoneField extends Field {
  fieldName(): string {
    return 'done'
  }

  protected override filterRegExp(): RegExp {
    return new RegExp('^(not done|done)$', 'i')
  }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line.trim())
    if (matched === null) return invalidFilter(`unable to parse: ${line}`)
    const wantDone = matched[1]!.toLowerCase() === 'done'
    return { filter: (task) => task.status.isDone === wantDone, error: null }
  }

  override supportsSorting(): boolean {
    return true
  }

  comparator(): Comparator {
    return (a, b) => compareGroupKeys(a.status.typeGroupText, b.status.typeGroupText)
  }

  override supportsGrouping(): boolean {
    return true
  }

  override grouper(): GrouperFunction {
    return (task) => [task.status.typeGroupText]
  }
}

class StatusNameField extends TextField {
  fieldName(): string {
    return 'status.name'
  }

  protected matcher(): (task: Task) => string {
    return (task) => task.status.name
  }

  override supportsSorting(): boolean {
    return true
  }

  comparator(): Comparator {
    return (a, b) => compareGroupKeys(a.status.name, b.status.name)
  }

  override supportsGrouping(): boolean {
    return true
  }

  override grouper(): GrouperFunction {
    return (task) => [task.status.name]
  }
}

class StatusTypeField extends Field {
  fieldName(): string {
    return 'status.type'
  }

  protected override filterRegExp(): RegExp {
    return new RegExp(`^status\\.type (is|is not) (${STATUS_TYPES.join('|')})`, 'i')
  }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line.trim())
    if (matched === null) return invalidFilter(`Status type must be one of: ${STATUS_TYPES.join(', ')} - ${line}`)
    const negated = matched[1]!.toLowerCase() === 'is not'
    const wanted = matched[2]!.toUpperCase() as StatusType
    return { filter: (task) => (task.status.type === wanted) !== negated, error: null }
  }

  override supportsSorting(): boolean {
    return true
  }

  comparator(): Comparator {
    return (a, b) => compareGroupKeys(a.status.typeGroupText, b.status.typeGroupText)
  }

  override supportsGrouping(): boolean {
    return true
  }

  override grouper(): GrouperFunction {
    return (task) => [task.status.typeGroupText]
  }
}

export const doneField = new DoneField()
export const statusNameField = new StatusNameField()
export const statusTypeField = new StatusTypeField()

/** Ordered: `status.name` and `status.type` must be tried before the bare `status`. */
export const STATUS_FIELDS: Field[] = [statusNameField, statusTypeField, doneField]
