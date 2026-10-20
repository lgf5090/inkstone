// @vitest-environment jsdom
/**
 * The task edit form.
 *
 * What is pinned is the two things a form like this gets wrong: a field the reader cannot reach or
 * return to once the dialog is up, and a Save that quietly drops what it could not read. The dialog
 * chrome itself is the shared `Modal`'s business; the claim here is that this form is built on it in
 * a way that keeps those guarantees.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestGlobals } from '../../lib/test-render'
import { initI18n } from '../../lib/i18n'
import { EmojiTaskSerializer } from '../../lib/tasks/serializer/emoji'
import { StatusRegistry } from '../../lib/tasks/status/registry'
import { parseTaskLine } from '../../lib/tasks/model/task'
import { unknownPosition } from '../../lib/tasks/model/task-location'
import { applyDraft, draftFromTask, type DraftErrors, type TaskDraft } from '../../lib/tasks/edit/task-editor'
import { EditTaskModal } from './EditTaskModal'

const registry = new StatusRegistry()
const serializer = new EmojiTaskSerializer()
const NOW = new Date(2026, 9, 19)

function draftOf(line: string): TaskDraft {
  const task = parseTaskLine(line, unknownPosition('', ''), { registry, serializer, now: NOW })!
  return draftFromTask(task)
}

function emptyErrors(): DraftErrors {
  return { dates: {}, recurrence: 'none' }
}

let root: Root
let host: HTMLElement
let opener: HTMLButtonElement

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  document.body.replaceChildren()
  opener = document.createElement('button')
  opener.textContent = 'open'
  host = document.createElement('div')
  document.body.append(opener, host)
  opener.focus()
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
})

function render(props: Partial<Parameters<typeof EditTaskModal>[0]> = {}): void {
  act(() => {
    root.render(createElement(EditTaskModal, {
      draft: draftOf(`- [ ] pay rent ${String.fromCodePoint(0x1F4C5)} 2026-10-21`),
      statuses: registry.registeredStatuses.map((status) => ({ symbol: status.symbol, name: status.name })),
      validate: () => emptyErrors(),
      onClose: () => undefined,
      onSave: async () => undefined,
      ...props,
    }))
  })
}

const panel = (): HTMLElement => document.querySelector('[role=dialog]') as HTMLElement
const fieldByLabel = (label: string): HTMLInputElement | null => {
  const hit = [...panel().querySelectorAll('label')].find((node) => node.textContent?.includes(label))
  const id = hit?.htmlFor
  return id ? document.getElementById(id) as HTMLInputElement | null : null
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string): void {
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const saveButton = (): HTMLButtonElement =>
  [...panel().querySelectorAll('button')].find((button) => button.textContent?.includes('Save')) as HTMLButtonElement

describe('what the form shows', () => {
  it('opens with every field holding what the line said', () => {
    render()
    expect(fieldByLabel('Description')?.value).toBe('pay rent')
    expect(fieldByLabel('Due')?.value).toBe('2026-10-21')
    expect(fieldByLabel('Done')?.value).toBe('')
    expect((fieldByLabel('Repeats') as HTMLInputElement).value).toBe('')
  })

  it('names the rule it can read, and says so where the reader will look', () => {
    render({ draft: draftOf('- [ ] water 🔁 every week 📅 2026-10-19') })
    expect(panel().textContent).toContain('Next one: every week')
  })
})

describe('the dialog keeps its promises', () => {
  it('moves focus inside, and hands it back on close', () => {
    const onClose = vi.fn()
    render({ onClose })
    expect(panel().contains(document.activeElement)).toBe(true)
    press('Escape')
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the tab ring inside the panel', () => {
    render()
    const focusables = [...panel().querySelectorAll<HTMLElement>('input, select, button, [tabindex]')]
    focusables.at(-1)!.focus()
    press('Tab')
    expect(panel().contains(document.activeElement)).toBe(true)
  })

  it('closes on the backdrop as well', () => {
    const onClose = vi.fn()
    render({ onClose })
    const scrim = document.querySelector('.app-viewport-fixed > div') as HTMLElement
    act(() => { scrim.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('saving', () => {
  it('sends the edited draft and the status the reader chose', async () => {
    const onSave = vi.fn(async (_draft: TaskDraft, _statusSymbol: string) => undefined)
    render({ onSave })
    type(fieldByLabel('Description')!, 'pay the rent')
    const status = panel().querySelector('select') as HTMLSelectElement
    act(() => {
      status.value = 'x'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { saveButton().click() })
    expect(onSave).toHaveBeenCalledTimes(1)
    const [saved, symbol] = onSave.mock.calls[0]!
    expect(saved.description).toBe('pay the rent')
    expect(symbol).toBe('x')
  })

  it('refuses to save a date it cannot read, and says which field', async () => {
    const onSave = vi.fn(async () => undefined)
    render({
      onSave,
      validate: (draft) => (draft.dates.dueDate.includes('13') ? {
        dates: { dueDate: 'unreadable' },
        recurrence: 'none',
      } satisfies DraftErrors : emptyErrors()),
    })
    type(fieldByLabel('Due')!, '2026-13-45')
    await act(async () => { saveButton().click() })
    expect(onSave).not.toHaveBeenCalled()
    expect(panel().textContent).toContain('That does not name a day.')
    expect(fieldByLabel('Due')?.getAttribute('aria-invalid')).toBe('true')
    expect(fieldByLabel('Due')?.value).toBe('2026-13-45')
  })

  it('names a date that cannot be taken out because the note supplied it', async () => {
    const onSave = vi.fn(async () => undefined)
    render({
      onSave,
      validate: (draft) => (draft.dates.scheduledDate === '' ? {
        dates: { scheduledDate: 'from-note-name' },
        recurrence: 'none',
      } satisfies DraftErrors : emptyErrors()),
    })
    type(fieldByLabel('Scheduled')!, '')
    await act(async () => { saveButton().click() })
    expect(onSave).not.toHaveBeenCalled()
    // The two date problems need two sentences: "that does not name a day" would send the reader off
    // to retype a date they were trying to get rid of.
    expect(panel().textContent).toContain("That date comes from the note's own name")
    expect(fieldByLabel('Scheduled')?.getAttribute('aria-invalid')).toBe('true')
  })

  it('will not save an empty description', () => {
    const onSave = vi.fn(async () => undefined)
    render({ onSave })
    type(fieldByLabel('Description')!, '   ')
    expect(saveButton().disabled).toBe(true)
    expect(panel().textContent).toContain('A task needs some words.')
  })
})

/** The model path the form's `validate` is expected to be wired to, pinned so the two cannot drift. */
describe('the form and the model agree', () => {
  it('a draft the form accepts is a draft the model can write', async () => {
    const settings = {
      registry,
      serializer,
      setDoneDate: true,
      setCancelledDate: true,
      setCreatedDate: false,
      recurrenceOnNextLine: false,
      recursiveSubTaskCompletion: false,
    }
    const task = parseTaskLine('- [ ] pay rent 📅 2026-10-21', unknownPosition('', ''), { registry, serializer, now: NOW })!
    const draft = draftFromTask(task)
    const out = applyDraft(task, { ...draft, description: 'pay the rent' }, registry.bySymbolOrCreate('x'), settings, NOW)
    expect(out.errors).toEqual(emptyErrors())
    expect(out.tasks).toHaveLength(1)
  })
})
