/**
 * F-07. A template is what a reader presses when the board they just inserted is empty, so the one
 * thing these cases insist on is that what a template writes is a document the rest of the module
 * can already read: stages the cards are actually filed in, views whose fields exist, ids used once,
 * and nothing shared between two boards that started from the same blueprint.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '../../i18n'
import { installTestGlobals } from '../../test-render'
import { KANBAN_TEMPLATE_KINDS, applyKanbanTemplate } from './templates'
import type { KanbanData, KanbanPropertyType, KanbanView } from './types'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const current: KanbanData = {
  title: 'Q3 Roadmap',
  activeViewId: 'view-table',
  views: [{ id: 'view-table', name: 'Table', type: 'table' }],
  columns: [{ id: 'title', name: 'Title', type: 'title' }],
  items: [],
}

/** What each built-in column id has to be for the control behind it to exist at all. */
const COLUMN_KIND = {
  title: 'title',
  status: 'select',
  tags: 'multi-select',
  assignee: 'person',
  startDate: 'date',
  endDate: 'date',
} as const satisfies Record<string, KanbanPropertyType>

/** Every column a view reads by id, so a template cannot leave a view pointing at nothing. */
function fieldsRead(view: KanbanView): string[] {
  return [view.groupBy, view.swimlaneBy, view.dateField, view.startField, view.endField, view.progressField, view.chartGroupBy]
    .filter((id): id is string => Boolean(id))
}

function statusColumn(data: KanbanData) {
  return data.columns.find((column) => column.id === 'status')
}

describe('the structures a board can start from', () => {
  it.each(KANBAN_TEMPLATE_KINDS)('%s brings its own stages, views and cards to rename', (kind) => {
    const seeded = applyKanbanTemplate(current, kind)
    const status = statusColumn(seeded)
    expect(status?.type).toBe('select')
    expect((status?.options ?? []).length).toBeGreaterThan(1)
    expect(seeded.views.length).toBeGreaterThan(0)
    expect(seeded.items.length).toBeGreaterThan(0)
  })

  it.each(KANBAN_TEMPLATE_KINDS)('%s declares every field the views it brings read', (kind) => {
    const seeded = applyKanbanTemplate(current, kind)
    const declared = new Set(seeded.columns.map((column) => column.id))
    expect(declared.has('title')).toBe(true)
    for (const view of seeded.views) {
      expect(fieldsRead(view).every((id) => declared.has(id)), `view ${view.id} reads a column that is not there`).toBe(true)
    }
  })

  it.each(KANBAN_TEMPLATE_KINDS)('%s types the columns the rest of the board reads by kind', (kind) => {
    const seeded = applyKanbanTemplate(current, kind)
    // Not a stylistic choice: the tag filter bar only collects multi-selects, the member picker only
    // opens on a person column, and a date badge needs a date — mislabel one and the control behind
    // that id silently stops existing.
    const typed = seeded.columns.filter((column) => column.id in COLUMN_KIND)
    expect(typed.length).toBeGreaterThan(2)
    for (const column of typed) expect(column.type, column.id).toBe(COLUMN_KIND[column.id as keyof typeof COLUMN_KIND])
  })

  it.each(KANBAN_TEMPLATE_KINDS)('%s uses every id it writes exactly once', (kind) => {
    const seeded = applyKanbanTemplate(current, kind)
    const columnIds = seeded.columns.map((column) => column.id)
    const viewIds = seeded.views.map((view) => view.id)
    const itemIds = seeded.items.map((item) => item.id)
    expect(new Set(columnIds).size).toBe(columnIds.length)
    expect(new Set(viewIds).size).toBe(viewIds.length)
    expect(new Set(itemIds).size).toBe(itemIds.length)
    for (const column of seeded.columns) {
      const optionIds = (column.options ?? []).map((option) => option.id)
      expect(new Set(optionIds).size).toBe(optionIds.length)
    }
  })
})

describe('what a reader sees on the board a template starts', () => {
  it.each(KANBAN_TEMPLATE_KINDS)('%s files the cards it seeds in a stage that exists', (kind) => {
    const seeded = applyKanbanTemplate(current, kind)
    const stages = new Set((statusColumn(seeded)?.options ?? []).map((option) => option.id))
    expect(seeded.items.length).toBeGreaterThan(1)
    for (const item of seeded.items) {
      expect(stages.has(String(item.properties.status)), item.title).toBe(true)
      expect(item.title.trim()).not.toBe('')
      expect(item.archived).toBeUndefined()
    }
  })

  it('opens the board on the first view the template brings', () => {
    for (const kind of KANBAN_TEMPLATE_KINDS) {
      const seeded = applyKanbanTemplate(current, kind)
      expect(seeded.activeViewId).toBe(seeded.views[0]?.id)
    }
  })

  it.each(KANBAN_TEMPLATE_KINDS)('%s writes names a reader can read, not the keys behind them', (kind) => {
    const seeded = applyKanbanTemplate(current, kind)
    const names = [
      ...seeded.columns.map((column) => column.name),
      ...seeded.columns.flatMap((column) => (column.options ?? []).map((option) => option.label)),
      ...seeded.items.map((item) => item.title),
    ]
    expect(names.length).toBeGreaterThan(5)
    for (const name of names) expect(name.startsWith('preview.')).toBe(false)
  })
})

describe('what a template leaves alone', () => {
  it('keeps the board named what it was named', () => {
    expect(applyKanbanTemplate(current, 'project').title).toBe('Q3 Roadmap')
  })

  it('does not name a board that was never named', () => {
    const anonymous: KanbanData = { ...current, title: undefined }
    expect('title' in applyKanbanTemplate(anonymous, 'content')).toBe(true)
    expect(applyKanbanTemplate(anonymous, 'content').title).toBeUndefined()
  })

  it('writes a fresh document without touching the one it was given', () => {
    const before = JSON.stringify(current)
    const seeded = applyKanbanTemplate(current, 'issues')
    expect(seeded).not.toBe(current)
    expect(JSON.stringify(current)).toBe(before)
    expect(seeded.items).toHaveLength(2)
  })

  it('gives two boards from one blueprint nothing they share', () => {
    const first = applyKanbanTemplate(current, 'project')
    const second = applyKanbanTemplate(current, 'project')
    expect(first.columns).not.toBe(second.columns)
    expect(first.views).not.toBe(second.views)
    expect(first.columns[1]?.options).not.toBe(second.columns[1]?.options)
    expect(first.items.map((item) => item.id)).not.toEqual(second.items.map((item) => item.id))
  })

  it('seeds only what a card must answer: a stage', () => {
    const seeded = applyKanbanTemplate(current, 'content')
    expect(Object.keys(seeded.items[0]!.properties)).toEqual(['status'])
    expect(seeded.items[0]!.properties.status).toBe('idea')
  })
})
