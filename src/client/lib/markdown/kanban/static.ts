/**
 * A board as a still, for every surface that serializes or prints its markup: an exported document, a
 * shared note, a slide, a link hover card, the editor's live preview. Those channels cannot host a
 * live board — a React root there would outlive the page it was drawn for, and every control on it
 * would be a button nobody can press — so the cards travel as the fence describes them. Grouping
 * follows the board's own group column; the view's filters are deliberately not applied, because a
 * still has no control that could tell the reader it is looking at a subset.
 *
 * Two shapes answer two questions. `list` says what is on the board, which is enough for a hover card
 * or a paragraph of exported text. `board` is for a surface read from several metres — a projector,
 * the printed deck, the presenter's own panes — where *which column a card sits in* is itself the
 * information, along with what the card says about itself. It draws the same values the live card
 * draws, reached through the same helpers, so a card cannot read one way on the board and another on
 * its still (N-36).
 */
import { t } from '../../i18n'
import { kanbanActiveItems } from './archive'
import { parseKanbanBody } from './body'
import { kanbanCardCover, kanbanCardFields, readKanbanCardFields } from './card-fields'
import { getKanbanTagStyle, getKanbanTintStyle, resolveKanbanTagColor } from './colors'
import { groupKanbanItems, type KanbanGroup } from './filter-sort'
import { formatKanbanGroupLabel, formatKanbanOptionLabel } from './i18n-helpers'
import type { KanbanData, KanbanItem, KanbanView } from './types'
import { kanbanPriorityColumn, kanbanTagsColumn } from './view-ops'
import { kanbanBody, kanbanBlocks, kanbanPlaceholder, markKanbanReady, removeKanbanLiveControls, showKanbanError } from './view'

export type KanbanSnapshotShape = 'list' | 'board'

function activeView(data: KanbanData): KanbanView | undefined {
  return data.views.find((view) => view.id === data.activeViewId)
}

function snapshotGroups(data: KanbanData): KanbanGroup[] {
  const groupBy = activeView(data)?.groupBy || 'status'
  const groupProperty = data.columns.find((column) => column.id === groupBy)
  // Archived cards are invisible on the live board, so a still of that board must not resurrect them.
  return groupKanbanItems(kanbanActiveItems(data.items), groupBy, groupProperty).filter((group) => group.items.length > 0)
}

function cardList(items: KanbanItem[]): HTMLUListElement {
  const list = document.createElement('ul')
  list.className = 'kanban-snapshot-cards'
  for (const item of items) {
    const card = document.createElement('li')
    card.className = 'kanban-snapshot-card'
    card.textContent = item.title
    list.append(card)
  }
  return list
}

/** The tag chips a card wears, each in the colour the board picked for that tag. */
function cardTags(item: KanbanItem, data: KanbanData): HTMLElement | null {
  const column = kanbanTagsColumn(data.columns)
  const tags = column && Array.isArray(item.properties[column.id]) ? item.properties[column.id] as string[] : []
  if (tags.length === 0) return null
  const list = document.createElement('ul')
  list.className = 'kanban-snapshot-card-tags'
  for (const tag of tags) {
    const option = column?.options?.find((entry) => entry.id === tag || entry.label === tag)
    const chip = document.createElement('li')
    Object.assign(chip.style, getKanbanTagStyle(resolveKanbanTagColor(tag, column?.options)))
    chip.textContent = formatKanbanOptionLabel(option?.label ?? tag, column?.id ?? 'tags')
    list.append(chip)
  }
  return list
}

/** The priority the card was filed under, as the live card's footer chip wears it. */
function cardPriority(item: KanbanItem, data: KanbanData): HTMLElement | null {
  const column = kanbanPriorityColumn(data.columns)
  const option = column?.options?.find((entry) => entry.id === item.properties[column.id] || entry.label === item.properties[column.id])
  if (!option) return null
  const chip = document.createElement('p')
  chip.className = 'kanban-snapshot-card-priority'
  Object.assign(chip.style, getKanbanTagStyle(option.color))
  chip.textContent = formatKanbanOptionLabel(option.label, column?.id ?? 'priority')
  return chip
}

/** The values the view asked to be printed under the title, by their column's own names. */
function cardFields(item: KanbanItem, data: KanbanData, view: KanbanView | undefined): HTMLElement | null {
  if (!view) return null
  const read = readKanbanCardFields(item, kanbanCardFields(view, data.columns), data.columns)
  if (read.length === 0) return null
  const list = document.createElement('dl')
  list.dataset.kanbanCardFields = ''
  for (const field of read) {
    const row = document.createElement('div')
    const name = document.createElement('dt')
    name.textContent = field.label
    const value = document.createElement('dd')
    if (field.href) {
      const link = document.createElement('a')
      link.href = field.href
      link.textContent = field.value
      value.append(link)
    }
    else {
      value.textContent = field.value
    }
    row.append(name, value)
    list.append(row)
  }
  return list
}

/** How far the card got, as the live card's summary bar counts it. */
function cardSubtasks(item: KanbanItem): HTMLElement | null {
  const subtasks = item.subtasks ?? []
  if (subtasks.length === 0) return null
  const done = subtasks.filter((subtask) => subtask.completed).length
  const note = document.createElement('p')
  note.className = 'kanban-snapshot-card-subtasks'
  note.textContent = `${done}/${subtasks.length}`
  return note
}

function boardCard(item: KanbanItem, data: KanbanData, view: KanbanView | undefined): HTMLLIElement {
  const card = document.createElement('li')
  card.className = 'kanban-snapshot-card'
  const cover = kanbanCardCover(item)
  if (cover) {
    const image = document.createElement('img')
    image.className = 'kanban-cover'
    image.src = cover
    image.alt = item.title
    image.decoding = 'async'
    card.append(image)
  }
  const title = document.createElement('p')
  title.className = 'kanban-snapshot-card-title'
  title.textContent = item.title
  card.append(title)
  for (const region of [cardTags(item, data), cardFields(item, data, view), cardSubtasks(item), cardPriority(item, data)]) {
    if (region) card.append(region)
  }
  return card
}

function boardGroup(group: KanbanGroup, data: KanbanData, view: KanbanView | undefined): HTMLElement {
  const column = document.createElement('div')
  column.className = 'kanban-board-column'
  const name = document.createElement('dt')
  name.className = 'kanban-snapshot-group'
  name.textContent = formatKanbanGroupLabel(group.groupKey, group.label)
  const tint = getKanbanTintStyle(group.color)
  if (tint) Object.assign(name.style, tint)
  const cards = document.createElement('dd')
  cards.className = 'kanban-snapshot-group-cards'
  const list = document.createElement('ul')
  list.className = 'kanban-snapshot-cards'
  for (const item of group.items) list.append(boardCard(item, data, view))
  cards.append(list)
  column.append(name, cards)
  return column
}

/**
 * The columns laid out as the board. `styles/kanban.css` keys the row layout on
 * `.kanban-board-columns` and `.kanban-board-column`, so these class names are the contract between
 * the DOM drawn here and the sheet that bends it into columns — a column that stops being a third of
 * the page is a layout regression, and the projector scenario measures exactly that.
 */
function boardColumns(groups: KanbanGroup[], data: KanbanData): HTMLElement {
  const list = document.createElement('dl')
  list.className = 'kanban-snapshot-groups kanban-board-columns'
  const view = activeView(data)
  for (const group of groups) list.append(boardGroup(group, data, view))
  return list
}

function groupList(groups: KanbanGroup[]): HTMLElement {
  const list = document.createElement('dl')
  list.className = 'kanban-snapshot-groups'
  for (const group of groups) {
    const name = document.createElement('dt')
    name.className = 'kanban-snapshot-group'
    name.textContent = formatKanbanGroupLabel(group.groupKey, group.label)
    const cards = document.createElement('dd')
    cards.className = 'kanban-snapshot-group-cards'
    cards.append(cardList(group.items))
    list.append(name, cards)
  }
  return list
}

function emptyNote(): HTMLElement {
  const empty = document.createElement('p')
  empty.className = 'kanban-snapshot-empty'
  empty.textContent = t('preview.kanban_snapshot_empty')
  return empty
}

function titleNote(title: string): HTMLElement {
  const node = document.createElement('p')
  node.className = 'kanban-snapshot-title'
  node.textContent = title
  return node
}

function snapshotNode(data: KanbanData, shape: KanbanSnapshotShape): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = shape === 'board' ? 'kanban-snapshot kanban-snapshot-board' : 'kanban-snapshot'
  wrap.dataset.kanbanSnapshot = '1'
  const groups = snapshotGroups(data)
  if (data.title)
    wrap.append(titleNote(data.title))
  if (groups.length === 0)
    wrap.append(emptyNote())
  else
    wrap.append(shape === 'board' ? boardColumns(groups, data) : groupList(groups))
  return wrap
}

function drawSnapshot(node: HTMLElement, data: KanbanData, shape: KanbanSnapshotShape): void {
  const placeholder = kanbanPlaceholder(node) ?? node
  placeholder.replaceChildren(snapshotNode(data, shape))
  markKanbanReady(node)
}

function drawBlock(node: HTMLElement, shape: KanbanSnapshotShape): void {
  const parsed = parseKanbanBody(kanbanBody(node))
  if (!parsed.ok)
    showKanbanError(node, parsed.error)
  else
    drawSnapshot(node, parsed.data, shape)
  removeKanbanLiveControls(node)
}

/**
 * Draws every kanban block in `root` as a still — its cards as a list, or laid out as the board the
 * fence describes — instead of a board that never arrives.
 */
export function renderStaticKanbans(root: ParentNode, shape: KanbanSnapshotShape = 'list'): void {
  kanbanBlocks(root).forEach((node) => drawBlock(node, shape))
}
