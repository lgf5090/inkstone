/**
 * The narrow seam for "what does this task line say".
 *
 * `index.ts` is the module's full surface and reaches the query engine, the recurrence rules and the
 * natural-language date parser. A caller that only reads a line must not pay for any of that: this
 * file is the second, deliberate entry point for that reader, and it pulls in neither `rrule` nor
 * `chrono-node`. It is a declared entry of the task module, not a deep path into its internals.
 */
export { EmojiTaskSerializer } from './serializer/emoji'
export { DataviewTaskSerializer } from './serializer/dataview-format'
export { Priority, PRIORITY_NAMES, priorityFromName } from './model/priority'
export { OnCompletion } from './model/on-completion'
export { formatTaskDate, isInvalidTaskDate } from './date/date-tools'
export type { TaskFields, TaskDateField, TaskSerializer, SerializeOptions } from './serializer/index'
