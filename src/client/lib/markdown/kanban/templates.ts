/**
 * F-07. The structures a reader can start an empty board from.
 *
 * A template hands over a whole document rather than a pile of cards, because a board's views, its
 * columns and the stages its cards sit in have to agree the moment it is drawn: adding a group to a
 * board with no grouping column is what the error state is for. So each blueprint below declares the
 * three together, keeps the grouping column under the id `status` (the id the rest of the module
 * treats as the workflow, from `handleAddItem` to the WIP limits), and builds its other columns out
 * of the ids the board already knows how to read — dates a calendar can point at, a person field the
 * picker fills, tags the filter bar collects.
 *
 * Only the *id* of a stage is fixed: what a reader sees is written in the language they are working
 * in, so the fence holds ordinary text afterwards and stops following the interface the moment they
 * rename a stage, which is what a template is for.
 */
import { t, type MessageKey } from '../../i18n'
import { createKanbanId } from './id'
import type {
  KanbanColorName,
  KanbanData,
  KanbanItem,
  KanbanProperty,
  KanbanView,
} from './types'

export type KanbanTemplateKind = 'project' | 'content' | 'issues'

export const KANBAN_TEMPLATE_KINDS: KanbanTemplateKind[] = ['project', 'content', 'issues']

/** One choice as a blueprint states it: the id the cards carry, the name to print, the tint. */
type Stage = [id: string, labelKey: MessageKey, color: KanbanColorName]

interface KanbanTemplate {
  columns: () => KanbanProperty[]
  views: () => KanbanView[]
  /** One stage per seeded card, so a reader sees a card in the places a card is meant to sit. */
  seeds: () => KanbanItem[]
}

function selectColumn(id: string, nameKey: MessageKey, type: 'select' | 'multi-select', stages: Stage[]): KanbanProperty {
  return { id, name: t(nameKey), type, options: stages.map(([value, labelKey, color]) => ({ id: value, label: t(labelKey), color })) }
}

function datedColumn(id: string, nameKey: MessageKey): KanbanProperty {
  return { id, name: t(nameKey), type: 'date' }
}

function exampleItems(stages: string[], titles: MessageKey[]): KanbanItem[] {
  return titles.map((titleKey, index) => ({
    id: `item-${createKanbanId()}`,
    title: t(titleKey),
    properties: { status: stages[index] },
  }))
}

const TITLE_COLUMN = (): KanbanProperty => ({ id: 'title', name: t('preview.kanban_prop_title'), type: 'title' })

const EXAMPLE_TITLES: MessageKey[] = ['preview.kanban_template_example_card', 'preview.kanban_template_example_card_two']

const PROJECT_STAGES: Stage[] = [
  ['todo', 'preview.kanban_status_todo', 'gray'],
  ['in_progress', 'preview.kanban_status_in_progress', 'blue'],
  ['in_review', 'preview.kanban_status_in_review', 'yellow'],
  ['done', 'preview.kanban_status_done', 'green'],
]

const PRIORITIES: Stage[] = [
  ['low', 'preview.kanban_priority_low', 'green'],
  ['medium', 'preview.kanban_priority_medium', 'yellow'],
  ['high', 'preview.kanban_priority_high', 'red'],
]

const CONTENT_STAGES: Stage[] = [
  ['idea', 'preview.kanban_status_idea', 'gray'],
  ['writing', 'preview.kanban_status_writing', 'blue'],
  ['in_review', 'preview.kanban_status_in_review', 'yellow'],
  ['scheduled', 'preview.kanban_status_scheduled', 'purple'],
  ['published', 'preview.kanban_status_published', 'green'],
]

const ISSUE_STAGES: Stage[] = [
  ['backlog', 'preview.kanban_status_backlog', 'gray'],
  ['triage', 'preview.kanban_status_triage', 'slate'],
  ['in_progress', 'preview.kanban_status_in_progress', 'blue'],
  ['waiting', 'preview.kanban_status_waiting', 'yellow'],
  ['resolved', 'preview.kanban_status_resolved', 'green'],
]

const ISSUE_LABELS: Stage[] = [
  ['feat', 'preview.kanban_tag_feat', 'green'],
  ['improve', 'preview.kanban_tag_improve', 'blue'],
  ['bug', 'preview.kanban_tag_bug', 'red'],
]

const TEMPLATES: Record<KanbanTemplateKind, KanbanTemplate> = {
  project: {
    columns: () => [
      TITLE_COLUMN(),
      selectColumn('status', 'preview.kanban_prop_status', 'select', PROJECT_STAGES),
      selectColumn('priority', 'preview.kanban_prop_priority', 'select', PRIORITIES),
      { id: 'assignee', name: t('preview.kanban_prop_assignee'), type: 'person' },
      datedColumn('startDate', 'preview.kanban_prop_start_date'),
      datedColumn('endDate', 'preview.kanban_prop_end_date'),
    ],
    views: () => [
      { id: 'view-board', name: 'Board', type: 'board', groupBy: 'status' },
      { id: 'view-table', name: 'Table', type: 'table' },
      { id: 'view-calendar', name: 'Calendar', type: 'calendar', dateField: 'startDate' },
      { id: 'view-gantt', name: 'Gantt', type: 'gantt', startField: 'startDate', endField: 'endDate' },
      { id: 'view-chart', name: 'Chart', type: 'chart', chartType: 'bar', chartGroupBy: 'status' },
      { id: 'view-gallery', name: 'Gallery', type: 'gallery' },
    ],
    seeds: () => exampleItems(['todo', 'in_progress'], EXAMPLE_TITLES),
  },
  content: {
    columns: () => [
      TITLE_COLUMN(),
      selectColumn('status', 'preview.kanban_prop_status', 'select', CONTENT_STAGES),
      { id: 'assignee', name: t('preview.kanban_prop_assignee'), type: 'person' },
      datedColumn('endDate', 'preview.kanban_prop_end_date'),
    ],
    views: () => [
      { id: 'view-board', name: 'Board', type: 'board', groupBy: 'status' },
      { id: 'view-calendar', name: 'Calendar', type: 'calendar', dateField: 'endDate' },
      { id: 'view-table', name: 'Table', type: 'table' },
      { id: 'view-list', name: 'List', type: 'list' },
    ],
    seeds: () => exampleItems(['idea', 'writing'], EXAMPLE_TITLES),
  },
  issues: {
    columns: () => [
      TITLE_COLUMN(),
      selectColumn('status', 'preview.kanban_prop_status', 'select', ISSUE_STAGES),
      selectColumn('priority', 'preview.kanban_prop_priority', 'select', PRIORITIES),
      selectColumn('tags', 'preview.kanban_prop_tags', 'multi-select', ISSUE_LABELS),
      { id: 'assignee', name: t('preview.kanban_prop_assignee'), type: 'person' },
    ],
    views: () => [
      { id: 'view-board', name: 'Board', type: 'board', groupBy: 'status' },
      { id: 'view-table', name: 'Table', type: 'table' },
      { id: 'view-chart', name: 'Chart', type: 'chart', chartType: 'bar', chartGroupBy: 'priority' },
      { id: 'view-list', name: 'List', type: 'list' },
    ],
    seeds: () => exampleItems(['backlog', 'triage'], EXAMPLE_TITLES),
  },
}

/**
 * Writes a blueprint over the document it is given, keeping the board's own name — an unnamed board
 * stays unnamed. One commit, so one undo takes a template back off.
 */
export function applyKanbanTemplate(current: KanbanData, kind: KanbanTemplateKind): KanbanData {
  const template = TEMPLATES[kind]
  const views = template.views()
  return {
    ...current,
    activeViewId: views[0]?.id,
    views,
    columns: template.columns(),
    items: template.seeds(),
  }
}
