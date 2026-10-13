// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  GROUPS_MAX,
  createGroup,
  deleteGroup,
  groupName,
  groupsHolding,
  normaliseGroups,
  pruneGroups,
  renameGroup,
  sortGroups,
  toggleBook,
  type BookGroup,
} from '../src/client/features/reading/book-groups'

function group(id: string, name: string, bookIds: string[] = [], at = 1000): BookGroup {
  return { id, name, bookIds, createdAt: at, updatedAt: at }
}

const ok = (answer: { ok: boolean; groups?: BookGroup[] }) => {
  if (!answer.ok) throw new Error(`refused: ${answer.reason}`)
  return answer.groups ?? []
}

describe('making a group', () => {
  it('trims the name and keeps the groups it did not touch', () => {
    const groups = ok(createGroup([group('g1', '科幻')], '  重读  '))
    expect(groups.map((one) => one.name)).toEqual(['科幻', '重读'])
  })

  it.each([['   ', 'empty'], ['', 'empty']])('refuses %j as a name', (name, reason) => {
    expect(createGroup([], name)).toMatchObject({ ok: false, reason })
  })

  it('refuses a name the shelf already uses, however it was typed', () => {
    expect(createGroup([group('g1', 'Heavy  Metal')], 'heavy   metal')).toMatchObject({ ok: false, reason: 'duplicate' })
  })

  it('refuses one group too many', () => {
    const full = Array.from({ length: GROUPS_MAX }, (_, index) => group(`g${index}`, `G${index}`))
    expect(createGroup(full, 'one more')).toMatchObject({ ok: false, reason: 'limit' })
  })
})

describe('renaming and deleting', () => {
  const three = [group('g1', '一'), group('g2', '二'), group('g3', '三')]

  it('moves the renamed group only', () => {
    const next = ok(renameGroup(three, 'g2', '  改过  '))
    expect(next.map((one) => one.name)).toEqual(['一', '改过', '三'])
    expect(next[1].updatedAt).toBeGreaterThanOrEqual(next[1].createdAt)
    expect(next[0].updatedAt).toBe(1000)
  })

  it('will not rename a group onto another one', () => {
    expect(renameGroup(three, 'g2', '一')).toMatchObject({ ok: false, reason: 'duplicate' })
  })

  it('says so when the group is gone', () => {
    expect(renameGroup(three, 'nope', 'x')).toMatchObject({ ok: false, reason: 'unknown' })
    expect(toggleBook(three, 'nope', 'b1')).toMatchObject({ ok: false, reason: 'unknown' })
  })

  it('deletes only the named group', () => {
    expect(deleteGroup(three, 'g2').map((one) => one.id)).toEqual(['g1', 'g3'])
  })
})

describe('putting books in and out', () => {
  it('toggles membership without disturbing the other groups', () => {
    const start = [group('g1', '在读', ['b1']), group('g2', '科幻', ['b2'])]
    const added = ok(toggleBook(start, 'g1', 'b9'))
    expect(added[0].bookIds).toEqual(['b1', 'b9'])
    expect(added[1].bookIds).toEqual(['b2'])
    const removed = ok(toggleBook(start, 'g1', 'b1'))
    expect(removed[0].bookIds).toEqual([])
  })

  it('never lists a book twice in one group', () => {
    const once = ok(toggleBook([group('g1', 'a')], 'g1', 'b1'))
    expect(ok(toggleBook(once, 'g1', 'b1'))[0].bookIds).toEqual([])
  })
})

describe('a shelf that lost a book', () => {
  it('takes it out of every group and leaves the group itself', () => {
    const start = [group('g1', '在读', ['b1', 'b2']), group('g2', '空了', ['b1'])]
    const next = pruneGroups(start, new Set(['b2']))
    expect(next.map((one) => one.bookIds)).toEqual([['b2'], []])
    expect(next[1].name).toBe('空了')
  })

  it('leaves an untouched group as the same object', () => {
    const start = [group('g1', '在读', ['b1'])]
    expect(pruneGroups(start, new Set(['b1']))[0]).toBe(start[0])
  })
})

describe('what arrives from a file or the server', () => {
  it('drops the rows that cannot be a group', () => {
    const kept = normaliseGroups([
      null, 'x', 7,
      { id: '', name: 'no id' },
      { id: 'g1', name: '   ' },
      { id: 'g2', name: 'ok', bookIds: ['b1', 'b1', 5, null] },
      { id: 'g2', name: 'dup id' },
      { id: 'g3', name: 'ok' },
    ])
    expect(kept.map((one) => [one.id, one.name, one.bookIds])).toEqual([['g2', 'ok', ['b1']]])
  })

  it('keeps the member list bounded', () => {
    const huge = normaliseGroups([{ id: 'g1', name: 'all', bookIds: Array.from({ length: 900 }, (_, i) => `b${i}`) }])
    expect(huge[0].bookIds.length).toBe(500)
  })

  it('survives anything that is not a list', () => {
    for (const junk of [undefined, null, {}, 'groups', 42]) {
      expect(normaliseGroups(junk)).toEqual([])
    }
  })
})

describe('reading the groups back', () => {
  it('lists a group by the name the reader typed, collapsed', () => {
    expect(groupName('  两   个  ')).toBe('两 个')
  })

  it('sorts by the last touch and then by name', () => {
    const ordered = sortGroups([group('a', 'Bravo', [], 5), group('b', 'Alpha', [], 5), group('c', 'Charlie', [], 9)])
    expect(ordered.map((one) => one.name)).toEqual(['Charlie', 'Alpha', 'Bravo'])
  })

  it('says which groups hold a book', () => {
    const holding = groupsHolding([group('g1', '在读', ['b1']), group('g2', '科幻', ['b2'])], 'b1')
    expect(holding.map((one) => one.name)).toEqual(['在读'])
  })
})
