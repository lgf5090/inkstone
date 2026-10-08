import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { parseOmnisearchQuery } from '@shared/omnisearch-query'
import { buildFileDocument, buildNoteDocument, type NoteSource } from './document'
import { docIdForNote, OmnisearchEngine, recencyFactor } from './engine'
import { foldTerm } from './fold'
import { documentSettings, engineSettings } from './settings'
import { buildTokenizer } from './tokenizer'
import type { SearchSettings } from '@shared/types'

const NOW = Date.UTC(2026, 9, 8, 12)
const DAY = 86_400_000

function harness(search: Partial<SearchSettings> = {}, bodies: Record<string, string> = {}) {
  const merged: SearchSettings = { ...DEFAULT_SETTINGS.search, ...search }
  const tokenizer = buildTokenizer({
    splitCamelCase: merged.splitCamelCase,
    cjkBigrams: merged.cjkBigrams,
    pinyinSearch: merged.pinyinSearch,
  }, (value) => foldTerm(value, merged.ignoreDiacritics))
  const engine = new OmnisearchEngine({
    tokenizer,
    settings: () => engineSettings(merged),
    resolveBodies: async (ids) => new Map(ids
      .map((id) => [id, bodies[id.replace(/^n:/, '')]] as const)
      .filter((pair): pair is [string, string] => typeof pair[1] === 'string')),
  })
  const add = async (notes: NoteSource[]) => {
    await engine.addDocuments(
      notes.map((note) => buildNoteDocument(note, documentSettings(merged))),
      notes.map((note) => bodies[note.id] !== undefined),
    )
  }
  const find = (raw: string, options = {}) => engine.search(parseOmnisearchQuery(raw, (value) => foldTerm(value, merged.ignoreDiacritics)), options)
  return { engine, merged, add, find }
}

function note(id: string, title: string, content: string, extra: Partial<NoteSource> = {}): NoteSource {
  return {
    id,
    title,
    content,
    updatedAt: NOW,
    folderPath: '',
    archived: false,
    starred: false,
    ...extra,
  }
}

describe('engine ranking', () => {
  it('puts a title hit above a body hit', async () => {
    const { add, find } = harness()
    await add([
      note('body', 'Unrelated', 'the espresso machine needs descaling, espresso again'),
      note('title', 'Espresso machine', 'nothing else here'),
    ])
    const results = await find('espresso')
    expect(results[0]!.doc.title).toBe('Espresso machine')
  })

  it('lifts a heading above plain body text', async () => {
    const { add, find } = harness()
    await add([
      note('plain', 'Note one', 'the peloton analysis appears here in the body'),
      note('head', 'Note two', '# the peloton analysis\n\nand more words'),
    ])
    const ranked = await find('peloton')
    const order = ranked.map((result) => result.doc.title)
    expect(order[0]).toBe('Note two')
    expect(order).toHaveLength(2)
  })

  it('raises the file name weight above the body match', async () => {
    const strong = harness({ weightTitle: 10 })
    await strong.add([note('a', 'Kettle', 'a bell rings for the kettle'), note('b', 'Bell', 'a kettle rings like a bell')])
    expect((await strong.find('kettle'))[0]!.doc.title).toBe('Kettle')

    const weak = harness({ weightTitle: 1 })
    await weak.add([note('a', 'Kettle', 'a bell rings for the kettle'), note('b', 'Bell', 'a kettle rings like a bell')])
    const flat = await weak.find('kettle')
    expect(flat[0]!.score).toBeLessThan((await strong.find('kettle'))[0]!.score)
  })

  it('boosts a note whose title starts with the whole query', async () => {
    const { add, find } = harness()
    await add([
      note('mid', 'The Great Dane', 'great danes are big'),
      note('start', 'Great Dane care', 'feeding a great dane'),
    ])
    const results = await find('great dane')
    expect(results[0]!.doc.title).toBe('Great Dane care')
  })

  it('boosts a named tag once, not once per matching tag', async () => {
    const { add, find } = harness()
    await add([note('a', 'Tagged', 'alpha beta #solo #tour'), note('b', 'Plain', 'alpha beta tour')])
    const results = await find('alpha #solo #tour')
    const tagged = results.find((result) => result.doc.title === 'Tagged')
    const plain = results.find((result) => result.doc.title === 'Plain')
    expect(tagged!.score).toBeGreaterThan(plain!.score)
    const single = await find('alpha #tour')
    expect(single.find((result) => result.doc.title === 'Plain')!.score)
      .toBeGreaterThan(single.find((result) => result.doc.title === 'Tagged')!.score / 6)
  })

  it('demotes a note in a downranked folder', async () => {
    const h = harness({ downrankedFolders: ['Archive'] })
    await h.add([
      note('kept', 'Kept', 'alpha beta', { folderPath: 'Tools' }),
      note('buried', 'Buried', 'alpha beta', { folderPath: 'Archive/Deep' }),
    ])
    const results = await h.find('alpha')
    expect(results[0]!.doc.title).toBe('Kept')
    expect(results[1]!.score).toBeLessThan(results[0]!.score / 2)
  })

  it('applies a front matter weight without throwing on a numeric property', async () => {
    const { add, find } = harness({ weightCustomProperties: [{ name: 'priority', weight: 3 }] })
    await add([
      note('a', 'Alpha', 'alpha beta\n---\npriority: 9\n---\n', { title: 'Alpha' }),
      note('b', 'Beta', 'alpha beta\n\npriority: 9\n'),
    ])
    await expect(find('alpha')).resolves.toBeInstanceOf(Array)
  })
})

describe('engine filters', () => {
  const sources = [
    note('a', 'Latte art', 'milk and foam', { folderPath: 'Drinks', starred: true }),
    note('b', 'Filter coffee', 'paper and water', { folderPath: 'Drinks' }),
    note('c', 'Notebook sketch', 'latte art drawn later', { archived: true, updatedAt: NOW - 3 * DAY }),
  ]

  async function loaded(search: Partial<SearchSettings> = {}) {
    const h = harness(search, { a: 'milk and foam', b: 'paper and water', c: 'latte art drawn later' })
    await h.add(sources)
    return h
  }

  it('matches the folder path for path:', async () => {
    const { find } = await loaded()
    const results = await find('latte path:drinks')
    expect(results.map((result) => result.doc.title)).toEqual(['Latte art'])
  })

  it('excludes a path fragment', async () => {
    const { find } = await loaded()
    const results = await find('latte -path:drinks')
    expect(results.map((result) => result.doc.title)).toEqual(['Notebook sketch'])
  })

  it('filters by folder qualifier the way the sidebar does', async () => {
    const { find } = await loaded()
    expect((await find('folder:drinks')).map((result) => result.doc.title).sort()).toEqual(['Filter coffee', 'Latte art'])
  })

  it('matches a folder qualifier against the whole ancestor path', async () => {
    const h = harness()
    await h.add([
      note('a', 'Roast log', 'beans', { folderPath: 'Journal/2026/October' }),
      note('b', 'Trips', 'beans', { folderPath: 'Journal/2025' }),
      note('c', 'Loose', 'beans', { folderPath: 'October' }),
    ])
    expect((await h.find('folder:Journal/2026/Oct')).map((result) => result.id)).toEqual(['n:a'])
    expect((await h.find('folder:2026/October')).map((result) => result.id)).toEqual(['n:a'])
  })

  it('narrows a tag-only query to the notes carrying that tag', async () => {
    const h = harness()
    await h.add([
      note('a', 'Plain', 'writing about coffee #todo'),
      note('b', 'Tagged', 'writing about coffee #mood'),
    ])
    expect((await h.find('#mood')).map((result) => result.id)).toEqual(['n:b'])
    // With a word in the query the tag stays a boost, so the untagged note still shows — above the
    // id tie-break, which alone would have put `a` first.
    expect((await h.find('coffee #mood')).map((result) => result.id)).toEqual(['n:b', 'n:a'])
  })

  it('honours is:starred and is:archived', async () => {
    const { find } = await loaded()
    expect((await find('latte is:starred')).map((result) => result.id)).toEqual(['n:a'])
    expect((await find('latte is:archived')).map((result) => result.id)).toEqual(['n:c'])
  })

  it('hides archived notes only when asked', async () => {
    const shown = await (await loaded()).find('latte')
    expect(shown.map((result) => result.id)).toContain('n:c')
    const hidden = await (await loaded({ hideArchived: true })).find('latte')
    expect(hidden.map((result) => result.id)).not.toContain('n:c')
  })

  it('keeps trashed notes out of a local index that never held them', async () => {
    const { find } = await loaded()
    expect(await find('latte is:trash')).toEqual([])
  })

  it('filters an exact phrase before cutting the list, not after', async () => {
    // The reference cut to fifty first, so a phrase could silently remove every kept result.
    const noisy = Array.from({ length: 4 }, (_unused, index) => note(`n${index}`, `Noise ${index}`, 'latte latte latte latte'))
    const h = harness({ maxResults: 2 }, { keep: 'a latte art station', n0: 'latte', n1: 'latte', n2: 'latte', n3: 'latte' })
    await h.add([...noisy, note('keep', 'Station', 'a latte art station, mentioned once')])
    const results = await h.find('"latte art"')
    expect(results.map((result) => result.id)).toEqual(['n:keep'])
  })

  it('drops results carrying an excluded word', async () => {
    const h = harness({}, { a: 'alpha draft', b: 'alpha final' })
    await h.add([note('a', 'Draft one', 'alpha draft'), note('b', 'Final one', 'alpha final')])
    const results = await h.find('alpha -draft')
    expect(results.map((result) => result.doc.title)).toEqual(['Final one'])
  })

  it('filters by extension, including attachment names', async () => {
    const h = harness()
    await h.add([note('a', 'Latte', 'latte foam')])
    const file = buildFileDocument({ id: 'shot1', filename: 'shot.png', noteId: 'a', updatedAt: NOW, size: 12, mime: 'image/png' })
    await h.engine.addDocuments([file])
    expect((await h.find('shot .png')).map((result) => result.id)).toEqual(['f:shot1'])
    expect((await h.find('latte -ext:png')).map((result) => result.id)).toEqual(['n:a'])
  })

  it('matches a parent tag as a subtree', async () => {
    const h = harness()
    await h.add([note('a', 'Nested', 'latte foam\n\n#project/alpha')])
    expect((await h.find('tag:project')).map((result) => result.doc.title)).toEqual(['Nested'])
    expect(await h.find('tag:missing')).toEqual([])
  })

  it('answers a qualifier-only query without any text terms', async () => {
    const h = harness({}, { a: 'latte foam' })
    await h.add([note('a', 'Latte', 'latte foam', { starred: true })])
    const results = await h.find('is:starred')
    expect(results.map((result) => result.doc.title)).toEqual(['Latte'])
  })

  it('restricts a single-document search to that document', async () => {
    const h = harness({}, { a: 'latte foam', b: 'latte again' })
    await h.add([note('a', 'Latte', 'latte foam'), note('b', 'Other', 'latte again')])
    const results = await h.find('latte', { singleDocId: docIdForNote('b') })
    expect(results.map((result) => result.doc.title)).toEqual(['Other'])
  })

  it('returns nothing for a blank query', async () => {
    const h = harness()
    await h.add([note('a', 'Latte', 'latte foam')])
    expect(await h.find('')).toEqual([])
  })
})

describe('engine embeds', () => {
  it('shows an embedded document once, even when it also matched', async () => {
    const h = harness({}, { host: 'latte foam', guest: 'latte foam' })
    await h.add([note('host', 'Host note', 'latte foam'), note('guest', 'Guest note', 'latte foam')])
    h.engine.setEmbeddings(docIdForNote('host'), [docIdForNote('guest')])
    const results = await h.find('latte')
    expect(results.filter((result) => result.id === docIdForNote('guest'))).toHaveLength(1)
    expect(results.some((result) => result.isEmbed)).toBe(false)
  })

  it('pulls in the note that embeds a matched document', async () => {
    const h = harness({}, { host: 'nothing relevant', guest: 'latte foam' })
    await h.add([note('host', 'Host note', 'nothing relevant'), note('guest', 'Guest note', 'latte foam')])
    h.engine.setEmbeddings(docIdForNote('host'), [docIdForNote('guest')])
    const results = await h.find('latte')
    expect(results.map((result) => result.id)).toEqual([docIdForNote('guest'), docIdForNote('host')])
    expect(results[1]!.isEmbed).toBe(true)
  })

  it('caps the embedding notes taken from one result', async () => {
    const h = harness({ maxEmbeds: 2 }, {})
    const hosts = Array.from({ length: 5 }, (_unused, index) => note(`h${index}`, `Host ${index}`, 'a page with an image'))
    await h.add([...hosts, note('shared', 'Photo', 'latte foam')])
    for (const host of hosts) h.engine.setEmbeddings(docIdForNote(host.id), [docIdForNote('shared')])
    const results = await h.find('latte')
    expect(results[0]!.id).toBe(docIdForNote('shared'))
    expect(results.filter((result) => result.isEmbed)).toHaveLength(2)
  })

  it('forgets a removed note from both sides of the map', async () => {
    const h = harness({}, {})
    await h.add([note('host', 'Host', 'latte'), note('guest', 'Guest', 'espresso')])
    h.engine.setEmbeddings(docIdForNote('host'), [docIdForNote('guest')])
    h.engine.removeDocuments([docIdForNote('host')])
    expect(h.engine.embedsOf(docIdForNote('guest'))).toEqual([])
  })
})

describe('engine cache', () => {
  it('round-trips through the serialized payload', async () => {
    const first = harness({}, { a: 'latte foam' })
    await first.add([note('a', 'Latte art', 'latte foam', { folderPath: 'Drinks' })])
    first.engine.setEmbeddings(docIdForNote('a'), [docIdForNote('a')])
    const payload = first.engine.toJSON()
    const second = harness({}, { a: 'latte foam' })
    expect(second.engine.restore(payload)).toBe(true)
    expect(second.engine.documentCount).toBe(1)
    expect((await second.find('latte')).map((result) => result.doc.title)).toEqual(['Latte art'])
  })

  it('refuses a payload MiniSearch cannot read', () => {
    const h = harness()
    expect(h.engine.restore({ index: 'not json', refs: [], hasBody: [], embeds: [] })).toBe(false)
  })

  it('drops references that are not in the restored index', async () => {
    const first = harness()
    await first.add([note('a', 'Latte', 'latte foam')])
    const payload = first.engine.toJSON()
    payload.refs.push(['n:ghost', 1])
    payload.hasBody.push(['n:ghost', true])
    payload.embeds.push(['n:ghost', ['n:a']])
    const second = harness()
    expect(second.engine.restore(payload)).toBe(true)
    expect(second.engine.references.has('n:ghost')).toBe(false)
    expect(second.engine.embedsOf('n:ghost')).toEqual([])
  })

  it('re-indexing a document replaces rather than duplicates it', async () => {
    const h = harness({}, { a: 'espresso' })
    await h.add([note('a', 'Latte', 'milk')])
    await h.add([note('a', 'Latte', 'espresso')])
    expect(h.engine.documentCount).toBe(1)
    expect((await h.find('espresso')).map((result) => result.id)).toEqual(['n:a'])
    expect((await h.find('milk'))).toEqual([])
  })
})

describe('engine diffing', () => {
  it('sees a new revision as work to add and a vanished id as work to remove', async () => {
    const h = harness()
    await h.add([note('a', 'One', 'alpha'), note('b', 'Two', 'beta')])
    const next = new Map([
      [docIdForNote('a'), NOW + 1],
      [docIdForNote('c'), NOW],
    ])
    const diff = h.engine.diff(next)
    expect(diff.toAdd.sort()).toEqual([docIdForNote('a'), docIdForNote('c')])
    expect(diff.toRemove.sort()).toEqual([docIdForNote('b')])
  })

  it('leaves a note the server could not read alone until it changes', async () => {
    const h = harness()
    h.engine.markRevisions([[docIdForNote('gone'), 7]])
    expect(h.engine.diff(new Map([[docIdForNote('gone'), 7]]))).toEqual({ toAdd: [], toRemove: [] })
    expect(h.engine.diff(new Map([[docIdForNote('gone'), 8]]))).toEqual({ toAdd: [docIdForNote('gone')], toRemove: [] })
  })
})

describe('engine chinese matching', () => {
  const WORD = String.fromCharCode(0x673a, 0x5668, 0x5b66, 0x4e60)
  const SENTENCE = [
    String.fromCharCode(0x8fd9, 0x662f, 0x4e00, 0x4efd, 0x5173, 0x4e8e),
    WORD,
    String.fromCharCode(0x7684, 0x7814, 0x7a76, 0x62a5, 0x544a),
  ].join('')

  it('finds a four-character word that sits inside a longer run', async () => {
    const h = harness({}, { a: SENTENCE })
    await h.add([note('a', 'Report', SENTENCE)])
    expect((await h.find(WORD)).map((result) => result.id)).toEqual(['n:a'])
  })

  it('finds a word by the initials of a pair inside the run', async () => {
    const { preloadPinyin, pinyinKeysOf } = await import('../../lib/pinyin')
    await preloadPinyin()
    const pairs = [...WORD]
    const reading = pinyinKeysOf(pairs[0]! + pairs[1]!)
    const h = harness({ pinyinSearch: true }, { a: SENTENCE })
    await h.add([note('a', 'Report', SENTENCE)])
    expect(reading).not.toBeNull()
    const hits = await h.find(reading!.initials)
    expect(hits.map((result) => result.id)).toEqual(['n:a'])
  })
})

describe('recencyFactor', () => {
  const rule = (cutoff: 'disabled' | 'day' | 'week' | 'month') => ({ enabled: cutoff !== 'disabled', cutoff })

  it('does nothing when the reader turned it off', () => {
    expect(recencyFactor(NOW - DAY, NOW, rule('disabled'))).toBe(1)
  })

  it('decays across the window it was given', () => {
    expect(recencyFactor(NOW, NOW, rule('day'))).toBeCloseTo(2, 5)
    expect(recencyFactor(NOW - DAY / 2, NOW, rule('day'))).toBeCloseTo(1.5, 5)
    expect(recencyFactor(NOW - DAY * 2, NOW, rule('day'))).toBe(1)
  })

  it('makes the three windows behave differently, which the reference’s curve did not', () => {
    const week = recencyFactor(NOW - DAY * 2, NOW, rule('week'))
    const day = recencyFactor(NOW - DAY * 2, NOW, rule('day'))
    expect(week).toBeGreaterThan(day)
    expect(week).toBeCloseTo(1 + (1 - 2 / 7), 5)
  })

  it('treats a clock skew towards the future as brand new', () => {
    expect(recencyFactor(NOW + DAY * 10, NOW, rule('day'))).toBeCloseTo(2, 5)
  })
})

describe('engine fuzziness', () => {
  it('finds a mistyped long word at the default setting', async () => {
    const h = harness({}, { a: 'the aerodynamic frame' })
    await h.add([note('a', 'Bikes', 'the aerodynamic frame')])
    expect((await h.find('aerodinamic')).map((result) => result.id)).toEqual(['n:a'])
  })

  it('refuses a mistyped word when set to exact', async () => {
    const h = harness({ fuzziness: '0' }, { a: 'the aerodynamic frame' })
    await h.add([note('a', 'Bikes', 'the aerodynamic frame')])
    expect(await h.find('aerodinamic')).toEqual([])
  })

  it('does not prefix a short word in simpler search', async () => {
    const h = harness({ simpleSearch: true }, { a: 'teapot kettle' })
    await h.add([note('a', 'Ware', 'teapot kettle')])
    expect(await h.find('te')).toEqual([])
    const keen = harness({ simpleSearch: false }, { a: 'teapot kettle' })
    await keen.add([note('a', 'Ware', 'teapot kettle')])
    expect((await keen.find('ket')).map((result) => result.id)).toEqual(['n:a'])
  })
})
