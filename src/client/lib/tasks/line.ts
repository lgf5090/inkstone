/**
 * The narrow seam for "what does this task line say".
 *
 * `index.ts` is the module's full surface and reaches the query engine, the recurrence rules and the
 * natural-language date parser. A caller that only reads a line must not pay for any of that: this
 * file is the second, deliberate entry point for that reader, and it pulls in neither `rrule` nor
 * `chrono-node`. It is a declared entry of the task module, not a deep path into its internals.
 */
import { StatusRegistry } from './status/registry'

export { EmojiTaskSerializer } from './serializer/emoji'
export { DataviewTaskSerializer } from './serializer/dataview-format'
export { CompatTaskSerializer, readEitherFormat } from './serializer/compat'
export { Priority, PRIORITY_NAMES, priorityFromName } from './model/priority'
export { OnCompletion } from './model/on-completion'
export { formatTaskDate, isInvalidTaskDate } from './date/date-tools'
export { Status } from './status/status'
export { StatusRegistry, DEFAULT_STATUS_CONFIGURATIONS } from './status/registry'
export type { StatusType, StatusConfiguration } from './status/status'
/**
 * The statuses every reader gets whether they configured any or not.
 *
 * A single instance, because the four defaults are the same for everybody; the settings screen
 * swaps in its own once a reader defines more characters. Rebuilding it is cheap and the scan
 * re-reads it, so a note never disagrees with the registry that produced it.
 */
export const defaultStatusRegistry = new StatusRegistry()
export type { TaskFields, TaskDateField, TaskSerializer, SerializeOptions } from './serializer/index'
