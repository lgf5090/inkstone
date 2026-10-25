import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  TODO_TEMPLATE_MAX,
  TODO_TEMPLATE_TAG_MAX,
  mergeSettings,
} from './constants'
import type { TodoTemplate } from './types'

const templates = (value: unknown) => mergeSettings({ todo: value }).todo.templates ?? []

function template(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'weekly-report-abc',
    name: 'Weekly report',
    title: 'Weekly report',
    description: 'Numbers first',
    priority: 'high',
    listId: 'work',
    tags: ['work'],
    steps: ['Gather', 'Write'],
    timeEstimate: 5_400_000,
    ...over,
  }
}

describe('the kept task templates', () => {
  it('reads back as none when the blob never had them', () => {
    expect(templates({})).toEqual([])
    expect(templates({ templates: 'nope' })).toEqual([])
  })

  it('survives a round trip through the merge', () => {
    // The one thing this field cannot afford: a panel that writes a template and a merge that drops it,
    // with nothing on screen to say the save went nowhere.
    const saved = mergeSettings({ todo: { templates: [template()] } })
    const reread = mergeSettings(JSON.parse(JSON.stringify(saved)))

    expect(reread.todo.templates).toEqual<TodoTemplate[]>([{
      id: 'weekly-report-abc',
      name: 'Weekly report',
      title: 'Weekly report',
      description: 'Numbers first',
      priority: 'high',
      listId: 'work',
      tags: ['work'],
      steps: ['Gather', 'Write'],
      timeEstimate: 5_400_000,
    }])
  })

  it('drops a row with no name or no title, and keeps the rest', () => {
    const kept = templates({ templates: [template({ name: '  ' }), template({ title: '' }), template()] })
    expect(kept).toHaveLength(1)
    expect(kept[0]!.name).toBe('Weekly report')
  })

  it('refuses a priority that is not a priority, and an estimate that is not a length', () => {
    const kept = templates({ templates: [template({ priority: 'whenever', timeEstimate: -1 })] })
    expect(kept[0]!.priority).toBe('medium')
    expect(kept[0]!.timeEstimate).toBeNull()
  })

  it('trims the lists a template carries, and de-duplicates them', () => {
    const kept = templates({ templates: [template({ tags: [' work ', 'WORK', '', 'home'], steps: ['Gather', 'gather', '  '] })] })
    expect(kept[0]!.tags).toEqual(['work', 'home'])
    expect(kept[0]!.steps).toEqual(['Gather'])
  })

  it('keeps no more than the menu can show, and no more tags than a task may wear', () => {
    const many = Array.from({ length: TODO_TEMPLATE_MAX + 5 }, (_unused, index) =>
      template({ id: `t-${index}`, name: `Shape ${index}` }))
    expect(templates({ templates: many })).toHaveLength(TODO_TEMPLATE_MAX)

    const tagged = template({ tags: Array.from({ length: TODO_TEMPLATE_TAG_MAX + 4 }, (_unused, index) => `tag-${index}`) })
    expect(templates({ templates: [tagged] })[0]!.tags).toHaveLength(TODO_TEMPLATE_TAG_MAX)
  })

  it('keeps the default list of templates out of the shared settings object', () => {
    // A clone that shared the array would let one account's saved template appear in the next account's
    // defaults; `DEFAULT_SETTINGS` is read by every account that has never written one.
    expect(DEFAULT_SETTINGS.todo.templates).toEqual([])
    const kept = mergeSettings({ todo: { templates: [template()] } }).todo.templates!
    kept.push({ id: 'other', name: 'Other', title: 'Other', description: '', priority: 'low', listId: null, tags: [], steps: [], timeEstimate: null })
    expect(DEFAULT_SETTINGS.todo.templates).toEqual([])
  })
})
