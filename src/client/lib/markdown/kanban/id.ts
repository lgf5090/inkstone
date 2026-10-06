// Kanban ids were built from Date.now() alone or with a short random suffix,
// so a burst of creates inside one millisecond (paste, batch add, duplicated
// subtasks) produced duplicate keys. The monotonic sequence pins uniqueness per
// tab; the random tail keeps ids distinct across tabs that share a millisecond.
let lastGeneratedAt = 0
let sequence = 0

export function createKanbanId(): string {
  const now = Date.now()
  sequence = now === lastGeneratedAt ? sequence + 1 : 0
  lastGeneratedAt = now
  return `${now.toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`
}
