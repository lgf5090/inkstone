import { filenameOf, folderOf, rootOf } from '../model/task'
import { urgencyOf } from '../model/urgency'
import { PRIORITY_NAMES, Priority } from '../model/priority'
import type { Task } from '../model/task'
import { Field, MultiTextField, TextField } from './field'
import { compareGroupKeys, invalidFilter, makeSorter, type Comparator, type FilterOrErrorMessage, type GrouperFunction, type SearchInfo, type Sorter } from './values'

function textOf(read: (task: Task) => string): (task: Task) => string {
  return read
}

class PathField extends TextField {
  fieldName(): string { return 'path' }
  protected matcher() { return textOf((task) => task.location.path) }
  override supportsSorting(): boolean { return true }
  comparator(): Comparator { return (a, b) => compareGroupKeys(a.location.path, b.location.path) }
  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction { return (task) => [task.location.path] }
}

class FolderField extends TextField {
  fieldName(): string { return 'folder' }
  protected matcher() { return textOf(folderOf) }
  override supportsSorting(): boolean { return true }
  comparator(): Comparator { return (a, b) => compareGroupKeys(folderOf(a), folderOf(b)) }
  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction { return (task) => [folderOf(task)] }
}

class RootField extends TextField {
  fieldName(): string { return 'root' }
  protected matcher() { return textOf(rootOf) }
  override supportsSorting(): boolean { return true }
  comparator(): Comparator { return (a, b) => compareGroupKeys(rootOf(a), rootOf(b)) }
  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction { return (task) => [rootOf(task)] }
}

class FilenameField extends TextField {
  fieldName(): string { return 'filename' }
  protected matcher() { return textOf(filenameOf) }
  override supportsSorting(): boolean { return true }
  comparator(): Comparator { return (a, b) => compareGroupKeys(filenameOf(a), filenameOf(b)) }
  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction { return (task) => [filenameOf(task)] }
}

class HeadingField extends TextField {
  fieldName(): string { return 'heading' }
  protected matcher() { return textOf((task) => task.location.precedingHeader ?? '') }
  override supportsSorting(): boolean { return true }
  comparator(): Comparator {
    return (a, b) => {
      const left = a.location.precedingHeader ?? 'No heading'
      const right = b.location.precedingHeader ?? 'No heading'
      if (left !== right) return compareGroupKeys(left, right)
      return a.location.sectionStart - b.location.sectionStart || a.location.sectionIndex - b.location.sectionIndex
    }
  }
  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction { return (task) => [task.location.precedingHeader ?? 'No heading'] }
}

class DescriptionField extends TextField {
  fieldName(): string { return 'description' }
  protected matcher() { return textOf((task) => task.fields.description) }
  override supportsSorting(): boolean { return true }
  comparator(): Comparator { return (a, b) => compareGroupKeys(a.fields.description, b.fields.description) }
  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction { return (task) => [task.fields.description] }
}

class TagsField extends MultiTextField {
  fieldName(): string { return 'tags' }
  override fieldNameSingular(): string { return 'tag' }
  protected matcher(): (task: Task) => string[] {
    return (task) => task.fields.tags
  }

  protected override filterRegExp(): RegExp {
    return new RegExp('^(?:tag|tags) (includes|does not include|include|do not include|regex matches|regex does not match) (.*)', 'i')
  }

  override supportsGrouping(): boolean {
    return true
  }

  /** The instruction spells the field plural when it groups: `group by tags`. */
  protected override grouperRegExp(): RegExp {
    return /^group by tags?( reverse)?$/i
  }

  override supportsSorting(): boolean {
    return true
  }

  /** `sort by tag`, `sort by tag 2`, and either with `reverse`. */
  protected override sorterRegExp(): RegExp {
    return /^sort by tag( reverse)?[\s]*(\d+)?/i
  }

  override createSorterFromLine(line: string): Sorter | null {
    const matched = this.sorterRegExp().exec(line)
    if (matched === null) return null
    const reverse = Boolean(matched[1])
    const which = matched[2] === undefined ? 1 : Number(matched[2])
    return makeSorter(line, 'tag', tagComparator(which), reverse)
  }

  comparator(): Comparator {
    return tagComparator(1)
  }

  override grouper(): GrouperFunction {
    return (task) => (task.fields.tags.length > 0 ? task.fields.tags : ['(No tags)'])
  }
}

/**
 * Order two tasks by their n-th tag, counting from one the way a reader names them.
 *
 * A task with fewer tags than `which` is asked for is placed after one that has that many: the reader
 * who sorts by the second tag wants the tasks that *have* one in front of the ones that cannot answer.
 */
function tagComparator(which: number): Comparator {
  return (a, b) => {
    const tagsA = a.fields.tags
    const tagsB = b.fields.tags
    if (tagsA.length === 0 && tagsB.length === 0) return 0
    if (tagsA.length === 0) return 1
    if (tagsB.length === 0) return -1
    if (tagsA.length < which && tagsB.length >= which) return 1
    if (tagsB.length < which && tagsA.length >= which) return -1
    if (tagsA.length < which && tagsB.length < which) return 0
    return tagsA[which - 1]!.localeCompare(tagsB[which - 1]!, undefined, { numeric: true })
  }
}

/** `has tag(s)` / `no tag(s)`, which the four text comparisons cannot express. */
class HasTagsField extends Field {
  fieldName(): string { return 'tags' }
  override fieldNameSingular(): string { return 'tag' }

  protected override filterRegExp(): RegExp {
    return new RegExp('^(has|no) (tag|tags)$', 'i')
  }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line.trim())
    if (matched === null) return invalidFilter(`unable to parse: ${line}`)
    const want = matched[1]!.toLowerCase() === 'has'
    return { filter: (task) => (task.fields.tags.length > 0) === want, error: null }
  }
}

class PriorityField extends Field {
  fieldName(): string { return 'priority' }

  protected override filterRegExp(): RegExp {
    return new RegExp(`^priority (is )?(above |below |not )?(${Object.values(PRIORITY_NAMES).join('|')})$`, 'i')
  }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line.trim())
    if (matched === null) return invalidFilter(`Priority must be one of: ${Object.values(PRIORITY_NAMES).join(', ')} - ${line}`)
    const relation = (matched[2] ?? '').trim().toLowerCase()
    const wanted = nameToPriority(matched[3]!)
    if (wanted === null) return invalidFilter(`unknown priority: ${matched[3]}`)
    const rank = Number(wanted)
    return {
      filter: (task) => {
        const value = Number(task.fields.priority)
        if (relation === 'above') return value < rank
        if (relation === 'below') return value > rank
        if (relation === 'not') return value !== rank
        return value === rank
      },
      error: null,
    }
  }

  override supportsSorting(): boolean { return true }
  comparator(): Comparator {
    return (a, b) => Number(a.fields.priority) - Number(b.fields.priority)
  }

  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction {
    return (task) => [`${Number(task.fields.priority) + 1} ${PRIORITY_NAMES[task.fields.priority]}`]
  }
}

function nameToPriority(name: string): Priority | null {
  const needle = name.trim().toLowerCase()
  for (const [priority, label] of Object.entries(PRIORITY_NAMES)) {
    if (label === needle) return priority as Priority
  }
  return null
}

class RecurringField extends Field {
  fieldName(): string { return 'recurring' }

  protected override filterRegExp(): RegExp {
    return new RegExp('^(is not recurring|is recurring)$', 'i')
  }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line.trim())
    if (matched === null) return invalidFilter(`unable to parse: ${line}`)
    const want = matched[1]!.toLowerCase() === 'is recurring'
    return { filter: (task) => (task.recurrence !== null) === want, error: null }
  }

  override supportsSorting(): boolean { return true }
  comparator(): Comparator { return (a, b) => Number(a.recurrence === null) - Number(b.recurrence === null) }
  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction { return (task) => [task.recurrence === null ? 'Regular' : 'Recurring'] }
}

class RecurrenceRuleField extends TextField {
  fieldName(): string { return 'recurrence' }
  protected matcher() { return textOf((task) => task.fields.recurrenceRuleText) }
  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction { return (task) => [task.fields.recurrenceRuleText === '' ? 'No recurrence rule' : task.fields.recurrenceRuleText] }
}

class IdField extends TextField {
  fieldName(): string { return 'id' }
  protected matcher() { return textOf((task) => task.fields.id) }
  override supportsSorting(): boolean { return true }
  comparator(): Comparator {
    // A task with no id is not "before" the named ones alphabetically — it has no place in that
    // ordering at all, so it goes last rather than masquerading as the smallest string.
    return (a, b) => {
      if (a.fields.id === b.fields.id) return 0
      if (a.fields.id === '') return 1
      if (b.fields.id === '') return -1
      return compareGroupKeys(a.fields.id, b.fields.id)
    }
  }
  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction { return (task) => [task.fields.id === '' ? 'No id' : task.fields.id] }
}

class HasIdField extends Field {
  fieldName(): string { return 'id' }
  protected override filterRegExp(): RegExp {
    return new RegExp('^(has|no) id$', 'i')
  }
  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line.trim())
    if (matched === null) return invalidFilter(`unable to parse: ${line}`)
    const want = matched[1]!.toLowerCase() === 'has'
    return { filter: (task) => (task.fields.id !== '') === want, error: null }
  }
}

class DependsOnField extends Field {
  fieldName(): string { return 'depends on' }

  protected override filterRegExp(): RegExp {
    return new RegExp('^(has|no) depends on$', 'i')
  }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line.trim())
    if (matched === null) return invalidFilter(`unable to parse: ${line}`)
    const want = matched[1]!.toLowerCase() === 'has'
    return { filter: (task) => (task.fields.dependsOn.length > 0) === want, error: null }
  }

  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction {
    return (task) => (task.fields.dependsOn.length > 0 ? task.fields.dependsOn : ['(none)'])
  }
}

/**
 * `is blocked` and `is blocking`, which cannot be answered from one task.
 *
 * A dependency names an id, not a note, so the question "is this waiting on anything" is a question
 * about the whole result set. That is why `SearchInfo` carries every task: answering per-row would
 * make the result depend on which filters ran first.
 */
class BlockingField extends Field {
  fieldName(): string { return 'blocked' }

  protected override filterRegExp(): RegExp {
    return new RegExp('^is (not blocked|blocked|not blocking|blocking)$', 'i')
  }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line.trim())
    if (matched === null) return invalidFilter(`unable to parse: ${line}`)
    const instruction = matched[1]!.toLowerCase()
    return {
      filter: (task, info) => {
        const answer = instruction === 'blocked' || instruction === 'not blocked'
          ? isBlocked(task, info)
          : isBlocking(task, info)
        return instruction.startsWith('not') ? !answer : answer
      },
      error: null,
    }
  }
}

function isBlocked(task: Task, info: SearchInfo): boolean {
  if (task.fields.dependsOn.length === 0) return false
  const byId = indexById(info.allTasks)
  return task.fields.dependsOn.some((id) => {
    const dependency = byId.get(id)
    if (dependency === undefined) return true
    return !dependency.status.isDone
  })
}

function isBlocking(task: Task, info: SearchInfo): boolean {
  if (task.fields.id === '') return false
  return info.allTasks.some((other) => other !== task && other.fields.dependsOn.includes(task.fields.id) && !other.status.isDone)
}

function indexById(tasks: Task[]): Map<string, Task> {
  const out = new Map<string, Task>()
  for (const task of tasks) {
    if (task.fields.id !== '') out.set(task.fields.id, task)
  }
  return out
}

/** Sort and group only: `urgency` is a score, not something a reader filters a line against. */
class UrgencyField extends Field {
  fieldName(): string { return 'urgency' }

  createFilterOrErrorMessage(): FilterOrErrorMessage {
    return invalidFilter('urgency cannot be filtered on; use sort by urgency or group by urgency')
  }

  override canCreateFilterForLine(): boolean {
    return false
  }

  override supportsSorting(): boolean { return true }
  comparator(): Comparator {
    // Descending: urgency is a score where louder means more urgent, so the reader who asks
    // for it wants the pressing task first rather than last.
    return (a, b, info) => urgencyOf(b, info.now) - urgencyOf(a, info.now)
  }

  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction {
    return (task) => {
      const score = urgencyOf(task, new Date())
      const label = score >= 8 ? 'High' : score >= 4 ? 'Normal' : score > 0 ? 'Low' : 'None'
      return [`${label} - ${score.toFixed(2)}`]
    }
  }
}

/**
 * `group by backlink`: the file a task was read out of, which is the label a grouped list already
 * prints next to each row.
 *
 * It has no filter of its own — `path includes …` says the same thing with an operator — so this is
 * one field that exists only to be grouped by.
 */
class BacklinkField extends Field {
  fieldName(): string { return 'backlink' }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    return invalidFilter(`backlink cannot be filtered on; use path or filename - ${line}`)
  }

  override canCreateFilterForLine(): boolean {
    return false
  }

  override supportsGrouping(): boolean { return true }
  override grouper(): GrouperFunction {
    return (task) => [task.location.path.split('/').pop() ?? task.location.path]
  }
}

/**
 * `exclude sub-items`: keep the list items that are not nested under another one.
 *
 * A line indented under a bullet is somebody's sub-task, and the query that lists "everything to do"
 * does not want it twice. A blockquote's own `>` is not nesting, which is why the indentation is read
 * rather than simply tested for being empty.
 */
class ExcludeSubItemsField extends Field {
  fieldName(): string { return 'exclude sub-items' }

  protected override filterRegExp(): RegExp {
    return /^exclude sub-items$/i
  }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line.trim())
    if (matched === null) return invalidFilter(`unable to parse: ${line}`)
    return { filter: (task) => !isSubItem(task.indentation), error: null }
  }
}

function isSubItem(indentation: string): boolean {
  if (indentation === '') return false
  const lastQuote = indentation.lastIndexOf('>')
  if (lastQuote === -1) return true
  // One space after the `>` is how a blockquote is written; a second one is a nested list item.
  return !/^ ?$/.test(indentation.slice(lastQuote + 1))
}

export const pathField = new PathField()
export const folderField = new FolderField()
export const rootField = new RootField()
export const filenameField = new FilenameField()
export const headingField = new HeadingField()
export const descriptionField = new DescriptionField()
export const tagsField = new TagsField()
export const hasTagsField = new HasTagsField()
export const priorityField = new PriorityField()
export const recurringField = new RecurringField()
export const recurrenceRuleField = new RecurrenceRuleField()
export const idField = new IdField()
export const hasIdField = new HasIdField()
export const dependsOnField = new DependsOnField()
export const blockingField = new BlockingField()
export const urgencyField = new UrgencyField()
export const backlinkField = new BacklinkField()
export const excludeSubItemsField = new ExcludeSubItemsField()

/**
 * The order the parser tries, which is not alphabetical.
 *
 * A specific instruction must be reached before a looser one that would also match it: `has id`
 * before `id includes`, `tag` before any field whose name starts the same way.
 */
export const TEXT_FIELDS: Field[] = [
  hasTagsField,
  tagsField,
  hasIdField,
  idField,
  dependsOnField,
  blockingField,
  recurringField,
  priorityField,
  recurrenceRuleField,
  descriptionField,
  headingField,
  filenameField,
  rootField,
  folderField,
  pathField,
  urgencyField,
  backlinkField,
  excludeSubItemsField,
]
