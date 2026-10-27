import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_INK_SETTINGS, inkAutoSaveDelayMs, useInkSettingsStore } from './ink-settings-store'

describe('ink settings store', () => {
    beforeEach(() => {
        localStorage.clear()
        useInkSettingsStore.getState().resetSettings()
    })

    it('starts from the documented defaults', () => {
        const state = useInkSettingsStore.getState()
        expect(state.filenamePrefix).toBe('Ink ')
        expect(state.filenameDateFormat).toBe('YYYY-MM-DD HH.mm.ss')
        expect(state.useInkExtension).toBe(true)
        expect(state.autoSaveIntervalMs).toBe(2000)
        expect(state.defaultColor).toBe('auto')
        expect(state.paperStyle).toBe('grid')
        expect(state.pressureResponse).toBe('subtle')
        expect(state.canvasBackground).toBe('theme')
        expect(state.openInAdjacentPane).toBe(true)
    })

    it('persists updates and rejects invalid values', () => {
        useInkSettingsStore.getState().updateSettings({ paperStyle: 'dots', defaultColor: '#AABBCC' })
        expect(useInkSettingsStore.getState().paperStyle).toBe('dots')
        expect(JSON.parse(localStorage.getItem('inkstone:inkpad-settings')!)).toMatchObject({ paperStyle: 'dots', defaultColor: '#AABBCC' })

        useInkSettingsStore.getState().updateSettings({ paperStyle: 'nope' as never, defaultColor: 'javascript:' })
        expect(useInkSettingsStore.getState().paperStyle).toBe('dots')
        expect(useInkSettingsStore.getState().defaultColor).toBe('#AABBCC')
    })

    it('clamps the delay where it is read, not where it is edited', () => {
        expect(inkAutoSaveDelayMs(100)).toBe(1800)
        expect(inkAutoSaveDelayMs(5000)).toBe(5000)
        expect(inkAutoSaveDelayMs(6000)).toBe(5000)
        expect(inkAutoSaveDelayMs(Number.NaN)).toBe(DEFAULT_INK_SETTINGS.autoSaveIntervalMs)
    })

    it('resets every field and the stored copy', () => {
        useInkSettingsStore.getState().updateSettings({ folder: 'drawings', openInAdjacentPane: false })
        useInkSettingsStore.getState().resetSettings()
        expect(useInkSettingsStore.getState().folder).toBe('')
        expect(useInkSettingsStore.getState().openInAdjacentPane).toBe(true)
        expect(JSON.parse(localStorage.getItem('inkstone:inkpad-settings')!)).toMatchObject({ folder: '', openInAdjacentPane: true })
    })
})
