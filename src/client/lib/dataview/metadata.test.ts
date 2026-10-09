import { describe, expect, it } from 'vitest'
import {
  extractDate, extractFullLineField, extractInlineFields, parseFrontmatterValue, parseNote, pathOfNote, serializePage,
  type NoteInput,
} from './metadata'
import { DvDuration, DvLink, Values } from './value'

function input(overrides: Partial<NoteInput> = {}): NoteInput {
  return {
    id: 'note-1',
    title: 'Alpha',
    content: '',
    folder: '',
    tags: [],
    createdAt: Date.UTC(2024, 0, 1, 8),
    updatedAt: Date.UTC(2024, 0, 2, 8),
    charCount: 12,
    wordCount: 3,
    starred: false,
    pinned: false,
    archived: false,
    ...overrides,
  }
}

describe('inline field extraction', () => {
  it('reads bracket and parenthesis forms with their positions', () => {
    const hits = extractInlineFields('status [done:: true] and (due:: 2024-05-01) tail')
    expect(hits.map((hit) => [hit.key, hit.value, hit.wrapping])).toEqual([
      ['done', 'true', '['],
      ['due', '2024-05-01', '('],
    ])
  })

  it('nests and honours escapes inside a field body', () => {
    const [hit] = extractInlineFields('[link:: [[Target|with ] inside]]')
    expect(hit?.key).toBe('link')
    expect(hit?.value).toBe('[[Target|with ] inside]]'.replace(']]', ']'))
  })

  it('restarts the scan after a rejected key, and reads nothing from plain prose', () => {
    // A key may not contain a wrapper, so `[a[b:: c]` is not one field — but the inner `[b:: c]` is,
    // which is how the reference's scanner behaves and what a nested link in a field relies on.
    expect(extractInlineFields('[a[b:: c]')).toEqual([
      { key: 'b', value: 'c', start: 2, end: 9, wrapping: '[' },
    ])
    expect(extractInlineFields('just prose')).toHaveLength(0)
  })

  it('reads the special task emoji dates', () => {
    const hits = extractInlineFields('ship it 📅 2024-05-06 ✅ 2024-05-07', true)
    expect(hits.map((hit) => hit.key)).toEqual(['due', 'completion'])
    expect(hits.map((hit) => hit.value)).toEqual(['2024-05-06', '2024-05-07'])
  })

  it('takes a whole-line field and drops its Markdown wrappers', () => {
    const full = extractFullLineField('**Daily**:: stood up at nine')
    expect(full?.key).toBe('Daily')
    expect(full?.value).toBe('stood up at nine')
    expect(full?.wrapping).toBeNull()
    expect(extractFullLineField('- [ ] task:: value')).not.toBeNull()
    expect(extractFullLineField('| a | b |')).toBeNull()
    expect(extractFullLineField('no separator')).toBeNull()
  })
})

describe('front matter conversion', () => {
  it('types scalars that look like dates, durations and links', () => {
    expect(parseFrontmatterValue('2024-05-06')).toEqual(new Date(2024, 4, 6))
    expect(Values.isDuration(parseFrontmatterValue('3 days'))).toBe(true)
    expect(parseFrontmatterValue('[[Note]]')).toEqual(DvLink.file('Note'))
    expect(parseFrontmatterValue('plain')).toBe('plain')
    expect(parseFrontmatterValue(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseFrontmatterValue({ x: 1 })).toEqual({ x: 1 })
    expect(parseFrontmatterValue(null)).toBeNull()
  })
})

describe('note parsing', () => {
  it('builds a path from the folder chain and the title', () => {
    expect(pathOfNote({ title: 'Alpha', folder: '' })).toBe('Alpha.md')
    expect(pathOfNote({ title: 'Alpha', folder: 'Reading/Books/' })).toBe('Reading/Books/Alpha.md')
  })

  it('merges tags from the note record, front matter and body', () => {
    const page = parseNote(input({
      tags: ['project'],
      content: '---\ntags: [work, team]\n---\nBody #active/now text',
    }))
    expect([...page.tags].sort()).toEqual(['#active/now', '#project', '#team', '#work'])
  })

  it('keeps aliases, and both spellings of a tag list', () => {
    const page = parseNote(input({ content: '---\nalias: One, Two\n---\n' }))
    expect([...page.aliases].sort()).toEqual(['One', 'Two'])
  })

  it('collects inline fields from prose, front matter and lists into one map', () => {
    const page = parseNote(input({
      content: ['---', 'rating: 4', '---', 'Author:: Ursula', 'Notes:', '- [ ] buy milk [due:: 2024-05-06]', '- store:: milk'].join('\n'),
    }))
    expect(page.fields.get('rating')).toBe(4)
    expect(page.fields.get('Author')).toBe('Ursula')
    expect(page.fields.get('store')).toBe('milk')
    // A task's own fields stay with the task, so `due` is reached through the task, not the page.
    const due = page.lists[0]?.fields.get('due')?.[0]
    expect(Values.isDate(due)).toBe(true)
  })

  it('parses list items with nesting, tasks and the section they sit under', () => {
    const page = parseNote(input({
      content: ['## Plans', '- [x] one', '  - [ ] two', '    with detail', '- three'].join('\n'),
    }))
    expect(page.headings).toEqual([{ level: 2, text: 'Plans', line: 0 }])
    expect(page.lists).toHaveLength(3)
    const [first, second, third] = page.lists
    expect(first?.task?.completed).toBe(true)
    expect(first?.children).toEqual([second?.line])
    expect(second?.parent).toBe(first?.line)
    expect(second?.text).toBe('two\nwith detail')
    expect(second?.lineCount).toBe(2)
    expect(third?.task).toBeNull()
    expect(second?.section.path).toBe('Alpha.md')
    expect(second?.section.subpath).toBe('Plans')
  })

  it('propagates full completion down a task tree', () => {
    const page = parseNote(input({ content: '- [x] parent\n  - [ ] child' }))
    const [parent, child] = page.lists
    expect(child?.task?.completed).toBe(false)
    expect(parent?.task?.fullyCompleted).toBe(false)
  })

  it('keeps task fields on the task and list fields on the page', () => {
    const page = parseNote(input({ content: '- [ ] buy milk [due:: 2024-05-06]\n- store:: milk' }))
    const [task, item] = page.lists
    expect(task?.fields.get('due')).toBeDefined()
    expect(item?.fields.get('store')).toBeDefined()
    expect(page.fields.get('store')).toBeDefined()
    expect(page.fields.get('due')).toBeUndefined()
  })

  it('records block ids and links, including on the task link', () => {
    const page = parseNote(input({ content: 'See [[Beta]] and ![[Gamma|g]].\n- [ ] a thing ^abc' }))
    expect(page.links.map((link) => link.path)).toEqual(['Beta', 'Gamma'])
    expect(page.links[1]?.embed).toBe(true)
    expect(page.lists[0]?.blockId).toBe('abc')
    expect(page.lists[0]?.link.kind).toBe('block')
  })

  it('does not read fields or links out of a code fence', () => {
    const page = parseNote(input({ content: '```\nKey:: value\n[[NotALink]]\n```' }))
    expect(page.fields.size).toBe(0)
    expect(page.links).toHaveLength(0)
  })

  it('finds the day a note is about from its field or its title', () => {
    expect(parseNote(input({ content: '---\ndate: 2024-05-06\n---\n' })).day).toEqual(new Date(2024, 4, 6))
    expect(parseNote(input({ title: '2024-05-06 standup' })).day).toEqual(new Date(2024, 4, 6))
    expect(parseNote(input({ title: 'Alpha' })).day).toBeNull()
  })

  it('serializes the file object a query reads', () => {
    const page = parseNote(input({
      title: 'Alpha',
      folder: 'Reading',
      starred: true,
      content: '---\nrating: 4\n---\n- [ ] one task\nSee [[Beta]].',
    }))
    const data = serializePage(page, [DvLink.file('Zed.md')])
    const file = data.file! as Record<string, unknown>
    expect(file.path).toBe('Reading/Alpha.md')
    expect(file.name).toBe('Alpha')
    expect(file.folder).toBe('Reading')
    expect(file.starred).toBe(true)
    expect((file.tasks as unknown[])).toHaveLength(1)
    expect((file.lists as unknown[])).toHaveLength(1)
    expect((file.outlinks as DvLink[]).map((link) => link.path)).toEqual(['Beta'])
    expect((file.inlinks as DvLink[]).map((link) => link.path)).toEqual(['Zed.md'])
    expect(data.rating).toBe(4)
    expect(extractDate(String(file.mtime))).toBeNull()
  })

  it('never lets a field displace the file object', () => {
    const page = parseNote(input({ content: 'file:: stolen' }))
    const data = serializePage(page)
    expect(Values.isObject(data.file)).toBe(true)
  })

  it('flattens a single-valued field and keeps a repeated one as a list', () => {
    const page = parseNote(input({ content: 'Tag:: one\nTag:: two\nSolo:: x' }))
    expect(page.fields.get('Solo')).toBe('x')
    expect(page.fields.get('Tag')).toEqual(['one', 'two'])
  })

  it('keeps a duration field as calendar units', () => {
    const page = parseNote(input({ content: 'Effort:: 2 days 3 hours' }))
    const effort = page.fields.get('Effort')
    expect(effort instanceof DvDuration).toBe(true)
    expect((effort as DvDuration).hours).toBe(3)
  })
})
