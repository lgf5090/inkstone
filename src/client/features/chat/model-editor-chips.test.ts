/**
 * The model editor's quick picks and the badges the list derives from them.
 *
 * The chips exist so a reader sets 256K without typing 262144, and the badges exist so the same facts are
 * readable without opening the editor. Both are pinned by what they change in the draft, not by markup.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantModel } from '@shared/assistant'
import { CONTEXT_WINDOW_STEPS, formatTokenStep } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ModelEditorDialog, draftFromModel } from './ModelEditorDialog'


function model(over: Partial<AssistantModel> = {}): AssistantModel {
    return {
        id: 'm1',
        providerId: 'p1',
        model: 'deepseek-flash',
        label: 'DeepSeek Flash',
        temperature: 0.7,
        maxOutputTokens: 8192,
        enabled: true,
        reasoning: 'auto',
        contextTokens: null,
        vision: true,
        purpose: 'chat',
        kind: 'text',
        supportsTools: true,
        maxInputTokens: null,
        modalities: [],
        topP: null,
        customParams: [],
        protocol: null,
        ...over,
    }
}

let root: Root
beforeEach(async () => {
    installTestGlobals()
    await initI18n()
})
afterEach(() => {
    if (root) act(() => root.unmount())
    document.body.innerHTML = ''
})

/** The modal portals onto document.body, so that is where its controls have to be looked for. */
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
/**
 * A preset inside one named row. '128K' is offered by both the context row and the input ceiling, so a
 * lookup that ignores which row it belongs to cannot tell the two settings apart.
 */
const chip = (label: string, row?: string) => {
    const scope = row
        ? [...document.body.querySelectorAll<HTMLElement>('[role="group"]')].find((node) => node.getAttribute('aria-label') === row)
        : document.body
    expect(scope, `${row} row is not rendered`).toBeTruthy()
    return [...scope!.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((node) => node.textContent?.trim() === label)
}
const press = (node: HTMLElement | undefined, name: string) => {
    expect(node, `${name} is not rendered`).toBeTruthy()
    act(() => { node!.click() })
}

function open(over: Partial<AssistantModel> = {}) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const saved = vi.fn()
    act(() => {
        root.render(createElement(ModelEditorDialog, {
            model: model(over),
            providerLabel: 'DeepSeek',
            onClose: () => undefined,
            onSave: saved,
        }))
    })
    // The granular half of the editor sits behind the "more settings" door, as the reader reaches it.
    press(buttons().find((node) => node.textContent?.includes(t('assistant.model.more'))), 'the more-settings door')
    return { saved }
}

const save = () => press(buttons().find((node) => node.textContent?.includes(t('assistant.model.save'))), 'the save button')

describe('the quick picks', () => {
    it('labels each step with the number the reader reads off the button', () => {
        expect(CONTEXT_WINDOW_STEPS.map(formatTokenStep)).toEqual(['128K', '200K', '256K', '400K', '512K', '1M'])
        expect(formatTokenStep(1000)).toBe('1K')
        expect(formatTokenStep(512)).toBe('512')
    })
    it('marks the stored value, and only that one, as taken', () => {
        open({ contextTokens: CONTEXT_WINDOW_STEPS[2] })
        const context = t('assistant.model.context')
        expect(chip('256K', context)?.getAttribute('aria-pressed')).toBe('true')
        expect(chip('400K', context)?.getAttribute('aria-pressed')).toBe('false')
        press(chip('400K', context), 'the 400K preset')
        const row = [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
            .find((node) => node.getAttribute('aria-label') === t('assistant.model.context'))
        expect([...row!.querySelectorAll('button[aria-pressed="true"]')].map((node) => node.textContent?.trim())).toEqual(['400K'])
    })
    it('sends the picked step into the draft', () => {
        const { saved } = open()
        press(chip('400K', t('assistant.model.context')), 'the 400K preset')
        save()
        expect(saved.mock.calls[0]?.[0].contextTokens).toBe(400_000)
    })
    it('offers a preset for the input ceiling and the output ceiling too', () => {
        const { saved } = open()
        press(chip('128K', t('assistant.model.max_input')), 'the 128K input preset')
        press(chip('16K', t('assistant.model.max_output')), 'the 16K output preset')
        save()
        const draft = saved.mock.calls[0]?.[0]
        expect(draft.maxInputTokens).toBe(128_000)
        expect(draft.maxOutputTokens).toBe(16_000)
    })
})

describe('the input modality chips', () => {
    it('adds and removes one modality without disturbing the other', () => {
        const { saved } = open({ modalities: ['audio'] })
        expect(chip(t('assistant.model.modality.audio'))?.getAttribute('aria-pressed')).toBe('true')
        expect(chip(t('assistant.model.modality.video'))?.getAttribute('aria-pressed')).toBe('false')
        press(chip(t('assistant.model.modality.video')), 'the video chip')
        press(chip(t('assistant.model.modality.audio')), 'the audio chip')
        save()
        expect(saved.mock.calls[0]?.[0].modalities).toEqual(['video'])
    })
    it('carries the saved set into the draft as a copy', () => {
        expect(draftFromModel(model({ modalities: ['video'] })).modalities).toEqual(['video'])
        const stored = model({ modalities: ['audio'] })
        const draft = draftFromModel(stored)
        draft.modalities.push('video')
        expect(stored.modalities).toEqual(['audio'])
    })
})

describe('the capabilities a model is edited with', () => {
const visionSwitch = () => document.body.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${t('assistant.model.vision')}"]`)
const reasoningSelect = () => document.body.querySelector<HTMLSelectElement>(`select[aria-label="${t('assistant.composer.thinking')}"]`)

describe('the capabilities the model row no longer carries', () => {
    it('read back what a model has, and send what the reader sets', () => {
        const { saved } = open({ reasoning: 'high', vision: true })
        expect(reasoningSelect()?.value).toBe('high')
        expect(visionSwitch()?.getAttribute('aria-checked')).toBe('true')
        press(visionSwitch() ?? undefined, 'the vision switch')
        expect(visionSwitch()?.getAttribute('aria-checked')).toBe('false')
        act(() => {
            const node = reasoningSelect()!
            node.value = 'off'
            node.dispatchEvent(new Event('change', { bubbles: true }))
        })
        save()
        expect(saved.mock.calls[0]?.[0].vision).toBe(false)
        expect(saved.mock.calls[0]?.[0].reasoning).toBe('off')
    })
})
})

describe('the wire protocol a model is called on', () => {
    const protocolSelect = () => document.body.querySelector<HTMLSelectElement>(
        `select[aria-label="${t('assistant.model.protocol')}"]`,
    )

    it('starts on the provider and sends what the reader picks', () => {
        const { saved } = open()
        expect(protocolSelect()?.value).toBe('')
        expect(protocolSelect()?.querySelector('option')?.textContent).toBe(t('assistant.model.protocol.follow'))
        act(() => {
            const node = protocolSelect()!
            node.value = 'anthropic'
            node.dispatchEvent(new Event('change', { bubbles: true }))
        })
        save()
        expect(saved.mock.calls[0]?.[0].protocol).toBe('anthropic')
    })

    it('reads back a model that already names one', () => {
        open({ protocol: 'gemini' })
        expect(protocolSelect()?.value).toBe('gemini')
    })
})
