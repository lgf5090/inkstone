// @vitest-environment jsdom
/**
 * The provider form's own guard rail.
 *
 * A browser can autocomplete a saved username into the text box sitting above a password field, and the
 * address boxes are optional. The reader must see which box says what, before any request is sent — and
 * the save they did mean must still go through.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ProviderForm } from './AssistantSettingsView'
import { useAssistant } from './assistant-store'

const original = useAssistant.getState()
let root: Root
let container: HTMLDivElement

const geminiBox = () => document.querySelector<HTMLInputElement>(
  `input[aria-label="${t('assistant.settings.endpoint_other')} ${t('assistant.settings.protocol.gemini')}"]`,
)
const baseBox = () => document.querySelector<HTMLInputElement>('input.font-mono')
const submit = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.textContent?.trim() === t('assistant.settings.add_provider'))

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
  useAssistant.setState({ ...original, addProvider: vi.fn(async () => undefined), updateProvider: vi.fn(async () => undefined) })
  await act(async () => { root.render(createElement(ProviderForm, { open: true, onClose: () => undefined })) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('an address box that got something else typed into it', () => {
  it('names the box, and refuses to send a half-address', () => {
    const box = geminiBox()
    expect(box, 'the optional gemini address is not rendered').toBeTruthy()
    act(() => { type(box!, 'lgf5090') })
    expect(box?.getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain(t('assistant.settings.address_invalid'))
    expect(submit()?.disabled, 'the save should be blocked while a box is not an address').toBe(true)
  })

  it('sends the rest of the form once the junk is taken back out', async () => {
    const box = geminiBox()
    const anthropic = document.querySelector<HTMLInputElement>(
      `input[aria-label="${t('assistant.settings.endpoint_other')} ${t('assistant.settings.protocol.anthropic')}"]`,
    )
    expect(anthropic, 'the optional anthropic address is not rendered').toBeTruthy()
    // A half-typed scheme is "nothing entered": it must not travel to the route as an address.
    act(() => { type(anthropic!, 'https://') })
    act(() => { type(box!, 'https://generativelanguage.googleapis.com') })
    expect(box?.getAttribute('aria-invalid')).toBe(null)
    expect(submit()?.disabled).toBe(false)
    await act(async () => { submit()!.click() })
    const body = vi.mocked(useAssistant.getState().addProvider).mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.endpoints).toEqual({ gemini: 'https://generativelanguage.googleapis.com' })
  })

  it('treats a scheme with no host as nothing entered, so the preset can be saved as typed', async () => {
    act(() => { type(baseBox()!, 'https://') })
    expect(document.body.textContent).toContain(t('assistant.settings.address_missing'))
    expect(submit()?.disabled).toBe(true)
    act(() => { type(baseBox()!, 'https://api.deepseek.com') })
    expect(submit()?.disabled).toBe(false)
    await act(async () => { submit()!.click() })
    expect((useAssistant.getState().addProvider as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].endpoints).toEqual({})
  })
})
