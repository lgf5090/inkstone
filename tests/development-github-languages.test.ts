import { describe, expect, it } from 'vitest'
import {
  GITHUB_LANGUAGES,
  fuzzyMatchLanguages,
  getLanguageColor,
} from '../src/client/features/development/github/lib/languages'

describe('GitHub language data', () => {
  it('ports the reference list one to one', () => {
    expect(GITHUB_LANGUAGES).toHaveLength(324)
    expect(GITHUB_LANGUAGES[0]).toEqual({ name: 'JavaScript', color: '#f1e05a' })
    expect(GITHUB_LANGUAGES).toContainEqual({ name: "Ren'Py", color: '#ff7f7f' })
    expect(new Set(GITHUB_LANGUAGES.map((language) => language.name)).size).toBe(324)
  })

  it('matches names case-insensitively', () => {
    const matches = fuzzyMatchLanguages('TYPE')
    expect(matches.some((language) => language.name === 'TypeScript')).toBe(true)
    expect(fuzzyMatchLanguages('  py  ').some((language) => language.name === 'Python')).toBe(true)
    expect(fuzzyMatchLanguages('no-such-language')).toEqual([])
  })

  it('returns all languages for an empty query and caps matches at fifty', () => {
    expect(fuzzyMatchLanguages('')).toHaveLength(324)
    expect(fuzzyMatchLanguages('a')).toHaveLength(50)
    expect(fuzzyMatchLanguages('a', 2)).toHaveLength(2)
    expect(fuzzyMatchLanguages('a', 0)).toEqual([])
  })

  it('returns the language color with a neutral fallback', () => {
    expect(getLanguageColor('Rust')).toBe('#dea584')
    expect(getLanguageColor('Unknown')).toBe('#94a3b8')
    expect(getLanguageColor(null)).toBe('#94a3b8')
  })
})
