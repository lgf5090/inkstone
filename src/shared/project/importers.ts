/**
 * The six external importers (G-1…G-6) as pure converters: each parses its system's export into the
 * same archive lines the server importer reads, so there is exactly one trust boundary. Lists /
 * sections / columns become a single select property; rows become cards carrying that property, and
 * free text becomes a text content block. G-7's packing is the shared archive envelope itself.
 */
import type { ProjectArchiveLine } from './archive'
import { newProjectId } from './limits'

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  const source = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 1 } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r' && source[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1 }
    else if (ch === '\n' || ch === '\r') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

interface ConvertedCard {
  title: string
  status?: string
  description?: string
}

function buildArchive(title: string, statuses: string[], cards: ConvertedCard[]): ProjectArchiveLine[] {
  const boardId = newProjectId('board')
  const statusPropertyId = newProjectId('property')
  const optionIds = new Map(statuses.map((name) => [name, newProjectId('property')]))
  const stamps = { createdBy: '', modifiedBy: '', createAt: 0, updateAt: 0, deleteAt: 0 }
  const lines: ProjectArchiveLine[] = [
    {
      type: 'board',
      data: {
        id: boardId, title, description: '', icon: '', type: 'P', minimumRole: '',
        cardProperties: statuses.length
          ? [{ id: statusPropertyId, name: 'Status', type: 'select', options: statuses.map((name) => ({ id: optionIds.get(name)!, value: name, color: '' })) }]
          : [],
      },
    },
    { type: 'block', data: { id: newProjectId('view'), type: 'view', parentId: boardId, boardId, title: 'Board', fields: { viewType: 'board', groupById: statuses.length ? statusPropertyId : undefined }, ...stamps } },
  ]
  for (const card of cards) {
    const cardId = newProjectId('card')
    const contentOrder: string[] = []
    const properties: Record<string, string> = {}
    if (card.status && optionIds.has(card.status)) properties[statusPropertyId] = optionIds.get(card.status)!
    if (card.description) {
      const textId = newProjectId('content')
      contentOrder.push(textId)
      lines.push({ type: 'block', data: { id: textId, type: 'text', parentId: cardId, boardId, title: card.description, fields: {}, ...stamps } })
    }
    lines.push({ type: 'block', data: { id: cardId, type: 'card', parentId: boardId, boardId, title: card.title, fields: { properties, contentOrder }, ...stamps } })
  }
  return lines
}

function uniqueStatuses(cards: ConvertedCard[]): string[] {
  return [...new Set(cards.map((c) => c.status).filter((s): s is string => Boolean(s)))]
}

export function importTrello(json: string): ProjectArchiveLine[] {
  const data = JSON.parse(json) as { name?: string, lists?: { id: string, name: string, closed?: boolean }[], cards?: { name: string, idList?: string, desc?: string, closed?: boolean }[] }
  const lists = (data.lists ?? []).filter((l) => !l.closed)
  const listNames = new Map(lists.map((l) => [l.id, l.name]))
  const cards = (data.cards ?? []).filter((c) => !c.closed).map((c) => ({ title: c.name, status: c.idList ? listNames.get(c.idList) : undefined, description: c.desc || undefined }))
  return buildArchive(data.name ?? 'Trello board', lists.map((l) => l.name), cards)
}

export function importDeck(json: string): ProjectArchiveLine[] {
  const data = JSON.parse(json) as { title?: string, stacks?: { id: number, title: string }[], cards?: { title: string, stackId: number, description?: string }[] }
  const stacks = data.stacks ?? []
  const stackNames = new Map(stacks.map((s) => [s.id, s.title]))
  const cards = (data.cards ?? []).map((c) => ({ title: c.title, status: stackNames.get(c.stackId), description: c.description || undefined }))
  return buildArchive(data.title ?? 'Deck board', stacks.map((s) => s.title), cards)
}

function fromCsv(csv: string, title: string, titleCol: string[], statusCol: string[], descCol: string[]): ProjectArchiveLine[] {
  const rows = parseCsv(csv)
  if (rows.length === 0) return buildArchive(title, [], [])
  const header = rows[0]!.map((h) => h.trim().toLowerCase())
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h))
  const ti = idx(titleCol), si = idx(statusCol), di = idx(descCol)
  const cards = rows.slice(1).map((r) => ({ title: (ti >= 0 ? r[ti] : r[0]) ?? '', status: si >= 0 ? r[si] : undefined, description: di >= 0 ? r[di] : undefined }))
    .filter((c) => c.title.trim() !== '')
  return buildArchive(title, uniqueStatuses(cards), cards)
}

export function importAsanaCsv(csv: string): ProjectArchiveLine[] {
  return fromCsv(csv, 'Asana board', ['name', 'task name'], ['section/column', 'section', 'column'], ['notes', 'description'])
}

export function importNotionCsv(csv: string): ProjectArchiveLine[] {
  return fromCsv(csv, 'Notion board', ['name', 'title'], ['status', 'select'], ['description', 'text'])
}

export function importJiraCsv(csv: string): ProjectArchiveLine[] {
  return fromCsv(csv, 'Jira board', ['summary', 'title'], ['status'], ['description'])
}

export function importTodoistCsv(csv: string): ProjectArchiveLine[] {
  return fromCsv(csv, 'Todoist board', ['content', 'task name'], ['section', 'column'], ['description'])
}