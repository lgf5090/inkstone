import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultQuickAddSettings,
  newCaptureChoice,
  newGroupChoice,
  newMacroChoice,
  newTemplateChoice,
  type QuickAddChoice,
  type QuickAddSettings,
} from '@shared/quickadd'
import { initI18n, t } from '../../lib/i18n'
import { listHotkeys } from '../../lib/hotkeys'
import { STARTUP_STAMP_KEY, resetStartupSession, startupDay } from '../../lib/quickadd/startup'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useQuickAdd } from '../../store/quickadd'
import { useUi } from '../../store/ui'
import { useQuickAddBridge } from './bridge'

const runs = vi.hoisted(() => ({ calls: [] as string[], throws: [] as string[] }))

vi.mock('../../lib/quickadd/runner', () => ({
  runQuickAddChoice: async (id: string) => {
    runs.calls.push(id)
    if (runs.throws.includes(id)) throw new Error(`the ${id} script blew up`)
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
const MORNING_ROUTINE = { ...newMacroChoice('qa-mac', 'Morning routine', 0), runOnStartup: true }
const EVENING_REVIEW = { ...newMacroChoice('qa-eve', 'Evening review', 1), runOnStartup: true }
const notesWereHydrated = useNotes.getState().hydrated

function seedStartup(over: Partial<QuickAddSettings> = {}, choices: QuickAddChoice[] = [MORNING_ROUTINE], notesReady = true): void {
  act(() => {
    useNotes.setState({ hydrated: notesReady })
    useQuickAdd.setState({
      choices,
      settings: { ...defaultQuickAddSettings(), ...over },
      hydrated: true,
      owner: 'user-1',
    })
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  runs.calls = []
  runs.throws = []
  resetStartupSession()
  localStorage.clear()
  document.body.replaceChildren()
})

afterEach(() => {
  rendered?.unmount()
  useQuickAdd.setState({ choices: [], settings: defaultQuickAddSettings(), hydrated: false, owner: '' })
  useNotes.setState({ hydrated: notesWereHydrated })
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

describe('the startup macros', () => {
  it('run the flagged ones in list order once the library and the notes have loaded', async () => {
    seedStartup({}, [EVENING_REVIEW, MORNING_ROUTINE])
    mount()
    await settle()
    expect(runs.calls, 'the list position decides, not the array order it was stored in').toEqual(['qa-mac', 'qa-eve'])
  })

  it('leave a macro alone unless it asked to run at startup', async () => {
    seedStartup({}, [{ ...MORNING_ROUTINE, runOnStartup: false }, { ...EVENING_REVIEW, enabled: false }])
    mount()
    await settle()
    expect(runs.calls).toEqual([])
  })

  it('wait for the notes, or a capture would file a second copy of a note it cannot see', async () => {
    seedStartup({}, [MORNING_ROUTINE], false)
    mount()
    await settle()
    expect(runs.calls).toEqual([])
    act(() => { useNotes.setState({ hydrated: true }) })
    await settle()
    expect(runs.calls).toEqual(['qa-mac'])
  })

  it('never fire twice while the library settles', async () => {
    seedStartup()
    mount()
    await settle()
    seedStartup({}, [MORNING_ROUTINE, { ...newTemplateChoice('qa-late', 'Late', 2) }])
    await settle()
    expect(runs.calls, 'the shell re-renders as the account loads; one run is one run').toEqual(['qa-mac'])
  })

  it('keep going when one of them throws, and say which one stopped', async () => {
    const toasts = vi.spyOn(useUi.getState(), 'toast').mockImplementation(() => 'toast-1')
    runs.throws = ['qa-eve']
    seedStartup({}, [EVENING_REVIEW, MORNING_ROUTINE])
    mount()
    await settle()
    expect(runs.calls).toEqual(['qa-mac', 'qa-eve'])
    expect(toasts).toHaveBeenCalledTimes(1)
    const notice = toasts.mock.calls[0]?.[0]
    expect(notice?.title).toBe(t('quickadd.startup_failed', { name: EVENING_REVIEW.name }))
    expect(notice?.tone).toBe('danger')
    toasts.mockRestore()
  })

  it('run nothing when QuickAdd itself is switched off', async () => {
    seedStartup({ enabled: false })
    mount()
    await settle()
    expect(runs.calls).toEqual([])
  })

  it('honour the day stamp per macro across a reload, and forget it the next day', async () => {
    seedStartup({}, [EVENING_REVIEW, MORNING_ROUTINE])
    mount()
    await settle()
    expect(runs.calls).toEqual(['qa-mac', 'qa-eve'])
    const stored = JSON.parse(localStorage.getItem(STARTUP_STAMP_KEY) ?? '{}') as Record<string, string>
    expect(Object.keys(stored).sort()).toEqual(['qa-eve', 'qa-mac'])

    resetStartupSession()
    rendered.unmount()
    mount()
    await settle()
    expect(runs.calls, 'a second load on the same day files nothing twice').toEqual(['qa-mac', 'qa-eve'])

    localStorage.setItem(STARTUP_STAMP_KEY, JSON.stringify({ 'qa-mac': startupDay(new Date()) }))
    resetStartupSession()
    rendered.unmount()
    mount()
    await settle()
    expect(runs.calls, 'the macro without today’s stamp runs again').toEqual(['qa-mac', 'qa-eve', 'qa-eve'])
  })

  it('fire on every load once the reader asks for the session scope', async () => {
    seedStartup({ startupScope: 'session' })
    mount()
    await settle()
    resetStartupSession()
    rendered.unmount()
    mount()
    await settle()
    expect(runs.calls).toEqual(['qa-mac', 'qa-mac'])
  })
})
