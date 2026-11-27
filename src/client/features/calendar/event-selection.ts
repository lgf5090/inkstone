export interface EventSelectionModifiers {
  shift: boolean
  meta: boolean
}

export interface EventSelectionResult {
  selected: Set<string>
  anchor: string
}

export function nextEventSelection(
  current: ReadonlySet<string>,
  ordered: readonly string[],
  id: string,
  modifiers: EventSelectionModifiers,
  anchor: string | null,
): EventSelectionResult {
  if (modifiers.meta) {
    const selected = new Set(current)
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    return { selected, anchor: id }
  }
  if (modifiers.shift && anchor) {
    const from = ordered.indexOf(anchor)
    const to = ordered.indexOf(id)
    if (from >= 0 && to >= 0) {
      const selected = new Set(current)
      for (let index = Math.min(from, to); index <= Math.max(from, to); index++) selected.add(ordered[index]!)
      return { selected, anchor }
    }
  }
  return { selected: new Set([id]), anchor: id }
}
