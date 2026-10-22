// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MemoWebhook,
  MemoWebhookCreateResult,
  MemoWebhookInput,
} from '@shared/memos/types'
import { ConfirmHost } from '../../../../components/overlay'
import { ApiError } from '../../../../lib/api'
import { initI18n, t } from '../../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../../lib/test-render'
import { WebhooksSettings } from './WebhooksSettings'

const client = vi.hoisted(() => ({
  list: vi.fn<(signal?: AbortSignal) => Promise<MemoWebhook[]>>(),
  create: vi.fn<(input: MemoWebhookInput) => Promise<MemoWebhookCreateResult>>(),
  update: vi.fn<(id: string, input: MemoWebhookInput) => Promise<MemoWebhook>>(),
  delete: vi.fn<(id: string) => Promise<{ ok: true }>>(),
  regenerateSecret: vi.fn<(id: string) => Promise<MemoWebhookCreateResult>>(),
}))

vi.mock('../../webhook-client', () => ({ memoWebhooksClient: client }))

const CREATED_SECRET = 'whsec_created_secret_value'
const REGENERATED_SECRET = 'whsec_regenerated_secret_value'

let items: MemoWebhook[] = []
let nextId = 0
let rendered: RenderedElement | null = null

function webhook(overrides: Partial<MemoWebhook> = {}): MemoWebhook {
  return {
    id: 'webhook-1',
    title: 'Release bot',
    url: 'https://example.com/hooks/memos',
    signingSecretSet: true,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  }
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(times = 2): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function labeledControl<T extends HTMLElement>(text: string): T {
  const label = [...document.querySelectorAll('label')]
    .find((node) => node.textContent?.trim() === text)
  const control = label?.htmlFor ? document.getElementById(label.htmlFor) : null
  if (!control) throw new Error(`no labeled control ${text}`)
  return control as T
}

function labeledControlWithin<T extends HTMLElement>(root: ParentNode, text: string): T {
  const label = [...root.querySelectorAll('label')]
    .find((node) => node.textContent?.trim() === text)
  const control = label?.htmlFor ? document.getElementById(label.htmlFor) : null
  if (!control) throw new Error(`no labeled control ${text}`)
  return control as T
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

function submit(form: HTMLFormElement): void {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!found) throw new Error('no dialog')
  return found
}

function renderWebhooks(): HTMLElement {
  rendered = renderElement(createElement(
    Fragment,
    null,
    createElement(WebhooksSettings),
    createElement(ConfirmHost),
  ))
  return rendered.container
}

beforeEach(async () => {
  await initI18n()
  vi.clearAllMocks()
  items = []
  nextId = 0
  client.list.mockImplementation(() => Promise.resolve(items))
  client.create.mockImplementation((input) => {
    nextId += 1
    const created = webhook({ id: `webhook-${nextId}`, title: input.title, url: input.url })
    items = [created, ...items]
    return Promise.resolve({ webhook: created, signingSecret: CREATED_SECRET })
  })
  client.update.mockImplementation((id, input) => {
    const current = items.find((item) => item.id === id)
    if (!current) return Promise.reject(new ApiError(404, 'not_found', 'Webhook not found'))
    const updated: MemoWebhook = {
      ...current,
      title: input.title,
      url: input.url,
      updatedAt: current.updatedAt + 1,
    }
    items = items.map((item) => (item.id === id ? updated : item))
    return Promise.resolve(updated)
  })
  client.delete.mockImplementation((id) => {
    items = items.filter((item) => item.id !== id)
    return Promise.resolve({ ok: true })
  })
  client.regenerateSecret.mockImplementation((id) => {
    const current = items.find((item) => item.id === id)
    if (!current) return Promise.reject(new ApiError(404, 'not_found', 'Webhook not found'))
    return Promise.resolve({ webhook: current, signingSecret: REGENERATED_SECRET })
  })
})

afterEach(() => {
  act(() => { rendered?.unmount() })
  rendered = null
  document.body.innerHTML = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  vi.unstubAllGlobals()
})

describe('the webhook settings section', () => {
  it('lists webhooks with their secret status', async () => {
    items = [
      webhook(),
      webhook({
        id: 'webhook-2',
        title: 'Legacy endpoint',
        url: 'https://example.com/hooks/legacy',
        signingSecretSet: false,
      }),
    ]
    const host = renderWebhooks()
    await flush()
    expect(host.textContent).toContain('Release bot')
    expect(host.textContent).toContain('https://example.com/hooks/memos')
    expect(host.textContent).toContain('https://example.com/hooks/legacy')
    expect(host.textContent).toContain(t('memos.settings.webhooks_secret_set'))
    expect(host.textContent).toContain(t('memos.settings.webhooks_secret_missing'))
    expect(host.textContent).not.toContain(t('memos.settings.webhooks_empty'))
  })

  it('shows the empty state when the account has no webhooks', async () => {
    const host = renderWebhooks()
    await flush()
    expect(host.textContent).toContain(t('memos.settings.webhooks_empty'))
    expect(host.textContent).not.toContain(t('memos.settings.webhooks_secret_set'))
  })

  it('creates a webhook and shows its signing secret exactly once', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const host = renderWebhooks()
    await flush()
    expect(client.list).toHaveBeenCalledTimes(1)

    setValue(labeledControl<HTMLInputElement>(t('memos.settings.webhooks_title_label')), '  Release bot  ')
    setValue(
      labeledControl<HTMLInputElement>(t('memos.settings.webhooks_url_label')),
      ' https://example.com/hooks/memos ',
    )
    submit(buttonNamed(t('memos.settings.webhooks_create')).closest('form')!)
    await flush(3)

    expect(client.create).toHaveBeenCalledWith({
      title: 'Release bot',
      url: 'https://example.com/hooks/memos',
    })
    const sheet = dialog()
    const secretInput = sheet.querySelector<HTMLInputElement>('input[readonly]')
    expect(secretInput?.value).toBe(CREATED_SECRET)
    expect(sheet.textContent).toContain(t('memos.settings.webhooks_secret_warning'))
    expect(host.textContent).toContain('Release bot')
    expect(client.list).toHaveBeenCalledTimes(2)

    click(buttonNamed(t('memos.settings.webhooks_copy')))
    await flush()
    expect(writeText).toHaveBeenCalledWith(CREATED_SECRET)
    expect(sheet.textContent).toContain(t('memos.settings.webhooks_copied'))

    click(buttonNamed(t('memos.settings.webhooks_done')))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain(CREATED_SECRET)
  })

  it('validates the title and the endpoint URL before calling the server', async () => {
    const host = renderWebhooks()
    await flush()

    submit(buttonNamed(t('memos.settings.webhooks_create')).closest('form')!)
    await flush()
    expect(host.textContent).toContain(t('memos.settings.webhooks_title_required'))
    expect(client.create).not.toHaveBeenCalled()

    setValue(labeledControl<HTMLInputElement>(t('memos.settings.webhooks_title_label')), 'x'.repeat(121))
    setValue(labeledControl<HTMLInputElement>(t('memos.settings.webhooks_url_label')), 'https://example.com/hook')
    submit(buttonNamed(t('memos.settings.webhooks_create')).closest('form')!)
    await flush()
    expect(host.textContent).toContain(t('memos.settings.webhooks_title_too_long', { max: 120 }))

    setValue(labeledControl<HTMLInputElement>(t('memos.settings.webhooks_title_label')), 'Automation')
    setValue(labeledControl<HTMLInputElement>(t('memos.settings.webhooks_url_label')), 'ftp://example.com/hook')
    submit(buttonNamed(t('memos.settings.webhooks_create')).closest('form')!)
    await flush()
    expect(host.textContent).toContain(t('memos.settings.webhooks_url_invalid'))
    expect(client.create).not.toHaveBeenCalled()
  })

  it('surfaces the server reason when a webhook is refused', async () => {
    const host = renderWebhooks()
    await flush()
    client.create.mockRejectedValueOnce(new ApiError(
      400,
      'bad_request',
      t('api.error.bad_request'),
      undefined,
      'Webhook URL host is not allowed',
    ))
    setValue(labeledControl<HTMLInputElement>(t('memos.settings.webhooks_title_label')), 'Automation')
    setValue(labeledControl<HTMLInputElement>(t('memos.settings.webhooks_url_label')), 'https://example.com/hook')
    submit(buttonNamed(t('memos.settings.webhooks_create')).closest('form')!)
    await flush()
    expect(host.textContent).toContain(t('memos.settings.webhooks_create_failed'))
    expect(host.textContent).toContain('Webhook URL host is not allowed')
  })

  it('edits a webhook from a dialog and refreshes the list', async () => {
    items = [webhook()]
    const host = renderWebhooks()
    await flush()

    click(buttonNamed(t('memos.settings.webhooks_edit')))
    const sheet = dialog()
    expect(labeledControlWithin<HTMLInputElement>(sheet, t('memos.settings.webhooks_title_label')).value)
      .toBe('Release bot')
    expect(labeledControlWithin<HTMLInputElement>(sheet, t('memos.settings.webhooks_url_label')).value)
      .toBe('https://example.com/hooks/memos')

    setValue(
      labeledControlWithin<HTMLInputElement>(sheet, t('memos.settings.webhooks_title_label')),
      'Weekly digest',
    )
    setValue(
      labeledControlWithin<HTMLInputElement>(sheet, t('memos.settings.webhooks_url_label')),
      'https://example.com/hooks/digest',
    )
    submit(sheet.querySelector('form')!)
    await flush(3)

    expect(client.update).toHaveBeenCalledWith('webhook-1', {
      title: 'Weekly digest',
      url: 'https://example.com/hooks/digest',
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(host.textContent).toContain('Weekly digest')
    expect(host.textContent).toContain('https://example.com/hooks/digest')
  })

  it('regenerates the signing secret through a confirmation and reveals it once', async () => {
    items = [webhook()]
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const host = renderWebhooks()
    await flush()

    click(buttonNamed(t('memos.settings.webhooks_regenerate')))
    const confirmation = dialog()
    expect(confirmation.textContent).toContain(t('memos.settings.webhooks_regenerate_title'))
    click(buttonNamed(t('memos.common.cancel')))
    await flush()
    expect(client.regenerateSecret).not.toHaveBeenCalled()

    click(buttonNamed(t('memos.settings.webhooks_regenerate')))
    click(buttonNamed(t('memos.settings.webhooks_regenerate_confirm')))
    await flush(3)

    expect(client.regenerateSecret).toHaveBeenCalledWith('webhook-1')
    const sheet = dialog()
    const secretInput = sheet.querySelector<HTMLInputElement>('input[readonly]')
    expect(secretInput?.value).toBe(REGENERATED_SECRET)
    click(buttonNamed(t('memos.settings.webhooks_copy')))
    await flush()
    expect(writeText).toHaveBeenCalledWith(REGENERATED_SECRET)
    expect(host.textContent).toContain(t('memos.settings.webhooks_secret_set'))

    click(buttonNamed(t('memos.settings.webhooks_done')))
    expect(document.body.textContent).not.toContain(REGENERATED_SECRET)
  })

  it('deletes a webhook only after the custom confirmation', async () => {
    items = [webhook({ id: 'webhook-1', title: 'Release bot' }), webhook({ id: 'webhook-2', title: 'Digest' })]
    const host = renderWebhooks()
    await flush()

    click(buttonNamed(t('memos.settings.webhooks_delete')))
    expect(dialog().textContent).toContain(t('memos.settings.webhooks_delete_title'))
    click(buttonNamed(t('memos.common.cancel')))
    await flush()
    expect(client.delete).not.toHaveBeenCalled()

    click(buttonNamed(t('memos.settings.webhooks_delete')))
    click(buttonNamed(t('memos.settings.webhooks_delete_confirm')))
    await flush(3)

    expect(client.delete).toHaveBeenCalledWith('webhook-1')
    expect(host.textContent).not.toContain('Release bot')
    expect(host.textContent).toContain('Digest')
  })

  it('reports a load failure and retries', async () => {
    client.list.mockRejectedValueOnce(new ApiError(500, 'internal', 'backend unavailable'))
    const host = renderWebhooks()
    await flush()
    expect(host.textContent).toContain('backend unavailable')

    click(buttonNamed(t('memos.common.retry')))
    await flush()
    expect(client.list).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain(t('memos.settings.webhooks_empty'))
  })
})
