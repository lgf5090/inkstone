import { DATE_FIELDS } from './date-fields'
import { STATUS_FIELDS } from './status-fields'
import { TEXT_FIELDS } from './text-fields'
import type { Field } from './field'
import type { FilterOrErrorMessage } from './values'

/**
 * Every field that answers a question about a single task.
 *
 * Order is the parser's semantics, not a listing: `status.name` and `status.type` before the bare
 * `status`, `has id` before `id includes`, and so on. A looser instruction placed first would
 * swallow the specific one behind it and the query would answer a different question than written.
 */
export const SIMPLE_FIELDS: Field[] = [...STATUS_FIELDS, ...DATE_FIELDS, ...TEXT_FIELDS]

/**
 * Parse one instruction that is not a boolean combination.
 *
 * The boolean field calls this for its leaves, and this module deliberately does not know about the
 * boolean field: the two would otherwise import each other, and a nested expression would have no
 * bottom to stop at.
 */
export function parseSimpleFilterInstruction(line: string, now?: Date): FilterOrErrorMessage | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  for (const field of SIMPLE_FIELDS) {
    if (!field.canCreateFilterForLine(trimmed)) continue
    return field.createFilterOrErrorMessage(trimmed, now)
  }
  return null
}
