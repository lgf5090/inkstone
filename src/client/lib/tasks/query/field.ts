import { patternSafety } from '@shared/regex-safety'
import type { Task } from '../model/task'
import {
  compareGroupKeys,
  invalidFilter,
  makeGrouper,
  makeSorter,
  type Comparator,
  type FilterOrErrorMessage,
  type Grouper,
  type GrouperFunction,
  type SearchInfo,
  type Sorter,
} from './values'

/** How a text instruction compares a field against what the reader typed. */
export type MatchMode = 'includes' | 'does not include' | 'regex matches' | 'regex does not match'

const MODES: MatchMode[] = ['includes', 'does not include', 'regex matches', 'regex does not match']

/**
 * Compile a reader-supplied pattern, or refuse it.
 *
 * A query is data the reader wrote, but it is executed against every note they can open, so a
 * pattern with catastrophic backtracking would hang the tab on somebody else's text. The same gate
 * the Dataview engine uses, so the two cannot disagree about what is safe.
 */
export function compileReaderPattern(source: string): RegExp | string {
  if (patternSafety(source) !== null) return 'unsafe_or_too_long_pattern'
  try {
    return new RegExp(source, 'iu')
  }
  catch {
    return 'invalid_regular_expression'
  }
}

/** Parse `/pattern/flags`, or treat the whole text as a literal substring. */
export function textPredicate(mode: MatchMode, value: string): ((text: string) => boolean) | string {
  if (mode === 'regex matches' || mode === 'regex does not match') {
    const compiled = compileReaderPattern(value)
    if (typeof compiled === 'string') return compiled
    const negated = mode === 'regex does not match'
    return (text: string) => negated !== compiled.test(text)
  }
  const needle = value.toLowerCase()
  const negated = mode === 'does not include'
  return (text: string) => negated !== text.toLowerCase().includes(needle)
}

/**
 * One queryable field of a task: its filter, its sorter and its grouper, from one definition.
 *
 * The three share a name and a value function, so declaring them together is what keeps
 * `sort by due` and `group by due` answering about the same thing as `due before`.
 */
export abstract class Field {
  canCreateFilterForLine(line: string): boolean {
    const pattern = this.filterRegExp()
    return pattern !== null && pattern.test(line)
  }

  abstract createFilterOrErrorMessage(line: string): FilterOrErrorMessage
  abstract fieldName(): string

  /** The shape this field's filter instruction takes, or null when it cannot be filtered on. */
  protected filterRegExp(): RegExp | null {
    return null
  }

  fieldNameSingular(): string {
    return this.fieldName()
  }

  protected fieldNameEscaped(): string {
    return this.fieldNameSingular().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  supportsSorting(): boolean {
    return false
  }

  protected sorterRegExp(): RegExp {
    return new RegExp(`^sort by ${this.fieldNameEscaped()}( reverse)?`, 'i')
  }

  comparator(): Comparator {
    throw new Error(`comparator() unimplemented for ${this.fieldNameSingular()}`)
  }

  createSorterFromLine(line: string): Sorter | null {
    if (!this.supportsSorting()) return null
    const matched = this.sorterRegExp().exec(line)
    if (matched === null) return null
    const reverse = Boolean(matched[1])
    return makeSorter(`sort by ${this.fieldNameSingular()}${reverse ? ' reverse' : ''}`, this.fieldNameSingular(), this.comparator(), reverse)
  }

  supportsGrouping(): boolean {
    return false
  }

  protected grouperRegExp(): RegExp {
    return new RegExp(`^group by ${this.fieldNameEscaped()}( reverse)?$`, 'i')
  }

  grouper(): GrouperFunction {
    throw new Error(`grouper() unimplemented for ${this.fieldNameSingular()}`)
  }

  createGrouperFromLine(line: string): Grouper | null {
    if (!this.supportsGrouping()) return null
    const matched = this.grouperRegExp().exec(line)
    if (matched === null) return null
    const reverse = Boolean(matched[1])
    return makeGrouper(`group by ${this.fieldNameSingular()}${reverse ? ' reverse' : ''}`, this.fieldNameSingular(), this.grouper(), reverse)
  }
}

/** A field whose every instruction is one of the four text comparisons. */
export abstract class TextField extends Field {
  protected abstract matcher(): (task: Task, info: SearchInfo) => string | string[]

  protected filterRegExp(): RegExp {
    return new RegExp(`^${this.fieldNameEscaped()} (${MODES.join('|')}) (.*)`, 'i')
  }

  createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
    const matched = this.filterRegExp().exec(line)
    if (matched === null) return invalidFilter(`unable to parse: ${line}`)
    const mode = matched[1]!.toLowerCase() as MatchMode
    const predicate = textPredicate(mode, matched[2]!)
    if (typeof predicate === 'string') return invalidFilter(`${predicate}: ${matched[2]}`)
    const read = this.matcher()
    return {
      filter: (task, info) => {
        const value = read(task, info)
        const texts = Array.isArray(value) ? value : [value]
        return texts.some((text) => predicate(text))
      },
      error: null,
    }
  }
}

/** A field that also accepts the singular `include` / `do not include` spellings. */
export abstract class MultiTextField extends TextField {
  protected pluralised(): boolean {
    return true
  }

  protected override filterRegExp(): RegExp {
    const extra = this.pluralised() ? '|include|do not include' : ''
    return new RegExp(`^${this.fieldNameEscaped()} (${MODES.join('|')}${extra}) (.*)`, 'i')
  }
}

/** Sort by a text value, which is what most text fields want. */
export function textComparator(read: (task: Task) => string): Comparator {
  return (a, b) => compareGroupKeys(read(a), read(b))
}
