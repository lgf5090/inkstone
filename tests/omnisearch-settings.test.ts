import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, mergeSettingsPatch } from '@shared/constants'
import type { SearchSettings } from '@shared/types'

const search = (patch: unknown): SearchSettings => mergeSettings({ search: patch }).search

describe('search settings validation', () => {
  it('starts from the defaults when nothing was stored yet', () => {
    expect(search(undefined)).toEqual(DEFAULT_SETTINGS.search)
    expect(search({})).toEqual(DEFAULT_SETTINGS.search)
  })

  it('keeps a well-formed section intact', () => {
    const value = { ...DEFAULT_SETTINGS.search, maxResults: 40, weightH1: 3.5, recencyBoost: 'week' as const }
    expect(search(value)).toMatchObject({ maxResults: 40, weightH1: 3.5, recencyBoost: 'week' })
  })

  it('refuses to let junk become a setting', () => {
    const messy = search({
      enabled: 'yes',
      maxResults: 'lots',
      maxEmbeds: 99,
      fuzziness: 'purple',
      recencyBoost: 'year',
      weightTitle: 500,
      downrankedFolders: 'not-a-list',
      weightCustomProperties: 'nope',
      maxIndexedNotes: -5,
      indexStorageMb: 1e9,
      displayTitleProperty: { a: 1 },
    })
    expect(messy.enabled).toBe(true)
    expect(messy.maxResults).toBe(DEFAULT_SETTINGS.search.maxResults)
    expect(messy.maxEmbeds).toBe(10)
    expect(messy.fuzziness).toBe('1')
    expect(messy.recencyBoost).toBe('disabled')
    expect(messy.weightTitle).toBe(10)
    expect(messy.downrankedFolders).toEqual([])
    expect(messy.weightCustomProperties).toEqual([])
    expect(messy.maxIndexedNotes).toBe(200)
    expect(messy.indexStorageMb).toBe(512)
    expect(messy.displayTitleProperty).toBe('')
  })

  it('snaps weights to the half step the slider offers', () => {
    expect(search({ weightH2: 4.49 }).weightH2).toBe(4.5)
    expect(search({ weightH2: 4.2 }).weightH2).toBe(4)
  })

  it('normalises the folder list without inventing entries', () => {
    const value = search({ downrankedFolders: [' Archive/', '', 'archive', 'Drafts', '  ', 'Archive/deep'] })
    expect(value.downrankedFolders).toEqual(['Archive', 'Drafts', 'Archive/deep'])
  })

  it('drops nameless properties and caps how many are kept', () => {
    const many = Array.from({ length: 30 }, (_unused, index) => ({ name: `p${index}`, weight: 2 }))
    expect(search({ weightCustomProperties: many }).weightCustomProperties).toHaveLength(12)
    expect(search({ weightCustomProperties: [{ name: '  ', weight: 2 }, { name: 'x' }] }).weightCustomProperties)
      .toEqual([{ name: 'x', weight: 1 }])
  })

  it('clamps a property weight rather than dropping the rule', () => {
    expect(search({ weightCustomProperties: [{ name: 'k', weight: 900 }] }).weightCustomProperties[0]!.weight).toBe(5)
    expect(search({ weightCustomProperties: [{ name: 'k', weight: 'x' }] }).weightCustomProperties[0]!.weight).toBe(1)
  })

  it('patches one search field without disturbing the others', () => {
    const current = { ...DEFAULT_SETTINGS, search: { ...DEFAULT_SETTINGS.search, weightTags: 8 } }
    const next = mergeSettingsPatch(current, { search: { maxEmbeds: 0 } })
    expect(next.search.maxEmbeds).toBe(0)
    expect(next.search.weightTags).toBe(8)
    expect(next.notes).toEqual(DEFAULT_SETTINGS.notes)
  })

  it('keeps the search section out of the way of the other sections', () => {
    const next = mergeSettingsPatch(DEFAULT_SETTINGS, { appearance: { theme: 'dark' } })
    expect(next.appearance.theme).toBe('dark')
    expect(next.search).toEqual(DEFAULT_SETTINGS.search)
  })
})
