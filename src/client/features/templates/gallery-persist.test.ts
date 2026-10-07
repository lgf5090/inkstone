import { beforeEach, describe, expect, it } from 'vitest'
import { GALLERY_PERSIST_KEY, loadGalleryPersist, splitTagInput } from './gallery-persist'

beforeEach(() => {
  localStorage.clear()
})

describe('loadGalleryPersist', () => {
  it('falls back to the default view with nothing stored', () => {
    expect(loadGalleryPersist()).toEqual({ filter: { kind: 'all' }, selectMode: false })
  })

  it('never reads a search term out of storage, whoever left it there', () => {
    localStorage.setItem(GALLERY_PERSIST_KEY, JSON.stringify({
      filter: { kind: 'tag', tag: 'work' },
      query: 'the previous person secret search',
      selectMode: false,
    }))
    const loaded = loadGalleryPersist()
    expect(loaded).toEqual({ filter: { kind: 'tag', tag: 'work' }, selectMode: false })
    expect('query' in loaded).toBe(false)
  })

  it('drops a malformed filter instead of throwing', () => {
    for (const junk of ['not json', '[]', 'null', '{"filter":null}', '{"filter":{"kind":"nope"}}',
      '{"filter":{"kind":"category","id":7}}', '{"filter":{"kind":"tag","tag":7}}']) {
      localStorage.setItem(GALLERY_PERSIST_KEY, junk)
      expect(loadGalleryPersist()).toEqual({ filter: { kind: 'all' }, selectMode: false })
    }
  })

  it('keeps a select mode that was left on', () => {
    localStorage.setItem(GALLERY_PERSIST_KEY, JSON.stringify({ filter: { kind: 'favorites' }, selectMode: true }))
    expect(loadGalleryPersist()).toEqual({ filter: { kind: 'favorites' }, selectMode: true })
  })
})

describe('splitTagInput', () => {
  it('splits on every separator a keyboard produces', () => {
    expect(splitTagInput('a,b，c、d e')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('drops the empties a stray separator leaves behind', () => {
    expect(splitTagInput(' , a ,, b, ')).toEqual(['a', 'b'])
    expect(splitTagInput('')).toEqual([])
  })
})
