/**
 * Public surface of the task layer.
 *
 * The query module reads tasks through here and nothing else: it needs the line parser and the
 * status registry, not the query engine, so the two modules stay separable and the dependency only
 * ever points in this direction.
 */
export { EmojiTaskSerializer } from './serializer/emoji'
export { DataviewTaskSerializer } from './serializer/dataview-format'
export type { TaskFields, TaskDateField, TaskSerializer, SerializeOptions } from './serializer/index'
export { Status } from './status/status'
export { StatusRegistry, DEFAULT_STATUS_CONFIGURATIONS, validateStatusConfigurations } from './status/registry'
export type { StatusConfiguration, StatusType } from './status/status'
export { Priority, PRIORITY_NAMES, priorityFromName } from './model/priority'
export { OnCompletion } from './model/on-completion'
export { extractTaskComponents, parseTaskLine, toMarkdownLine, happensDates, isDone, isRecurring } from './model/task'
export type { Task, ParseTaskOptions } from './model/task'
export { urgencyOf } from './model/urgency'
export { Recurrence } from './model/recurrence'
export { Occurrence } from './model/occurrence'
export { fallbackDateFromPath, canApplyFallback } from './date/date-fallback'
export type { FilenameDateSettings } from './date/date-fallback'
export { parseDay, parseRange, expandDateAbbreviation } from './date/date-parser'
export { DateRange } from './date/date-range'
export { compareTaskDates, formatTaskDate, isInvalidTaskDate } from './date/date-tools'
export { TaskRegularExpressions } from './model/task-regular-expressions'
