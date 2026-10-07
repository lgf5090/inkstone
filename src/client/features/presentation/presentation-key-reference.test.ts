// N-17 asked where the show's twenty-odd bindings could be looked up, and the answer had better be one
// table: the card, the capsule's tooltip and the right-click menu are three renderings of the same map.
// This file is the cross-surface check — a row that quietly drops its key, or spells it differently
// from the card, fails here rather than in front of a talk.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { buildPresentationMenuItems, buildPresentationOverflowItems } from './presentation-context-menu'
import { menuOptions } from './presentation-menu-options.test-helpers'
import { presentationKeyCombo, presentationKeyReference } from './presentation-keys'

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  document.body.innerHTML = ''
})

// Home and End have no row of their own: the menu offers no jump to the ends of the deck, so those two
// bindings live on the card alone.
const CARD_ONLY = ['first', 'last']

describe('the right-click menu and the key reference', () => {
  it('prints on each row the key the reference says drives it', () => {
    const items = buildPresentationMenuItems(menuOptions())
    for (const row of presentationKeyReference().filter((entry) => !CARD_ONLY.includes(entry.command))) {
      const item = items.find((entry) => entry.label === row.description)
      expect(item, `no menu row offers ${row.command}`).toBeTruthy()
      expect(item?.combo, row.command).toBe(presentationKeyCombo(row.command))
    }
  })

  it('leaves the key off the follow row once there is nothing left to follow', () => {
    const row = buildPresentationMenuItems({ ...menuOptions(), followLost: true }).find((item) => item.id === 'follow')
    expect(row?.combo).toBeUndefined()
  })

  it('offers the card itself as a row, marked up while the card is open', () => {
    const onToggleKeyGuide = vi.fn()
    const row = buildPresentationMenuItems({ ...menuOptions(), keyGuide: true, onToggleKeyGuide }).find((item) => item.id === 'key-guide')
    expect(row?.label).toBe(t('workspace.presentation_keys'))
    expect(row?.checked).toBe(true)
    row?.onSelect?.()
    expect(onToggleKeyGuide).toHaveBeenCalledTimes(1)
  })
})

// N-18 + N-35: the narrow bar gets one door instead of eleven controls, and the door has to hold the
// same rows the right-click menu holds — otherwise the phone gets a second, quieter map to learn.
describe('the narrow-screen door and the key reference', () => {
  it('holds every view, tool and session row, and none of the turns or the exit the bar keeps', () => {
    expect(buildPresentationOverflowItems(menuOptions()).map((item) => item.id)).toEqual([
      'overview',
      'rail',
      'presenter',
      'laser',
      'spotlight',
      'ink',
      'blackout',
      'whiteout',
      'follow',
      'fullscreen',
      'key-guide',
    ])
  })

  it('spells every row of the door with the key the card prints beside those words', () => {
    for (const item of buildPresentationOverflowItems(menuOptions())) {
      const row = presentationKeyReference().find((entry) => entry.description === item.label)
      expect(row, item.id).toBeTruthy()
      expect(item.combo, item.id).toBe(presentationKeyCombo(row!.command))
    }
  })
})
