/**
 * The shortcut that puts the current note on the projector. These read the key as it actually
 * arrives — dispatched through the real registry, bound on `window` in the capture phase — because
 * what matters is who gets the key: the show when one is running, the note's editor cursor when the
 * keystroke lands inside the editor, and nobody at all when there is no note to present.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const start = vi.hoisted(() => vi.fn(() => true))

vi.mock('./start-presentation', () => ({
  startPresentationFromNote: start,
}))

import { IS_MAC, hotkeyText, registerAll } from '../../lib/hotkeys'
import { APP_SHORTCUTS } from '../../lib/shortcuts'
import { initI18n, t } from '../../lib/i18n'
import { usePresentation } from '../../store/presentation'
import { useUi } from '../../store/ui'
import { PRESENTATION_HOTKEYS } from './presentation-hotkeys'
import { GLOBAL_HOTKEYS } from '../shell/AppShell'

const IDLE = { open: false, noteId: null, title: '', snapshot: '', following: true, initialSlideIndex: 0 }
const MOD = IS_MAC ? { metaKey: true } : { ctrlKey: true }

let dispose: () => void

beforeAll(async () => {
  await initI18n()
})

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init })
  target.dispatchEvent(event)
  return event
}

function presentKey() {
  return press(document.body, { key: 'p', ...MOD, altKey: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  usePresentation.setState(IDLE)
  useUi.setState({ activeNoteId: 'note-1' })
  dispose = registerAll(PRESENTATION_HOTKEYS)
})

afterEach(() => {
  dispose()
  useUi.setState({ activeNoteId: null })
})

describe('presentation hotkey (P-22)', () => {
  it('presents the note on screen', () => {
    const event = presentKey()
    expect(start).toHaveBeenCalledWith('note-1')
    expect(event.defaultPrevented).toBe(true)
  })

  it('reaches the show from inside the editor, where the cursor decides the opening slide', () => {
    // The key is dispatched on the editor itself, not on the body: whether the registry hands a
    // keystroke over is decided by what the event targets, so pressing on plain ground would prove
    // nothing about the field it is meant to reach into.
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    document.body.append(editor)

    const event = press(editor, { key: 'p', ...MOD, altKey: true })
    editor.remove()
    expect(start).toHaveBeenCalledWith('note-1')
    expect(event.defaultPrevented).toBe(true)
  })

  it('reaches the show from a focused field too', () => {
    const field = document.createElement('textarea')
    document.body.append(field)

    press(field, { key: 'p', ...MOD, altKey: true })
    field.remove()
    expect(start).toHaveBeenCalledWith('note-1')
  })

  it('is listed in the shortcut reference under the note group', () => {
    const [hotkey] = PRESENTATION_HOTKEYS
    expect(hotkey.combo).toBe('mod+alt+p')
    expect(hotkeyText(hotkey.description)).toBe(t('workspace.presentation_mode'))
    expect(hotkeyText(hotkey.group)).toBe(t('common.note'))
  })
})

/**
 * The same key read from the other side: a running show, an absent note, and a shortcut that looks
 * like this one. Each of these would be a way for the shell to steal a keystroke from something
 * that already owns it.
 */
describe('presentation hotkey — the keys it leaves alone', () => {
  it('leaves the key to the running show instead of restarting it mid-talk', () => {
    usePresentation.setState({ ...IDLE, open: true, noteId: 'note-1' })

    const event = presentKey()
    expect(start).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not present anything when no note is on screen', () => {
    useUi.setState({ activeNoteId: null })

    presentKey()
    expect(start).not.toHaveBeenCalled()
  })

  it('is not the quick-open key it is spelled like', () => {
    press(document.body, { key: 'p', ...MOD })
    expect(start).not.toHaveBeenCalled()
  })
})

// N-17, in this fork's spelling: the app's keyboard panel is on `mod+shift+/` rather than on `?`, so
// the two surfaces do not collide on one keystroke. The gate is still owed, for a different reason —
// the panel is a modal at the settings tier, below the projector, so a presenter who hits it during a
// talk gets a dialog they cannot see that has taken the focus.
function shellShortcuts() {
  const hotkey = GLOBAL_HOTKEYS.find((item) => item.id === 'shortcuts')
  if (!hotkey) throw new Error('the shell no longer registers a shortcuts hotkey')
  return hotkey
}

function shortcutsPress(target: EventTarget = document.body) {
  return press(target, { key: '/', ...MOD, shiftKey: true })
}

describe('the app panel yields to a running show', () => {
  afterEach(() => {
    useUi.setState({ panel: null })
  })

  it('is the keystroke the app panel already carries', () => {
    expect(shellShortcuts().combo).toBe(APP_SHORTCUTS.shortcuts)
  })

  it('opens the app panel while nothing is being presented', () => {
    const disposeShell = registerAll([shellShortcuts()])
    shortcutsPress()
    disposeShell()
    expect(useUi.getState().panel).toBe('shortcuts')
  })

  it('stays out of the way while a show is running, which owns the screen', () => {
    usePresentation.setState({ ...IDLE, open: true })
    const disposeShell = registerAll([shellShortcuts()])
    const event = shortcutsPress()
    disposeShell()
    expect(useUi.getState().panel).toBeNull()
    expect(event.defaultPrevented, 'the panel left the keystroke for the show to answer').toBe(false)
  })
})
