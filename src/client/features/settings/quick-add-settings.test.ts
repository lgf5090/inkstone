import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORGANIZER_COLORS,
} from '@shared/organizer-colors'
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

function selectNamed(name: string, value: string): void {
  const node = control(name)
  if (!(node instanceof HTMLSelectElement)) throw new Error(`no select named "${name}"`)
  act(() => {
    node.value = value
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
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
  useNoteTemplates.setState({ templates: [], categories: [], hydrated: true, owner: 'user-1', hydrate: async () => {} } as never)
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

  it('gives every row the same action slots, so the switches line up', () => {
    seed({ choices: [newGroupChoice('qa-g', 'Outer', 0), newTemplateChoice('qa-t', 'Leaf', 1)] })
    mount(QuickAddChoiceList)
    const rows = [...document.querySelectorAll('li')]
    expect(rows).toHaveLength(2)
    // The switch sits left of the action cluster, so its column only holds still while every row
    // reserves the same slots — a group keeps an empty one where the run button would be.
    const slots = rows.map((row) => row.querySelector('div')?.childElementCount)
    expect(slots).toEqual([6, 6])
  })

  it('keeps the header’s icon beside its label instead of above it', () => {
    seed({ choices: [] })
    mount(QuickAddChoiceList)
    const add = control(t('quickadd.new_template_choice'))
    expect(add).not.toBeNull()
    expect(add?.firstElementChild?.tagName.toLowerCase(), 'the glyph has to be a flex child of the button').toBe('svg')
    expect(add?.textContent?.trim()).toBe(t('quickadd.new_template_choice'))
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

  it('lets any choice be placed inside a group from its own editor', async () => {
    const group = newGroupChoice('qa-g', 'Work', 0)
    const capture = { ...newCaptureChoice('qa-c', 'Meeting', 0), targetTitle: 'Inbox' }
    seed({ choices: [group, capture] })
    editor(capture)
    selectNamed(t('quickadd.field_parent'), 'qa-g')
    clickNamed(t('common.save'))
    await settle()
    expect(library().find((choice) => choice.id === 'qa-c')?.parentId).toBe('qa-g')
  })

  it('does not offer a group the choices inside it', () => {
    const outer = newGroupChoice('qa-outer', 'Outer', 0)
    const inner = { ...newGroupChoice('qa-inner', 'Inner', 0), parentId: 'qa-outer' }
    seed({ choices: [outer, inner] })
    editor(outer)
    const select = control(t('quickadd.field_parent'))
    expect(select).toBeInstanceOf(HTMLSelectElement)
    const values = [...(select as HTMLSelectElement).options].map((option) => option.value)
    expect(values).toContain('')
    expect(values, 'a group cannot live inside its own contents').not.toContain('qa-inner')
  })

  function colourGroup(): HTMLDivElement | null {
    return document.querySelector<HTMLDivElement>(`[role="group"][aria-label="${t('quickadd.field_color')}"]`)
  }

  it('paints the palette as colours, not as their hex codes', async () => {
    seed({ choices: [newTemplateChoice('qa-t', 'Alpha', 0)] })
    editor(library()[0]!)
    const group = colourGroup()
    expect(group).not.toBeNull()
    const swatches = [...group!.querySelectorAll('button')]
    expect(swatches).toHaveLength(ORGANIZER_COLORS.length + 1)
    for (const swatch of swatches.slice(1)) {
      expect(swatch.textContent, 'a swatch must not print its own value').toBe('')
      expect(swatch.getAttribute('aria-label') ?? '').not.toMatch(/^#/)
    }
    expect(swatches[0].getAttribute('aria-label')).toBe(t('quickadd.color_none'))
    click(swatches[3])
    await settle()
    clickNamed(t('common.save'))
    await settle()
    expect(library()[0]!.color).toBe(ORGANIZER_COLORS[2])
  })

  it('keeps the step list’s add button on one line', () => {
    const choice = newMacroChoice('qa-m', 'Routine', 0)
    seed({ choices: [choice] })
    editor(choice)
    const add = control(t('quickadd.add_step'))
    expect(add?.firstElementChild?.tagName.toLowerCase()).toBe('svg')
    expect(add?.textContent?.trim()).toBe(t('quickadd.add_step'))
  })

  it('retires the fixed template row once the run is told to ask', async () => {
    const choice = newTemplateChoice('qa-t', 'Alpha', 0)
    seed({ choices: [choice] })
    editor(choice)
    const templateSelect = () => document.querySelector(`select[aria-label="${t('quickadd.field_template')}"]`)
    expect(templateSelect()).not.toBeNull()
    selectNamed(t('quickadd.field_template_pick'), 'ask')
    expect(templateSelect(), 'the named template is not used when the run asks').toBeNull()
    clickNamed(t('common.save'))
    await settle()
    const saved = library()[0]!
    expect(saved.type === 'template' && saved.templatePick).toBe('ask')
  })

  it('asks where the template lands, and only for the mode that lands it', async () => {
    const choice = { ...newTemplateChoice('qa-t', 'Dropper', 0), mode: 'new-note' as const }
    seed({ choices: [choice] })
    editor(choice)
    const drop = () => document.querySelector(`select[aria-label="${t('quickadd.field_insert_position')}"]`)
    expect(drop(), 'a note that is created has nowhere to be dropped').toBeNull()
    const existing = () => document.querySelector<HTMLSelectElement>(`select[aria-label="${t('quickadd.field_existing')}"]`)
    expect([...(existing()?.options ?? [])].map((option) => option.value))
      .toEqual(['cancel', 'ask', 'number', 'appendTop', 'appendBottom'])

    selectNamed(t('quickadd.field_mode'), 'insert-here')
    expect(drop()).not.toBeNull()
    expect(existing(), 'a note that is not created cannot collide').toBeNull()
    selectNamed(t('quickadd.field_insert_position'), 'replace')

    clickNamed(t('common.save'))
    await settle()
    const saved = library()[0]!
    expect(saved.type === 'template' && saved.insertPosition).toBe('replace')
  })

  it('offers one place per kind of backlink, and only the fields that place needs', async () => {
    const choice = { ...newTemplateChoice('qa-t', 'Linked', 0), linkToSource: false }
    seed({ choices: [choice] })
    editor(choice)
    const placement = () => document.querySelector(`select[aria-label="${t('quickadd.field_link_placement')}"]`)
    const propertyField = () => document.querySelector(`input[aria-label="${t('quickadd.field_link_property')}"]`)
    const embed = () => [...document.querySelectorAll('button[role="checkbox"]')]
      .some((node) => node.textContent?.trim() === t('quickadd.field_link_embed'))
    expect(placement(), 'no link, so no place to put it').toBeNull()
    clickNamed(t('quickadd.field_link_to_source'))
    expect(placement()).not.toBeNull()
    expect(embed(), 'a labelled line at the bottom is not something you embed').toBe(false)
    expect(propertyField(), 'only a property placement names a property').toBeNull()

    selectNamed(t('quickadd.field_link_placement'), 'property')
    expect(propertyField()).not.toBeNull()
    expect(embed(), 'a property value is link-only').toBe(false)
    typeNamed(t('quickadd.field_link_property'), 'origin')

    selectNamed(t('quickadd.field_link_placement'), 'lineEnd')
    expect(propertyField()).toBeNull()
    expect(embed()).toBe(true)
    clickNamed(t('quickadd.field_link_embed'))

    clickNamed(t('common.save'))
    await settle()
    const saved = library()[0]!
    expect(saved.type === 'template' && saved.linkPlacement).toBe('lineEnd')
    expect(saved.type === 'template' && saved.linkEmbed).toBe(true)
  })

  it('holds the opening fields until the run says it opens the note', async () => {
    const choice = { ...newTemplateChoice('qa-t', 'Alpha', 0), openAfter: false }
    seed({ choices: [choice] })
    editor(choice)
    const pane = () => document.querySelector(`select[aria-label="${t('quickadd.field_open_pane')}"]`)
    expect(pane(), 'a choice that opens nothing has no pane to name').toBeNull()
    clickNamed(t('quickadd.field_open_after'))
    expect(pane()).not.toBeNull()
    selectNamed(t('quickadd.field_open_pane'), 'other')
    selectNamed(t('quickadd.field_open_layout'), 'preview')
    clickNamed(t('quickadd.field_open_focus'))
    clickNamed(t('common.save'))
    await settle()
    const saved = library()[0]!
    expect(saved.type === 'template' && saved.openPane).toBe('other')
    expect(saved.type === 'template' && saved.openLayout).toBe('preview')
    expect(saved.type === 'template' && saved.openFocus).toBe(false)
  })

  it('names the three modes the app itself uses', () => {
    const choice = { ...newCaptureChoice('qa-c', 'Beta', 0), openAfter: true }
    seed({ choices: [choice] })
    editor(choice)
    const layout = document.querySelector<HTMLSelectElement>(`select[aria-label="${t('quickadd.field_open_layout')}"]`)
    expect([...(layout?.options ?? [])].map((option) => option.textContent?.trim())).toEqual([
      t('quickadd.open_layout_inherit'),
      t('workspace.editing_mode'),
      t('workspace.split_view'),
      t('workspace.reading_mode'),
    ])
  })

  it('offers the pick-a-day switch only where it would add a command', async () => {
    const choice = { ...newTemplateChoice('qa-t', 'Alpha', 0), asCommand: false }
    seed({ choices: [choice] })
    editor(choice)
    const twin = () => document.querySelector(`button[role="switch"][aria-label="${t('quickadd.field_pick_day_command')}"]`)
    expect(twin(), 'a choice that is not a command has no second command to offer').toBeNull()
    clickNamed(t('quickadd.field_as_command'))
    expect(twin()).not.toBeNull()
    clickNamed(t('quickadd.field_pick_day_command'))
    clickNamed(t('common.save'))
    await settle()
    const saved = library()[0]!
    expect(saved.type === 'template' && saved.pickDayCommand).toBe(true)
  })

  it('withdraws the pick-a-day switch when the run already asks for its day', () => {
    const choice = { ...newTemplateChoice('qa-t', 'Alpha', 0), asCommand: true, dateOrigin: 'ask' as const }
    seed({ choices: [choice] })
    editor(choice)
    expect(
      document.querySelector(`button[role="switch"][aria-label="${t('quickadd.field_pick_day_command')}"]`),
      'a choice that asks every time has nothing left for the second entry to do',
    ).toBeNull()
  })

  it('offers the category filter only while the run asks which template', async () => {
    const choice = newTemplateChoice('qa-t', 'Alpha', 0)
    seed({ choices: [choice] })
    act(() => {
      useNoteTemplates.setState({ categories: [{ id: 'cat-j', name: 'Journal', icon: null, color: null, position: 0 }] as never })
    })
    editor(choice)
    const categorySelect = () => document.querySelector(`select[aria-label="${t('quickadd.field_template_pick_category')}"]`)
    expect(categorySelect(), 'a fixed template needs no filter').toBeNull()
    selectNamed(t('quickadd.field_template_pick'), 'ask')
    expect(categorySelect()).not.toBeNull()
    selectNamed(t('quickadd.field_template_pick_category'), 'cat-j')
    clickNamed(t('common.save'))
    await settle()
    const saved = library()[0]!
    expect(saved.type === 'template' && saved.templatePickCategory).toBe('cat-j')
  })

  it('names every switch in the editor, so a screen reader says what it toggles', () => {
    seed({ choices: [newMacroChoice('qa-m', 'Morning', 0), newTemplateChoice('qa-t', 'T', 1), newCaptureChoice('qa-c', 'C', 2)] })
    for (const choice of library()) {
      editor(choice)
      const unnamed = [...document.querySelectorAll('button[role="switch"]')]
        .filter((node) => !(node.getAttribute('aria-label') ?? '').trim())
        .map((node) => node.closest('[data-setting-title]')?.getAttribute('data-setting-title') ?? 'unknown')
      expect(unnamed, `the ${choice.name} editor has switches nobody can name`).toEqual([])
    }
  })

  it('lists the two caret-relative write positions for a capture', () => {
    const choice = newCaptureChoice('qa-c', 'Caret', 0)
    seed({ choices: [choice] })
    editor(choice)
    const select = control(t('quickadd.field_position')) as HTMLSelectElement
    const labels = [...select.querySelectorAll('option')].map((option) => option.textContent?.trim())
    expect(labels).toEqual([
      t('quickadd.position_bottom'),
      t('quickadd.position_top'),
      t('quickadd.position_insert_after'),
      t('quickadd.position_insert_before'),
      t('quickadd.position_cursor'),
      t('quickadd.position_line_above'),
      t('quickadd.position_line_below'),
    ])
    selectNamed(t('quickadd.field_position'), 'lineBelow')
    clickNamed(t('common.save'))
    const saved = library()[0]!
    expect(saved.type === 'capture' && saved.writePosition).toBe('lineBelow')
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

  it('lets a macro step name an app command', async () => {
    const choice = { ...newMacroChoice('qa-m', 'Routine', 0), steps: [] }
    seed({ choices: [choice] })
    editor(choice)
    clickNamed(t('quickadd.add_step'))
    selectNamed(t('quickadd.step_kind'), 'command')
    const select = control(t('quickadd.step_command'))
    expect(select, 'the step offers the same list the palette shows').toBeInstanceOf(HTMLSelectElement)
    const node = select as HTMLSelectElement
    expect([...node.options].map((option) => option.value)).toContain('cmd-new')
    expect(node.value, 'a fresh step names the first command rather than nothing').toBe('cmd-new')
    selectNamed(t('quickadd.step_command'), 'cmd-emoji')
    clickNamed(t('common.save'))
    await settle()
    const saved = library()[0]!
    expect(saved.type === 'macro' && saved.steps).toEqual([{ kind: 'command', commandId: 'cmd-emoji' }])
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
  it('keeps the global-variable add button on one line', () => {
    seed()
    mount(QuickAddSettings)
    const add = control(t('settings.quickadd_add_var'))
    expect(add?.firstElementChild?.tagName.toLowerCase()).toBe('svg')
    expect(add?.textContent?.trim()).toBe(t('settings.quickadd_add_var'))
  })

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
    // Reaching into groups is on until the reader says otherwise.
    expect(useQuickAdd.getState().settings.searchNestedChoices).toBe(true)
    click(control(t('settings.quickadd_nested_search')))
    expect(useQuickAdd.getState().settings.searchNestedChoices).toBe(false)
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

  it('offers the startup throttle the macros are governed by', () => {
    mount(QuickAddSettings)
    const name = t('quickadd.field_startup_scope')
    const select = control(name) as HTMLSelectElement
    expect([...select.querySelectorAll('option')].map((option) => option.textContent?.trim()))
      .toEqual([t('quickadd.startup_scope_day'), t('quickadd.startup_scope_session')])
    selectNamed(name, 'session')
    expect(useQuickAdd.getState().settings.startupScope).toBe('session')
  })
})
