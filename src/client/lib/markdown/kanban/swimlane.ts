/**
 * F-10. A board answers one question — which column is this card in. Swimlanes add a second: which
 * band. Both are groupings over the same items, so the bands are derived through the very same
 * `groupKanbanItems` the columns use (option order, id-or-label matching, the unassigned catch-all,
 * and the work-in-progress rule a column carries all come along instead of being re-decided here).
 *
 * A band is a fact about the card — it is that field's value — so dropping a card into another band
 * writes that field, and one gesture stays one step of undo.
 */
import { reorderKanbanItems } from './dnd'
import type { KanbanMovePivot } from './dnd'
import { groupKanbanItems } from './filter-sort'
import type { KanbanGroup } from './filter-sort'
import type { KanbanData, KanbanItem, KanbanProperty, KanbanView } from './types'

/** Where a drop lands: a column of the board, and the band that column is drawn in. */
export interface KanbanBoardCell {
  groupKey: string
  laneKey?: string
}

export interface KanbanBoardLayout {
  groupPropertyId: string
  groupProperty?: KanbanProperty
  lanePropertyId?: string
  laneProperty?: KanbanProperty
}

export interface KanbanSwimlane {
  lane: KanbanGroup
  columns: KanbanGroup[]
}

export interface KanbanCellMove {
  itemId: string
  cell: KanbanBoardCell
  pivot?: KanbanMovePivot
  layout: KanbanBoardLayout
}

/** The band a card with no value in the lane field belongs to, same key the columns use. */
const UNASSIGNED_BAND = '__none__'

/**
 * Identity of one cell of the grid. A column repeats in every band, so a highlight keyed on the
 * column alone would light up the same column in all of them at once.
 */
export function kanbanCellKey(cell: KanbanBoardCell): string {
  return JSON.stringify([cell.laneKey ?? null, cell.groupKey])
}

/**
 * The two groupings the view asked for, read off the columns this board actually has. Both the
 * drawing and the writer use this, so the band a card is dropped into is the band it is drawn in.
 */
export function kanbanBoardLayout(data: KanbanData, view: KanbanView): KanbanBoardLayout {
  const groupPropertyId = view.groupBy || 'status'
  const lanePropertyId = view.swimlaneBy
  return {
    groupPropertyId,
    groupProperty: data.columns.find((column) => column.id === groupPropertyId),
    lanePropertyId,
    laneProperty: lanePropertyId ? data.columns.find((column) => column.id === lanePropertyId) : undefined,
  }
}

/**
 * The slice of one band a column of the board draws. A band that reaches no card in a column has
 * nothing to group there, so it borrows the column's own answer about its label and its rule.
 */
export function kanbanBandColumn(band: KanbanSwimlane, column: KanbanGroup): KanbanGroup {
  return band.columns.find((group) => group.groupKey === column.groupKey) ?? { ...column, items: [] }
}

export function kanbanSwimlanes(items: KanbanItem[], layout: KanbanBoardLayout): KanbanSwimlane[] {
  const { lanePropertyId, groupPropertyId, groupProperty, laneProperty } = layout
  if (!lanePropertyId) return []
  return groupKanbanItems(items, lanePropertyId, laneProperty).map((lane) => ({
    lane,
    columns: groupKanbanItems(lane.items, groupPropertyId, groupProperty),
  }))
}

/** One drop made with a batch: the cell every picked card lands in, and the card the reader held. */
export interface KanbanCellsMove {
  itemIds: string[]
  anchorId: string
  cell: KanbanBoardCell
  pivot?: KanbanMovePivot
  layout: KanbanBoardLayout
}

/** One card of the document while a batch walks it, with its two neighbours. */
interface MoveNode {
  item: KanbanItem
  prev: MoveNode | null
  next: MoveNode | null
}

/** The document as a list, with the index a picked card is found by and the two ends a drop lands at. */
interface MoveDocument {
  head: MoveNode | null
  tail: MoveNode | null
  byId: Map<string, MoveNode>
}

function buildMoveDocument(items: KanbanItem[]): MoveDocument {
  let head: MoveNode | null = null
  let tail: MoveNode | null = null
  const byId = new Map<string, MoveNode>()
  for (const item of items) {
    const node: MoveNode = { item, prev: tail, next: null }
    if (tail) tail.next = node
    else head = node
    tail = node
    byId.set(item.id, node)
  }
  return { head, tail, byId }
}

function unlinkMoveNode(document: MoveDocument, node: MoveNode): void {
  if (node.prev) node.prev.next = node.next
  else document.head = node.next
  if (node.next) node.next.prev = node.prev
  else document.tail = node.prev
}

function linkMoveNode(document: MoveDocument, node: MoveNode, insertAfter: MoveNode | null): void {
  node.prev = insertAfter
  node.next = insertAfter ? insertAfter.next : document.head
  if (node.next) node.next.prev = node
  else document.tail = node
  if (node.prev) node.prev.next = node
  else document.head = node
}

/** The walking state one batch drop keeps between its picked cards. */
interface BatchWalk {
  document: MoveDocument
  /** Same membership rule the column filter uses, so a column of unvalued cards is found the same way. */
  inTargetColumn: (item: KanbanItem) => boolean
  /**
   * The last card of the target column, in document order — the place a card with no pivot lands.
   * Either the column's true last card, or one standing somewhere before it: a pivot can land a card
   * mid-document, so a read may still have to walk forward to find where the column ends.
   */
  columnTail: MoveNode | null
  columnTailResolved: boolean
}

function openBatchWalk(document: MoveDocument, move: KanbanCellsMove): BatchWalk {
  const groupPropertyId = move.layout.groupPropertyId
  const inTargetColumn = (item: KanbanItem): boolean => {
    const value = item.properties[groupPropertyId]
    return move.cell.groupKey === UNASSIGNED_BAND ? !value : value === move.cell.groupKey
  }
  let columnTail: MoveNode | null = null
  for (let node = document.head; node; node = node.next) {
    if (inTargetColumn(node.item)) columnTail = node
  }
  return { document, inTargetColumn, columnTail, columnTailResolved: true }
}

function resolveBatchColumnTail(walk: BatchWalk): void {
  if (walk.columnTail && !walk.columnTailResolved) {
    for (let cursor = walk.columnTail.next; cursor; cursor = cursor.next) {
      if (walk.inTargetColumn(cursor.item)) walk.columnTail = cursor
    }
    walk.columnTailResolved = true
  }
}

/** Where the card lands, read off the list without it, the way the array mover reads the array. */
function batchInsertionAfter(
  walk: BatchWalk,
  heldPivot: KanbanMovePivot | undefined,
): { insertAfter: MoveNode | null; atColumnEnd: boolean; atDocumentEnd: boolean } {
  const { document, columnTail } = walk
  if (heldPivot) {
    const pivotNode = document.byId.get(heldPivot.itemId)
    // A pivot only names a place inside a column that still has cards: the array mover never
    // reached it when the target group came out empty, and the card went to the document's end.
    if (pivotNode && columnTail) {
      const insertAfter = heldPivot.position === 'before' ? pivotNode.prev : pivotNode
      walk.columnTailResolved = false
      return {
        insertAfter,
        atColumnEnd: insertAfter === columnTail,
        atDocumentEnd: insertAfter === document.tail,
      }
    }
  }
  return {
    insertAfter: columnTail ?? document.tail,
    atColumnEnd: columnTail !== null,
    atDocumentEnd: columnTail === null,
  }
}

function moveBatchCard(walk: BatchWalk, move: KanbanCellsMove, itemId: string): void {
  const { cell, pivot, layout } = move
  const { groupPropertyId, lanePropertyId } = layout
  const laneKey = cell.laneKey
  const node = walk.document.byId.get(itemId)
  if (!node) return
  // The band is written even when the card never leaves its column (see `moveKanbanItemToCell`).
  if (laneKey !== undefined && lanePropertyId) node.item = writeBand(node.item, lanePropertyId, laneKey)
  const heldPivot = itemId === move.anchorId ? pivot : undefined
  if (!heldPivot && laneKey !== undefined && staysInColumn(node.item, groupPropertyId, cell.groupKey)) return
  if (heldPivot && heldPivot.itemId === itemId) return

  // Out of the document first: the insertion point is read off the list without this card.
  unlinkMoveNode(walk.document, node)
  // The tail is resolved before the removal is reconciled with it: a pivot may have left it pointing
  // before the column's true last card, and the rewind below has to start from that true last card.
  resolveBatchColumnTail(walk)
  if (node === walk.columnTail) {
    let cursor = node.prev
    while (cursor && !walk.inTargetColumn(cursor.item)) cursor = cursor.prev
    walk.columnTail = cursor
  }

  const where = batchInsertionAfter(walk, heldPivot)
  node.item = {
    ...node.item,
    properties: {
      ...node.item.properties,
      [groupPropertyId]: cell.groupKey === UNASSIGNED_BAND ? undefined : cell.groupKey,
    },
  }
  linkMoveNode(walk.document, node, where.insertAfter)
  // Landing after the column's last card — or at the document's end, when the column had none —
  // makes this card the column's last; a pivot that stood mid-column leaves the tail behind it.
  if (where.atColumnEnd || where.atDocumentEnd) {
    walk.columnTail = node
    walk.columnTailResolved = true
  }
}

function readMoveDocument(document: MoveDocument): KanbanItem[] {
  const next: KanbanItem[] = []
  for (let node = document.head; node; node = node.next) next.push(node.item)
  return next
}

/**
 * The same drop, made with a batch: every picked card lands in the cell, and the card the reader was
 * holding takes the place under the pointer. A pivot for each of them would be a guess — the pointer
 * named one spot, not one per card — so the rest of the batch keeps the order it already had, which is
 * the order the array gives the target column.
 *
 * The walk is card by card the same walk `moveKanbanItemToCell` makes — band write, the card that
 * only changed band staying put, the held card's pivot — but over a linked list instead of the
 * document array. The reduce this used to be ran four whole-array scans per picked card (find, map,
 * filter, splice), so a few hundred picked cards on a ceiling-size board spent a long frame copying
 * arrays; here every step is a pointer move and the array is walked twice, once to build the list
 * and once to read it back.
 */
export function moveKanbanItemsToCell(items: KanbanItem[], move: KanbanCellsMove): KanbanItem[] {
  const walk = openBatchWalk(buildMoveDocument(items), move)
  for (const itemId of move.itemIds) moveBatchCard(walk, move, itemId)
  return readMoveDocument(walk.document)
}

export function moveKanbanItemToCell(items: KanbanItem[], move: KanbanCellMove): KanbanItem[] {
  const { itemId, cell, pivot, layout } = move
  const laneKey = cell.laneKey
  const lanePropertyId = layout.lanePropertyId
  const cardIndex = items.findIndex((item) => item.id === itemId)
  // A card that is not on the board has no band to write, and handing back a fresh array would
  // make the no-op look like a change worth a step of undo.
  const written = laneKey === undefined || !lanePropertyId || cardIndex === -1
    ? items
    : items.map((item) => (item.id === itemId ? writeBand(item, lanePropertyId, laneKey) : item))
  const card = written[cardIndex]
  // A card that only changed band never left its column, so it keeps its place there — the reorder
  // below would otherwise drop it at the bottom of a column it is still standing in.
  if (!pivot && card && laneKey !== undefined && staysInColumn(card, layout.groupPropertyId, cell.groupKey)) {
    return written
  }
  return reorderKanbanItems(written, itemId, layout.groupPropertyId, cell.groupKey, pivot)
}

/**
 * Whether the card already names this column as its value. Deliberately stricter than the drawing,
 * which also reads a label where the board expects an id: a card that only *looks* misplaced gets the
 * reorder it asked for, which is the previous behaviour, rather than being left in place by mistake.
 */
function staysInColumn(item: KanbanItem, groupPropertyId: string, groupKey: string): boolean {
  const value = item.properties[groupPropertyId]
  return groupKey === UNASSIGNED_BAND ? !value : value === groupKey
}

function writeBand(item: KanbanItem, lanePropertyId: string, laneKey: string): KanbanItem {
  const properties = { ...item.properties }
  if (laneKey === UNASSIGNED_BAND) delete properties[lanePropertyId]
  else properties[lanePropertyId] = laneKey
  return { ...item, properties }
}
