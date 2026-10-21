// @vitest-environment jsdom
/**
 * The two shapes the same rows come in, and what each one offers.
 *
 * The list and the cards exist because a reader scanning dates and a reader surveying a portfolio want
 * different things from the same twelve plans. What they must not want is different *actions*: a card
 * that cannot be renewed, or a row whose right-click offers something else again, is two answers to one
 * question. These cases pin the parity, the right-click both surfaces now answer, and the flat layout a
 * non-date ordering falls into.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubscriptionItem } from '@shared/subscriptions/model'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { SubscriptionList, type SubscriptionActions } from './SubscriptionList'
import { SubscriptionGrid } from './SubscriptionGrid'
import { useSubscriptions } from './store'

function item(overrides: Partial<SubscriptionItem> = {}): SubscriptionItem {
  return {
    id: 'sub-1',
    name: 'Netflix',
    customType: 'streaming',
    category: 'family',
    amount: 60,
    currency: 'CNY',
    startDate: null,
    expiryDate: '2026-11-01T00:00:00.000Z',
    periodValue: 1,
    periodUnit: 'month',
    subscriptionMode: 'cycle',
    useLunar: false,
    isActive: true,
    autoRenew: true,
    notes: '',
    lastPaymentDate: null,
    trialEndsAt: null,
    trialDaysRemaining: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    daysRemaining: 10,
    hoursRemaining: 240,
    nextReminderAt: null,
    paymentCount: 1,
    paidTotal: 60,
    ...overrides,
  }
}

const ITEMS = [item({ id: 'a', name: 'Netflix', daysRemaining: 3 }), item({ id: 'b', name: 'Figma', daysRemaining: 40 })]
const ROW_ACTIONS = ['subscriptions.edit', 'subscriptions.renew.confirm', 'subscriptions.channel.test', 'subscriptions.detail.toggle_off', 'subscriptions.trash.move'] as const

const actions: SubscriptionActions = {
  onEdit: vi.fn(), onRenew: vi.fn(), onToggle: vi.fn(), onTrash: vi.fn(), onTest: vi.fn(),
}

let root: Root | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useSubscriptions.setState({ types: [], categories: [] })
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function mount(node: Parameters<Root['render']>[0]): void {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root!.render(node) })
}

function press(node: Element | null | undefined, what: string, event = new MouseEvent('click', { bubbles: true, cancelable: true })): void {
  expect(node, `${what} is not rendered`).toBeTruthy()
  act(() => { node!.dispatchEvent(event) })
}

/** The action names a menu is currently offering, in the order it lists them. */
function menuLabels(): string[] {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return []
  return [...menu.querySelectorAll('button')].map((node) => (node.textContent || '').trim())
}

const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

function gridProps(onSelect: (id: string) => void) {
  return { items: ITEMS, selectedId: null, loading: false, onSelect, onAdd: () => {}, actions }
}

describe('the cards', () => {
  it('draws one card per plan and opens the plan the card was pressed on', () => {
    const onSelect = vi.fn()
    mount(createElement(SubscriptionGrid, gridProps(onSelect)))
    const cards = [...document.querySelectorAll('[role="listitem"]')]
    expect(cards).toHaveLength(2)
    expect(document.body.textContent).toContain('Figma')

    press(cards[1]!.querySelector('button'), 'the second card')
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('offers the row\'s whole action list on a right-click', () => {
    mount(createElement(SubscriptionGrid, gridProps(() => {})))
    const card = document.querySelector<HTMLElement>('[role="listitem"]')
    press(card?.querySelector('button'), 'a card', contextMenu)

    const offered = menuLabels()
    for (const key of ROW_ACTIONS) expect(offered).toContain(t(key))
  })

  it('keeps the kebab beside the card, not inside it', () => {
    mount(createElement(SubscriptionGrid, gridProps(() => {})))
    const card = document.querySelector<HTMLElement>('[role="listitem"]')!
    const kebab = [...card.querySelectorAll('button')].at(-1)!
    expect(card.querySelector('button')!.contains(kebab), 'the actions button sits inside the button that opens the plan').toBe(false)
    press(kebab, 'the card kebab')
    expect(menuLabels()).toContain(t('subscriptions.trash.move'))
  })
})

describe('the list beside the cards', () => {
  it('answers a right-click with the same list the cards do', () => {
    mount(createElement(SubscriptionList, {
      items: ITEMS, sort: 'expiry', selectedId: null, loading: false, onSelect: () => {}, onAdd: () => {}, actions,
      selectMode: false, selection: [], onCheck: () => {},
    }))
    const row = document.querySelector('[role="listitem"]')
    press(row?.querySelector('button'), 'a row', contextMenu)

    const offered = menuLabels()
    for (const key of ROW_ACTIONS) expect(offered).toContain(t(key))
  })

  it('lays the rows out flat, under the ordering that asked for it, when the order is not about dates', () => {
    mount(createElement(SubscriptionList, {
      items: ITEMS, sort: 'cost', selectedId: null, loading: false, onSelect: () => {}, onAdd: () => {}, actions,
      selectMode: false, selection: [], onCheck: () => {},
    }))
    const text = document.body.textContent || ''
    expect(text).toContain(t('subscriptions.list.sort_cost'))
    // The urgency headings are a date ordering; sorting by cost under them would file the dearest plan
    // wherever the calendar happens to put it.
    expect(text).not.toContain(t('subscriptions.list.group_week'))
    expect(text).not.toContain(t('subscriptions.list.group_later'))
    expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(2)
  })

  it('keeps the headings when the ordering is the dates themselves', () => {
    mount(createElement(SubscriptionList, {
      items: ITEMS, sort: 'expiry', selectedId: null, loading: false, onSelect: () => {}, onAdd: () => {}, actions,
      selectMode: false, selection: [], onCheck: () => {},
    }))
    expect(document.body.textContent).toContain(t('subscriptions.list.group_week'))
    expect(document.body.textContent).toContain(t('subscriptions.list.group_later'))
  })
})
