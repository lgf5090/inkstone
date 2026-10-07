import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { prettyCombo } from '../../lib/hotkeys'
import { presentationCommand, presentationKeyCombo, presentationKeyReference } from './presentation-keys'

const plain = { onControl: false, onSlideList: false }
const onControl = { onControl: true, onSlideList: false }
const onSlideList = { onControl: false, onSlideList: true }
const onOverviewGrid = { onControl: false, onSlideList: false, onOverviewGrid: true }
const onMenu = { onControl: false, onSlideList: false, onMenu: true }
const onMenuControl = { onControl: true, onSlideList: false, onMenu: true }
const onNotesPane = { onControl: false, onSlideList: false, onNotesPane: true }

// The card reads its rows out of the locale, so the rows only become words once the messages are in.
beforeAll(async () => {
  await initI18n()
})

describe('presentationCommand — navigation', () => {
  it('walks the deck with the arrow, page and space keys', () => {
    expect(presentationCommand('ArrowRight', plain)).toBe('next')
    expect(presentationCommand('ArrowDown', plain)).toBe('next')
    expect(presentationCommand('PageDown', plain)).toBe('next')
    expect(presentationCommand(' ', plain)).toBe('next')
    expect(presentationCommand('ArrowLeft', plain)).toBe('prev')
    expect(presentationCommand('ArrowUp', plain)).toBe('prev')
    expect(presentationCommand('PageUp', plain)).toBe('prev')
  })

  it('jumps to the deck edges with Home and End', () => {
    expect(presentationCommand('Home', plain)).toBe('first')
    expect(presentationCommand('End', plain)).toBe('last')
  })

  it('ignores keys that belong to the rest of the page', () => {
    expect(presentationCommand('a', plain)).toBeNull()
    expect(presentationCommand('Escape', plain)).toBeNull()
    expect(presentationCommand('Tab', plain)).toBeNull()
  })
})

describe('presentationCommand — toggles and focus ownership', () => {
  it('toggles fullscreen, the slide list and following on F, S and L', () => {
    expect(presentationCommand('f', plain)).toBe('fullscreen')
    expect(presentationCommand('F', plain)).toBe('fullscreen')
    expect(presentationCommand('s', plain)).toBe('slideList')
    expect(presentationCommand('S', plain)).toBe('slideList')
    expect(presentationCommand('l', plain)).toBe('follow')
    expect(presentationCommand('L', plain)).toBe('follow')
  })

  it('still navigates while a control has focus, so a stray button cannot trap the keyboard', () => {
    expect(presentationCommand('ArrowRight', onControl)).toBe('next')
    expect(presentationCommand('End', onControl)).toBe('last')
  })

  it('leaves Space and Enter to the focused control instead of clicking twice', () => {
    expect(presentationCommand(' ', onControl)).toBeNull()
    expect(presentationCommand('Enter', onControl)).toBeNull()
  })

  it('leaves single-letter toggle keys to the focused control so typing is not hijacked', () => {
    expect(presentationCommand('f', onControl)).toBeNull()
    expect(presentationCommand('F', onControl)).toBeNull()
    expect(presentationCommand('s', onControl)).toBeNull()
    expect(presentationCommand('S', onControl)).toBeNull()
    expect(presentationCommand('l', onControl)).toBeNull()
    expect(presentationCommand('L', onControl)).toBeNull()
  })

  it('still turns pages from the list when the key is not an arrow or home/end', () => {
    expect(presentationCommand('PageDown', onSlideList)).toBe('next')
    expect(presentationCommand('PageUp', onSlideList)).toBe('prev')
    expect(presentationCommand(' ', onSlideList)).toBe('next')
    expect(presentationCommand('Escape', onSlideList)).toBeNull()
  })
})

// N-15: the two slide lists walk differently, and the keymap has to tell them apart — a key yielded to
// a list that has no use for it is handled by neither side, which is how the sideways turn died.
describe('presentationCommand — what each list owns', () => {
  it('lets the slide list keep only the keys it walks its own items with', () => {
    expect(presentationCommand('ArrowUp', onSlideList)).toBeNull()
    expect(presentationCommand('ArrowDown', onSlideList)).toBeNull()
    expect(presentationCommand('Home', onSlideList)).toBeNull()
    expect(presentationCommand('End', onSlideList)).toBeNull()
    expect(presentationCommand('ArrowLeft', onSlideList)).toBe('prev')
    expect(presentationCommand('ArrowRight', onSlideList)).toBe('next')
  })

  it('leaves the sideways turn to the grid that roams its rows', () => {
    expect(presentationCommand('ArrowLeft', onOverviewGrid)).toBeNull()
    expect(presentationCommand('ArrowRight', onOverviewGrid)).toBeNull()
    expect(presentationCommand('ArrowUp', onOverviewGrid)).toBeNull()
    expect(presentationCommand('ArrowDown', onOverviewGrid)).toBeNull()
    expect(presentationCommand('Home', onOverviewGrid)).toBeNull()
    expect(presentationCommand('End', onOverviewGrid)).toBeNull()
  })
})

describe('presentationCommand — laser pointer', () => {
  it('toggles the laser pointer on C', () => {
    expect(presentationCommand('c', plain)).toBe('laser')
    expect(presentationCommand('C', plain)).toBe('laser')
  })

  it('leaves C to the focused control so typing is not hijacked', () => {
    expect(presentationCommand('c', onControl)).toBeNull()
    expect(presentationCommand('C', onControl)).toBeNull()
  })

  it('keeps the pointer key off L, which has driven following since the first batch', () => {
    expect(presentationCommand('l', plain)).toBe('follow')
    expect(presentationCommand('L', plain)).toBe('follow')
  })
})

describe('presentationCommand — slide overview', () => {
  it('opens the overview on O, and on G for the grid it is laid out as', () => {
    expect(presentationCommand('o', plain)).toBe('overview')
    expect(presentationCommand('O', plain)).toBe('overview')
    expect(presentationCommand('g', plain)).toBe('overview')
    expect(presentationCommand('G', plain)).toBe('overview')
  })

  it('leaves O and G to the focused control so typing is not hijacked', () => {
    expect(presentationCommand('o', onControl)).toBeNull()
    expect(presentationCommand('G', onControl)).toBeNull()
  })

  it('keeps the overview keys off the letters the show has already shipped', () => {
    expect(presentationCommand('f', plain)).toBe('fullscreen')
    expect(presentationCommand('s', plain)).toBe('slideList')
    expect(presentationCommand('l', plain)).toBe('follow')
    expect(presentationCommand('c', plain)).toBe('laser')
    expect(presentationCommand('b', plain)).toBe('blackout')
    expect(presentationCommand('w', plain)).toBe('whiteout')
  })

  it('lets the grid keep both the arrows it roams its cards with', () => {
    expect(presentationCommand('ArrowRight', onOverviewGrid)).toBeNull()
    expect(presentationCommand('ArrowDown', onOverviewGrid)).toBeNull()
    expect(presentationCommand('Home', onOverviewGrid)).toBeNull()
  })

  it('still turns pages with PageDown while the grid holds the arrows', () => {
    expect(presentationCommand('PageDown', onOverviewGrid)).toBe('next')
  })
})

describe('presentationCommand — blackout and whiteout', () => {
  it('toggles blackout and whiteout on B/W and period/comma', () => {
    expect(presentationCommand('b', plain)).toBe('blackout')
    expect(presentationCommand('B', plain)).toBe('blackout')
    expect(presentationCommand('.', plain)).toBe('blackout')
    expect(presentationCommand('w', plain)).toBe('whiteout')
    expect(presentationCommand('W', plain)).toBe('whiteout')
    expect(presentationCommand(',', plain)).toBe('whiteout')
  })

  it('leaves B and W to the focused control so form fields are not hijacked', () => {
    expect(presentationCommand('b', onControl)).toBeNull()
    expect(presentationCommand('B', onControl)).toBeNull()
    expect(presentationCommand('w', onControl)).toBeNull()
    expect(presentationCommand('W', onControl)).toBeNull()
    expect(presentationCommand('.', onControl)).toBeNull()
    expect(presentationCommand(',', onControl)).toBeNull()
  })
})

describe('presentationCommand — presenter view', () => {
  it('opens presenter console on P', () => {
    expect(presentationCommand('p', plain)).toBe('presenter')
    expect(presentationCommand('P', plain)).toBe('presenter')
  })

  it('leaves P to the focused control so typing is not hijacked', () => {
    expect(presentationCommand('p', onControl)).toBeNull()
    expect(presentationCommand('P', onControl)).toBeNull()
  })
})

describe('presentationCommand — spotlight', () => {
  it('toggles spotlight on T and K', () => {
    expect(presentationCommand('t', plain)).toBe('spotlight')
    expect(presentationCommand('T', plain)).toBe('spotlight')
    expect(presentationCommand('k', plain)).toBe('spotlight')
    expect(presentationCommand('K', plain)).toBe('spotlight')
  })

  it('leaves T and K to the focused control so typing is not hijacked', () => {
    expect(presentationCommand('t', onControl)).toBeNull()
    expect(presentationCommand('T', onControl)).toBeNull()
    expect(presentationCommand('k', onControl)).toBeNull()
    expect(presentationCommand('K', onControl)).toBeNull()
  })
})

describe('presentationCommand — menu context ownership', () => {
  it('yields vertical navigation arrows to the open menu so background slides do not flip', () => {
    expect(presentationCommand('ArrowDown', onMenu)).toBeNull()
    expect(presentationCommand('ArrowUp', onMenu)).toBeNull()
    expect(presentationCommand('ArrowDown', onMenuControl)).toBeNull()
    expect(presentationCommand('ArrowUp', onMenuControl)).toBeNull()
  })

  it('yields all other navigation and activation keys to the open menu', () => {
    expect(presentationCommand('ArrowLeft', onMenu)).toBeNull()
    expect(presentationCommand('ArrowRight', onMenu)).toBeNull()
    expect(presentationCommand('PageDown', onMenu)).toBeNull()
    expect(presentationCommand('PageUp', onMenu)).toBeNull()
    expect(presentationCommand('Home', onMenu)).toBeNull()
    expect(presentationCommand('End', onMenu)).toBeNull()
    expect(presentationCommand(' ', onMenu)).toBeNull()
    expect(presentationCommand('Enter', onMenu)).toBeNull()
  })

  it('yields single-letter tool toggles to the open menu', () => {
    expect(presentationCommand('f', onMenu)).toBeNull()
    expect(presentationCommand('s', onMenu)).toBeNull()
    expect(presentationCommand('l', onMenu)).toBeNull()
    expect(presentationCommand('c', onMenu)).toBeNull()
    expect(presentationCommand('t', onMenu)).toBeNull()
    expect(presentationCommand('k', onMenu)).toBeNull()
    expect(presentationCommand('b', onMenu)).toBeNull()
    expect(presentationCommand('w', onMenu)).toBeNull()
    expect(presentationCommand('p', onMenu)).toBeNull()
    expect(presentationCommand('g', onMenu)).toBeNull()
    expect(presentationCommand('o', onMenu)).toBeNull()
  })
})



describe('presentationCommand — the speaker notes pane', () => {
  it('hands the notes pane the keys it scrolls with, so reading notes does not flip the deck', () => {
    expect(presentationCommand('ArrowDown', onNotesPane)).toBeNull()
    expect(presentationCommand('ArrowUp', onNotesPane)).toBeNull()
    expect(presentationCommand('PageDown', onNotesPane)).toBeNull()
    expect(presentationCommand('PageUp', onNotesPane)).toBeNull()
    expect(presentationCommand('Home', onNotesPane)).toBeNull()
    expect(presentationCommand('End', onNotesPane)).toBeNull()
    expect(presentationCommand(' ', onNotesPane)).toBeNull()
  })

  it('keeps the sideways turns and the tools for the show, which the notes cannot scroll', () => {
    expect(presentationCommand('ArrowRight', onNotesPane)).toBe('next')
    expect(presentationCommand('ArrowLeft', onNotesPane)).toBe('prev')
    expect(presentationCommand('f', onNotesPane)).toBe('fullscreen')
    expect(presentationCommand('p', onNotesPane)).toBe('presenter')
  })
})

// N-17: the show had over twenty bindings and nowhere to look them up. The reference is only worth
// printing if it is the map, so the table below is checked against `presentationCommand` itself —
// a row that names a key the map answers with a different command is a card that lies to the speaker.
describe('presentationCommand — the key reference', () => {
  it('opens and closes the key card on ?', () => {
    expect(presentationCommand('?', plain)).toBe('keyGuide')
    expect(presentationCommand('?', onSlideList)).toBe('keyGuide')
    expect(presentationCommand('?', onOverviewGrid)).toBe('keyGuide')
    expect(presentationCommand('?', onNotesPane)).toBe('keyGuide')
  })

  it('leaves ? to a focused control and to an open menu, so typing is not hijacked', () => {
    expect(presentationCommand('?', onControl)).toBeNull()
    expect(presentationCommand('?', onMenu)).toBeNull()
  })
})

describe('the printed key reference and the keymap', () => {
  it('names no keystroke twice, so one press is one row of the card', () => {
    const keys = presentationKeyReference().flatMap((row) => row.bindings)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.length).toBeGreaterThan(15)
  })

  it('prints only the keys that actually drive the command each row names', () => {
    for (const row of presentationKeyReference()) {
      if (row.command === 'exit') continue
      for (const key of row.bindings) {
        expect(presentationCommand(key, plain), `${key} is printed under ${row.command}`).toBe(row.command)
      }
    }
  })

  // Which commands must appear is a compile-time rule: the reference is a `Record` over the command
  // union, so a command added to the map without a row to document it does not build. What the test
  // can check is the other direction — that the rows do not repeat themselves.
  it('gives each command one row, so a press has one line to read', () => {
    const rows = presentationKeyReference()
    expect(new Set(rows.map((row) => row.command)).size).toBe(rows.length)
    expect(rows.length).toBeGreaterThan(14)
  })

})

describe('what the printed key reference reads like', () => {
  it('describes each row with the words the control it drives already uses', () => {
    const rows = presentationKeyReference()
    expect(rows.find((row) => row.command === 'next')?.description).toBe(t('workspace.presentation_next'))
    expect(rows.find((row) => row.command === 'exit')?.description).toBe(t('workspace.presentation_exit'))
    expect(rows.find((row) => row.command === 'keyGuide')?.description).toBe(t('workspace.presentation_keys'))
  })

  // The card, the capsule's tooltip and the right-click menu are three renderings of one binding: a
  // speaker who reads `→` on the button and `ArrowRight` on the card has been shown two different maps.
  it('spells a key the same way in the card as in the tooltip and the menu', () => {
    for (const row of presentationKeyReference()) {
      expect(row.caps[0], row.command).toBe(prettyCombo(presentationKeyCombo(row.command))[0])
    }
  })

  // The caps are what a presenter actually reads, so they are pinned as words rather than derived from
  // the same function the card calls: a keystroke that stopped spelling as a key would otherwise read
  // back as its own browser name.
  it('spells each binding the way a key on a keyboard is written', () => {
    const caps = Object.fromEntries(presentationKeyReference().map((row) => [row.command, row.caps]))
    expect(caps.next).toEqual(['→', 'Page Down', '↓', 'Space', '↵'])
    expect(caps.prev).toEqual(['←', 'Page Up', '↑'])
    expect(caps.first).toEqual(['Home'])
    expect(caps.last).toEqual(['End'])
    expect(caps.blackout).toEqual(['B', '.'])
    expect(caps.keyGuide).toEqual(['?'])
    expect(caps.exit).toEqual(['Esc'])
  })

  it('offers one canonical key per command for a tooltip or a menu row', () => {
    expect(presentationKeyCombo('next')).toBe('arrowright')
    expect(presentationKeyCombo('prev')).toBe('arrowleft')
    expect(presentationKeyCombo('overview')).toBe('g')
    expect(presentationKeyCombo('laser')).toBe('c')
    expect(presentationKeyCombo('exit')).toBe('escape')
    expect(presentationKeyCombo('keyGuide')).toBe('?')
  })
})
