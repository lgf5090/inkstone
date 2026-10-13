import { describe, expect, it } from 'vitest'
import { emptyLibrary, newFeed, newGroup, parseRssLibrary, type RssLibrary } from './model'
import { applyLibraryPatch, diffLibrary, patchChars, patchIsEmpty, parseRssPatch } from './patch'

const NOW = 1_700_000_000_000
const clock = () => NOW

function library(): RssLibrary {
  const value = emptyLibrary()
  const shelf = newGroup('g1', 'Tech', 0, null, 5)
  const weekly = newFeed('f1', 'https://weekly.test/feed.xml', 'A weekly', 0)
  weekly.tags = ['tech', 'news']
  const show = newFeed('f2', 'https://show.test/feed.xml', 'A show', 1)
  value.groups.push(shelf)
  value.feeds.push(weekly, show)
  value.readIds = ['e1', 'e2']
  value.favorites = ['e1']
  value.opened = { e1: 100 }
  value.savedNotes = { 'e1|note': 'n1' }
  value.lastChannel = 'feed:f1'
  return value
}

/** The same account as another device left it: a different star, a feed this one has never seen. */
function otherDevice(): RssLibrary {
  const value = library()
  value.favorites = ['e9', 'e1']
  value.feeds.push(newFeed('f3', 'https://elsewhere.test/feed.xml', 'Elsewhere', 2))
  return value
}

describe('the change set', () => {
  it('says nothing when nothing moved', () => {
    const base = library()
    expect(patchIsEmpty(diffLibrary(base, structuredClone(base), clock))).toBe(true)
    expect(patchIsEmpty(diffLibrary(null, base, clock))).toBe(false)
  })

  it('names one star and nothing else', () => {
    const base = library()
    const later = structuredClone(base)
    later.favorites = ['e7', ...later.favorites]
    const patch = diffLibrary(base, later, clock)
    expect(patch.feeds).toEqual({ upsert: [], remove: [] })
    expect(patch.groups.upsert).toHaveLength(0)
    expect(patch.marks.upsert).toEqual([{ kind: 'star', entryId: 'e7', value: '', at: NOW }])
    expect(patch.marks.remove).toEqual([])
    expect(patch.state).toBeNull()
  })

  it('stamps a mark that is new and leaves one that only changed place', () => {
    const base = library()
    const reordered = structuredClone(base)
    reordered.readIds = ['e2', 'e1']
    expect(diffLibrary(base, reordered, clock).marks.upsert).toEqual([])
    const added = structuredClone(base)
    added.readIds = ['e3', ...added.readIds]
    expect(diffLibrary(base, added, clock).marks.upsert).toEqual([{ kind: 'read', entryId: 'e3', value: '', at: NOW }])
  })

  it('carries the clock and the note id, which are the marks with a payload', () => {
    const base = library()
    const next = structuredClone(base)
    next.opened = { e1: 200 }
    next.savedNotes = { 'e1|note': 'n1', 'e5|copy': 'n9' }
    const patch = diffLibrary(base, next, clock)
    expect(patch.marks.upsert).toEqual([
      { kind: 'opened', entryId: 'e1', value: '', at: 200 },
      { kind: 'copy', entryId: 'e5', value: 'n9', at: 0 },
    ])
  })

  it('takes a tag off with the feed that wore it', () => {
    const base = library()
    const next = structuredClone(base)
    next.feeds = next.feeds.filter(feed => feed.id !== 'f1')
    const patch = diffLibrary(base, next, clock)
    expect(patch.feeds.remove).toEqual(['f1'])
    expect(patch.tags.remove).toEqual([
      { feedId: 'f1', tag: 'tech' },
      { feedId: 'f1', tag: 'news' },
    ])
    expect(patch.tags.upsert).toEqual([])
  })

  it('reports a rename as one feed row', () => {
    const base = library()
    const next = structuredClone(base)
    next.feeds[1].title = 'A show, renamed'
    const patch = diffLibrary(base, next, clock)
    expect(patch.feeds.upsert.map(feed => feed.id)).toEqual(['f2'])
    expect(patch.feeds.remove).toEqual([])
  })

  it('mentions the channel only when it moved', () => {
    const base = library()
    const next = structuredClone(base)
    next.lastChannel = 'all'
    expect(diffLibrary(base, next, clock).state).toEqual({ lastChannel: 'all' })
    expect(diffLibrary(base, structuredClone(base), clock).state).toBeNull()
  })

  it('is small enough to be worth sending on a library of any size', () => {
    const base = library()
    for (let index = 0; index < 200; index++) {
      base.feeds.push(newFeed(`fb${index}`, `https://feed${index}.test/rss`, `Feed ${index}`, index + 2))
    }
    base.readIds = Array.from({ length: 2000 }, (_unused, index) => `e${index}`)
    const next = structuredClone(base)
    next.favorites = ['e7', ...next.favorites]
    const whole = JSON.stringify(next).length
    const patch = patchChars(diffLibrary(base, next, clock))
    expect(patch).toBeLessThan(whole / 100)
    expect(whole).toBeGreaterThan(40_000)
  })
})

describe('folding a change set in', () => {
  it('keeps what another device marked', () => {
    const account = otherDevice()
    const mine = library()
    const patch = diffLibrary(structuredClone(account), mine, clock)
    const merged = applyLibraryPatch(account, patch)
    expect(merged.favorites).toEqual(['e1'])
    expect(merged.feeds.map(feed => feed.id)).toEqual(['f1', 'f2'])
  })

  it('answers with both stars when two devices each added one', () => {
    const base = library()
    const deviceA = structuredClone(base)
    deviceA.favorites = ['eA', ...deviceA.favorites]
    const deviceB = structuredClone(base)
    deviceB.favorites = ['eB', ...deviceB.favorites]
    let account = base
    account = applyLibraryPatch(account, diffLibrary(base, deviceA, clock))
    account = applyLibraryPatch(account, diffLibrary(base, deviceB, clock))
    expect(account.favorites.sort()).toEqual(['e1', 'eA', 'eB'])
  })

  it('puts a new mark at the head of its list', () => {
    const base = library()
    const next = structuredClone(base)
    next.readIds = ['e9', ...next.readIds]
    const merged = applyLibraryPatch(base, diffLibrary(base, next, clock))
    expect(merged.readIds).toEqual(['e9', 'e1', 'e2'])
  })

  it('round-trips: the merge of a diff is the library that made it', () => {
    const base = library()
    const next = structuredClone(base)
    next.feeds[0].title = 'Renamed'
    next.feeds[0].tags = ['tech']
    next.feeds.push(newFeed('f3', 'https://new.test/feed', 'New', 2))
    next.groups.push(newGroup('g2', 'Deep', 1, 'g1', 6))
    next.readIds = ['e3']
    next.favorites = []
    next.hiddenIds = ['e4']
    next.opened = { e3: 300 }
    next.savedNotes = { 'e3|note': 'n7' }
    next.lastChannel = 'feed:f3'
    const merged = applyLibraryPatch(base, diffLibrary(base, next, clock))
    expect(merged).toEqual(parseRssLibrary(next).data)
  })

  it('takes a mark away without disturbing its neighbours', () => {
    const base = library()
    const next = structuredClone(base)
    next.readIds = ['e2']
    next.savedNotes = {}
    const merged = applyLibraryPatch(base, diffLibrary(base, next, clock))
    expect(merged.readIds).toEqual(['e2'])
    expect(merged.savedNotes).toEqual({})
    expect(merged.opened).toEqual({ e1: 100 })
  })

  it('leaves the library alone for an empty change set', () => {
    const base = library()
    expect(applyLibraryPatch(base, diffLibrary(base, structuredClone(base), clock))).toEqual(base)
  })
})

describe('a change set from the network', () => {
  it('reads back what the client wrote', () => {
    const base = library()
    const next = structuredClone(base)
    next.favorites = ['e7', 'e1']
    const round = parseRssPatch(JSON.parse(JSON.stringify(diffLibrary(base, next, clock))))
    expect(round).not.toBeNull()
    expect(applyLibraryPatch(base, round!).favorites).toEqual(['e7', 'e1'])
  })

  it('refuses anything that is not shaped like one', () => {
    const good = diffLibrary(library(), library(), clock)
    expect(parseRssPatch(null)).toBeNull()
    expect(parseRssPatch([])).toBeNull()
    expect(parseRssPatch({ ...good, feeds: undefined })).toBeNull()
    expect(parseRssPatch({ ...good, feeds: { upsert: 'x', remove: [] } })).toBeNull()
    expect(parseRssPatch({ ...good, state: { lastChannel: 7 } })).toBeNull()
    expect(parseRssPatch({ ...good, marks: { upsert: [{ kind: 'bogus', entryId: 'e1', value: '', at: 1 }], remove: [] } })).toBeNull()
    expect(parseRssPatch({ ...good, marks: { upsert: [{ kind: 'read', entryId: 'e1', value: '', at: Number.NaN }], remove: [] } })).toBeNull()
    expect(parseRssPatch({ ...good, feeds: { upsert: [{ id: 'f9' }], remove: [] } })).toBeNull()
    expect(parseRssPatch({ ...good, groups: { upsert: [{ id: 'g9', name: 4 }], remove: [] } })).toBeNull()
    expect(parseRssPatch({ ...good, tags: { upsert: [{ feedId: 'f1' }], remove: [] } })).toBeNull()
  })

  it('refuses a section larger than the library it claims to update', () => {
    const huge = { feeds: { upsert: [], remove: Array.from({ length: 500 }, (_unused, index) => `f${index}`) }, groups: { upsert: [], remove: [] }, tags: { upsert: [], remove: [] }, marks: { upsert: [], remove: [] }, state: null }
    expect(parseRssPatch(huge)).toBeNull()
  })
})
