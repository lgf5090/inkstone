import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultQuickAddSettings,
  newCaptureChoice,
  newGroupChoice,
  newMacroChoice,
  newTemplateChoice,
  type QuickAddChoice,
  type QuickAddSettings as QuickAddSettingsModel,
} from '@shared/quickadd'
import type { QuickAddData } from '../../lib/db'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useNoteTemplates } from '../../store/note-templates'
import { useQuickAdd } from '../../store/quickadd'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { QuickAddChoiceEditor } from '../quickadd/choice-editor'
import { QuickAddChoiceList } from '../quickadd/choice-list'
import { QuickAddSettings } from './QuickAddSettings'

const calls = vi.hoisted(() => ({
  runs: [] as string[],
  confirms: [] as string[],
  saved: [] as QuickAddData[],
  toasts: [] as { title: string, tone?: string }[],
}))

vi.mock('../../lib/db', () => ({
  CLIENT_ID: 'this-tab',
  createBroadcast: () => ({ close: () => {} }),
  publishBroadcast: () => {},
  localDb: {
    loadQuickAdd: async () => null,
    saveQuickAdd: async (data: QuickAddData) => { calls.saved.push(data) },
  },
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      quickadd: {
        load: async () => ({ savedAt: 0, library: null }),
        save: async () => ({ savedAt: 1 }),
        fieldValues: async () => [],
      },
    },
  }
})

vi.mock('../../components/overlay', async () => {
  const actual = await vi.importActual<typeof import('../../components/overlay')>('../../components/overlay')
  return {
    ...actual,
    confirm: async (options: { title: string }) => {
      calls.confirms.push(options.title)
      return true
    },
  }
})

vi.mock('../../lib/quickadd/runner', () => ({
  runQuickAddChoice: async (id: string) => {
    calls.runs.push(id)
    return { kind: 'written', noteId: 'n-1', created: false, summary: 'ran' }
  },
}))

/**
 * Names and text in the app's other language: the list, the editor and the launcher all have to sort,
 * filter and echo them back, and `check-i18n.mjs` keeps such data in a named constant because
 * interface copy has to come from the catalog.
 */
const CJK_CHOICE_FIXTURES = {
  inbox: '收集箱',
  macro: '晨间例行',
  group: '日志',
  child: '周记',
  word: '记事',
  dateFormat: 'YYYY年MM月DD日',
  cjkDate: (year: number, month: number, day: number) => `${year}年${String(month).padStart(2, '0')}月${String(day).padStart(2, '0')}日`,
}

let rendered: RenderedElement | undefined

function library(): QuickAddChoice[] {
  return useQuickAdd.getState().choices
}

function seed(over: { choices?: QuickAddChoice[], settings?: Partial<QuickAddSettingsModel> } = {}): void {
  useQuickAdd.setState({
    choices: over.choices ?? [],
    settings: { ...defaultQuickAddSettings(), ...over.settings },
    hydrated: true,
    owner: 'user-1',
    undoable: null,
  })
}

function mount(node: Parameters<typeof createElement>[0]): void {
  rendered?.unmount()
  rendered = renderElement(createElement(node))
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

/**
 * The app labels every control, so a test can look one up by the name a screen reader would read:
 * an `aria-label`, the `<label>` a `Field` wires with `aria-labelledby`, or a button's own text.
 */
function control(name: string): HTMLElement | null {
  const nodes = [...document.querySelectorAll<HTMLElement>('button, input, textarea, select, [aria-label], [aria-labelledby]')]
  return nodes.find((node) => {
    if (node.getAttribute('aria-label') === name) return true
    const labelledBy = node.getAttribute('aria-labelledby')
    if (labelledBy && document.getElementById(labelledBy)?.textContent?.trim() === name) return true
    return node.textContent?.trim() === name
  }) ?? null
}

function click(node: HTMLElement | null): void {
  if (!node) throw new Error('the control is missing')
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function clickNamed(name: string): void {
  click(control(name))
}

function typeInto(node: HTMLElement | null, value: string): void {
  if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement))
    throw new Error('the field is missing')
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function typeNamed(name: string, value: string): void {
  typeInto(control(name), value)
}

function transportBox(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settings.quickadd_transport')}"]`)
}

function settle(): Promise<void> {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  await initI18n()
  calls.runs = []
  calls.confirms = []
  calls.saved = []
  calls.toasts = []
  document.body.replaceChildren()
  useSession.setState({ user: { id: 'user-1', username: 'tester', role: 'owner' } as never })
  useNoteTemplates.setState({ templates: [], hydrated: true, owner: 'user-1', hydrate: async () => {} } as never)
  vi.spyOn(useUi.getState(), 'toast').mockImplementation((input) => {
    calls.toasts.push({ title: input.title, tone: input.tone })
    return 'toast-1'
  })
})

afterEach(() => {
  rendered?.unmount()
  rendered = undefined
  vi.restoreAllMocks()
  seed()
})

describe('the choice list', () => {
  it('shows each choice with a one-line summary of what it does', () => {
    seed({ choices: [
      { ...newCaptureChoice('qa-inbox', CJK_CHOICE_FIXTURES.inbox, 0), targetTitle: 'Inbox' },
      { ...newMacroChoice('qa-macro', CJK_CHOICE_FIXTURES.macro, 1), steps: [{ kind: 'insert', text: 'x' }] },
    ] })
    mount(QuickAddChoiceList)
    expect(bodyText()).toContain(CJK_CHOICE_FIXTURES.inbox)
    expect(bodyText()).toContain(t('quickadd.summary_into', { value0: 'Inbox' }))
    expect(bodyText()).toContain(t('quickadd.summary_steps', { value0: '1' }))
  })

  it('creates a choice of the type asked for and opens its editor', async () => {
    seed()
    mount(QuickAddChoiceList)
    clickNamed(t('quickadd.new_capture_choice'))
    await settle()
    expect(library().map((choice) => choice.type)).toEqual(['capture'])
    expect(bodyText()).toContain(t('quickadd.edit_choice', { value0: library()[0]!.name }))
  })

  it('collapses a group without deleting its children', () => {
    seed({ choices: [
      { ...newGroupChoice('qa-g', CJK_CHOICE_FIXTURES.group, 0), collapsed: false },
      { ...newTemplateChoice('qa-c', CJK_CHOICE_FIXTURES.child, 1), parentId: 'qa-g' },
    ] })
    mount(QuickAddChoiceList)
    expect(bodyText()).toContain(CJK_CHOICE_FIXTURES.child)
    clickNamed(t('quickadd.collapse_group'))
    expect(bodyText()).not.toContain(CJK_CHOICE_FIXTURES.child)
    expect(library()).toHaveLength(2)
    const group = library()[0]
    expect(group?.type === 'group' && group.collapsed).toBe(true)
  })

  it('moves a choice down among its siblings', () => {
    seed({ choices: [newTemplateChoice('qa-a', 'Alpha', 0), newTemplateChoice('qa-b', 'Beta', 1)] })
    mount(QuickAddChoiceList)
    clickNamed(t('quickadd.move_down'))
    expect(order()).toEqual(['Beta', 'Alpha'])
  })

  /** The library is stored in `position` order, so a test has to read it the way the UI does. */
  function order(): string[] {
    return [...library()].sort((a, b) => a.position - b.position).map((choice) => choice.name)
  }

  it('lists a child whose group is gone, so it can still be deleted', () => {
    seed({ choices: [
      newTemplateChoice('qa-ok', 'Kept', 0),
      { ...newTemplateChoice('qa-lost', 'Orphan', 1), parentId: 'qa-gone' },
    ] })
    mount(QuickAddChoiceList)
    expect(bodyText()).toContain('Orphan')
  })

  it('asks before deleting a group and takes its children with it', async () => {
    seed({ choices: [
      newGroupChoice('qa-g', CJK_CHOICE_FIXTURES.group, 0),
      { ...newTemplateChoice('qa-c', CJK_CHOICE_FIXTURES.child, 1), parentId: 'qa-g' },
    ] })
    mount(QuickAddChoiceList)
    clickNamed(t('common.delete'))
    await settle()
    expect(calls.confirms.join('|')).toContain(CJK_CHOICE_FIXTURES.group)
    expect(library()).toEqual([])
  })

  it('runs a choice without opening anything else', async () => {
    seed({ choices: [newTemplateChoice('qa-a', 'Alpha', 0)] })
    mount(QuickAddChoiceList)
    clickNamed(t('quickadd.run_now'))
    await settle()
    expect(calls.runs).toEqual(['qa-a'])
  })
})

describe('the choice editor', () => {
  function editor(choice: QuickAddChoice, onClose: () => void = () => {}): void {
    mount(() => createElement(QuickAddChoiceEditor, { choice, onClose }))
  }

  function macroSteps(): { kind: string }[] {
    const choice = library()[0]!
    return choice.type === 'macro' ? choice.steps : []
  }

  it('saves an edited name and format through the store', async () => {
    const choice = { ...newCaptureChoice('qa-c', CJK_CHOICE_FIXTURES.inbox, 0), targetTitle: 'Inbox' }
    seed({ choices: [choice] })
    editor(choice)
    // The format textarea only exists once "format what is written" is ticked.
    expect(document.querySelector(`textarea[aria-label="${t('quickadd.field_format')}"]`)).toBeNull()
    clickNamed(t('quickadd.field_format'))
    await settle()
    typeNamed(t('quickadd.field_name'), 'Daily capture')
    typeInto(document.querySelector(`textarea[aria-label="${t('quickadd.field_format')}"]`), `{{DATE}} ${CJK_CHOICE_FIXTURES.word}`)
    expect(bodyText()).toContain(CJK_CHOICE_FIXTURES.word)
    clickNamed(t('common.save'))
    await settle()
    const saved = library()[0]!
    expect(saved.name).toBe('Daily capture')
    expect(saved.type === 'capture' && saved.format).toEqual({ enabled: true, format: `{{DATE}} ${CJK_CHOICE_FIXTURES.word}` })
  })

  it('refuses to save an empty name', () => {
    const choice = newTemplateChoice('qa-t', 'Alpha', 0)
    seed({ choices: [choice] })
    editor(choice)
    typeNamed(t('quickadd.field_name'), '   ')
    const save = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === t('common.save'))
    expect(save?.disabled).toBe(true)
  })

  it('normalizes the shortcut, and clears it to nothing', async () => {
    const choice = newTemplateChoice('qa-t', 'Alpha', 0)
    seed({ choices: [choice] })
    editor(choice)
    typeNamed(t('quickadd.field_hotkey'), 'Mod+Alt+M')
    clickNamed(t('common.save'))
    await settle()
    expect(library()[0]!.hotkey).toBe('mod+alt+m')

    const keyed = { ...choice, hotkey: 'mod+alt+m' }
    seed({ choices: [keyed] })
    editor(keyed)
    typeNamed(t('quickadd.field_hotkey'), '')
    clickNamed(t('common.save'))
    await settle()
    expect(library()[0]!.hotkey).toBeNull()
  })

  it('adds, moves and removes macro steps', () => {
    const choice = { ...newMacroChoice('qa-m', 'Routine', 0), steps: [{ kind: 'insert' as const, text: 'one' }] }
    seed({ choices: [choice] })
    editor(choice)
    // The editor works on a draft; the store only learns about it at Save.
    expect(document.querySelectorAll('fieldset')).toHaveLength(1)
    clickNamed(t('quickadd.add_step'))
    expect(document.querySelectorAll('fieldset')).toHaveLength(2)
    clickNamed(t('quickadd.add_step'))
    expect(document.querySelectorAll('fieldset')).toHaveLength(3)
    // The first step cannot move up, so the draft keeps its shape and only the removal changes it.
    clickNamed(t('quickadd.move_step_up'))
    expect(document.querySelectorAll('fieldset')).toHaveLength(3)
    clickNamed(t('quickadd.remove_step'))
    expect(document.querySelectorAll('fieldset')).toHaveLength(2)
    clickNamed(t('common.save'))
    expect(macroSteps()).toHaveLength(2)
  })

  it('offers the token list without leaving the editor', () => {
    const choice = newTemplateChoice('qa-t', 'Alpha', 0)
    seed({ choices: [choice] })
    editor(choice)
    expect(bodyText()).not.toContain('{{MVALUE}}')
    clickNamed(t('quickadd.show_token_help'))
    expect(bodyText()).toContain('{{MVALUE}}')
    expect(bodyText()).toContain(t('quickadd.help_mvalue'))
  })
})

describe('the automation page', () => {
  it('writes the master switch and the date format through the store', () => {
    seed()
    mount(QuickAddSettings)
    click(control(t('settings.quickadd_enabled')))
    expect(useQuickAdd.getState().settings.enabled).toBe(false)
    typeNamed(t('settings.quickadd_date_format'), CJK_CHOICE_FIXTURES.dateFormat)
    expect(useQuickAdd.getState().settings.dateFormat).toBe(CJK_CHOICE_FIXTURES.dateFormat)
    // The hint under the row shows today through that format; the expectation is built here, not by
    // calling the formatter the page is under test for.
    const today = new Date()
    expect(bodyText()).toContain(CJK_CHOICE_FIXTURES.cjkDate(today.getFullYear(), today.getMonth() + 1, today.getDate()))
    // The cancellation notice is off until asked for, and the row is what turns it on.
    expect(useQuickAdd.getState().settings.cancelNotice).toBe(false)
    click(control(t('settings.quickadd_cancel_notice')))
    expect(useQuickAdd.getState().settings.cancelNotice).toBe(true)
    click(control(t('settings.quickadd_cancel_notice')))
    expect(useQuickAdd.getState().settings.cancelNotice).toBe(false)
  })

  it('adds, edits and removes a global variable', () => {
    seed({ settings: { globalVars: [{ name: 'greeting', value: 'Hello' }] } })
    mount(QuickAddSettings)
    // The stored name is data the author chose, not a field to type into: it is shown, and the value
    // is what gets edited.
    expect(bodyText()).toContain('greeting')
    typeNamed(`${t('quickadd.var_value')} 1`, 'Good morning')
    expect(useQuickAdd.getState().settings.globalVars[0]?.value).toBe('Good morning')

    // The draft row refuses a name the library would drop, which is a name already taken (any case).
    typeNamed(t('quickadd.var_name'), 'Greeting')
    expect(bodyText()).toContain(t('settings.quickadd_var_taken'))
    expect(addVarButton().disabled).toBe(true)

    typeNamed(t('quickadd.var_name'), 'sign-off')
    typeNamed(t('quickadd.var_value'), 'Bye')
    clickNamed(t('settings.quickadd_add_var'))
    expect(useQuickAdd.getState().settings.globalVars.map((entry) => entry.name)).toEqual(['greeting', 'sign-off'])

    click(control(t('common.delete')))
    expect(useQuickAdd.getState().settings.globalVars.map((entry) => entry.name)).toEqual(['sign-off'])
  })

  function addVarButton(): HTMLButtonElement {
    const node = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(t('settings.quickadd_add_var')))
    if (!(node instanceof HTMLButtonElement)) throw new Error('the add-variable button is missing')
    return node
  }

  it('edits where the periodic notes live and which template they use', () => {
    seed()
    useNoteTemplates.setState({ templates: [{ id: 'tpl-1', name: 'Daily page' } as never], hydrate: async () => {} } as never)
    mount(QuickAddSettings)
    typeNamed(`${t('quickadd.period_format')} daily`, 'YYYY/[W]ww')
    expect(useQuickAdd.getState().settings.periodic.daily.format).toBe('YYYY/[W]ww')
    expect(bodyText()).toContain('Daily page')
  })

  it('imports a library into the existing one and reports the count', async () => {
    seed({ choices: [newTemplateChoice('qa-old', 'Old', 0)] })
    const payload = JSON.stringify({
      version: 1,
      settings: defaultQuickAddSettings(),
      choices: [{ ...newTemplateChoice('qa-new', 'New', 5), id: 'other-id' }],
    })
    mount(QuickAddSettings)
    typeInto(transportBox(), payload)
    clickNamed(t('quickadd.import'))
    await settle()
    expect(library().map((choice) => choice.name).sort()).toEqual(['New', 'Old'])
    expect(calls.toasts.at(-1)?.title).toContain('1')
  })

  it('says so when the pasted library cannot be read', async () => {
    seed()
    mount(QuickAddSettings)
    typeInto(transportBox(), 'not json at all')
    clickNamed(t('quickadd.import'))
    await settle()
    expect(calls.toasts.at(-1)).toEqual({ title: t('quickadd.import_unreadable'), tone: 'danger' })
    expect(library()).toEqual([])
  })

  it('exports the current library into the box', () => {
    seed({ choices: [newTemplateChoice('qa-a', 'Alpha', 0)] })
    mount(QuickAddSettings)
    clickNamed(t('quickadd.export'))
    expect(transportBox()?.value).toContain('"Alpha"')
  })
})
