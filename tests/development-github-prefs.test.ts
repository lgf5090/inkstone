import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GIST_PREFS,
  DEFAULT_GITHUB_MIRRORS,
  DEFAULT_GITHUB_PREFS,
} from '@shared/development/github/types'
import {
  DEFAULT_LAYOUT_PREFS,
  loadCurrentMirrorId,
  loadGistPrefs,
  loadGistViewMode,
  loadLayoutPrefs,
  loadRepoPrefs,
  saveCurrentMirrorId,
  saveGistPrefs,
  saveGistViewMode,
  saveLayoutPrefs,
  saveRepoPrefs,
} from '../src/client/features/development/github/prefs'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('GitHub local preferences', () => {
  it('falls back to defaults when nothing is stored', () => {
    expect(loadRepoPrefs()).toEqual(DEFAULT_GITHUB_PREFS)
    expect(loadGistPrefs()).toEqual(DEFAULT_GIST_PREFS)
    expect(loadGistViewMode()).toBe('list')
    expect(loadCurrentMirrorId()).toBe(DEFAULT_GITHUB_MIRRORS[0]!.id)
    expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS)
  })

  it('round-trips repository and gist preferences', () => {
    saveRepoPrefs({ range: 'month', sort: 'forks', order: 'asc', language: 'Rust' })
    expect(loadRepoPrefs()).toEqual({ range: 'month', sort: 'forks', order: 'asc', language: 'Rust' })
    saveGistPrefs({ sort: 'files', order: 'asc' })
    expect(loadGistPrefs()).toEqual({ sort: 'files', order: 'asc' })
    saveGistViewMode('card')
    expect(loadGistViewMode()).toBe('card')
    saveCurrentMirrorId('custom')
    expect(loadCurrentMirrorId()).toBe('custom')
  })

  it('falls back from corrupt JSON and unknown values', () => {
    localStorage.setItem('inkstone.development.github.prefs', '{not json')
    expect(loadRepoPrefs()).toEqual(DEFAULT_GITHUB_PREFS)
    localStorage.setItem('inkstone.development.github.prefs', JSON.stringify({
      range: 'decade',
      sort: 'created',
      order: 'sideways',
      language: 'x'.repeat(100),
    }))
    expect(loadRepoPrefs()).toEqual({
      range: DEFAULT_GITHUB_PREFS.range,
      sort: DEFAULT_GITHUB_PREFS.sort,
      order: DEFAULT_GITHUB_PREFS.order,
      language: 'x'.repeat(64),
    })
    localStorage.setItem('inkstone.development.github.gist-prefs', JSON.stringify({ sort: 'stars', order: 'up' }))
    expect(loadGistPrefs()).toEqual(DEFAULT_GIST_PREFS)
    localStorage.setItem('inkstone.development.github.gist-view-mode', 'grid')
    expect(loadGistViewMode()).toBe('list')
    localStorage.setItem('inkstone.development.github.mirror', '')
    expect(loadCurrentMirrorId()).toBe(DEFAULT_GITHUB_MIRRORS[0]!.id)
  })

  it('clamps layout widths and merges patches', () => {
    saveLayoutPrefs({ sidebarWidth: 999, detailRatio: 0.9 })
    expect(loadLayoutPrefs()).toEqual({ sidebarWidth: 300, detailRatio: 0.7 })
    saveLayoutPrefs({ sidebarWidth: 100 })
    expect(loadLayoutPrefs()).toEqual({ sidebarWidth: 200, detailRatio: 0.7 })
    localStorage.setItem('inkstone.development.github.layout', JSON.stringify({ sidebarWidth: 'wide', detailRatio: null }))
    expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS)
  })
})
