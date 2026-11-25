import type { NoteSummary } from '@shared/types'

let target: Record<string, NoteSummary> = {}
let snapshot = new Proxy(target, {})

// A fresh Proxy identity publishes one changed key while the shared target avoids copying the vault.
export function updateNoteSummaryRecord(
  current: Record<string, NoteSummary>,
  id: string,
  next: NoteSummary,
): Record<string, NoteSummary> {
  if (current !== snapshot) {
    target = { ...current }
    snapshot = new Proxy(target, {})
  }
  target[id] = next
  snapshot = new Proxy(target, {})
  return snapshot
}
