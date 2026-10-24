// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailSummary } from '@shared/email/model'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { ConfirmHost } from '../../src/client/components/overlay'
import { t } from '../../src/client/lib/i18n'
import { TrashPanel } from '../../src/client/features/email/TrashPanel'
import { useEmailStore } from '../../src/client/features/email/store'

const original = useEmailStore.getState()

function row(): EmailSummary {
  return {
    id: 'm1',
    folderId: 'trash',
    subject: 'Old invoice',
    sender: 'Billing <billing@example.com>',
    recipient: 'me@example.com',
    cc: null,
    bcc: null,
    date: new Date().toISOString(),
    read: true,
    starred: false,
    threadId: null,
    snippet: 'Invoice attached.',
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

function plainButton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

let view: RenderedElement | null = null

beforeEach(() => {
  useEmailStore.setState(original, true)
  useEmailStore.setState({
    trash: [row()],
    trashTotal: 1,
    trashStatus: 'ready',
    trashError: null,
    trashPage: 1,
  })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  useEmailStore.setState(original, true)
})

describe('the trash panel', () => {
  it('asks before emptying the trash and then calls the account store', async () => {
    const loadTrash = vi.fn(async () => {})
    const emptyTrash = vi.fn(async () => {})
    useEmailStore.setState({ loadTrash, emptyTrash })
    view = renderElement(
      createElement(Fragment, null,
        createElement(TrashPanel, { open: true, accountId: 'a1', onClose: () => {} }),
        createElement(ConfirmHost)),
    )
    await settle()
    expect(document.body.textContent).toContain('Old invoice')
    act(() => { plainButton(t('email.trash.clear')).click() })
    await settle()
    expect(document.body.textContent).toContain(t('email.trash.clear_title'))
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((node) => node.textContent?.includes(t('email.trash.clear_title')))!
    const confirmButton = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === t('email.trash.clear'))!
    act(() => { confirmButton.click() })
    await settle()
    expect(emptyTrash).toHaveBeenCalledWith('a1')
  })
})
