/**
 * The guard that keeps the two icon lists honest.
 *
 * The names the worker validates against live in `@shared/subscriptions/identity`; the components that
 * draw them live in the browser, because a Worker has no business importing an icon set. Two lists is a
 * drift hazard, and the failure is silent in both directions: a name with no component draws an empty
 * tile and reads as a corrupt choice, and a component with no name is bytes in the bundle that nothing
 * can ever select.
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CATEGORY_PRESETS,
  SUBSCRIPTION_ICON_GROUPS,
  SUBSCRIPTION_ICON_NAMES,
  TYPE_PRESETS,
} from '../src/shared/subscriptions/identity'
import { ICON_COMPONENT_NAMES, iconComponentOf } from '../src/client/features/subscriptions/label-icons'

describe('the subscription icon set', () => {
  it('offers every name a component can draw', () => {
    const unresolvable = SUBSCRIPTION_ICON_NAMES.filter((name) => !ICON_COMPONENT_NAMES.includes(name))
    expect(unresolvable).toEqual([])
  })

  it('has no component that the picker does not offer', () => {
    expect([...ICON_COMPONENT_NAMES].sort()).toEqual([...SUBSCRIPTION_ICON_NAMES].sort())
  })

  it('wears only offered icons on its built-in labels', () => {
    const offered = new Set(SUBSCRIPTION_ICON_NAMES)
    const orphaned = [...TYPE_PRESETS, ...CATEGORY_PRESETS]
      .map((preset) => preset.icon)
      .filter((name) => !offered.has(name))
    expect(orphaned).toEqual([])
  })

  it('lists each name exactly once, so a grid cannot key two tiles to the same icon', () => {
    const flattened = SUBSCRIPTION_ICON_GROUPS.flatMap((group) => group.icons.map((icon) => icon.name))
    expect(flattened.length).toBe(new Set(flattened).size)
    expect(flattened).toEqual([...SUBSCRIPTION_ICON_NAMES])
  })

  it('resolves the stored spelling and nothing else', () => {
    expect(iconComponentOf('lucide:Tv')).toBeTruthy()
    expect(iconComponentOf('Tv')).toBeNull()
    expect(iconComponentOf('lucide:NotARealIcon')).toBeNull()
    expect(iconComponentOf(null)).toBeNull()
    expect(iconComponentOf(undefined)).toBeNull()
  })
})
