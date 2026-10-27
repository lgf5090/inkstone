import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder } from '@shared/types'
import { useNotes } from '../../store/notes'
import { parseInkDocumentResult } from '../../lib/inkpad/format'
import { useInkSettingsStore } from './ink-settings-store'

describe('createInkNote', () => {
    let payload: Record<string, unknown> | null = null

    beforeEach(() => {
        payload = null
        useInkSettingsStore.getState().resetSettings()
        useNotes.setState({
            createNote: vi.fn(async (input: Record<string, unknown>) => {
                payload = input
                return 'new-note'
            }) as never,
            notes: {},
            folders: [
                { id: 'f-drawings', name: 'Drawings', parentId: null, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 } as Folder,
            ],
        })
    })

    it('uses the prefix, date and .ink extension by default', async () => {
        const id = await useNotes.getState().createInkNote()
        expect(id).toBe('new-note')
        expect(payload?.title).toMatch(/^Ink \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.ink$/)
        expect(payload?.open).toBe(true)
        const parsed = parseInkDocumentResult(String(payload?.content))
        expect(parsed.ok).toBe(true)
    })

    it('can create an ordinary note with the extension off', async () => {
        useInkSettingsStore.getState().updateSettings({ useInkExtension: false, filenamePrefix: 'Sketch ' })
        await useNotes.getState().createInkNote()
        expect(String(payload?.title).startsWith('Sketch ')).toBe(true)
        expect(String(payload?.title).endsWith('.ink')).toBe(false)
    })

    it('resolves the configured folder by name and id', async () => {
        useInkSettingsStore.getState().updateSettings({ folder: 'Drawings' })
        await useNotes.getState().createInkNote()
        expect(payload?.folderId).toBe('f-drawings')

        useInkSettingsStore.getState().updateSettings({ folder: 'f-drawings' })
        await useNotes.getState().createInkNote()
        expect(payload?.folderId).toBe('f-drawings')
    })

    it('prefers an explicit folder and drops an unknown configured name', async () => {
        useInkSettingsStore.getState().updateSettings({ folder: 'Drawings' })
        await useNotes.getState().createInkNote('f-explicit')
        expect(payload?.folderId).toBe('f-explicit')

        useInkSettingsStore.getState().updateSettings({ folder: 'Nope' })
        await useNotes.getState().createInkNote()
        expect(payload?.folderId).toBeNull()
    })
})
