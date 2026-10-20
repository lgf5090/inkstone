import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { FeedSettings } from './FeedSettings'

/**
 * The calendar-subscription block.
 *
 * What these cases pin is the wire between the screen and the owner's endpoints: the block reads the
 * account's list on mount, the generate press really calls the API, and every address it shows is
 * rebuilt from `window.location.origin` rather than trusting the origin a reverse proxy happened to
 * hand the worker. The passcode is never part of that address — it is sent once, hashed by the server,
 * and the screen keeps only the "protected" marker.
 */

const { listMock, createMock, removeMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  createMock: vi.fn(),
  removeMock: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: {
      todos: {
        feed: {
          list: listMock,
          create: createMock,
          remove: removeMock,
        },
      },
    },
  }
})

const SLUG = 'abcdefghjkmnpqrstvwz'

function feed(over: Record<string, unknown> = {}) {
  return {
    slug: SLUG,
    url: 'https://worker.internal/feeds/abcdefghjkmnpqrstvwz.ics',
    hasPassword: false,
    expiresAt: null,
    createdAt: Date.parse('2026-10-20T09:00:00Z'),
    ...over,
  }
}

let view: RenderedElement | null = null

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  })
}

async function render(): Promise<void> {
  view = renderElement(createElement(FeedSettings))
  await settle()
}

function button(label: string): HTMLButtonElement {
  const node = [...(view?.container.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((candidate) => candidate.textContent?.includes(label))
  if (!node) throw new Error(`the "${label}" button is not rendered`)
  return node
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  listMock.mockReset().mockResolvedValue({ feeds: [] })
  createMock.mockReset().mockResolvedValue({ feed: feed() })
  removeMock.mockReset().mockResolvedValue({ ok: true })
})

afterEach(() => {
  view?.unmount()
  view = null
})

describe('the calendar-subscription block', () => {
  it('loads the list, says it is empty, and really creates a feed on the generate press', async () => {
    await render()
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(view?.container.textContent).toContain(t('settings.todo_feed_empty'))

    await click(button(t('settings.todo_feed_create')))

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock).toHaveBeenCalledWith({ password: null, expiresIn: null })
    // The answer is painted without a second read: the row the server minted is the row on screen.
    const address = view?.container.querySelector<HTMLInputElement>('input[readonly]')
    expect(address?.value).toBe(`${window.location.origin}/feeds/${SLUG}.ics`)
  })

  it('rebuilds every address from the browser origin, never from the route answer', async () => {
    listMock.mockResolvedValue({ feeds: [feed({ hasPassword: true })] })
    await render()

    const address = view?.container.querySelector<HTMLInputElement>('input[readonly]')
    expect(address?.value).toBe(`${window.location.origin}/feeds/${SLUG}.ics`)
    expect(address?.value).not.toContain('worker.internal')

    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await click(button(t('common.copy')))
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/feeds/${SLUG}.ics`)
  })

  it('sends the passcode and the chosen lifetime with the create press', async () => {
    await render()

    const password = view?.container.querySelector<HTMLInputElement>('input[type="password"]')
    const expiry = view?.container.querySelector<HTMLSelectElement>('select')
    if (!password || !expiry) throw new Error('the create form is not rendered')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(password, 'correct horse battery')
      password.dispatchEvent(new Event('input', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(expiry, '30')
      expiry.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()

    await click(button(t('settings.todo_feed_create')))

    expect(createMock).toHaveBeenCalledWith({
      password: 'correct horse battery',
      expiresIn: 30 * 24 * 60 * 60 * 1000,
    })
  })

  it('names a failed read and retries it', async () => {
    listMock.mockRejectedValueOnce(new Error('offline'))
    await render()
    expect(view?.container.textContent).toContain(t('settings.todo_feed_load_failed'))

    await click(button(t('common.retry')))
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(view?.container.textContent).toContain(t('settings.todo_feed_empty'))
  })
})
