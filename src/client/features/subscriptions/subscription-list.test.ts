// @vitest-environment jsdom
/**
 * The row's two states: reading, and selecting.
 *
 * These four assertions exist because the app once shipped a list whose selection boxes could never
 * appear: the row derived "am I selecting" from "is anything already checked", so the box needed a check
 * before it could make one. The toolbar still flipped to its exit label, so nothing looked wrong from the
 * outside, and the batch actions under it were unreachable. Deriving the mode from the selection is the
 * exact bug this file forbids, which is why `selectMode` is a prop and is passed straight to the row.
 *
 * What the browser measured and jsdom cannot: the box's hit area, and the colour it paints.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SubscriptionItem } from '@shared/subscriptions/model'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { SubscriptionList, type SubscriptionActions } from './SubscriptionList'
import { useSubscriptions } from './store'

const NO_ACTIONS: SubscriptionActions = {
  onEdit: () => {}, onRenew: () => {}, onToggle: () => {}, onTrash: () => {}, onTest: () => {},
}

function item(overrides: Partial<SubscriptionItem> = {}): SubscriptionItem {
  return {
    id: 'sub-1',
    name: 'Netflix',
    customType: 'streaming',
    category: 'media',
    amount: 68,
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
    paymentCount: 0,
    paidTotal: 0,
    ...overrides,
  }
}

const ITEMS = [item(), item({ id: 'sub-2', name: 'Figma', currency: 'USD', amount: 15 })]

let root: Root | null = null
let checked: string[]

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  checked = []
  useSubscriptions.setState({ types: [], categories: [] })
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
})

function mount(selectMode: boolean, selection: readonly string[] = []): void {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root?.render(createElement(SubscriptionList, {
      items: ITEMS,
      sort: 'expiry',
      selectedId: null,
      loading: false,
      onSelect: () => {},
      onAdd: () => {},
      actions: NO_ACTIONS,
      selectMode,
      selection,
      onCheck: (id: string) => { checked.push(id) },
    }))
  })
}

function boxes(): Element[] {
  return [...document.querySelectorAll('[role=checkbox]')]
}

/** The part of each row that opens the detail panel — not the actions menu, not the selection box. */
function openers(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role=listitem] button:not([aria-label]):not([role=checkbox])')]
}

describe('the subscription row', () => {
  it('offers no selection box until selecting is what the reader asked for', () => {
    mount(false)
    expect(boxes(), 'a reader walking the list one row at a time is not asked to answer a question they never opened').toHaveLength(0)
    expect(openers()).toHaveLength(2)
    for (const opener of openers()) expect(opener.tabIndex, 'the row stays in the tab order').not.toBe(-1)
  })

  it('puts one named box on every row the moment selecting starts, with nothing checked yet', () => {
    mount(true)
    const found = boxes()
    expect(found, 'select mode cannot wait for a selection to exist before offering its own control').toHaveLength(2)
    for (const box of found) expect(box.getAttribute('aria-checked')).toBe('false')
    expect(found[0]!.textContent).toContain('Netflix')
    expect(found[1]!.textContent).toContain('Figma')
    expect(found[0]!.textContent).toBe(t('subscriptions.bulk.pick', { name: 'Netflix' }))
  })

  it('reports the row a box was pressed for, which is the only door to a batch action', async () => {
    mount(true)
    const first = boxes()[0] as HTMLElement
    await act(async () => { first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(checked).toEqual(['sub-1'])
  })

  it('takes the opener out of the tab order while boxes are the path through the list', () => {
    mount(true, ['sub-2'])
    for (const opener of openers()) expect(opener.tabIndex).toBe(-1)
    const found = boxes()
    expect(found[1]!.getAttribute('aria-checked')).toBe('true')
    expect(found[0]!.getAttribute('aria-checked')).toBe('false')
  })
})
