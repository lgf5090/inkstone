// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailContact, EmailGroupWithMembers } from '@shared/email/contacts'
import { api } from '../../src/client/lib/api'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { RecipientField } from '../../src/client/features/email/RecipientField'

const grace: EmailContact = {
  id: 'c1',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  company: 'Navy',
  notes: '',
  starred: true,
  usageCount: 3,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const alan: EmailContact = {
  id: 'c2',
  email: 'alan@example.com',
  name: 'Alan Turing',
  company: '',
  notes: '',
  starred: false,
  usageCount: 1,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const team: EmailGroupWithMembers = {
  id: 'g1',
  name: 'Team',
  description: 'Everyone',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [grace, alan],
}

function Harness({ initial, onChange }: { initial: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial)
  return createElement('div', null,
    createElement(RecipientField, {
      value,
      onChange: (next: string) => {
        setValue(next)
        onChange?.(next)
      },
      'aria-label': 'Recipients',
    }),
    createElement('output', null, value),
  )
}

function field(initial = '', onChange?: (value: string) => void): RenderedElement {
  return renderElement(createElement(Harness, { initial, onChange }))
}

function input(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('input[role="combobox"]')
  if (!found) throw new Error('no recipient input')
  return found
}

function value(): string {
  return document.querySelector('output')?.textContent ?? ''
}
function change(node: HTMLInputElement, next: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(node, next)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(node: HTMLInputElement, key: string): void {
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function chip(address: string): HTMLButtonElement {
  const label = t('email.recipients.remove', { address })
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no chip for ${address}`)
  return found
}

function groupChip(name: string): HTMLButtonElement {
  const label = t('email.recipients.remove_group', { name })
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no group chip for ${name}`)
  return found
}

async function settle(ms = 240): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the recipient field', () => {
  it('shows prefilled addresses as removable chips', () => {
    const view = field('grace@example.com, alan@example.com')
    expect(chip('grace@example.com').textContent).toContain('grace@example.com')
    expect(chip('alan@example.com')).toBeTruthy()
    expect(input().value).toBe('')
    act(() => { chip('grace@example.com').click() })
    expect(value()).toBe('alan@example.com')
    view.unmount()
  })

  it('picks the active suggestion with the arrow keys', async () => {
    vi.spyOn(api.email, 'listContacts').mockResolvedValue([grace, alan])
    const view = field()
    change(input(), 'example')
    await settle()
    expect(document.querySelector('[role="listbox"]')).toBeTruthy()
    press(input(), 'ArrowDown')
    expect(input().getAttribute('aria-activedescendant')).toMatch(/-option-1$/)
    press(input(), 'Enter')
    expect(value()).toBe('alan@example.com')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    view.unmount()
  })

  it('keeps a prefilled display name when another address joins it', () => {
    const view = field('Grace Hopper <grace@example.com>')
    expect(chip('grace@example.com').textContent).toContain('Grace Hopper')
    change(input(), 'alan@example.com')
    press(input(), 'Enter')
    expect(value()).toBe('grace@example.com, alan@example.com')
    expect(chip('grace@example.com').textContent).toContain('Grace Hopper')
    view.unmount()
  })

  it('offers contacts while typing and adds one without duplicating it', async () => {
    const listContacts = vi.spyOn(api.email, 'listContacts').mockResolvedValue([grace])
    const view = field()
    change(input(), 'gra')
    await settle()
    expect(listContacts).toHaveBeenCalledWith('gra')
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((node) => node.textContent?.includes('Grace Hopper'))
    if (!option) throw new Error('no contact option')
    act(() => { option.click() })
    expect(value()).toBe('grace@example.com')
    expect(chip('grace@example.com').textContent).toContain('Grace Hopper')
    expect(input().value).toBe('')
    change(input(), 'grace@example.com')
    press(input(), 'Enter')
    expect(value()).toBe('grace@example.com')
    view.unmount()
  })

  it('expands a chosen group into member chips and removes the whole group', async () => {
    const listGroups = vi.spyOn(api.email, 'listGroups').mockResolvedValue([team])
    const view = field()
    change(input(), '@')
    await settle(20)
    expect(listGroups).toHaveBeenCalledTimes(1)
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((node) => node.textContent?.includes('Team'))
    if (!option) throw new Error('no group option')
    act(() => { option.click() })
    expect(value()).toBe('grace@example.com, alan@example.com')
    expect(groupChip('Team').textContent).toContain('(2)')
    expect(() => chip('grace@example.com')).toThrow()
    expect(() => chip('alan@example.com')).toThrow()
    change(input(), '@')
    act(() => {
      document.querySelector<HTMLElement>('[role="option"]')?.click()
    })
    expect(value()).toBe('grace@example.com, alan@example.com')
    expect(listGroups).toHaveBeenCalledTimes(1)
    act(() => { groupChip('Team').click() })
    expect(value()).toBe('')
    view.unmount()
  })

  it('keeps an invalid address out and says why', () => {
    const view = field()
    change(input(), 'not-an-address')
    press(input(), 'Enter')
    expect(value()).toBe('')
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('email.recipients.invalid', { value: 'not-an-address' }))
    view.unmount()
  })

  it('splits pasted addresses and reports the invalid ones', () => {
    const view = field()
    const event = new Event('paste', { bubbles: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => 'grace@example.com; nope; alan@example.com' },
    })
    act(() => { input().dispatchEvent(event) })
    expect(value()).toBe('grace@example.com, alan@example.com')
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('email.recipients.invalid', { value: 'nope' }))
    view.unmount()
  })
})
