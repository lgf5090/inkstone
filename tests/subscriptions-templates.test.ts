// @vitest-environment node
/**
 * The list of services the app knows by name.
 *
 * Two things are worth holding still here rather than trusting to care. Every entry has to point at a
 * built-in label that actually exists — a template that filed something under a name with no icon or
 * colour behind it would draw a plain row in a list of styled ones — and the table has to stay price-free,
 * which is the promise the picker makes out loud ("it never guesses a price"). A key that drifts or a
 * price that sneaks in is a claim the app can no longer back, so both are asserted rather than reviewed.
 */
import { describe, expect, it } from 'vitest'
import { CATEGORY_PRESETS, TYPE_PRESETS } from '../src/shared/subscriptions/identity'
import { PERIOD_UNITS } from '../src/shared/subscriptions/model'
import { findServiceTemplate, SERVICE_TEMPLATES } from '../src/shared/subscriptions/templates'

const typeKeys = new Set(TYPE_PRESETS.map((preset) => preset.key))
const categoryKeys = new Set(CATEGORY_PRESETS.map((preset) => preset.key))

describe('the service templates', () => {
  it('names each one differently, so picking a row cannot be ambiguous', () => {
    const names = SERVICE_TEMPLATES.map((template) => template.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('files every one under a built-in type and a built-in category', () => {
    for (const template of SERVICE_TEMPLATES) {
      expect(typeKeys.has(template.typeKey), `${template.name} has no type identity`).toBe(true)
      expect(categoryKeys.has(template.categoryKey), `${template.name} has no category identity`).toBe(true)
    }
  })

  it('repeats a cycle the app can actually bill on', () => {
    for (const template of SERVICE_TEMPLATES) {
      expect(PERIOD_UNITS).toContain(template.periodUnit)
      expect(template.periodValue).toBeGreaterThanOrEqual(1)
      expect(Number.isInteger(template.periodValue)).toBe(true)
    }
  })

  it('carries no price, no currency and no date, because those are the reader\'s', () => {
    for (const template of SERVICE_TEMPLATES) {
      expect(Object.keys(template).sort()).toEqual(['categoryKey', 'name', 'periodUnit', 'periodValue', 'typeKey'])
    }
  })

  it('finds a service by the name as it is written, and by nothing else', () => {
    expect(findServiceTemplate('  netflix ')?.name).toBe('Netflix')
    expect(findServiceTemplate('Netflix')).toBeTruthy()
    expect(findServiceTemplate('')).toBeNull()
    expect(findServiceTemplate('Netflix2')).toBeNull()
    expect(findServiceTemplate(undefined)).toBeNull()
    expect(findServiceTemplate(42)).toBeNull()
  })
})
