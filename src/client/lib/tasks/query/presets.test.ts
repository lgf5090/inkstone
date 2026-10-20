import { describe, expect, it } from 'vitest'
import { explainQuery } from './explain'
import { expandPreset, PRESET_NAMES } from './presets'
import { parseTasksQuery } from './query'

const NOW = new Date(2026, 9, 19)

describe('presets', () => {
  it('expands the eight built-in names', () => {
    expect(PRESET_NAMES).toEqual([
      'this_file', 'this_folder', 'this_folder_only', 'this_root',
      'hide_date_fields', 'hide_non_date_fields', 'hide_query_elements', 'hide_everything',
    ])
    expect(expandPreset('nope', { currentPath: 'A/B.md' })).toBeNull()
  })

  it('scopes a preset to the note it is read from', () => {
    expect(expandPreset('this_file', { currentPath: 'Work/Team.md' })).toEqual(['path includes Work/Team.md'])
    expect(expandPreset('this_folder', { currentPath: 'Work/Team.md' })).toEqual(['folder includes Work/Team.md'])
    expect(expandPreset('this_root', { currentPath: 'Work/Projects/Team.md' })).toEqual(['root includes Work'])
  })

  it('answers nothing when it does not know which note is asking', () => {
    expect(expandPreset('this_file', { currentPath: null })).toEqual([])
  })

  it('hides every field without inventing an instruction', () => {
    const lines = expandPreset('hide_everything', { currentPath: null })!
    expect(lines).toContain('short mode')
    expect(lines).toContain('hide due date')
    expect(lines.filter((line) => /^hide /.test(line))).toHaveLength(lines.length - 1)
  })
})

describe('preset instructions', () => {
  it('are expanded and then parsed like anything the reader typed', () => {
    const parsed = parseTasksQuery('preset this_file\nnot done', NOW, { currentPath: 'Work/Team.md' })
    expect(parsed.errors).toEqual([])
    expect(parsed.instructions).toEqual(['path includes Work/Team.md', 'not done'])
  })

  it('report an unknown name instead of silently doing nothing', () => {
    expect(parseTasksQuery('preset nonsense', NOW).errors).toEqual(['unknown preset: nonsense'])
  })
})

describe('explain', () => {
  it('returns structure, not sentences, so the renderer owns the wording', () => {
    const parsed = parseTasksQuery('not done\ndue before 2026-10-20\nsort by urgency\ngroup by folder\nlimit 5\nshort mode\nhide backlink', NOW)
    const lines = explainQuery(parsed)
    expect(lines.map((line) => line.kind)).toEqual([
      'filter', 'filter', 'sort', 'group', 'limit', 'mode', 'layout',
    ])
    expect(lines.every((line) => typeof line.text === 'string' && line.text.length > 0)).toBe(true)
  })

  it('still explains a query that only says not done', () => {
    const lines = explainQuery(parseTasksQuery('not done', NOW))
    expect(lines.some((line) => line.kind === 'sort')).toBe(true)
  })
})
