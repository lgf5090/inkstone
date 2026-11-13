import { describe, expect, it } from 'vitest'
import type { ProjectCard, ProjectFilterClause, ProjectFilterGroup, ProjectProperty } from './model'
import { emptyProjectFilterGroup } from './model'
import { groupProjectCards, matchProjectFilterGroup, matchProjectViewSearch, orderProjectCards, projectFilterPrefill, projectGroupKeys, projectGroupLabel, projectKanbanDropOrder, projectPropertyDisplayText, sortProjectCards, sortProjectViewsAlphabetically } from './view-eval'

const stamps = { createdBy: 'u1', modifiedBy: 'u2', createAt: 1_000_000, updateAt: 2_000_000, deleteAt: 0 }

function card(id: string, values: Record<string, string> = {}, title = id): ProjectCard {
  return { id, boardId: 'b1', parentId: '', title, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

const props: ProjectProperty[] = [
  { id: 'pt', name: 'Text', type: 'text', options: [] },
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }, { id: 'o2', value: 'Done', color: '' }] },
  { id: 'pm', name: 'Tags', type: 'multiSelect', options: [] },
  { id: 'pd', name: 'Due', type: 'date', options: [] },
  { id: 'pc', name: 'Created', type: 'createdTime', options: [] },
]

function group(operation: 'and' | 'or', filters: ProjectFilterGroup['filters']): ProjectFilterGroup {
  return { operation, filters }
}
function clause(propertyId: string, condition: ProjectFilterClause['condition'], values: string[] = []): ProjectFilterClause {
  return { propertyId, condition, values }
}

describe('filter conditions (§6.4)', () => {
  it('an empty group matches everything', () => {
    expect(matchProjectFilterGroup(card('a'), emptyProjectFilterGroup(), props)).toBe(true)
  })

  it('includes/notIncludes handle empty, scalar and array values', () => {
    const c = card('a', { ps: 'o1', pm: '["x","y"]' })
    expect(matchProjectFilterGroup(c, group('and', [clause('ps', 'includes')]), props)).toBe(true)
    expect(matchProjectFilterGroup(c, group('and', [clause('ps', 'includes', ['o1'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(c, group('and', [clause('ps', 'includes', ['o2'])]), props)).toBe(false)
    expect(matchProjectFilterGroup(c, group('and', [clause('pm', 'includes', ['y'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(c, group('and', [clause('pm', 'notIncludes', ['y'])]), props)).toBe(false)
    expect(matchProjectFilterGroup(c, group('and', [clause('pm', 'notIncludes', ['z'])]), props)).toBe(true)
  })

  it('emptiness and set conditions read the raw value', () => {
    const empty = card('e')
    const full = card('f', { pt: 'x' })
    expect(matchProjectFilterGroup(empty, group('and', [clause('pt', 'isEmpty')]), props)).toBe(true)
    expect(matchProjectFilterGroup(full, group('and', [clause('pt', 'isEmpty')]), props)).toBe(false)
    expect(matchProjectFilterGroup(full, group('and', [clause('pt', 'isNotEmpty')]), props)).toBe(true)
    expect(matchProjectFilterGroup(full, group('and', [clause('pt', 'isSet')]), props)).toBe(true)
    expect(matchProjectFilterGroup(empty, group('and', [clause('pt', 'isNotSet')]), props)).toBe(true)
  })

  it('text comparison lowercases both sides (the Q-10 fix)', () => {
    const upper = card('u', { pt: 'ABC' })
    const lower = card('l', { pt: 'abc' })
    expect(matchProjectFilterGroup(upper, group('and', [clause('pt', 'is', ['abc'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(lower, group('and', [clause('pt', 'is', ['ABC'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(upper, group('and', [clause('pt', 'contains', ['b'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(upper, group('and', [clause('pt', 'startsWith', ['a'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(upper, group('and', [clause('pt', 'endsWith', ['c'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(upper, group('and', [clause('pt', 'notContains', ['z'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(upper, group('and', [clause('pt', 'contains')]), props)).toBe(true)
  })

  it('date is equals a single, contains a range, and createdTime uses the open half-day window', () => {
    const single = card('s', { pd: '{"from":5000}' })
    const range = card('r', { pd: '{"from":1000,"to":9000}' })
    expect(matchProjectFilterGroup(single, group('and', [clause('pd', 'is', ['5000'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(range, group('and', [clause('pd', 'is', ['5000'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(range, group('and', [clause('pd', 'is', ['9500'])]), props)).toBe(false)
    const c = { ...card('c'), createAt: 200_000_000 }
    expect(matchProjectFilterGroup(c, group('and', [clause('pc', 'is', ['200000000'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(c, group('and', [clause('pc', 'isBefore', ['300000000'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(c, group('and', [clause('pc', 'isAfter', ['100000000'])]), props)).toBe(true)
    // Within half a day of the target, the open window says neither before nor after.
    expect(matchProjectFilterGroup(c, group('and', [clause('pc', 'isBefore', ['210000000'])]), props)).toBe(false)
    expect(matchProjectFilterGroup(c, group('and', [clause('pc', 'isAfter', ['190000000'])]), props)).toBe(false)
  })

  it('isAfter prefers the range end and isBefore reads the start', () => {
    const range = card('r', { pd: '{"from":1000,"to":9000}' })
    expect(matchProjectFilterGroup(range, group('and', [clause('pd', 'isAfter', ['5000'])]), props)).toBe(true)
    expect(matchProjectFilterGroup(range, group('and', [clause('pd', 'isAfter', ['9500'])]), props)).toBe(false)
    expect(matchProjectFilterGroup(range, group('and', [clause('pd', 'isBefore', ['500'])]), props)).toBe(false)
    expect(matchProjectFilterGroup(range, group('and', [clause('pd', 'isBefore', ['2000'])]), props)).toBe(true)
  })

  it('evaluates nested (A and B) or C', () => {
    const c = card('n', { pt: 'x', ps: 'o2' })
    const aAndB = group('and', [clause('pt', 'is', ['x']), clause('ps', 'is', ['o1'])])
    const orC = group('or', [aAndB, clause('ps', 'is', ['o2'])])
    expect(matchProjectFilterGroup(c, orC, props)).toBe(true)
    const andC = group('and', [aAndB, clause('ps', 'is', ['o2'])])
    expect(matchProjectFilterGroup(c, andC, props)).toBe(false)
  })
})

describe('sort and group', () => {
  it('sorts numerically, honors reversed, and puts empty values last', () => {
    const cards = [card('a', { pt: '10' }), card('b', { pt: '2' }), card('e', {})]
    const asc = sortProjectCards(cards, [{ propertyId: 'pt', reversed: false }], props)
    expect(asc.map((c) => c.id)).toEqual(['b', 'a', 'e'])
    const desc = sortProjectCards(cards, [{ propertyId: 'pt', reversed: true }], props)
    expect(desc.map((c) => c.id)).toEqual(['a', 'b', 'e'])
  })

  it('groups by a select value with an empty bucket', () => {
    const cards = [card('a', { ps: 'o1' }), card('b', { ps: 'o2' }), card('c', { ps: 'o1' }), card('e', {})]
    const groups = groupProjectCards(cards, 'ps', props)
    expect(groups.get('o1')!.map((c) => c.id)).toEqual(['a', 'c'])
    expect(groups.get('o2')!.map((c) => c.id)).toEqual(['b'])
    expect(groups.get('')!.map((c) => c.id)).toEqual(['e'])
  })
})

describe('property display text', () => {
  const byId = (id: string): ProjectProperty => props.find((p) => p.id === id)!

  it('renders a select option label, not the option id', () => {
    expect(projectPropertyDisplayText(card('a', { ps: 'o1' }), byId('ps'))).toBe('Open')
    expect(projectPropertyDisplayText(card('a'), byId('ps'))).toBe('')
  })

  it('renders a date as a locale date, never the raw JSON envelope', () => {
    const from = Date.UTC(2026, 10, 15)
    const text = projectPropertyDisplayText(card('a', { pd: JSON.stringify({ from }) }), byId('pd'))
    expect(text).toBe(new Date(from).toLocaleDateString())
    expect(text).not.toContain('{')
    expect(projectPropertyDisplayText(card('a'), byId('pd'))).toBe('')
  })

  it('renders a date range with both endpoints', () => {
    const from = Date.UTC(2026, 10, 15)
    const to = Date.UTC(2026, 10, 20)
    const text = projectPropertyDisplayText(card('a', { pd: JSON.stringify({ from, to }) }), byId('pd'))
    expect(text).toBe(`${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`)
  })

  it('renders multiSelect labels joined and checkbox as a tick', () => {
    const multi: ProjectProperty = { id: 'pm2', name: 'Tags', type: 'multiSelect', options: [{ id: 'm1', value: 'One', color: '' }, { id: 'm2', value: 'Two', color: '' }] }
    expect(projectPropertyDisplayText(card('a', { pm2: JSON.stringify(['m1', 'm2']) }), multi)).toBe('One, Two')
    const check: ProjectProperty = { id: 'pk', name: 'Done', type: 'checkbox', options: [] }
    expect(projectPropertyDisplayText(card('a', { pk: 'true' }), check)).toBe('✓')
    expect(projectPropertyDisplayText(card('a', { pk: 'false' }), check)).toBe('')
  })
})

describe('view tab order (C-23)', () => {
  it('strips the whole leading emoji cluster, including joiners and variation selectors', () => {
    const views = [{ title: '🗺️ Zebra' }, { title: 'Apple' }, { title: '👨‍👩‍👧 Family' }]
    expect(sortProjectViewsAlphabetically(views).map((view) => view.title)).toEqual(['Apple', '👨‍👩‍👧 Family', '🗺️ Zebra'])
  })

  it('leaves digit-led and empty titles alone and keeps the sort stable', () => {
    const views = [{ title: '123 numbers' }, { title: '' }, { title: '2 apples' }]
    expect(sortProjectViewsAlphabetically(views).map((view) => view.title)).toEqual(['', '123 numbers', '2 apples'])
    const same = [{ title: 'b' }, { title: 'b' }]
    expect(sortProjectViewsAlphabetically(same)[0]).toBe(same[0])
  })
})

describe('view search (C-12)', () => {
  it('matches the title and any property display text, case-insensitively', () => {
    expect(matchProjectViewSearch(card('a', {}, 'Alpha'), 'ALP', props)).toBe(true)
    expect(matchProjectViewSearch(card('a', { pt: 'Hello World' }), 'world', props)).toBe(true)
    expect(matchProjectViewSearch(card('a', { ps: 'o1' }), 'open', props)).toBe(true)
    expect(matchProjectViewSearch(card('a', { ps: 'o1' }), 'o1', props)).toBe(false)
  })

  it('treats an empty or whitespace query as no filter', () => {
    expect(matchProjectViewSearch(card('a'), '', props)).toBe(true)
    expect(matchProjectViewSearch(card('a'), '   ', props)).toBe(true)
    expect(matchProjectViewSearch(card('a'), 'nothing', props)).toBe(false)
  })
})

describe('new-card prefill from the active filter (B-11)', () => {
  it('inherits single-value is/includes clauses including nested groups, ignores contains', () => {
    const filter: ProjectFilterGroup = {
      operation: 'and',
      filters: [
        { propertyId: 'ps', condition: 'is', values: ['o1'] },
        { propertyId: 'pt', condition: 'contains', values: ['skip'] },
        { operation: 'or', filters: [{ propertyId: 'pt', condition: 'includes', values: ['keep'] }] },
      ],
    }
    expect(projectFilterPrefill(filter)).toEqual({ ps: 'o1', pt: 'keep' })
  })

  it('returns empty for no filter or multi-value clauses', () => {
    expect(projectFilterPrefill(undefined)).toEqual({})
    expect(projectFilterPrefill({ operation: 'and', filters: [{ propertyId: 'ps', condition: 'is', values: ['o1', 'o2'] }] })).toEqual({})
  })
})

describe('multiPerson display (R3-10)', () => {
  const many: ProjectProperty = { id: 'pm', name: 'Owners', type: 'multiPerson', options: [] }
  const holder = (raw: string): ProjectCard => ({ id: 'c1', boardId: 'b1', parentId: '', title: 'T', icon: '', isTemplate: false, contentOrder: [], values: raw ? { pm: raw } : {}, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 })

  it('reads the stored id array as a list rather than raw JSON', () => {
    expect(projectPropertyDisplayText(holder('["alice","bob"]'), many)).toBe('alice, bob')
  })

  it('takes a bare id and reads an unset value as empty', () => {
    expect(projectPropertyDisplayText(holder('alice'), many)).toBe('alice')
    expect(projectPropertyDisplayText(holder(''), many)).toBe('')
  })
})

describe('manual card order', () => {
  const card = (id: string): ProjectCard => ({ id, boardId: 'b1', parentId: '', title: id, icon: '', isTemplate: false, contentOrder: [], values: {}, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 })
  const cards = [card('a'), card('b'), card('c')]

  it('leaves the sorted list alone when nothing has been dragged', () => {
    expect(orderProjectCards(cards, []).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('puts a named card where it was dropped and keeps the rest in sorted order behind it', () => {
    expect(orderProjectCards(cards, ['c']).map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
  })

  it('moves a card to the front of the column it landed in', () => {
    const order = projectKanbanDropOrder({
      columns: [{ key: 'x', cardIds: ['a'] }, { key: 'y', cardIds: ['b', 'c'] }],
      cardOrder: [],
      draggedIds: ['a'],
      target: { zone: 'y', index: 0 },
    })
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('appends to the end of a column when the drop is past its last card', () => {
    const order = projectKanbanDropOrder({
      columns: [{ key: 'x', cardIds: ['a', 'b'] }, { key: 'y', cardIds: ['c'] }],
      cardOrder: [],
      draggedIds: ['a'],
      target: { zone: 'x', index: 1 },
    })
    expect(order).toEqual(['b', 'a', 'c'])
  })

  it('lands in an empty column at the position that column occupies', () => {
    const order = projectKanbanDropOrder({
      columns: [{ key: 'x', cardIds: ['a'] }, { key: 'y', cardIds: [] }, { key: 'z', cardIds: ['c'] }],
      cardOrder: [],
      draggedIds: ['c'],
      target: { zone: 'y', index: 0 },
    })
    expect(order).toEqual(['a', 'c'])
  })

  it('keeps cards the view filtered out at the end in their own order', () => {
    const order = projectKanbanDropOrder({
      columns: [{ key: 'x', cardIds: ['a', 'b'] }],
      cardOrder: ['hidden1', 'b', 'hidden2', 'a'],
      draggedIds: ['a'],
      target: { zone: 'x', index: 0 },
    })
    expect(order).toEqual(['a', 'b', 'hidden1', 'hidden2'])
  })

  it('moves a selected group together, keeping their relative order', () => {
    const order = projectKanbanDropOrder({
      columns: [{ key: 'x', cardIds: ['a', 'b', 'c'] }, { key: 'y', cardIds: ['d'] }],
      cardOrder: [],
      draggedIds: ['a', 'c'],
      target: { zone: 'y', index: 1 },
    })
    expect(order).toEqual(['b', 'd', 'a', 'c'])
  })

  it('a group dropped within its own column lands at the index counted without the group', () => {
    const order = projectKanbanDropOrder({
      columns: [{ key: 'x', cardIds: ['a', 'b', 'c', 'd'] }],
      cardOrder: [],
      draggedIds: ['a', 'b'],
      target: { zone: 'x', index: 1 },
    })
    expect(order).toEqual(['c', 'a', 'b', 'd'])
  })
})

describe('group keys and labels', () => {
  it('unions the declared options with the values the cards hold', () => {
    const keys = projectGroupKeys([card('a', { pp: 'u1' }), card('b', { ps: 'o2' })], 'pp', [
      ...props,
      { id: 'pp', name: 'Owner', type: 'person', options: [] },
    ])
    expect(keys).toEqual(['u1', ''])
    expect(projectGroupKeys([card('a', { ps: 'o2' })], 'ps', props)).toEqual(['o1', 'o2', ''])
  })

  it('labels people and dates the way the card face does', () => {
    const people = { u1: { id: 'u1', name: 'Alice', avatarUrl: '' } }
    expect(projectGroupLabel({ id: 'pp', name: 'Owner', type: 'person', options: [] }, 'u1', people)).toBe('Alice')
    expect(projectGroupLabel(props[1], 'o2')).toBe('Done')
    expect(projectGroupLabel(undefined, 'raw')).toBe('raw')
  })
})
