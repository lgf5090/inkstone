// @vitest-environment jsdom
/**
 * The picker's contract: one press chooses a brand, the default clears an override, and an upload hands
 * back the mark the helper produced rather than the file itself.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { AssistantIconPicker } from './AssistantIconPicker'
import { iconFromFile } from './assistant-icon-upload'

vi.mock('./assistant-icon-upload', () => ({ iconFromFile: vi.fn(async () => 'data:image/png;base64,AAAA') }))

let rendered: RenderedElement | null = null
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byText = (text: string) => buttons().find((node) => node.textContent?.trim() === text)

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('choosing an icon', () => {
  it('opens on brands and hands back the chosen one', async () => {
    const onChange = vi.fn()
    rendered = renderElement(createElement(AssistantIconPicker, { value: '', fallback: 'brand:deepseek', onChange }))
    act(() => { byText(t('assistant.icon.choose'))!.click() })
    const qwen = byText('Qwen')
    expect(qwen, 'the brand grid is not rendered').toBeTruthy()
    act(() => { qwen!.click() })
    expect(onChange).toHaveBeenCalledWith('brand:qwen')
    // The choice is the whole task, so the dialog is gone.
    expect(document.body.textContent).not.toContain(t('assistant.icon.title'))
  })

  it('clears an override back to the inferred mark', () => {
    const onChange = vi.fn()
    rendered = renderElement(createElement(AssistantIconPicker, { value: 'brand:qwen', fallback: 'brand:deepseek', onChange }))
    act(() => { byText(t('assistant.icon.default'))!.click() })
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('uploads through the helper and closes with the produced data URL', async () => {
    const onChange = vi.fn()
    rendered = renderElement(createElement(AssistantIconPicker, { value: '', onChange }))
    act(() => { byText(t('assistant.icon.choose'))!.click() })
    act(() => { byText(t('assistant.icon.upload'))!.click() })
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File([new Uint8Array([1, 2, 3])], 'mark.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(iconFromFile).toHaveBeenCalledWith(file)
    expect(onChange).toHaveBeenCalledWith('data:image/png;base64,AAAA')
  })
})
