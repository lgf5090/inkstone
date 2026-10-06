import type { KanbanColorName, KanbanData, KanbanItem, KanbanOption, KanbanProperty } from './types'

function defaultViews() {
  return [
    { id: 'view-board', name: 'Board', type: 'board' as const, groupBy: 'status' },
    { id: 'view-table', name: 'Table', type: 'table' as const },
    { id: 'view-chart', name: 'Chart', type: 'chart' as const, chartType: 'bar' as const, chartGroupBy: 'status' },
    { id: 'view-calendar', name: 'Calendar', type: 'calendar' as const, dateField: 'startDate' },
    { id: 'view-timeline', name: 'Timeline', type: 'timeline' as const, startField: 'startDate', endField: 'endDate' },
    { id: 'view-gantt', name: 'Gantt', type: 'gantt' as const, startField: 'startDate', endField: 'endDate', progressField: 'progress' },
    { id: 'view-list', name: 'List', type: 'list' as const },
    { id: 'view-gallery', name: 'Gallery', type: 'gallery' as const },
  ]
}

const DEFAULT_COLORS: KanbanColorName[] = ['gray', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'red']

function ensureGroupOption(options: KanbanOption[], groupName: string): void {
  if (options.some((o) => o.label === groupName)) return
  const color = DEFAULT_COLORS[options.length % DEFAULT_COLORS.length]!
  options.push({ id: `status-${options.length + 1}`, label: groupName, color })
}

function assignOutlineProperty(properties: Record<string, unknown>, key: string, val: string): void {
  switch (key) {
    case 'priority':
      properties.priority = val
      break
    case 'assignee':
      properties.assignee = val
      break
    case 'start':
    case 'startdate':
      properties.startDate = val
      break
    case 'end':
    case 'enddate':
      properties.endDate = val
      break
    case 'progress':
      properties.progress = Number(val) || 0
      break
    case 'tags':
      properties.tags = val.split(/[,\uFF0C]/).map((s) => s.trim()).filter(Boolean)
      break
    default:
      properties[key] = val
  }
}

function parseOutlineProperties(rawText: string): { properties: Record<string, unknown>; cleanText: string } {
  const properties: Record<string, unknown> = {}
  // \[ and \] are literal brackets in a title, not the start of a property tag.
  const tagMatches = [...rawText.matchAll(/(?<!\\)\[([a-zA-Z0-9_\u4e00-\u9fa5]+):\s*([^\]]+)\]/g)]
  for (const m of tagMatches) {
    const key = m[1]!.trim().toLowerCase()
    const val = m[2]!.trim()
    assignOutlineProperty(properties, key, val)
  }
  const cleanText = rawText
    .replace(/(?<!\\)\[[a-zA-Z0-9_\u4e00-\u9fa5]+:\s*([^\]]+)\]/g, '')
    .replace(/\\([\[\]])/g, '$1')
    .trim()
  return { properties, cleanText }
}

function createDefaultColumns(options: KanbanOption[]): KanbanProperty[] {
  return [
    { id: 'title', name: 'Title', type: 'title' },
    { id: 'status', name: 'Status', type: 'select', options },
    { id: 'priority', name: 'Priority', type: 'select', options: [
      { id: 'low', label: 'Low', color: 'green' },
      { id: 'medium', label: 'Medium', color: 'yellow' },
      { id: 'high', label: 'High', color: 'red' },
    ]},
    { id: 'assignee', name: 'Assignee', type: 'person' },
    { id: 'startDate', name: 'Start Date', type: 'date' },
    { id: 'endDate', name: 'End Date', type: 'date' },
    { id: 'progress', name: 'Progress', type: 'number' },
    { id: 'tags', name: 'Tags', type: 'multi-select', options: [] },
  ]
}

export function parseKanbanOutline(markdown: string): KanbanData {
  const lines = markdown.split(/\r?\n/)
  const options: KanbanOption[] = []
  const items: KanbanItem[] = []
  let currentGroup = 'Default'
  let itemIdCounter = 1

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const headingMatch = /^#{1,4}\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      currentGroup = headingMatch[1]!.trim()
      ensureGroupOption(options, currentGroup)
      continue
    }

    const itemMatch = /^[-*+]\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(trimmed)
    if (!itemMatch) continue

    ensureGroupOption(options, currentGroup)
    const isChecked = Boolean(itemMatch[1] && itemMatch[1].toLowerCase() === 'x')
    const { properties, cleanText } = parseOutlineProperties(itemMatch[2]!.trim())
    const currentOpt = options.find((o) => o.label === currentGroup)
    if (currentOpt) properties.status = currentOpt.id

    items.push({
      id: `item-${itemIdCounter++}`,
      title: cleanText || 'Untitled',
      properties: { ...properties, ...(isChecked ? { checked: true } : {}) },
    })
  }

  return {
    // No title: an outline body carries none, and inventing one here would not merely name the board —
    // the first edit upgrades the fence to JSON, which writes this value into the note, and every
    // board parsed from an outline would go on claiming the same name in whatever language this file
    // happened to be written in. A board with no title of its own is announced by the caller's own
    // localized label (review K-25).
    activeViewId: 'view-board',
    views: defaultViews(),
    columns: createDefaultColumns(options),
    items,
  }
}

export function serializeKanbanOutline(data: KanbanData): string {
  const statusCol = data.columns.find((c) => c.id === 'status' || c.type === 'select')
  const options = statusCol?.options ?? []
  const lines: string[] = []

  const renderItem = (item: KanbanItem) => {
    const check = item.properties.checked ? '[x]' : '[ ]'
    const tags: string[] = []
    if (item.properties.priority) tags.push(`[priority: ${item.properties.priority}]`)
    if (item.properties.assignee) tags.push(`[assignee: ${item.properties.assignee}]`)
    if (item.properties.startDate) tags.push(`[start: ${item.properties.startDate}]`)
    if (item.properties.endDate) tags.push(`[end: ${item.properties.endDate}]`)
    if (item.properties.progress !== undefined && item.properties.progress !== null) {
      tags.push(`[progress: ${item.properties.progress}]`)
    }
    if (Array.isArray(item.properties.tags) && item.properties.tags.length > 0) {
      tags.push(`[tags: ${item.properties.tags.join(', ')}]`)
    }
    const tagSuffix = tags.length > 0 ? ` ${tags.join(' ')}` : ''
    const escapedTitle = item.title.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    return `- ${check} ${escapedTitle}${tagSuffix}`
  }

  for (const opt of options) {
    lines.push(`## ${opt.label}`)
    const groupItems = data.items.filter((i) => i.properties[statusCol?.id ?? 'status'] === opt.id)
    for (const item of groupItems) {
      lines.push(renderItem(item))
    }
    lines.push('')
  }

  const otherItems = data.items.filter((i) => {
    const val = i.properties[statusCol?.id ?? 'status']
    return !options.some((o) => o.id === val)
  })

  if (otherItems.length > 0) {
    lines.push('## Other')
    for (const item of otherItems) {
      lines.push(renderItem(item))
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}
