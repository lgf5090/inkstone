import { describe, expect, it } from 'vitest'
import { parseKanbanOutline, serializeKanbanOutline } from './outline'

describe('parseKanbanOutline headings and items', () => {
  it('parses headings as column status options and items into columns', () => {
    const md = [
      '## To Do',
      '- [ ] Design mockups',
      '- [ ] Architecture doc',
      '## Done',
      '- [x] Research requirements',
    ].join('\n')
    const data = parseKanbanOutline(md)
    // An outline body names nothing, and a board that invented a name here would write that name into
    // the note on its first JSON edit (K-25).
    expect(data.title).toBeUndefined()
    expect(data.items).toHaveLength(3)

    const statusCol = data.columns.find((c) => c.id === 'status')
    expect(statusCol?.options?.map((o) => o.label)).toEqual(['To Do', 'Done'])

    const todoOpt = statusCol?.options?.find((o) => o.label === 'To Do')
    const doneOpt = statusCol?.options?.find((o) => o.label === 'Done')
    expect(data.items[0]?.properties.status).toBe(todoOpt?.id)
    expect(data.items[0]?.title).toBe('Design mockups')
    expect(data.items[2]?.properties.status).toBe(doneOpt?.id)
    expect(data.items[2]?.properties.checked).toBe(true)
  })
})

describe('parseKanbanOutline properties and defaults', () => {
  it('parses inline property tags for priority, assignee, dates, progress, tags', () => {
    const md = '## In Progress\n- [ ] Build API [priority: high] [assignee: Bob] [start: 2026-09-01] [end: 2026-09-15] [progress: 40] [tags: backend, core]'
    const data = parseKanbanOutline(md)
    expect(data.items).toHaveLength(1)
    const item = data.items[0]!
    expect(item.title).toBe('Build API')
    expect(item.properties.priority).toBe('high')
    expect(item.properties.assignee).toBe('Bob')
    expect(item.properties.startDate).toBe('2026-09-01')
    expect(item.properties.endDate).toBe('2026-09-15')
    expect(item.properties.progress).toBe(40)
    expect(item.properties.tags).toEqual(['backend', 'core'])
  })

  it('handles items without heading by placing them in Default group', () => {
    const data = parseKanbanOutline('- [ ] Loose task')
    expect(data.items).toHaveLength(1)
    expect(data.items[0]?.title).toBe('Loose task')
    const statusCol = data.columns.find((c) => c.id === 'status')
    expect(statusCol?.options?.some((o) => o.label === 'Default')).toBe(true)
  })
})

describe('serializeKanbanOutline', () => {
  it('serializes columns and items back to formatted markdown outline', () => {
    const md = '## To Do\n- [ ] Task 1 [priority: high]\n\n## Done\n- [x] Task 2'
    const data = parseKanbanOutline(md)
    const serialized = serializeKanbanOutline(data)
    expect(serialized).toContain('## To Do')
    expect(serialized).toContain('- [ ] Task 1 [priority: high]')
    expect(serialized).toContain('## Done')
    expect(serialized).toContain('- [x] Task 2')
  })

  it('preserves roundtrip properties', () => {
    const original = '## In Progress\n- [ ] Feature A [priority: medium] [assignee: Alice] [start: 2026-10-01] [end: 2026-10-05] [progress: 60]'
    const data = parseKanbanOutline(original)
    const reserialized = serializeKanbanOutline(data)
    expect(reserialized).toContain('## In Progress')
    expect(reserialized).toContain('Feature A')
    expect(reserialized).toContain('[priority: medium]')
    expect(reserialized).toContain('[assignee: Alice]')
    expect(reserialized).toContain('[start: 2026-10-01]')
    expect(reserialized).toContain('[end: 2026-10-05]')
    expect(reserialized).toContain('[progress: 60]')
  })

  it('round-trips titles whose own brackets look like property tags', () => {
    const data = parseKanbanOutline('## To Do\n- [ ] Deploy \\[v2: beta\\] board')
    expect(data.items[0]?.title).toBe('Deploy [v2: beta] board')
    expect(data.items[0]?.properties.v2).toBeUndefined()
    expect(serializeKanbanOutline(data)).toContain('Deploy \\[v2: beta\\] board')
  })
})
