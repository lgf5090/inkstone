import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarDto, CalendarShareDto } from '@shared/calendar/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CalendarShareDialog } from './CalendarDialogs'

/**
 * The share dialog's three read states and its two writes.
 *
 * The address is rebuilt from `window.location.origin`, the same rule the to-do feed screen follows:
 * behind a proxy the origin the worker saw may be one a reader cannot reach. The states are pinned
 * separately because the dialog is the only place the owner learns a link exists — a failed read that
 * renders as "no link yet" would invite them to mint a second one.
 */

const { getMock, mintMock, revokeMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  mintMock: vi.fn(),
  revokeMock: vi.fn(),
}))

vi.mock('./api', () => ({
  getCalendarShare: getMock,
  shareCalendar: mintMock,
  unshareCalendar: revokeMock,
}))

const SLUG = 'abcdefghjkmnpqrstvwz'

function share(over: Partial<CalendarShareDto> = {}): CalendarShareDto {
  return {
    slug: SLUG,
    calendarId: 'cal-1',
    views: 3,
    createdAt: Date.parse('2026-10-20T09:00:00Z'),
    lastViewedAt: Date.parse('2026-10-24T09:00:00Z'),
    ...over,
  }
}

const calendar = { id: 'cal-1', name: 'Trips', rev: 4 } as unknown as CalendarDto

let view: RenderedElement | null = null

function panel(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!node) throw new Error('the share dialog did not render a panel')
  return node
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  })
}

async function open(): Promise<void> {
  view = renderElement(createElement(CalendarShareDialog, { open: true, calendar, onClose: () => {} }))
  await settle()
}

async function click(label: string): Promise<void> {
  const node = [...panel().querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(label))
  if (!node) throw new Error(`the "${label}" button is not rendered`)
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

function address(): HTMLInputElement | null {
  return panel().querySelector<HTMLInputElement>('input[readonly]')
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  getMock.mockReset()
  mintMock.mockReset()
  revokeMock.mockReset()
})

afterEach(() => {
  view?.unmount()
  view = null
})

describe('the calendar share dialog', () => {
  it('reads once and shows the address a reader would subscribe to', async () => {
    getMock.mockResolvedValue(share())
    await open()
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(getMock).toHaveBeenCalledWith('cal-1')
    expect(address()?.value).toBe(`${window.location.origin}/feeds/calendar/${SLUG}.ics`)
    expect(panel().textContent).toContain(t('calendar.share.views', { count: 3 }))
  })

  it('keeps a failed read apart from a calendar that was never published', async () => {
    getMock.mockRejectedValue(new Error('share state unreachable'))
    await open()
    expect(panel().textContent).toContain('share state unreachable')
    expect(panel().textContent).not.toContain(t('calendar.share.not_shared'))
    expect(address()).toBeNull()

    getMock.mockResolvedValue(share())
    await click(t('common.retry'))
    expect(getMock).toHaveBeenCalledTimes(2)
    expect(address()?.value).toContain(`/feeds/calendar/${SLUG}.ics`)
  })

  it('publishes on the create press without asking the server for the state again', async () => {
    getMock.mockResolvedValue(null)
    mintMock.mockResolvedValue(share())
    await open()
    expect(panel().textContent).toContain(t('calendar.share.not_shared'))
    await click(t('calendar.share.create'))
    expect(mintMock).toHaveBeenCalledWith('cal-1')
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(address()?.value).toBe(`${window.location.origin}/feeds/calendar/${SLUG}.ics`)
  })

  it('revokes in place', async () => {
    getMock.mockResolvedValue(share())
    revokeMock.mockResolvedValue(undefined)
    await open()
    await click(t('calendar.share.stop'))
    expect(revokeMock).toHaveBeenCalledWith('cal-1')
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(address()).toBeNull()
    expect(panel().textContent).toContain(t('calendar.share.not_shared'))
  })

  it('copies the whole address', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    getMock.mockResolvedValue(share())
    await open()
    await click(t('common.copy'))
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/feeds/calendar/${SLUG}.ics`)
    expect(panel().textContent).toContain(t('common.copied'))
  })
})
