/**
 * The document edits behind the view switcher: what a board looks like after it gains, names,
 * copies, orders or loses a view. These stay free of React and of the store because the board
 * history wraps every commit — an operation that only returns the next document is undoable for
 * free, and the toast's way back is the same undo as Ctrl+Z.
 */
import { createKanbanId } from './id'
import type { KanbanData, KanbanProperty, KanbanView, KanbanViewType } from './types'

/** The kinds a reader can add, in the order the switcher lists them. */
export const KANBAN_VIEW_TYPES: KanbanViewType[] = [
  'board',
  'table',
  'calendar',
  'timeline',
  'gantt',
  'list',
  'gallery',
  'chart',
]

// A generated name is `<type> <n>`; only that shape is counted when numbering the next one, so a
// name a reader typed by hand cannot be mistaken for a sibling of the same kind.
const GENERATED_VIEW_NAME = /^(.*?)\s(\d+)$/

function isOptionColumn(column: KanbanProperty): boolean {
  return column.type === 'select' || column.type === 'multi-select'
}

/**
 * The columns the UI paints chips, pickers and the progress bar with. The fence is a public format,
 * so a hand-written board may name its columns anything: the conventional id wins when it is there,
 * and otherwise the first column of the kind the field needs answers — never an invented id, which
 * is what used to write ghost values no option owned.
 */
export function kanbanStatusColumn(columns: KanbanProperty[]): KanbanProperty | undefined {
  return columns.find((column) => column.id === 'status') ?? columns.find(isOptionColumn)
}

export function kanbanPriorityColumn(columns: KanbanProperty[]): KanbanProperty | undefined {
  const conventional = columns.find((column) => column.id === 'priority')
  if (conventional) return conventional
  const status = kanbanStatusColumn(columns)
  return columns.find((column) => isOptionColumn(column) && column !== status)
}

export function kanbanTagsColumn(columns: KanbanProperty[]): KanbanProperty | undefined {
  const conventional = columns.find((column) => column.id === 'tags')
  if (conventional) return conventional
  const status = kanbanStatusColumn(columns)
  return columns.find((column) => column.type === 'multi-select' && column !== status)
}

function groupSource(columns: KanbanProperty[]): string {
  // A board view's grouping is stricter than the chip resolvers above: the conventional id only
  // counts when it actually holds options, so a text column that happens to be called `status`
  // never becomes the thing new boards group by.
  return (columns.find((c) => c.id === 'status' && isOptionColumn(c)) ?? columns.find(isOptionColumn))?.id ?? 'status'
}

function dateColumns(columns: KanbanProperty[]): KanbanProperty[] {
  return columns.filter((c) => c.type === 'date')
}

/**
 * The fields a view needs to draw anything, read off the columns this board actually has. A view
 * that cannot be answered by the schema is left asking nothing rather than inventing a property id
 * no item will ever carry.
 */
function kanbanViewFields(type: KanbanViewType, columns: KanbanProperty[]): Partial<KanbanView> {
  const dates = dateColumns(columns)
  switch (type) {
    case 'board':
      return { groupBy: groupSource(columns) }
    case 'chart':
      return { chartType: 'bar', chartGroupBy: groupSource(columns) }
    case 'calendar':
      return { dateField: dates[0]?.id }
    case 'timeline':
      return { startField: dates[0]?.id, endField: dates[1]?.id }
    case 'gantt':
      return {
        startField: dates[0]?.id,
        endField: dates[1]?.id,
        progressField: columns.find((c) => c.type === 'number')?.id,
      }
    default:
      return {}
  }
}

function generatedViewName(type: KanbanViewType, views: KanbanView[]): string {
  let highest = 0
  for (const view of views) {
    const numbered = GENERATED_VIEW_NAME.exec(view.name)
    const head = (numbered?.[1] ?? view.name).toLowerCase()
    if (head !== type.toLowerCase()) continue
    highest = Math.max(highest, numbered ? Number(numbered[2]) : 1)
  }
  return highest === 0 ? type : `${type} ${highest + 1}`
}

/** Builds an unset view of `type`. The name stores the type itself so the tab keeps translating. */
export function createKanbanView(type: KanbanViewType, columns: KanbanProperty[], views: KanbanView[]): KanbanView {
  return {
    id: `view-${createKanbanId()}`,
    name: generatedViewName(type, views),
    type,
    ...kanbanViewFields(type, columns),
  }
}

/**
 * Whether the view narrows or reorders the cards on its own — filters, sorts, a search query, or a
 * tag selection. The tab strip marks such views with a dot, because a view that shows fewer cards
 * than the board beside it otherwise reads as data loss rather than as a lens the reader (or an
 * earlier session) left on it. Shaping preferences (grouping, card size, hidden columns) are not
 * what the dot names: they change how the same cards are drawn, not which cards are there.
 */
export function kanbanViewCarriesState(view: KanbanView): boolean {
  return Boolean(
    (view.filters && view.filters.length > 0) ||
    (view.sorts && view.sorts.length > 0) ||
    (view.searchQuery && view.searchQuery.trim().length > 0) ||
    (view.selectedTags && view.selectedTags.length > 0),
  )
}

function withViews(data: KanbanData, views: KanbanView[], activeViewId: KanbanData['activeViewId']): KanbanData {
  return { ...data, views, activeViewId }
}

/** Appends a view of `type` and puts it on screen. */
export function addKanbanView(data: KanbanData, type: KanbanViewType): KanbanData {
  const view = createKanbanView(type, data.columns, data.views)
  return withViews(data, [...data.views, view], view.id)
}

/** Copies a view's whole config into the slot next to it, under a name of its own. */
export function duplicateKanbanView(data: KanbanData, viewId: string): KanbanData {
  const index = data.views.findIndex((v) => v.id === viewId)
  if (index === -1) return data
  const source = data.views[index]!
  const copy: KanbanView = {
    ...source,
    id: `view-${createKanbanId()}`,
    name: generatedViewName(source.type, data.views),
    filters: source.filters ? [...source.filters] : undefined,
    sorts: source.sorts ? [...source.sorts] : undefined,
    hiddenColumns: source.hiddenColumns ? [...source.hiddenColumns] : undefined,
    cardFields: source.cardFields ? [...source.cardFields] : undefined,
  }
  const views = [...data.views]
  views.splice(index + 1, 0, copy)
  return withViews(data, views, copy.id)
}

export function renameKanbanView(data: KanbanData, viewId: string, name: string): KanbanData {
  const trimmed = name.trim()
  if (!trimmed) return data
  return withViews(data, data.views.map((v) => (v.id === viewId ? { ...v, name: trimmed } : v)), data.activeViewId)
}

/**
 * Drops a view, never the last one: with no view left the board has nothing to render, and its
 * `activeViewId` would name a view that does not exist. The neighbour to the left takes the screen,
 * because that is where the reader's attention was before the tab vanished.
 */
export function removeKanbanView(data: KanbanData, viewId: string): KanbanData {
  if (data.views.length < 1 + 1) return data
  const index = data.views.findIndex((v) => v.id === viewId)
  if (index === -1) return data
  const views = data.views.filter((v) => v.id !== viewId)
  const shown = data.activeViewId !== viewId
    ? data.activeViewId
    : views[Math.max(index - 1, 0)]!.id
  return withViews(data, views, shown)
}

/** Steps a tab one place along the strip; at either end there is nowhere to go. */
export function moveKanbanView(data: KanbanData, viewId: string, offset: -1 | 1): KanbanData {
  const index = data.views.findIndex((v) => v.id === viewId)
  const target = index + offset
  if (index === -1 || target < 0 || target >= data.views.length) return data
  const views = [...data.views]
  const [moved] = views.splice(index, 1)
  views.splice(target, 0, moved!)
  return withViews(data, views, data.activeViewId)
}
