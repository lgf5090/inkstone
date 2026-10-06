/**
 * React keys for lists of value-shaped rules (sort rules, filter rules, progress
 * segments). The fence stores these rules without an identity, so their key is
 * derived from the values that make them up, with an occurrence counter so two
 * identical rules still get distinct keys. An index key would re-key every row
 * after a mid-list removal, remounting rows whose only change is position and
 * dragging any local state a row holds (a draft, an open picker) onto the
 * neighbour that now wears its index.
 */
export function kanbanStableKeys<T>(
  items: readonly T[],
  partsOf: (item: T) => ReadonlyArray<string | number | undefined>,
): string[] {
  const counts = new Map<string, number>()
  return items.map((item) => {
    const base = partsOf(item)
      .map((part) => (part === undefined ? '' : String(part)))
      .join('|')
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    return `${base}#${seen}`
  })
}
