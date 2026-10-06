/**
 * Core type definitions for the Kanban and Notion-style database block.
 */

export type KanbanPropertyType =
  | 'title'
  | 'select'
  | 'multi-select'
  | 'date'
  | 'text'
  | 'number'
  | 'checkbox'
  | 'person'
  | 'files'
  | 'url'

export type KanbanColorName =
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
  | 'coral'
  | 'teal'
  | 'slate'

export interface KanbanOption {
  id: string
  label: string
  color: KanbanColorName
  /** Cards this workflow state may hold at once; absent means the reader set no rule. See `filter-sort.ts`. */
  wipLimit?: number
}

/**
 * What a reader may change about one column of the board. `wipLimit` is optional in the patch and
 * also clearable: a patch that names it at all answers the question, so `undefined` removes the
 * rule, while leaving the key out keeps the rule the column has.
 */
export type KanbanColumnPatch = Partial<Pick<KanbanOption, 'label' | 'color' | 'wipLimit'>>

/**
 * How a new card arrives, for the doors that do not all want the same thing. Every door but one opens
 * the card's own window so the reader can fill the rest of it in; the column's title field keeps the
 * focus instead, so a column of cards can be typed in one title at a time (`ku-13`).
 */
export interface KanbanAddFinish {
  /** The title to give the new card. Absent or blank means the localized placeholder title. */
  title?: string
  /** Open the card's window. Absent means yes, which is how every door but the title field behaves. */
  openDetail?: boolean
}

export interface KanbanProperty {
  id: string
  name: string
  type: KanbanPropertyType
  options?: KanbanOption[]
  /** Pixels the reader sized this column to; absent means the type decides. See `column-width.ts`. */
  width?: number
}

export interface KanbanFile {
  id: string
  name: string
  size: number
  mime: string
  url: string
}

export interface KanbanSubtask {
  id: string
  title: string
  completed: boolean
  icon?: string
  description?: string
  status?: string
  dueDate?: string
  startDate?: string
  priority?: string
  owner?: string
  tags?: string[]
}

/**
 * What someone said about a card. A board is a document, so the note it carries has no account to
 * attribute a comment to: the name is whatever the writer typed, and a comment without one is simply
 * unattributed rather than filed under somebody guessed at.
 */
export interface KanbanComment {
  id: string
  text: string
  /** Who wrote it, as they chose to be called; absent means the writer stayed anonymous. */
  author?: string
  /** When it was written, in UTC. The reader's own locale is what prints it. */
  at?: string
}

export interface KanbanItem {
  id: string
  title: string
  icon?: string
  cover?: string
  content?: string
  description?: string
  files?: KanbanFile[]
  subtasks?: KanbanSubtask[]
  /** What the board's readers have said about this card, oldest first. See `comments.ts`. */
  comments?: KanbanComment[]
  /** Set only while the card is archived; restoring deletes the key. See `archive.ts`. */
  archived?: boolean
  /** Set only while the card sits in the deleted list: still in the document, out of every view.
   *  Restoring deletes the key; the purge removes the card itself. See `archive.ts`. */
  deleted?: boolean
  /** The ids of the cards that must be done before this one — its blockers. See `dependencies.ts` (KU-23). */
  dependsOn?: string[]
  properties: Record<string, unknown>
}

export type KanbanViewType =
  | 'board'
  | 'table'
  | 'calendar'
  | 'timeline'
  | 'gantt'
  | 'list'
  | 'gallery'
  | 'chart'

export type KanbanChartType =
  | 'bar'
  | 'line'
  | 'pie'
  | 'doughnut'
  | 'polarArea'
  | 'radar'

export interface KanbanChartDataset {
  labels: string[]
  data: number[]
  colors: KanbanColorName[]
  total: number
  /**
   * The property value each slice stands for, aligned with `labels` — the option id a click can
   * write into a filter rule. Slices that stand for several stray values at once (the "no value"
   * bucket, or the single slice a property-less group draws) have no one value and are `undefined`.
   */
  values: (string | undefined)[]
}

export type KanbanFilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'greater_or_equal'
  | 'less_or_equal'
  | 'before'
  | 'after'
  | 'is_overdue'
  | 'is_empty'
  | 'is_not_empty'

export interface KanbanFilter {
  propertyId: string
  operator: KanbanFilterOperator
  value?: string
}

export interface KanbanSort {
  propertyId: string
  direction: 'asc' | 'desc'
}

export interface KanbanView {
  id: string
  name: string
  type: KanbanViewType
  groupBy?: string
  /** Board only: a second field the cards are cut into horizontal bands by. */
  swimlaneBy?: string
  dateField?: string
  startField?: string
  endField?: string
  progressField?: string
  chartType?: KanbanChartType
  chartGroupBy?: string
  filters?: KanbanFilter[]
  sorts?: KanbanSort[]
  searchQuery?: string
  /** Tag names this view filters to; stored on the view with the search and the filters beside it. */
  selectedTags?: string[]
  /**
   * The number column this view totals into its column headers; absent means the reader asked for no
   * summary. A column that stopped being a number keeps the id (see the view options' candidates).
   */
  sumBy?: string
  cardSize?: 'small' | 'medium' | 'large'
  hiddenColumns?: string[]
  /**
   * Columns this view prints on its own cards, in the order they are read. Absent means none, which is
   * the card every board drew before the setting existed (see `card-fields.ts` for what a value reads as).
   */
  cardFields?: string[]
}

export interface KanbanData {
  title?: string
  activeViewId?: string
  views: KanbanView[]
  columns: KanbanProperty[]
  items: KanbanItem[]
}

export type KanbanMode = 'json' | 'outline'

export type KanbanParseResult =
  | { ok: true; data: KanbanData; mode: KanbanMode }
  | { ok: false; error: string; raw: string }

export interface KanbanFenceRef {
  line: number
  body: string
}

export type KanbanWriteResult = 'written' | 'conflict' | 'missing'

export type KanbanWriter = (ref: KanbanFenceRef, nextBody: string) => KanbanWriteResult
