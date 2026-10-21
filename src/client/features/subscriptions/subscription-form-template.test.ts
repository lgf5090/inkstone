// @vitest-environment jsdom
/**
 * The starting-point picker in the create form.
 *
 * What is worth testing is the promise the picker makes: it fills the four fields it knows and touches
 * nothing else. A template that also wrote a price would be the app claiming to know what a reader pays,
 * and a picker that appeared while editing would overwrite a plan that already exists.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubscriptionDetail } from '@shared/subscriptions/model'
import { SERVICE_TEMPLATES } from '@shared/subscriptions/templates'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { SubscriptionForm } from './SubscriptionForm'

let root: Root
let host: HTMLElement

const byPlaceholder = (placeholder: string): HTMLInputElement | undefined =>
  [...document.querySelectorAll<HTMLInputElement>('input')].find((node) => node.placeholder === placeholder)

/** The box a labelled field owns: found by the `for` the Field wires up, not by the markup around it. */
const boxFor = (label: string): HTMLInputElement | undefined => {
  const field = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find((node) => (node.textContent ?? '').replace(/\s+/g, '') === label.replace(/\s+/g, ''))
  return field?.htmlFor ? (document.getElementById(field.htmlFor) as HTMLInputElement | null) ?? undefined : undefined
}

async function choose(templateName: string): Promise<void> {
  const field = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find((node) => (node.textContent ?? '').includes(t('subscriptions.form.template')))
  const select = field?.htmlFor ? document.getElementById(field.htmlFor) as HTMLSelectElement | null : null
  expect(select, 'the service picker is not rendered').toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, templateName)
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function mount(detail: SubscriptionDetail | null = null): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(SubscriptionForm, {
      open: true,
      detail,
      timezone: 'Asia/Shanghai',
      categories: ['娱乐'],
      types: ['流媒体'],
      saving: false,
      onClose: () => {},
      onSubmit: vi.fn(async () => true),
    }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  document.body.innerHTML = ''
})

describe('the service picker', () => {
  it('offers every known service by name', async () => {
    await mount()
    const field = [...document.querySelectorAll<HTMLLabelElement>('label')]
      .find((node) => (node.textContent ?? '').includes(t('subscriptions.form.template')))
    const select = field?.htmlFor ? document.getElementById(field.htmlFor) as HTMLSelectElement | null : null
    const options = [...(select?.options ?? [])].map((option) => option.textContent)
    expect(options).toContain(t('subscriptions.form.template_placeholder'))
    for (const template of SERVICE_TEMPLATES) expect(options).toContain(template.name)
  })

  it('fills the name, the two labels and the cycle, and says which labels it chose', async () => {
    await mount()
    await choose('Netflix')
    expect(byPlaceholder(t('subscriptions.form.name_placeholder'))?.value).toBe('Netflix')
    expect(byPlaceholder(t('subscriptions.form.type_placeholder'))?.value).toBe(t('subscriptions.type.streaming'))
    expect(byPlaceholder(t('subscriptions.form.category_placeholder'))?.value).toBe(t('subscriptions.category.entertainment'))
    expect(boxFor(t('subscriptions.form.period_value'))?.value).toBe('1')
    expect(document.body.textContent ?? '').toContain(t('subscriptions.form.template_used', {
      name: 'Netflix', type: t('subscriptions.type.streaming'), category: t('subscriptions.category.entertainment'),
    }))
  })

  it('leaves the amount and every date for the reader', async () => {
    await mount()
    // Read what the pickers show rather than how many there are: the dates are no longer native fields,
    // and an empty `input[type=date]` list would make this assertion pass while proving nothing.
    const shownDates = () => [...document.querySelectorAll('[aria-haspopup="dialog"]')]
      .map((node) => (node.textContent || '').trim())
    const datesBefore = shownDates()
    expect(datesBefore.length, 'the form drew no date pickers').toBeGreaterThan(0)
    expect(boxFor(t('subscriptions.form.amount'))?.value).toBe('')
    await choose('Netflix')
    expect(boxFor(t('subscriptions.form.amount'))?.value, 'a template that filled a price would be the app guessing').toBe('')
    expect(shownDates(), 'a template moved a date the reader never answered').toEqual(datesBefore)
  })

  it('does not appear while a plan that already exists is being corrected', async () => {
    const detail = {
      item: {
        id: 'sub-1', name: 'Existing', customType: 'tools', category: '', amount: 30, currency: 'CNY',
        startDate: null, expiryDate: '2026-12-01T00:00:00.000Z', periodValue: 1, periodUnit: 'month',
        subscriptionMode: 'cycle', useLunar: false, isActive: true, autoRenew: true, notes: '',
        trialEndsAt: null, daysRemaining: 40, paymentCount: 0, paidByCurrency: [], createdAt: '', updatedAt: '',
      },
      payments: [],
      rules: [],
    } as unknown as SubscriptionDetail
    await mount(detail)
    expect([...document.querySelectorAll<HTMLLabelElement>('label')]
      .some((node) => (node.textContent ?? '').includes(t('subscriptions.form.template')))).toBe(false)
    expect(byPlaceholder(t('subscriptions.form.name_placeholder'))?.value).toBe('Existing')
    expect(boxFor(t('subscriptions.form.amount'))?.value).toBe('30')
  })
})
