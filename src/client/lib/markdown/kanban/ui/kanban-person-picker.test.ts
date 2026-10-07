import { act, createElement } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { renderElement } from '../../../test-render'
import { KanbanPersonAvatar, KanbanPersonPicker } from './kanban-person-picker'
import type { ReactNode } from 'react'

beforeAll(async () => {
  await initI18n()
})

const PROPERTY = 'Assignee'

function label(property: string) {
  return t('preview.kanban_person_change', { property })
}

interface PickerProps {
  propertyName: string
  value: string
  candidates: string[]
  onChange: (name: string) => void
}

function mount(overrides: Partial<PickerProps> = {}) {
  const props: PickerProps = {
    propertyName: PROPERTY,
    value: '',
    candidates: [],
    onChange: vi.fn(),
    ...overrides,
  }
  const node: ReactNode = createElement(KanbanPersonPicker, props)
  const rendered = renderElement(node)
  const trigger = () => rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${label(PROPERTY)}"]`)!
  const panel = () => rendered.container.querySelector<HTMLDivElement>('[role="dialog"]')
  const names = () =>
    Array.from(panel()!.querySelectorAll<HTMLElement>('[data-kanban-person-name]')).map((el) => el.textContent)
  const input = () => panel()!.querySelector<HTMLInputElement>('input[type="search"]')!
  const addButton = () => panel()!.querySelector<HTMLButtonElement>('[data-kanban-person-add]')
  const clearButton = () =>
    panel()!.querySelector<HTMLButtonElement>(`button[aria-label="${t('preview.kanban_person_clear')}"]`)

  const open = () => act(() => trigger().click())
  const type = (text: string) => {
    const field = input()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = (key: string) => {
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }
  return { rendered, props, trigger, panel, names, input, addButton, clearButton, open, type, press }
}

describe('the member picker a person column hands the reader', () => {
  it('says which property it changes before the panel is even open', () => {
    const { trigger, panel, rendered } = mount()
    expect(trigger()).toBeTruthy()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog')
    expect(panel()).toBeNull()
    rendered.unmount()
  })

  it('shows the person already on the card, by their whole name to a screen reader', () => {
    const { trigger, rendered } = mount({ value: 'Alice Nguyen' })
    const avatar = trigger().querySelector<HTMLElement>('[role="img"]')!
    expect(avatar.getAttribute('aria-label')).toBe('Alice Nguyen')
    expect(avatar.textContent).toBe('AL')
    rendered.unmount()
  })

  it('says there is nobody on the card rather than showing a blank hole', () => {
    const { trigger, rendered } = mount({ value: '' })
    expect(trigger().textContent).toBe(t('preview.kanban_person_unassigned'))
    expect(rendered.container.querySelector('[role="img"]')).toBeNull()
    rendered.unmount()
  })

})

describe('who the member panel offers, and what a click writes', () => {

  it('lists the roster the board already knows and writes the one that is clicked', () => {
    const { open, names, panel, rendered, props } = mount({ candidates: ['Bob', 'Alice'] })
    open()
    expect(panel()!.getAttribute('aria-label')).toBe(t('preview.kanban_person_pick', { property: PROPERTY }))
    expect(names()).toEqual(['Bob', 'Alice'])
    const bob = panel()!.querySelectorAll<HTMLButtonElement>('[data-kanban-person-choice]')[0]!
    act(() => bob.click())
    expect(props.onChange).toHaveBeenCalledWith('Bob')
    expect(panel()).toBeNull()
    rendered.unmount()
  })

  it('marks the person the card already holds', () => {
    const { open, panel, rendered } = mount({ value: 'Alice', candidates: ['Bob', 'Alice'] })
    open()
    const marks = panel()!.querySelectorAll<HTMLButtonElement>('[data-kanban-person-choice][aria-current="true"]')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.querySelector('[data-kanban-person-name]')!.textContent).toBe('Alice')
    rendered.unmount()
  })

  it('cuts the roster down to the names the reader typed', () => {
    const { open, type, names, rendered } = mount({ candidates: ['Bob', 'Alice', 'Bianca'] })
    open()
    type('bi')
    expect(names()).toEqual(['Bianca'])
    rendered.unmount()
  })

})

describe('what the search box commits', () => {

  it('assigns the first name a search leaves without typing it out', () => {
    const { open, type, press, panel, props, rendered } = mount({ candidates: ['Bob', 'Bianca'] })
    open()
    type('bi')
    press('Enter')
    expect(props.onChange).toHaveBeenCalledWith('Bianca')
    expect(panel()).toBeNull()
    rendered.unmount()
  })

  it('offers a name nobody has used yet and writes it on Enter', () => {
    const { open, type, press, panel, addButton, rendered, props } = mount({ candidates: ['Bob'] })
    open()
    type('Cyd')
    expect(addButton()).toBeTruthy()
    press('Enter')
    expect(props.onChange).toHaveBeenCalledWith('Cyd')
    expect(panel()).toBeNull()
    rendered.unmount()
  })

  it('does not offer to add a person the roster already lists', () => {
    const { open, type, addButton, rendered } = mount({ candidates: ['Bob'] })
    open()
    type('bob')
    expect(addButton()).toBeNull()
    rendered.unmount()
  })

})

describe('writing nobody, and saying there is no one', () => {

  it('writes nobody when the reader unassigns the card', () => {
    const { open, clearButton, rendered, props } = mount({ value: 'Alice', candidates: ['Alice'] })
    open()
    act(() => clearButton()!.click())
    expect(props.onChange).toHaveBeenCalledWith('')
    rendered.unmount()
  })

  it('hides the unassign button from a card that holds nobody', () => {
    const { open, clearButton, rendered } = mount({ value: '', candidates: ['Alice'] })
    open()
    expect(clearButton()).toBeNull()
    rendered.unmount()
  })

  it('says so when the board has no one to offer yet', () => {
    const { open, panel, names, rendered } = mount({ candidates: [] })
    open()
    expect(names()).toEqual([])
    expect(panel()!.textContent).toBe(t('preview.kanban_person_none'))
    rendered.unmount()
  })

})

describe('closing the panel without writing', () => {

  it('closes on Escape without writing and hands focus back to the trigger', () => {
    const { open, trigger, panel, input, rendered, props } = mount({ value: 'Alice', candidates: ['Alice'] })
    open()
    expect(document.activeElement).toBe(input())
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(panel()).toBeNull()
    expect(props.onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger())
    rendered.unmount()
  })

  it('closes on a click outside without writing', () => {
    const { open, panel, rendered, props } = mount({ candidates: ['Alice'] })
    open()
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(panel()).toBeNull()
    expect(props.onChange).not.toHaveBeenCalled()
    rendered.unmount()
  })
})

describe('the avatar every surface draws for a person', () => {
  it('speaks the whole name and hides the two letters it shows', () => {
    const rendered = renderElement(createElement(KanbanPersonAvatar, { name: 'Bob Jones' }))
    const avatar = rendered.container.querySelector<HTMLElement>('[role="img"]')!
    expect(avatar.getAttribute('aria-label')).toBe('Bob Jones')
    expect(avatar.getAttribute('title')).toBe('Bob Jones')
    expect(avatar.firstElementChild!.getAttribute('aria-hidden')).toBe('true')
    expect(avatar.textContent).toBe('BO')
    rendered.unmount()
  })
})
