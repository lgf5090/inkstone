import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultQuickAddSettings,
  newCaptureChoice,
  newGroupChoice,
  newTemplateChoice,
  type QuickAddChoice,
} from '@shared/quickadd'
import { initI18n } from '../../lib/i18n'
import { listHotkeys } from '../../lib/hotkeys'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useQuickAdd } from '../../store/quickadd'
import { useQuickAddBridge } from './bridge'

const runs = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('../../lib/quickadd/runner', () => ({
  runQuickAddChoice: async (id: string) => {
    runs.calls.push(id)
    return { kind: 'written', noteId: 'n-target', created: false, summary: 'ran' }
  },
}))

function Bridge({ owner }: { owner: string | undefined }) {
  useQuickAddBridge(owner)
  return createElement('span')
}

let rendered: RenderedElement

function seed(choices: QuickAddChoice[], enabled = true): void {
  act(() => {
    useQuickAdd.setState({
      choices,
      settings: { ...defaultQuickAddSettings(), enabled },
      hydrated: true,
      owner: 'user-1',
    })
  })
}

function mount(owner: string | undefined = 'user-1'): void {
  rendered = renderElement(createElement(Bridge, { owner }))
}

function settle(): Promise<void> {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function press(combo: 'mod+alt+j' | 'mod+alt+k', target: EventTarget = window): boolean {
  const key = combo.endsWith('j') ? 'j' : 'k'
  const event = new KeyboardEvent('keydown', {
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event.defaultPrevented
}

const WITH_KEY = { ...newTemplateChoice('qa-one', 'Morning', 0), hotkey: 'mod+alt+j' }
const OTHER_KEY = { ...newCaptureChoice('qa-two', 'Evening', 1), hotkey: 'mod+alt+k' }

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  runs.calls = []
  document.body.replaceChildren()
})

afterEach(() => {
  rendered?.unmount()
  useQuickAdd.setState({ choices: [], settings: defaultQuickAddSettings(), hydrated: false, owner: '' })
})

describe('the shell bridge', () => {
  it('loads the account’s library when somebody is signed in', async () => {
    const hydrate = vi.spyOn(useQuickAdd.getState(), 'hydrate').mockResolvedValue(undefined)
    mount()
    await settle()
    expect(hydrate).toHaveBeenCalledWith('user-1')
    hydrate.mockRestore()
  })

  it('does not load anything with nobody signed in', () => {
    const hydrate = vi.spyOn(useQuickAdd.getState(), 'hydrate').mockResolvedValue(undefined)
    // `mount(undefined)` would take the helper's own default, so the prop is set here directly.
    rendered = renderElement(createElement(Bridge, { owner: undefined }))
    expect(hydrate).not.toHaveBeenCalled()
    hydrate.mockRestore()
  })

  it('turns a choice’s shortcut into a key that runs that choice', async () => {
    seed([WITH_KEY, OTHER_KEY])
    mount()
    expect(listHotkeys().map((entry) => entry.id)).toContain('quickadd:qa-one')
    expect(press('mod+alt+j')).toBe(true)
    await settle()
    expect(runs.calls).toEqual(['qa-one'])
  })

  it('reaches the reader while they are typing in the editor', async () => {
    seed([WITH_KEY])
    mount()
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    editor.contentEditable = 'true'
    document.body.append(editor)
    expect(press('mod+alt+j', editor)).toBe(true)
    await settle()
    expect(runs.calls).toEqual(['qa-one'])
  })

  it('binds nothing for a switched-off choice, a group, or a whole feature that is off', () => {
    seed([
      WITH_KEY,
      { ...OTHER_KEY, enabled: false },
      { ...newGroupChoice('qa-group', 'Journal', 2), hotkey: 'mod+alt+k' },
    ])
    mount()
    expect(listHotkeys().map((entry) => entry.id)).toEqual(['quickadd:qa-one'])
  })

  it('binds nothing while QuickAdd itself is switched off', () => {
    seed([WITH_KEY], false)
    mount()
    expect(listHotkeys().map((entry) => entry.id)).not.toContain('quickadd:qa-one')
    expect(press('mod+alt+j')).toBe(false)
  })

  it('lets the first choice in tree order keep a contested shortcut', async () => {
    seed([{ ...WITH_KEY, position: 0 }, { ...OTHER_KEY, hotkey: 'mod+alt+j', position: 1 }])
    mount()
    expect(listHotkeys().filter((entry) => entry.id.startsWith('quickadd:'))).toHaveLength(1)
    press('mod+alt+j')
    await settle()
    expect(runs.calls).toEqual(['qa-one'])
  })

  it('moves the binding when the reader re-keys the choice', async () => {
    seed([WITH_KEY])
    mount()
    seed([{ ...WITH_KEY, hotkey: 'mod+alt+k' }])
    await settle()
    expect(press('mod+alt+j')).toBe(false)
    expect(press('mod+alt+k')).toBe(true)
    await settle()
    expect(runs.calls).toEqual(['qa-one'])
  })

  it('drops the binding when the choice is deleted', () => {
    seed([WITH_KEY])
    mount()
    seed([])
    expect(listHotkeys().map((entry) => entry.id)).not.toContain('quickadd:qa-one')
    expect(press('mod+alt+j')).toBe(false)
  })
})
