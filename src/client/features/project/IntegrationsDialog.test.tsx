import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { IntegrationsDialog } from './IntegrationsDialog'
import * as api from './api'

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

let mounted: ReturnType<typeof renderElement> | undefined

async function open(): Promise<void> {
  await act(async () => {
    mounted = renderElement(createElement(IntegrationsDialog, { boardId: 'b1', onClose: vi.fn() }))
  })
  await flush()
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)
}

beforeEach(async () => {
  document.body.innerHTML = ''
  await initI18n()
  vi.spyOn(api, 'fetchProjectApiTokens').mockResolvedValue([])
  vi.spyOn(api, 'fetchProjectWebhooks').mockResolvedValue([])
  vi.spyOn(api, 'createProjectApiToken').mockResolvedValue({
    token: { id: 'q1', name: 'CI', scope: 'read', boardId: '', expiresAt: null, createdAt: 1, revokedAt: null },
    secret: 'pj_secret',
  })
  vi.spyOn(api, 'createProjectWebhook').mockResolvedValue({
    webhook: { id: 'h1', url: 'https://example.com/hook', events: ['*'], enabled: true, createdAt: 1, pending: 0, lastError: '' },
    secret: 'whsec_secret',
  })
})

afterEach(() => {
  mounted?.unmount()
  document.body.innerHTML = ''
})

describe('the integrations dialog', () => {
  it('shows a load failure with a retry rather than an empty list', async () => {
    vi.mocked(api.fetchProjectApiTokens).mockRejectedValueOnce(new Error('offline'))
    await open()
    expect(document.body.textContent).toContain(t('project.integrations.load_failed'))
    expect(button(t('common.retry'))).not.toBeUndefined()
  })

  it('shows a newly issued token secret once and lists the token without it', async () => {
    await open()
    expect(document.body.textContent).toContain(t('project.integrations.empty_tokens'))
    const name = document.querySelector<HTMLInputElement>(`input[aria-label="${t('project.integrations.name')}"]`)!
    await act(async () => { setInput(name, 'CI') })
    await act(async () => { button(t('project.integrations.create_token'))?.click() })
    await flush()
    expect(api.createProjectApiToken).toHaveBeenCalledWith({ name: 'CI', scope: 'read', boardId: '' })
    expect(document.body.textContent).toContain(t('project.integrations.token_secret'))
    expect(document.querySelector<HTMLInputElement>('input[value="pj_secret"]')).not.toBeNull()
    expect(document.body.textContent).toContain('CI')
  })

  it('creates a webhook and never lists its signing secret', async () => {
    await open()
    const url = document.querySelector<HTMLInputElement>(`input[aria-label="${t('project.integrations.url')}"]`)!
    await act(async () => { setInput(url, 'https://example.com/hook') })
    await act(async () => { button(t('project.integrations.create_webhook'))?.click() })
    await flush()
    expect(api.createProjectWebhook).toHaveBeenCalledWith('b1', { url: 'https://example.com/hook', events: ['*'] })
    expect(document.body.textContent).toContain(t('project.integrations.webhook_secret'))
    expect(document.body.textContent).not.toContain('whsec_secret')
  })
})
