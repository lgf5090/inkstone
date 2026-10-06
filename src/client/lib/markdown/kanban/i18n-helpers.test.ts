import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n, setLocale, t } from '../../i18n'
import {
  formatKanbanGroupLabel,
  formatKanbanOptionLabel,
  formatKanbanPropertyName,
  formatKanbanViewName,
} from './i18n-helpers'

beforeAll(async () => {
  await initI18n()
  await setLocale('zh-CN')
})

describe('formatKanbanViewName', () => {
  it('formats default view names based on view type', () => {
    expect(formatKanbanViewName({ id: '1', name: 'Board', type: 'board' })).toBe(t('preview.kanban_view_board'))
    expect(formatKanbanViewName({ id: '2', name: 'Table', type: 'table' })).toBe(t('preview.kanban_view_table'))
    expect(formatKanbanViewName({ id: '3', name: 'Calendar', type: 'calendar' })).toBe(t('preview.kanban_view_calendar'))
    expect(formatKanbanViewName({ id: '4', name: 'Timeline', type: 'timeline' })).toBe(t('preview.kanban_view_timeline'))
    expect(formatKanbanViewName({ id: '5', name: 'Gantt', type: 'gantt' })).toBe(t('preview.kanban_view_gantt'))
    expect(formatKanbanViewName({ id: '6', name: 'List', type: 'list' })).toBe(t('preview.kanban_view_list'))
    expect(formatKanbanViewName({ id: '7', name: 'Gallery', type: 'gallery' })).toBe(t('preview.kanban_view_gallery'))
  })

  it('preserves custom user-entered view names', () => {
    expect(formatKanbanViewName({ id: '8', name: 'My Sprint Sprint 24', type: 'board' })).toBe('My Sprint Sprint 24')
  })

  // A created or duplicated view stores `<type> <n>` so two tabs of one kind read apart. The number
  // is the only thing appended, because the resource already names the view — a `{count}` plural
  // would have to be a phrase per language, and here it is a bare ordinal on both sides.
  it('translates a generated name and keeps its number', () => {
    expect(formatKanbanViewName({ id: '9', name: 'board 2', type: 'board' })).toBe(`${t('preview.kanban_view_board')} 2`)
    expect(formatKanbanViewName({ id: '10', name: 'Gantt 12', type: 'gantt' })).toBe(`${t('preview.kanban_view_gantt')} 12`)
    expect(formatKanbanViewName({ id: '11', name: 'list 2', type: 'table' })).toBe(`${t('preview.kanban_view_list')} 2`)
  })

  it('leaves a hand-typed name that only looks numbered alone', () => {
    expect(formatKanbanViewName({ id: '12', name: 'Sprint 2', type: 'board' })).toBe('Sprint 2')
  })
})

describe('formatKanbanPropertyName', () => {
  it('formats standard property names', () => {
    expect(formatKanbanPropertyName('title')).toBe(t('preview.kanban_prop_title'))
    expect(formatKanbanPropertyName('Status')).toBe(t('preview.kanban_prop_status'))
    expect(formatKanbanPropertyName('priority')).toBe(t('preview.kanban_prop_priority'))
    expect(formatKanbanPropertyName('Assignee')).toBe(t('preview.kanban_prop_assignee'))
    expect(formatKanbanPropertyName('startDate')).toBe(t('preview.kanban_prop_start_date'))
    expect(formatKanbanPropertyName('end_date')).toBe(t('preview.kanban_prop_end_date'))
  })

  it('preserves custom property names', () => {
    expect(formatKanbanPropertyName('Custom Field')).toBe('Custom Field')
  })

  // A column the reader renamed has to read as they wrote it in every language; only a column still
  // carrying the name the fence generated for its id is taken apart for translating.
  it('shows a renamed built-in column the way the reader named it', () => {
    expect(formatKanbanPropertyName({ id: 'status', name: 'Board state', type: 'select' })).toBe('Board state')
    expect(formatKanbanPropertyName({ id: 'priority', name: 'Severity', type: 'select' })).toBe('Severity')
  })

  it('still translates a built-in column whose name only differs in case or spacing', () => {
    expect(formatKanbanPropertyName({ id: 'status', name: 'status', type: 'select' })).toBe(t('preview.kanban_prop_status'))
    expect(formatKanbanPropertyName({ id: 'startDate', name: 'Start Date', type: 'date' })).toBe(t('preview.kanban_prop_start_date'))
    expect(formatKanbanPropertyName({ id: 'end_date', name: 'end date', type: 'date' })).toBe(t('preview.kanban_prop_end_date'))
  })

  it('falls back to the built-in name when a column carries none', () => {
    expect(formatKanbanPropertyName({ id: 'tags', name: '', type: 'multi-select' })).toBe(t('preview.kanban_prop_tags'))
  })
})

describe('formatKanbanOptionLabel', () => {
  it('formats standard status and priority options', () => {
    expect(formatKanbanOptionLabel({ id: 'todo', label: 'To Do', color: 'gray' })).toBe(t('preview.kanban_status_todo'))
    expect(formatKanbanOptionLabel({ id: 'in_progress', label: 'In Progress', color: 'blue' })).toBe(t('preview.kanban_status_in_progress'))
    expect(formatKanbanOptionLabel({ id: 'done', label: 'Done', color: 'green' })).toBe(t('preview.kanban_status_done'))
    expect(formatKanbanOptionLabel({ id: 'high', label: 'High', color: 'red' })).toBe(t('preview.kanban_priority_high'))
  })

  it('formats fallback group label', () => {
    expect(formatKanbanGroupLabel('__none__', 'No Status')).toBe(t('preview.kanban_no_status'))
    expect(formatKanbanGroupLabel('status-1', 'To Do')).toBe(t('preview.kanban_status_todo'))
  })
})
