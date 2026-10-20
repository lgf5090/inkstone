// @vitest-environment jsdom
/**
 * The key ring's own screen.
 *
 * Three claims, none of them about markup: the ring is read only when the section is opened, a key is
 * never shown back once written, and the actions send what they say they send. The plaintext claim is the
 * one worth a test of its own — a screen that echoed a key would put it in a screenshot, a screen share
 * and the browser's own form history.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantProvider, AssistantProviderKey } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { api } from '../../lib/api'
import { ProviderKeys, type ProviderWallet } from './ProviderKeys'

let root: Root
let container: HTMLDivElement

/**
 * The card's wallet, emptied.
 *
 * These cases are about the ring — what it reads, what it sends, what it never echoes. The numbers the
 * wallet carries are the card's own claim and are pinned in `wired-surfaces.test.ts`.
 */
const wallet = (): ProviderWallet => ({ balances: null, problem: null, busy: false, reload: async () => {} })

function provider(over: Partial<AssistantProvider> = {}): AssistantProvider {
  return {
    id: 'p1', label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', endpoints: {},
    hasKey: true, icon: '', keyHint: '9876', reasoningDialect: null, createdAt: 1, updatedAt: 1, ...over,
  }
}

function key(over: Partial<AssistantProviderKey> = {}): AssistantProviderKey {
  return {
    id: 'k1', providerId: 'p1', label: 'second', hasKey: true, keyHint: '4321', enabled: true,
    lastUsedAt: null, errorCount: 0, lastError: null, createdAt: 1, updatedAt: 1, ...over,
  }
}

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byText = (label: string) => buttons().find((node) => node.textContent?.trim() === label)
/** The section's own trigger, which is the only button that both names the ring and owns a panel. */
const trigger = () => buttons().find((node) => node.textContent?.includes(t('assistant.keys.title')))
const box = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)

function type(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('the keys a provider rotates through', () => {
  it('reads the ring only once the section is opened, and never shows a key back', async () => {
    const list = vi.spyOn(api.assistant, 'providerKeys').mockResolvedValue({ keys: [key()] })
    await act(async () => { root.render(createElement(ProviderKeys, { provider: provider(), wallet: wallet() })) })
    // The panel is closed, so the request has not been made and the row is not on screen.
    expect(list).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('second')

    await act(async () => { trigger()!.click() })
    expect(list).toHaveBeenCalledWith('p1')
    expect(document.body.textContent).toContain('second')
    // The last four characters are the whole of what is kept: enough to tell two keys apart, useless to
    // anyone reading over a shoulder, and the only form the secret ever takes on screen.
    expect(document.body.textContent).toContain('4321')
    expect(document.body.textContent).toContain('9876')
    // The provider's own key is described the same way the provider row and the edit form describe it.
    expect(document.body.textContent).toContain(t('assistant.settings.key_stored_hint', { hint: '9876' }))
  })

  it('still says a stored key exists when the store kept no last-four hint', async () => {
    vi.spyOn(api.assistant, 'providerKeys').mockResolvedValue({ keys: [] })
    await act(async () => { root.render(createElement(ProviderKeys, { provider: provider({ icon: '', keyHint: '' }), wallet: wallet() })) })
    await act(async () => { trigger()!.click() })
    // No mask is available, but the row must not read as a missing key.
    expect(document.body.textContent).toContain(t('assistant.settings.key_stored'))
    expect(document.body.textContent).not.toContain(t('assistant.settings.key_missing'))
  })

  it('sends a new key with its label, and takes the secret back off the form', async () => {
    vi.spyOn(api.assistant, 'providerKeys').mockResolvedValue({ keys: [] })
    const created = vi.spyOn(api.assistant, 'createProviderKey').mockResolvedValue({ key: key() })
    await act(async () => { root.render(createElement(ProviderKeys, { provider: provider(), wallet: wallet() })) })
    await act(async () => { trigger()!.click() })
    await act(async () => { byText(t('assistant.keys.add'))!.click() })

    act(() => { type(box(t('assistant.keys.label'))!, 'third') })
    act(() => { type(box(t('assistant.keys.secret'))!, 'sk-third-0000') })
    await act(async () => { byText(t('assistant.model.save'))!.click() })

    expect(created).toHaveBeenCalledWith('p1', { label: 'third', apiKey: 'sk-third-0000' })
    // The form closes on success, which is also what keeps the typed secret out of the DOM afterwards.
    expect(box(t('assistant.keys.secret'))).toBeNull()
  })

  it('switches a key off without touching the others', async () => {
    vi.spyOn(api.assistant, 'providerKeys').mockResolvedValue({ keys: [key()] })
    const patched = vi.spyOn(api.assistant, 'updateProviderKey').mockResolvedValue({ key: key({ enabled: false }) })
    await act(async () => { root.render(createElement(ProviderKeys, { provider: provider(), wallet: wallet() })) })
    await act(async () => { trigger()!.click() })

    const toggle = document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${t('assistant.keys.enabled', { label: 'second' })}"]`)
    expect(toggle).toBeTruthy()
    expect(toggle!.getAttribute('aria-checked')).toBe('true')
    await act(async () => { toggle!.click() })
    expect(patched).toHaveBeenCalledWith('p1', 'k1', { enabled: false })
  })

  it('says a provider with no key at all is missing one rather than showing a blank', async () => {
    vi.spyOn(api.assistant, 'providerKeys').mockResolvedValue({ keys: [] })
    await act(async () => { root.render(createElement(ProviderKeys, { provider: provider({ hasKey: false, icon: '', keyHint: '' }), wallet: wallet() })) })
    await act(async () => { trigger()!.click() })
    expect(document.body.textContent).toContain(t('assistant.settings.key_missing'))
  })

  it('renames a key that is already stored, and sends nothing but the name', async () => {
    vi.spyOn(api.assistant, 'providerKeys').mockResolvedValue({ keys: [key()] })
    const patched = vi.spyOn(api.assistant, 'updateProviderKey').mockResolvedValue({ key: key({ label: 'laptop' }) })
    await act(async () => { root.render(createElement(ProviderKeys, { provider: provider(), wallet: wallet() })) })
    await act(async () => { trigger()!.click() })

    const pencil = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('assistant.keys.rename', { label: 'second' })}"]`,
    )
    expect(pencil, 'the row offers no way to name it').toBeTruthy()
    await act(async () => { pencil!.click() })
    act(() => { type(box(t('assistant.keys.label'))!, 'laptop') })
    await act(async () => { byText(t('assistant.model.save'))!.click() })

    // One field in the body: renaming must not read as a chance to re-send or clear the secret.
    expect(patched).toHaveBeenCalledWith('p1', 'k1', { label: 'laptop' })
    // The row goes back to being a row once the name is in.
    expect(box(t('assistant.keys.label'))).toBeNull()
  })
})
