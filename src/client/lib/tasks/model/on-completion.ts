/**
 * What the reader asked to happen to a recurring task when it is completed.
 *
 * `Ignore` is the unwritten default and must stay invisible on the line: a task that serialises
 * `🏁 keep` for every reader who never asked for it would rewrite half of a vault on first tick.
 */
export enum OnCompletion {
  Ignore = '',
  Keep = 'keep',
  Delete = 'delete',
}

export function parseOnCompletionValue(input: string): OnCompletion {
  const value = input.trim().toLowerCase()
  if (value === 'delete') return OnCompletion.Delete
  if (value === 'keep') return OnCompletion.Keep
  return OnCompletion.Ignore
}
