import type { KanbanItem, KanbanProperty } from './types'

/**
 * A person is stored as the name the author typed. Anything that is not a name — a blank, an
 * object, a list of tags — means the card holds nobody, so no surface has to re-derive it.
 */
export function kanbanPersonName(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

/** The two letters an avatar shows. Every surface that draws a person uses these same two. */
export function kanbanPersonInitials(name: string): string {
  return name.slice(0, 2).toUpperCase()
}

interface RosterEntry {
  name: string
  count: number
  declared: boolean
  order: number
}

/**
 * Who a member picker may offer: the directory the author declared for the column first, then the
 * people the cards already name by how often they appear and who showed up first. Names that differ
 * only in case or surrounding blanks are one person, spelled as they were first seen.
 */
export function kanbanPersonCandidates(column: KanbanProperty | undefined, items: KanbanItem[]): string[] {
  if (!column) return []
  const roster = new Map<string, RosterEntry>()
  const add = (raw: string, declared: boolean) => {
    const name = raw.trim()
    if (!name) return
    const key = name.toLowerCase()
    const existing = roster.get(key)
    if (existing) {
      existing.count += 1
      return
    }
    roster.set(key, { name, declared, count: 1, order: roster.size })
  }

  for (const option of column.options ?? []) add(option.label?.trim() || option.id, true)
  for (const item of items) add(kanbanPersonName(item.properties[column.id]), false)

  const entries = [...roster.values()]
  const declared = entries.filter((entry) => entry.declared)
  const used = entries
    .filter((entry) => !entry.declared)
    .sort((a, b) => b.count - a.count || a.order - b.order)
  return [...declared, ...used].map((entry) => entry.name)
}

/** The roster for every member column of a board, keyed by column id. */
export function kanbanPeopleDirectory(columns: KanbanProperty[], items: KanbanItem[]): Record<string, string[]> {
  const directory: Record<string, string[]> = {}
  for (const column of columns) {
    if (column.type !== 'person') continue
    const candidates = kanbanPersonCandidates(column, items)
    if (candidates.length > 0) directory[column.id] = candidates
  }
  return directory
}
