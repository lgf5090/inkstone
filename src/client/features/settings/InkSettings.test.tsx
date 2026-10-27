import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { useInkSettingsStore } from '../inkpad/ink-settings-store'
import { InkSettings } from './InkSettings'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(async () => {
    await initI18n()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    useInkSettingsStore.getState().resetSettings()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root.render(createElement(InkSettings)))
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
})

describe('InkSettings', () => {
    it('shows the drawing settings and writes the folder through the store', () => {
        expect(container.textContent).toContain('How a new .ink drawing is created')
        const input = container.querySelector<HTMLInputElement>('input')!
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        act(() => {
            setValue?.call(input, 'drawings')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        expect(useInkSettingsStore.getState().folder).toBe('drawings')
    })

    it('resets every field from the button', () => {
        act(() => useInkSettingsStore.getState().updateSettings({ folder: 'drawings', useInkExtension: false }))
        const reset = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reset ink settings')!
        act(() => reset.click())
        expect(useInkSettingsStore.getState().folder).toBe('')
        expect(useInkSettingsStore.getState().useInkExtension).toBe(true)
    })
})
