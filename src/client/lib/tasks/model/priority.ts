/**
 * How badly a task wants to be done before something else.
 *
 * The values are strings that sort correctly: `Low` must land after `None`, so a vault with no
 * priority set on most of its tasks still puts the ones the reader did mark low underneath them.
 */
export enum Priority {
  Highest = '0',
  High = '1',
  Medium = '2',
  None = '3',
  Low = '4',
  Lowest = '5',
}

export const PRIORITY_NAMES: Record<Priority, string> = {
  [Priority.Highest]: 'highest',
  [Priority.High]: 'high',
  [Priority.Medium]: 'medium',
  [Priority.None]: 'none',
  [Priority.Low]: 'low',
  [Priority.Lowest]: 'lowest',
}

const NAMES_TO_PRIORITY = new Map<string, Priority>(
  Object.entries(PRIORITY_NAMES).map(([value, name]) => [name, value as Priority]),
)

export function priorityFromName(name: string): Priority | null {
  return NAMES_TO_PRIORITY.get(name.trim().toLowerCase()) ?? null
}
