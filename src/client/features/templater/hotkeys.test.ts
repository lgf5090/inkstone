/**
 * The reader's template chords, proved from the keystroke to the run.
 *
 * `run-shell.ts` is faked: which action a chord stands for, which template it carries and where a new note
 * is filed are this file's business, and the runs themselves are `run-shell.test.ts`. Keys are sent the way
 * this app receives them — a real `keydown` on `window`, because the one dispatcher for a user chord is the
 * capture listener `lib/hotkeys.ts` puts there. A synthetic event on `document` would never reach a React
 * handler on a focused element, and a hand-made `Event('keydown')` is refused by that listener on purpose.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants'
import type { NoteSummary, NoteTemplate, PublicUser, TemplaterHotkey } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { IS_MAC, hotkeyText, listHotkeys, register } from '../../lib/hotkeys'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import {
  planTemplaterHotkeys,
  templaterChordClaims,
  templaterComboFingerprint,
  useTemplaterHotkeyReport,
  useTemplaterHotkeys,
  type TemplaterHotkeyReport,
} from './hotkeys'

const shell = vi.hoisted(() => ({
  insert: [] as string[],
  create: [] as { template: string; folderId: string | null; title: string }[],
}))

vi.mock('./run-shell', () => ({
  async insertTemplateIntoActiveNote(template: NoteTemplate) {
    shell.insert.push(template.name)
    return true
  },
  async createNoteFromTemplate(template: NoteTemplate, destination: { folderId: string | null; title: string }) {
    shell.create.push({ template: template.name, ...destination })
    return true
  },
}))

/** Chords no table in `lib/shortcuts.ts` or the chat's own list claims, so these cases own them. */
const J = 'mod+alt+j'
const K = 'mod+alt+k'
const BARE = 'k'
const MORNING = template('tpl-morning', 'Morning')
const EVENING = template('tpl-evening', 'Evening')
const USER: PublicUser = {
  id: 'u-chords',
  login: 'chords',
  name: 'Chords',
  avatarUrl: '',
  role: 'owner',
  createdAt: 0,
  username: 'chords',
}

let rendered: RenderedElement | undefined
let captured: TemplaterHotkeyReport | null = null
let hydrateRead: Mock<(owner: string) => Promise<void>>

function template(id: string, name: string): NoteTemplate {
  return {
    id,
    name,
    categoryId: null,
    description: '',
    content: '<% tp.date.now() %>',
    tags: [],
    builtin: false,
    isPinned: false,
    isStarred: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

function chord(templateId: string, combo: string | null, over: Partial<TemplaterHotkey> = {}): TemplaterHotkey {
  return { templateId, combo, insert: false, create: false, ...over }
}

/** Mounts the binding hook, the way `App.tsx` does. */
function mount(): void {
  function Probe() {
    useTemplaterHotkeys()
    return null
  }
  rendered = renderElement(createElement(Probe))
}

/** Mounts the binding hook beside the report hook, the way the settings screen has both live at once. */
function mountWithReport(): void {
  function Probe() {
    useTemplaterHotkeys()
    captured = useTemplaterHotkeyReport()
    return null
  }
  rendered = renderElement(createElement(Probe))
}

function seedTemplates(templates: NoteTemplate[]): void {
  act(() => {
    useNoteTemplates.setState({ hydrated: true, templates })
  })
}

function seedChords(rows: TemplaterHotkey[]): void {
  act(() => {
    useSession.setState({
      status: 'authed',
      user: USER,
      settings: mergeSettings({
        ...DEFAULT_SETTINGS,
        templater: { ...DEFAULT_SETTINGS.templater, templateHotkeys: rows },
      }),
    })
  })
}

/**
 * Sends the keystroke to the dispatcher and waits for the run it started.
 *
 * The handler pulls `run-shell.ts` with a dynamic import, so the call lands a microtask or two later, which
 * is the same settle the QuickAdd bridge's cases wait for. Whether the event was consumed is read after it,
 * because the chord either owns the keystroke or it does not.
 */
async function press(combo: string, target: EventTarget = window): Promise<boolean> {
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]!
  const event = new KeyboardEvent('keydown', {
    key,
    code: /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key,
    ctrlKey: parts.includes('ctrl') || (parts.includes('mod') && !IS_MAC),
    metaKey: parts.includes('meta') || parts.includes('cmd') || (parts.includes('mod') && IS_MAC),
    shiftKey: parts.includes('shift'),
    altKey: parts.includes('alt'),
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    target.dispatchEvent(event)
    await Promise.resolve()
    await Promise.resolve()
  })
  return event.defaultPrevented
}

/** Lets the store read the hook starts settle, so its failure can be asserted. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

function bound(): string[] {
  return listHotkeys()
    .filter((entry) => entry.id.startsWith('templater:'))
    .map((entry) => entry.id)
    .sort()
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  shell.insert = []
  shell.create = []
  captured = null
  document.body.replaceChildren()
  // The library read goes to the account store; these cases seed it directly, so only the fact that the
  // chord hook asked for it is under test here.
  hydrateRead = vi.spyOn(useNoteTemplates.getState(), 'hydrate').mockResolvedValue(undefined)
  useUi.setState({ activeNoteId: null, folderId: null, toasts: [] })
  useNotes.setState({ notes: {} })
  seedTemplates([MORNING, EVENING])
  seedChords([])
})

afterEach(() => {
  rendered?.unmount()
  rendered = undefined
  captured = null
  hydrateRead.mockRestore()
  seedChords([])
  useNoteTemplates.setState({ hydrated: false, templates: [] })
})

describe('a bound template chord', () => {
  it('runs the insert action for the template it names, and nothing else', async () => {
    seedChords([chord('tpl-morning', J, { insert: true })])
    mount()
    expect(bound()).toEqual(['templater:tpl-morning:insert'])
    expect(await press(J)).toBe(true)
    expect(shell.insert).toEqual(['Morning'])
    expect(shell.create).toEqual([])
  })

  it('creates the note in the folder the reader is looking at, which is the chooser’s default', async () => {
    useUi.setState({ activeNoteId: 'n-1' })
    useNotes.setState({ notes: { 'n-1': { id: 'n-1', title: 'Now', folderId: 'f-1', deletedAt: null } as NoteSummary } })
    seedChords([chord('tpl-evening', K, { create: true })])
    mount()
    expect(await press(K)).toBe(true)
    expect(shell.create).toEqual([{ template: 'Evening', folderId: 'f-1', title: '' }])
    expect(shell.insert, 'a create row must not also splice the note that is open').toEqual([])
  })

  it('files the note at the folder being browsed when no note is open', async () => {
    useUi.setState({ folderId: 'f-browse' })
    seedChords([chord('tpl-evening', K, { create: true })])
    mount()
    expect(await press(K)).toBe(true)
    expect(shell.create).toEqual([{ template: 'Evening', folderId: 'f-browse', title: '' }])
  })

  it('names the template it stands for in the shortcut overview', () => {
    seedChords([chord('tpl-morning', J, { insert: true })])
    mount()
    const entry = listHotkeys().find((hotkey) => hotkey.id === 'templater:tpl-morning:insert')!
    expect(hotkeyText(entry.description)).toContain('Morning')
    expect(hotkeyText(entry.description)).toContain(t('templater.cmd.insert'))
    expect(hotkeyText(entry.group)).toBe(t('templater.group'))
  })

  it('reaches the reader while they are typing in the note', async () => {
    seedChords([chord('tpl-morning', J, { insert: true })])
    mount()
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    editor.contentEditable = 'true'
    document.body.append(editor)
    expect(await press(J, editor)).toBe(true)
    expect(shell.insert).toEqual(['Morning'])
  })

  it('binds a bare key, but not so that it eats the letter the reader was typing', async () => {
    seedChords([chord('tpl-morning', BARE, { insert: true })])
    mount()
    expect(bound()).toEqual(['templater:tpl-morning:insert'])
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    editor.contentEditable = 'true'
    document.body.append(editor)
    expect(await press(BARE, editor)).toBe(false)
    expect(shell.insert, 'a lone letter must not take the keystroke away from the note').toEqual([])
    expect(await press(BARE)).toBe(true)
    expect(shell.insert).toEqual(['Morning'])
  })

  it('binds nothing for a row that chose neither action', async () => {
    seedChords([chord('tpl-morning', J)])
    mount()
    expect(bound()).toEqual([])
    expect(await press(J)).toBe(false)
  })

  it('binds nothing for a row that has no chord yet', () => {
    seedChords([chord('tpl-morning', null, { insert: true })])
    mount()
    expect(bound()).toEqual([])
  })
})

describe('the reader’s own edits', () => {
  it('stops answering the key once the row is deleted', async () => {
    seedChords([chord('tpl-morning', J, { insert: true })])
    mount()
    expect(await press(J)).toBe(true)
    seedChords([])
    expect(bound()).toEqual([])
    expect(await press(J)).toBe(false)
    expect(shell.insert, 'the deleted row is not asked for one more run').toEqual(['Morning'])
  })

  it('moves to the new chord when the reader re-keys the row', async () => {
    seedChords([chord('tpl-morning', J, { insert: true })])
    mount()
    seedChords([chord('tpl-morning', K, { insert: true })])
    expect(bound()).toEqual(['templater:tpl-morning:insert'])
    expect(await press(J)).toBe(false)
    expect(await press(K)).toBe(true)
    expect(shell.insert).toEqual(['Morning'])
  })

  it('binds the chord once the library that holds the template has arrived', async () => {
    seedTemplates([])
    seedChords([chord('tpl-morning', J, { insert: true })])
    mount()
    expect(bound()).toEqual([])
    seedTemplates([MORNING])
    expect(await press(J)).toBe(true)
    expect(shell.insert).toEqual(['Morning'])
  })

  it('reads the library itself, so a chord works on the next start and not only after the gallery was opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrateRead.mockRejectedValue(new Error('the library read failed'))
    seedChords([chord('tpl-morning', J, { insert: true })])
    mount()
    await settle()
    expect(hydrateRead).toHaveBeenCalledWith(USER.id)
    expect(warn).toHaveBeenCalled()
    expect(await press(J)).toBe(true)
    expect(shell.insert, 'a library that cannot be re-read leaves the rows already in memory working')
      .toEqual(['Morning'])
    warn.mockRestore()
  })

  it('binds nothing, and says which, when the template has left the library', async () => {
    seedChords([chord('tpl-gone', J, { insert: true, create: true })])
    mountWithReport()
    expect(bound()).toEqual([])
    expect(await press(J)).toBe(false)
    expect(captured?.stale).toEqual(['tpl-gone'])
    expect(captured?.conflicts).toEqual([])
  })

  it('calls a row broken only once the library has actually been read', () => {
    act(() => {
      useNoteTemplates.setState({ hydrated: false, templates: [] })
    })
    seedChords([chord('tpl-morning', J, { insert: true })])
    mountWithReport()
    expect(bound(), 'a template that has not arrived is not a template that was deleted')
      .toEqual([])
    expect(captured?.stale).toEqual([])
  })

  it('unmounts every binding it made', async () => {
    seedChords([chord('tpl-morning', J, { insert: true }), chord('tpl-evening', K, { create: true })])
    mount()
    expect(bound()).toHaveLength(2)
    rendered?.unmount()
    rendered = undefined
    expect(bound()).toEqual([])
    expect(await press(J)).toBe(false)
    expect(await press(K)).toBe(false)
  })
})

describe('a contested chord', () => {
  it('binds insert, the half upstream registers first, and reports the half that lost', async () => {
    seedChords([chord('tpl-morning', J, { insert: true, create: true })])
    mountWithReport()
    expect(bound()).toEqual(['templater:tpl-morning:insert'])
    expect(await press(J)).toBe(true)
    expect(shell.insert).toEqual(['Morning'])
    expect(shell.create, 'one chord is one action: upstream binds the two commands as two chords').toEqual([])
    expect(captured?.conflicts).toEqual([{
      combo: J,
      templateId: 'tpl-morning',
      templateName: 'Morning',
      action: 'create',
      takenBy: 'templater',
      owner: 'templater:tpl-morning:insert',
    }])
  })

  it('leaves a QuickAdd shortcut alone and says that QuickAdd holds the chord', async () => {
    const ran = vi.fn()
    const dispose = register({ id: 'quickadd:qa-one', combo: J, description: 'a choice', group: 'QuickAdd', handler: ran })
    try {
      seedChords([chord('tpl-morning', J, { insert: true })])
      mountWithReport()
      expect(bound()).toEqual([])
      expect(await press(J)).toBe(true)
      expect(ran).toHaveBeenCalledTimes(1)
      expect(shell.insert, 'the chord the reader already gave QuickAdd is not taken back silently').toEqual([])
      expect(captured?.conflicts).toEqual([{
        combo: J,
        templateId: 'tpl-morning',
        templateName: 'Morning',
        action: 'insert',
        takenBy: 'quickadd',
        owner: 'quickadd:qa-one',
      }])
    }
    finally {
      dispose()
    }
  })

  it('says that an app shortcut holds the chord it cannot have', async () => {
    // The command palette's own key, read out of `lib/shortcuts.ts` rather than copied here.
    seedChords([chord('tpl-morning', 'mod+shift+p', { insert: true })])
    mountWithReport()
    expect(bound()).toEqual([])
    expect(await press('mod+shift+p')).toBe(false)
    expect(shell.insert).toEqual([])
    expect(captured?.conflicts[0]).toMatchObject({ combo: 'mod+shift+p', takenBy: 'app', owner: 'shortcut:command' })
  })

  it('lets the first row in list order keep a chord two templates want', async () => {
    seedChords([chord('tpl-morning', J, { insert: true }), chord('tpl-evening', J, { insert: true })])
    mountWithReport()
    expect(bound()).toEqual(['templater:tpl-morning:insert'])
    expect(await press(J)).toBe(true)
    expect(shell.insert).toEqual(['Morning'])
    expect(captured?.conflicts).toEqual([{
      combo: J,
      templateId: 'tpl-evening',
      templateName: 'Evening',
      action: 'insert',
      takenBy: 'templater',
      owner: 'templater:tpl-morning:insert',
    }])
  })

  it('reads a hand-typed spelling as the chord it matches, not as a new one', () => {
    seedChords([chord('tpl-morning', 'Mod+Alt+J', { insert: true }), chord('tpl-evening', 'shift+mod+p', { insert: true })])
    mountWithReport()
    expect(bound(), 'the case a reader types is not a second chord').toEqual(['templater:tpl-morning:insert'])
    expect(captured?.conflicts.map((conflict) => conflict.owner)).toEqual(['shortcut:command'])
  })

  it('never hands one template two bindings, whoever wrote the rows', () => {
    const { bindings, report } = planTemplaterHotkeys(
      [chord('tpl-morning', J, { insert: true }), chord('tpl-morning', K, { insert: true })],
      [MORNING],
      templaterChordClaims(),
    )
    expect(bindings.map((binding) => binding.combo)).toEqual([J])
    expect(report.conflicts).toEqual([])
  })
})

describe('what a chord is, as the app matches it', () => {
  it('treats modifier order, `mod` and the platform key as one keystroke', () => {
    expect(templaterComboFingerprint('shift+mod+p')).toBe(templaterComboFingerprint('mod+shift+p'))
    expect(templaterComboFingerprint('Mod+Shift+P')).toBe(templaterComboFingerprint('mod+shift+p'))
    expect(templaterComboFingerprint('mod+a')).toBe(templaterComboFingerprint(IS_MAC ? 'meta+a' : 'ctrl+a'))
    expect(templaterComboFingerprint('cmd+a')).toBe(templaterComboFingerprint('meta+a'))
    expect(templaterComboFingerprint('shift+esc')).toBe(templaterComboFingerprint('shift+escape'))
  })

  it('keeps a different key, and a key nobody pressed, apart', () => {
    expect(templaterComboFingerprint('mod+j')).not.toBe(templaterComboFingerprint('mod+k'))
    expect(templaterComboFingerprint('mod+')).toBe('')
    expect(templaterComboFingerprint('')).toBe('')
  })
})
