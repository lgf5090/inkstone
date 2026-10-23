/**
 * The Templater settings page as a surface, not as a type.
 *
 * The store is real here: every click is put through `mergeSettingsPatch`, the same function the settings
 * route runs before it answers, so a control that writes a shape the normaliser drops shows up as a missing
 * expectation rather than as a green test. The two device-only switches are checked against `localStorage`
 * because that is where they live, and the confirmation is mocked because the dialog it stands for has its own
 * focus test in `components/overlay`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder, NoteTemplate, PublicUser, UserSettings } from '@shared/types'
import { DEFAULT_SETTINGS, mergeSettingsPatch } from '@shared/constants'
import { initI18n, t } from '../../lib/i18n'
import { preloadPinyin } from '../../lib/pinyin'
import { clearTemplaterDevicePrefs, loadTemplaterDevicePrefs, templaterDevicePrefsKey } from '../../lib/templater/device-prefs'
import { useNotes } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { TemplaterSettings } from './TemplaterSettings'

const confirmMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../../components/overlay', async (original) => ({
  ...(await original<typeof import('../../components/overlay')>()),
  confirm: confirmMock,
}))

// The chord list reads the editor keymap lazily, exactly as the shipped page does; one entry is enough to
// prove the claims arrive, and it is a real one: the palette's own cursor chord.
vi.mock('../../editor/shortcuts', () => ({
  EDITOR_SHORTCUTS: [{ id: 'jump-up', combo: 'mod+shift+arrowup', label: 'common.bold', run: () => {} }],
}))

const USER: PublicUser = {
  id: 'u-settings', login: 's', name: 'S', avatarUrl: '', role: 'owner', createdAt: 0, username: 's',
}
const JOURNAL: Folder = { id: 'f-journal', name: 'Journal', parentId: null } as Folder
const SCRIPTS: Folder = { id: 'f-scripts', name: 'Scripts', parentId: null } as Folder

function template(id: string, name: string): NoteTemplate {
  return {
    id, name, categoryId: null, description: '', content: '<% tp.date.now() %>', tags: [],
    builtin: false, isPinned: false, isStarred: false, createdAt: 1, updatedAt: 1,
  } as NoteTemplate
}

let root: Root
let container: HTMLDivElement
const initialSession = useSession.getState()
const initialNotes = useNotes.getState()
const initialLibrary = useNoteTemplates.getState()

function settings(): UserSettings {
  return useSession.getState().settings
}

async function render() {
  await act(async () => {
    root.render(createElement(TemplaterSettings))
    await flush()
  })
}

async function rerender() {
  await act(async () => {
    await flush()
  })
}

function row(title: string): HTMLElement {
  const match = container.querySelector<HTMLElement>(`[data-setting-title="${title}"]`)
  if (!match) throw new Error(`no settings row named ${title}`)
  return match
}

/** The control beside a row: the row's own block holds it as the last element. */
function controlIn(title: string): HTMLElement {
  const field = row(title).lastElementChild
  const control = field?.querySelector<HTMLElement>('button, select, input') ?? null
  if (!control) throw new Error(`row ${title} holds no control`)
  return control
}

function switchFor(title: string): HTMLButtonElement {
  return controlIn(title) as HTMLButtonElement
}

function selectFor(title: string): HTMLSelectElement {
  return controlIn(title) as HTMLSelectElement
}

async function choose(title: string, value: string) {
  const select = selectFor(title)
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
  })
}

/**
 * Drain what a click started.
 *
 * `confirm()` answers on a later tick than the keystroke that raised it, so a test that only yields one
 * microtask asserts against a dialog that has not been answered yet — green for a component that writes
 * regardless. A timer outlasts whichever promise chain the handler is on.
 */
const flush = () => new Promise<void>((resolve) => {
  setTimeout(resolve, 0)
})

async function toggle(title: string) {
  await act(async () => {
    switchFor(title).click()
    await flush()
  })
}

async function clickByText(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`no button labelled ${text}`)
  await act(async () => {
    button.click()
    await flush()
  })
}

/** The add button of one rule list: it is that row's own control, so it cannot be confused with the other. */
async function addRule(title: string) {
  await act(async () => {
    controlIn(title).click()
    await flush()
  })
}

/**
 * A keystroke, the way React reads one.
 *
 * Assigning `.value` moves the DOM without touching the tracker React compares against, so the `input` event
 * below would arrive with a value React already believes it saw and no `onChange` runs.
 */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
  })
}

function groupRows(label: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="group"]')]
    .filter((node) => node.getAttribute('aria-label') === label)
}

/** One template's row: its own group, so a tick cannot land on the template the test did not name. */
function templateRow(name: string): HTMLElement {
  const match = container.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`)
  if (!match) throw new Error(`no chord row for ${name}`)
  return match
}

function checkboxIn(name: string, label: string): HTMLButtonElement {
  const match = [...templateRow(name).querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
    .find((node) => node.textContent?.includes(label))
  if (!match) throw new Error(`no ${label} checkbox in the ${name} row`)
  return match
}

beforeAll(async () => {
  await initI18n()
  await preloadPinyin()
})

beforeEach(async () => {
  localStorage.clear()
  // The prefs module keeps one cache per account on purpose, and a test that only clears `localStorage`
  // reads the previous test's answer back out of it: the switch looks armed, the click counts as turning
  // it off, and the confirmation this file is about is never reached.
  clearTemplaterDevicePrefs(USER.id)
  clearTemplaterDevicePrefs('someone-else')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(true)
  Element.prototype.scrollIntoView = vi.fn()
  useSession.setState({
    status: 'authed',
    user: USER,
    settings: { ...DEFAULT_SETTINGS, templater: { ...DEFAULT_SETTINGS.templater } },
    updateSettings: (patch) => {
      // The real merge, so the panel is tested against the rules the server applies to the same blob.
      useSession.setState({ settings: mergeSettingsPatch(useSession.getState().settings, patch) })
    },
  })
  useNotes.setState({ folders: [JOURNAL, SCRIPTS], notes: {}, contents: {} })
  useNoteTemplates.setState({
    templates: [template('t-daily', 'Daily'), template('t-welcome', 'Welcome')],
    categories: [],
    hydrated: true,
    hydrate: vi.fn(async () => {}),
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await render()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useSession.setState(initialSession)
  useNotes.setState(initialNotes)
  useNoteTemplates.setState(initialLibrary)
})

describe('the editing switches', () => {
  it('writes one switch without disturbing the rest of the section', async () => {
    await toggle(t('settings.templater_highlight'))
    expect(settings().templater.syntaxHighlighting).toBe(false)
    expect(settings().templater.syntaxHighlightingMobile).toBe(DEFAULT_SETTINGS.templater.syntaxHighlightingMobile)
    expect(settings().templater.communityScriptPolicy).toBe(DEFAULT_SETTINGS.templater.communityScriptPolicy)
  })

  it('stores the documentation level the reader chose', async () => {
    await choose(t('settings.templater_intellisense'), '3')
    expect(settings().templater.intellisenseRender).toBe('3')
  })
})

describe('the trigger lists', () => {
  it('shows the rule lists only once a mode is chosen', async () => {
    expect(groupRows(t('settings.templater_folder_triggers'))).toHaveLength(0)
    await choose(t('settings.templater_creation_mode'), 'folder')
    expect(settings().templater.fileCreationMode).toBe('folder')
    expect(groupRows(t('settings.templater_folder_triggers'))).toHaveLength(0)
    await addRule(t('settings.templater_folder_triggers'))
    expect(groupRows(t('settings.templater_folder_triggers'))).toHaveLength(1)
  })

  it('adds a folder rule, keeps the folder the list names, and deletes it again', async () => {
    await choose(t('settings.templater_creation_mode'), 'folder')
    await addRule(t('settings.templater_folder_triggers'))
    expect(settings().templater.folderTemplates).toHaveLength(1)
    const selects = [...groupRows(t('settings.templater_folder_triggers'))[0]!.querySelectorAll<HTMLSelectElement>('select')]
    await act(async () => {
      selects[0]!.value = JOURNAL.id
      selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
      selects[1]!.value = 't-welcome'
      selects[1]!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(settings().templater.folderTemplates).toEqual([{ folderId: JOURNAL.id, templateId: 't-welcome' }])
    await act(async () => {
      groupRows(t('settings.templater_folder_triggers'))[0]!
        .querySelector<HTMLButtonElement>('button')!
        .click()
      await Promise.resolve()
    })
    expect(settings().templater.folderTemplates).toEqual([])
  })

  it('offers the library root as a choice and stores it as null', async () => {
    await choose(t('settings.templater_creation_mode'), 'folder')
    await addRule(t('settings.templater_folder_triggers'))
    const selects = [...groupRows(t('settings.templater_folder_triggers'))[0]!.querySelectorAll<HTMLSelectElement>('select')]
    expect(selects[0]!.options[0]!.textContent).toBe(t('templater.trigger.root'))
    expect(settings().templater.folderTemplates[0]!.folderId).toBe(JOURNAL.id)
    await act(async () => {
      selects[0]!.value = ''
      selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(settings().templater.folderTemplates).toEqual([{ folderId: null, templateId: 't-daily' }])
  })

  it('says so when a pattern can never match', async () => {
    await choose(t('settings.templater_creation_mode'), 'regex')
    await addRule(t('settings.templater_regex_triggers'))
    const input = groupRows(t('settings.templater_regex_triggers'))[0]!.querySelector<HTMLInputElement>('input')!
    await typeInto(input, '([unclosed')
    expect(container.textContent).toContain(t('templater.trigger.regex_invalid'))
    expect(settings().templater.fileTemplates[0]!.regex).toBe('([unclosed')
  })

  it('keeps an ignored folder out of the picker and lets the reader take it back out', async () => {
    await choose(t('settings.templater_creation_mode'), 'folder')
    useSession.setState({
      settings: mergeSettingsPatch(settings(), { templater: { ignoreFoldersOnCreation: [JOURNAL.id] } }),
    })
    await rerender()
    expect(row(t('settings.templater_ignored_folders')).textContent).toContain(JOURNAL.name)
    const picker = [...container.querySelectorAll<HTMLSelectElement>('select')]
      .find((select) => select.getAttribute('aria-label') === t('templater.ignored.add'))!
    // Already ignored, so already out of the choices: picking it again could only produce a repeat the
    // normaliser would drop, and a control that offers a value it will not keep is the trap this avoids.
    expect([...picker.options].map((option) => option.value)).not.toContain(JOURNAL.id)
    await act(async () => {
      picker.value = SCRIPTS.id
      picker.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await clickByText(t('templater.ignored.add'))
    expect(settings().templater.ignoreFoldersOnCreation).toEqual([JOURNAL.id, SCRIPTS.id])
    await act(async () => {
      row(t('settings.templater_ignored_folders'))
        .querySelector<HTMLButtonElement>(`button[aria-label="${t('templater.ignored.remove')}"]`)!
        .click()
      await Promise.resolve()
    })
    expect(settings().templater.ignoreFoldersOnCreation).toEqual([SCRIPTS.id])
  })
})

describe('the two device-only switches', () => {
  it('arms the new-note trigger on this device only, after the question', async () => {
    await toggle(t('settings.templater_device_trigger'))
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(loadTemplaterDevicePrefs(USER.id).triggerOnFileCreation).toBe(true)
    expect(localStorage.getItem(templaterDevicePrefsKey(USER.id))).toContain('"triggerOnFileCreation":true')
    expect(settings().templater).toEqual(DEFAULT_SETTINGS.templater)
  })

  it('leaves the switch off when the reader says no', async () => {
    confirmMock.mockResolvedValueOnce(false)
    await toggle(t('settings.templater_device_trigger'))
    expect(loadTemplaterDevicePrefs(USER.id).triggerOnFileCreation).toBe(false)
    expect(switchFor(t('settings.templater_device_trigger')).getAttribute('aria-checked')).toBe('false')
  })

  it('turns a device answer off without asking', async () => {
    await toggle(t('settings.templater_device_trigger'))
    confirmMock.mockClear()
    await toggle(t('settings.templater_device_trigger'))
    expect(confirmMock).not.toHaveBeenCalled()
    expect(loadTemplaterDevicePrefs(USER.id).triggerOnFileCreation).toBe(false)
  })

  it('keys the startup answer to the account, not to the device', async () => {
    await toggle(t('settings.templater_device_startup'))
    expect(loadTemplaterDevicePrefs(USER.id).enableStartupTemplates).toBe(true)
    expect(loadTemplaterDevicePrefs('someone-else').enableStartupTemplates).toBe(false)
  })

  it('will not hand the gallery the reader’s scripts until the confirmation is answered yes', async () => {
    await choose(t('settings.templater_script_policy'), 'trusted')
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(settings().templater.communityScriptPolicy).toBe('trusted')
  })

  it('puts the policy box back to the stored answer when the reader says no', async () => {
    confirmMock.mockResolvedValueOnce(false)
    await choose(t('settings.templater_script_policy'), 'trusted')
    expect(settings().templater.communityScriptPolicy).toBe('readonly')
    expect(selectFor(t('settings.templater_script_policy')).value).toBe('readonly')
  })
})

describe('the startup list', () => {
  it('adds and removes a startup template', async () => {
    const picker = [...container.querySelectorAll<HTMLSelectElement>('select')]
      .find((select) => select.getAttribute('aria-label') === t('templater.startup.choose'))!
    await act(async () => {
      picker.value = 't-welcome'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await clickByText(t('templater.startup.add'))
    expect(settings().templater.startupTemplates).toEqual(['t-welcome'])
    expect(container.textContent).not.toContain(t('templater.startup.gone', { value0: '1' }))
    await act(async () => {
      groupRows(t('settings.templater_startup'))[0]!.querySelector<HTMLButtonElement>('button')!.click()
      await Promise.resolve()
    })
    expect(settings().templater.startupTemplates).toEqual([])
  })

  it('names the rows whose template has left the library', async () => {
    useSession.setState({
      settings: mergeSettingsPatch(settings(), { templater: { startupTemplates: ['t-gone'] } }),
    })
    await rerender()
    expect(container.textContent).toContain(t('templater.startup.gone', { value0: '1' }))
  })
})

describe('the chord list', () => {
  function chordBox(name: string): HTMLInputElement {
    const match = [...container.querySelectorAll<HTMLInputElement>('input')]
      .find((input) => input.getAttribute('aria-label') === `${t('templater.hotkey.chord')} ${name}`)
    if (!match) throw new Error(`no chord box for ${name}`)
    return match
  }

  async function typeChord(name: string, combo: string) {
    await typeInto(chordBox(name), combo)
  }

  it('stores a chord only once it has something to bind', async () => {
    await typeChord('Daily', 'ctrl+alt+d')
    expect(settings().templater.templateHotkeys).toEqual([
      { templateId: 't-daily', combo: 'ctrl+alt+d', insert: false, create: false },
    ])
    await typeChord('Daily', '')
    expect(settings().templater.templateHotkeys).toEqual([])
  })

  it('normalises the chord the way the rest of the app spells one', async () => {
    await typeChord('Daily', 'Ctrl+Alt+D')
    expect(settings().templater.templateHotkeys[0]!.combo).toBe('ctrl+alt+d')
  })

  it('keeps the two actions of a template apart', async () => {
    await typeChord('Daily', 'ctrl+alt+d')
    await act(async () => {
      checkboxIn('Daily', t('templater.hotkey.insert')).click()
      await Promise.resolve()
    })
    expect(settings().templater.templateHotkeys[0]).toMatchObject({ insert: true, create: false })
  })

  it('names the app command that already holds a chord, and says the template cannot have it', async () => {
    await typeChord('Daily', 'mod+shift+o')
    await act(async () => {
      checkboxIn('Daily', t('templater.hotkey.insert')).click()
      await Promise.resolve()
    })
    expect(templateRow('Daily').textContent).toContain(t('templater.hotkey.by_app'))
  })

  it('says a chord taken from the editor is won, not refused', async () => {
    // The editor keymap is the one claim list the runtime never consults, so this is the one case where
    // promising the reader they cannot have the chord would be a lie: measured in a real browser, the
    // template fires and the editor command stops. The panel has to say which of the two outcomes the
    // reader is choosing.
    await typeChord('Daily', 'mod+shift+arrowup')
    await act(async () => {
      checkboxIn('Daily', t('templater.hotkey.insert')).click()
      await Promise.resolve()
    })
    const row = templateRow('Daily').textContent ?? ''
    expect(row).toContain(t('templater.hotkey.editor_chord', {
      value0: 'mod+shift+arrowup',
      value1: t('templater.hotkey.by_editor'),
    }))
    expect(row, 'an editor chord is not a refusal').not.toContain(t('templater.hotkey.by_app'))
  })

  it('tells the later row, not the first, that a chord is taken', async () => {
    await typeChord('Daily', 'ctrl+alt+d')
    await act(async () => {
      checkboxIn('Daily', t('templater.hotkey.insert')).click()
      await Promise.resolve()
    })
    await typeChord('Welcome', 'ctrl+alt+d')
    await act(async () => {
      checkboxIn('Welcome', t('templater.hotkey.create')).click()
      await Promise.resolve()
    })
    // Insert is claimed first, the way upstream registers the two commands, so the row that lost is Welcome.
    expect(templateRow('Welcome').textContent).toContain(t('templater.hotkey.by_other_row'))
    expect(templateRow('Daily').textContent).not.toContain(t('templater.hotkey.by_other_row'))
  })

  it('says which rows point at a template that is gone', async () => {
    useSession.setState({
      settings: mergeSettingsPatch(settings(), {
        templater: { templateHotkeys: [{ templateId: 't-gone', combo: 'ctrl+alt+g', insert: true, create: false }] },
      }),
    })
    await rerender()
    expect(container.textContent).toContain(t('templater.hotkey.stale', { value0: '1' }))
  })

  it('stops the list where scanning stops working and points at the filter', async () => {
    const many = Array.from({ length: 30 }, (_, index) => template(`t-many-${index}`, `Bulk ${String(index).padStart(2, '0')}`))
    useNoteTemplates.setState({ templates: many, categories: [], hydrated: true, hydrate: vi.fn(async () => {}) })
    await rerender()
    expect(container.querySelectorAll('[role="group"][aria-label^="Bulk "]')).toHaveLength(25)
    expect(container.textContent).toContain(t('templater.hotkey.more', { value0: '5' }))
  })

  it('filters the list without touching the stored chords', async () => {    await typeChord('Daily', 'ctrl+alt+d')
    const before = settings().templater.templateHotkeys
    const box = container.querySelector<HTMLInputElement>(`input[aria-label="${t('templater.hotkey.filter')}"]`)!
    await typeInto(box, 'Welc')
    const names = [...container.querySelectorAll('[role="group"]')].map((node) => node.textContent).join(' ')
    expect(names).toContain('Welcome')
    expect(names).not.toContain('Daily')
    expect(settings().templater.templateHotkeys).toEqual(before)
  })
})

describe('the script folder', () => {
  it('stores the chosen folder and the answer that means no scripts', async () => {
    await choose(t('settings.templater_script_folder'), SCRIPTS.id)
    expect(settings().templater.userScriptsFolderId).toBe(SCRIPTS.id)
    await choose(t('settings.templater_script_folder'), '')
    expect(settings().templater.userScriptsFolderId).toBeNull()
  })
})
