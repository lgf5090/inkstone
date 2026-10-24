import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { MailToTaskSettings } from './MailToTaskSettings'

/**
 * The email-to-task block.
 *
 * What these cases pin is the wire between the screen and the owner's endpoints: the block reads the
 * address on mount, the issue press really calls the API, a refused read keeps its reason on screen
 * (a deployment without MAIL_DOMAIN must not read as "you never asked for one"), and the revoke press
 * confirms before it spends the door.
 */

const { getMock, createMock, removeMock, confirmMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  createMock: vi.fn(),
  removeMock: vi.fn(),
  confirmMock: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: {
      todos: {
        mailToken: {
          get: getMock,
          create: createMock,
          remove: removeMock,
        },
      },
    },
  }
})

vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: confirmMock }
})

const ADDRESS = 'u+7f3c9a1b2d4e5f60718293a4b5c6d7e8f9@mail.example.com'

let view: RenderedElement | null = null

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  })
}

async function render(): Promise<void> {
  view = renderElement(createElement(MailToTaskSettings))
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
  getMock.mockReset().mockResolvedValue({ address: null, createdAt: null })
  createMock.mockReset().mockResolvedValue({ address: ADDRESS, createdAt: Date.parse('2026-10-20T09:00:00Z') })
  removeMock.mockReset().mockResolvedValue({ revoked: true })
  confirmMock.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  view?.unmount()
  view = null
})

describe('the email-to-task block', () => {
  it('reads the address on mount and offers the door when the account has none', async () => {
    await render()

    expect(getMock).toHaveBeenCalledTimes(1)
    expect(view?.container.textContent).toContain(t('settings.todo_mail_none'))
    await click(button(t('settings.todo_mail_issue')))
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(view?.container.textContent).toContain(ADDRESS)
  })

  it('opens on the address the account already holds', async () => {
    getMock.mockResolvedValue({ address: ADDRESS, createdAt: Date.parse('2026-10-20T09:00:00Z') })
    await render()

    expect(view?.container.textContent).toContain(ADDRESS)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('keeps the reason a refused read gave, rather than reading as "none yet"', async () => {
    getMock.mockRejectedValue(new Error('Email-to-task is unavailable: MAIL_DOMAIN must be set'))
    await render()

    expect(view?.container.textContent).toContain('MAIL_DOMAIN')
    expect(view?.container.textContent).not.toContain(t('settings.todo_mail_none'))
  })

  it('rotates the address without a question, and revokes one only after the dialog', async () => {
    getMock.mockResolvedValue({ address: ADDRESS, createdAt: Date.parse('2026-10-20T09:00:00Z') })
    await render()

    await click(button(t('settings.todo_mail_rotate')))
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(confirmMock).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(false)
    await click(button(t('settings.todo_mail_revoke')))
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(removeMock).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(true)
    await click(button(t('settings.todo_mail_revoke')))
    expect(removeMock).toHaveBeenCalledTimes(1)
    expect(view?.container.textContent).toContain(t('settings.todo_mail_none'))
  })
})
