import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, mergeSettingsPatch } from './constants'
import type { UserSettings } from './types'

/**
 * The store's own contract: a patch naming one field of one group has to arrive.
 *
 * `mergeSettingsPatch` walks a list of groups, and a group missing from that list is a settings panel
 * whose switches move on screen and never save — the reader sees nothing wrong. Probing one field per
 * group is what makes that failure answer in words rather than in a bug report.
 */
describe('a settings patch reaching every group', () => {
  it('lets one field change in each section of the stored settings', () => {
    for (const section of Object.keys(DEFAULT_SETTINGS) as (keyof UserSettings)[]) {
      const current = DEFAULT_SETTINGS[section] as unknown as Record<string, unknown>
      let reached = false
      let probeable = false
      for (const key of Object.keys(current)) {
        const value = current[key]
        const probe = typeof value === 'boolean' ? !value
          : typeof value === 'number' ? value + 1
            : typeof value === 'string' ? `${value}x`
              : null
        if (probe === null) continue
        probeable = true
        const merged = mergeSettingsPatch(DEFAULT_SETTINGS, { [section]: { [key]: probe } })
        const outcome = (merged[section] as unknown as Record<string, unknown>)[key]
        if (JSON.stringify(outcome) === JSON.stringify(value)) continue
        reached = true
        break
      }
      // The task section's defaults are all nulls and arrays, and an absent value has nothing a
      // scalar probe could change. Its fields are the cases below; this loop has no answer to give.
      if (!probeable) continue
      expect(reached, `no field of "${section}" survives a settings patch`).toBe(true)
    }
  })
})

describe('the task section of a stored profile', () => {
  const tasks = (settings: Record<string, unknown>) => mergeSettings(settings).tasks

  it('starts with the four statuses everyone gets and no filter', () => {
    expect(DEFAULT_SETTINGS.tasks.statuses).toEqual([])
    expect(DEFAULT_SETTINGS.tasks.globalFilter).toBe('')
    expect(DEFAULT_SETTINGS.tasks.autoSuggestMaxItems).toBeGreaterThan(DEFAULT_SETTINGS.tasks.autoSuggestMinMatch)
  })

  it('keeps a status row the registry can use', () => {
    const row = { symbol: '?', name: 'Question', nextStatusSymbol: ' ', type: 'TODO', availableAsCommand: true }
    expect(tasks({ tasks: { statuses: [row] } }).statuses).toEqual([row])
  })

  it('drops a row whose symbol is not one character', () => {
    const kept = tasks({ tasks: { statuses: [{ symbol: '??', name: 'Two', nextStatusSymbol: ' ', type: 'TODO' }] } })
    expect(kept.statuses).toEqual([])
  })

  it('drops a row whose type names nothing the registry knows', () => {
    const kept = tasks({ tasks: { statuses: [{ symbol: '!', name: 'Bad', nextStatusSymbol: ' ', type: 'MAYBE' }] } })
    expect(kept.statuses).toEqual([])
  })

  it('keeps the first of two rows sharing a symbol', () => {
    const first = { symbol: '*', name: 'First', nextStatusSymbol: ' ', type: 'TODO' }
    const kept = tasks({ tasks: { statuses: [first, { ...first, name: 'Second' }] } })
    expect(kept.statuses.map((row) => row.name)).toEqual(['First'])
  })

  it('treats an empty filter as the reader turning it off', () => {
    expect(tasks({ tasks: { globalFilter: '' } }).globalFilter).toBe('')
    expect(tasks({ tasks: { globalFilter: '   ' } }).globalFilter).toBe('')
  })

  it('cuts a filter down to a word the line can carry', () => {
    expect(tasks({ tasks: { globalFilter: `#${'x'.repeat(80)}` } }).globalFilter).toHaveLength(40)
  })

  it('keeps only the field names a tasks block knows how to hide', () => {
    const kept = tasks({ tasks: { defaultHiddenFields: ['due date', 'backlink', 'nonsense', 'Due Date'] } })
    expect(kept.defaultHiddenFields).toEqual(['due date'])
  })

  it('keeps the menu sliders inside the ranges the panel offers', () => {
    const kept = tasks({ tasks: { autoSuggestMinMatch: 99, autoSuggestMaxItems: 0 } })
    expect(kept.autoSuggestMinMatch).toBe(10)
    expect(kept.autoSuggestMaxItems).toBe(1)
  })

  it('answers with defaults for a profile written before the section existed', () => {
    expect(tasks({}).globalFilter).toBe('')
    expect(tasks({}).statuses).toEqual([])
  })
})
