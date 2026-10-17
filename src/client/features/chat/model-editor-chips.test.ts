/**
 * The model editor's quick picks and the badges the list derives from them.
 *
 * The chips exist so a reader sets 256K without typing 262144, and the badges exist so the same facts are
 * readable without opening the editor. Both are pinned by what they change in the draft, not by markup.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantModel, AssistantProvider } from '@shared/assistant'
import { CONTEXT_WINDOW_STEPS, DEFAULT_LIMITS, TOKEN_STEPS, formatTokenStep } from '@shared/assistant'
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
        fallbackModelId: null,
        inputPrice: null,
        outputPrice: null,
        priceCurrency: '',
        ...over,
    }
}

function provider(over: Partial<AssistantProvider> = {}): AssistantProvider {
    return {
        id: 'p1',
        label: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        endpoints: {},
        hasKey: true,
        keyHint: 'abcd',
        reasoningDialect: null,
        createdAt: 1,
        updatedAt: 1,
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

function open(over: Partial<AssistantModel> = {}, limits = DEFAULT_LIMITS, providerOver: Partial<AssistantProvider> = {}) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const saved = vi.fn()
    act(() => {
        root.render(createElement(ModelEditorDialog, {
            model: model(over),
            provider: provider(providerOver),
            models: [],
            limits: limits,
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
        // A token is counted in binary: 1K is 1024, so the label and the stored number are the same fact.
        expect(TOKEN_STEPS.map(formatTokenStep)).toEqual(['1K', '4K', '8K', '16K', '32K', '64K', '128K', '256K', '512K', '1M'])
        expect(formatTokenStep(1024)).toBe('1K')
        expect(formatTokenStep(1_048_576)).toBe('1M')
        // A number the ladder does not hold is printed as itself rather than rounded into a step it is not.
        expect(formatTokenStep(1000)).toBe('1000')
        expect(formatTokenStep(512)).toBe('512')
    })

    it('gives the input ceiling and the output ceiling the same picks', () => {
        open()
        const row = (name: string) => [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
            .find((node) => node.getAttribute('aria-label') === name)
        const labels = (name: string) => [...row(name)!.querySelectorAll('button[aria-pressed]')].map((node) => node.textContent?.trim())
        expect(labels(t('assistant.model.max_input'))).toEqual(labels(t('assistant.model.max_output')))
        expect(labels(t('assistant.model.max_output'))).toEqual(['1K', '4K', '8K', '16K', '32K', '64K', '128K', '256K', '512K', '1M'])
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
        expect(saved.mock.calls[0]?.[0].contextTokens).toBe(409_600)
    })
    it('offers a preset for the input ceiling and the output ceiling too', () => {
        const { saved } = open()
        press(chip('128K', t('assistant.model.max_input')), 'the 128K input preset')
        press(chip('16K', t('assistant.model.max_output')), 'the 16K output preset')
        save()
        const draft = saved.mock.calls[0]?.[0]
        expect(draft.maxInputTokens).toBe(131_072)
        expect(draft.maxOutputTokens).toBe(16_384)
    })

    it('lays the six-context-window ladder out as one even row rather than three over three', () => {
        open()
        const row = [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
            .find((node) => node.getAttribute('aria-label') === t('assistant.model.context'))
        expect(row, 'the context row is not rendered').toBeTruthy()
        // The dialog is the tallest surface in settings; one row of six is what keeps this section short.
        expect(row!.className).toContain('grid-cols-6')
        expect(row!.querySelectorAll('button')).toHaveLength(CONTEXT_WINDOW_STEPS.length)
    })

    it('lets the inherited note wrap under the field instead of running past the dialog edge', () => {
        open({ maxInputTokens: null })
        const note = [...document.body.querySelectorAll('span')]
            .find((node) => node.textContent?.trim() === t('assistant.model.value_inherited', { tokens: formatTokenStep(DEFAULT_LIMITS.maxInputTokens) }))
        expect(note, 'the inherited note is not rendered').toBeTruthy()
        expect(note!.parentElement!.className).toContain('flex-wrap')
        expect(note!.className).toContain('shrink-0')
    })
})

/** The three token numbers are optional, so emptying one has to be a real state rather than a default typed in. */
describe('leaving a token number unset', () => {
    const box = (row: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${row}"]`)
    const type = (node: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(node, value)
        node.dispatchEvent(new Event('input', { bubbles: true }))
    }

    it('reads a model with no output number back as unset', () => {
        const { saved } = open({ maxOutputTokens: null })
        expect(box(t('assistant.model.max_output'))?.value).toBe('')
        save()
        expect(saved.mock.calls[0]?.[0].maxOutputTokens).toBe(null)
    })

    it('takes the number out when the field is emptied', () => {
        const { saved } = open({ maxOutputTokens: 8192 })
        const field = box(t('assistant.model.max_output'))!
        expect(field.value).toBe('8192')
        act(() => type(field, ''))
        expect(field.value).toBe('')
        save()
        expect(saved.mock.calls[0]?.[0].maxOutputTokens).toBe(null)
        expect(saved.mock.calls[0]?.[0].contextTokens).toBe(null)
        expect(saved.mock.calls[0]?.[0].maxInputTokens).toBe(null)
    })

    it('names the ceiling the model would inherit while its own field is empty', () => {
        // The two account numbers are read off the same row, so the panel has to draw what they add up to:
        // an empty field inherits the assistant's ceiling, and a filled one is this model's own.
        open({ maxOutputTokens: null, maxInputTokens: 65_536 }, DEFAULT_LIMITS)
        expect(document.body.textContent).toContain(t('assistant.model.value_inherited', { tokens: formatTokenStep(DEFAULT_LIMITS.maxOutputTokens) }))
        expect(document.body.textContent).toContain(t('assistant.model.value_own'))
    })

    it('clears a number by pressing the preset that is already taken', () => {
        const { saved } = open({ maxOutputTokens: 16_384 })
        const row = t('assistant.model.max_output')
        expect(chip('16K', row)?.getAttribute('aria-pressed')).toBe('true')
        press(chip('16K', row), 'the 16K preset')
        expect(chip('16K', row)?.getAttribute('aria-pressed')).toBe('false')
        expect(box(row)?.value).toBe('')
        save()
        expect(saved.mock.calls[0]?.[0].maxOutputTokens).toBe(null)
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

describe('the thinking levels a model is offered', () => {
    const select = () => document.body.querySelector<HTMLSelectElement>(`select[aria-label="${t('assistant.composer.thinking')}"]`)
    const levels = () => [...(select()?.options ?? [])].map((option) => option.textContent?.trim())
    /** The note beside the field, reached through the association the field itself declares. */
    const thinkingHint = () => {
        const described = select()?.getAttribute('aria-describedby') ?? ''
        const id = described.split(' ').filter(Boolean).at(-1)
        return id ? document.getElementById(id)?.textContent ?? '' : ''
    }

    it('lists the rungs the model’s own service has, in its order', () => {
        // DeepSeek publishes four rungs of effort and a way to stop thinking, and its middle rung is not
        // the same word as another vendor's middle rung — the list is read from the vendor, not from us.
        open()
        expect(levels()).toEqual([
            t('assistant.reasoning.auto'),
            t('assistant.reasoning.off'),
            t('assistant.reasoning.low'),
            t('assistant.reasoning.medium'),
            t('assistant.reasoning.high'),
        ])
    })

    it('gives a 3.x Gemini its levels rather than the budget form it refuses', () => {
        open({ model: 'gemini-3.8-flash' }, DEFAULT_LIMITS, { label: 'Google', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' })
        expect(levels()).toEqual([
            t('assistant.reasoning.auto'),
            t('assistant.reasoning.minimal'),
            t('assistant.reasoning.low'),
            t('assistant.reasoning.medium'),
            t('assistant.reasoning.high'),
        ])
    })

    it('says out loud that a model which cannot stop thinking has no Off level', () => {
        open({ model: 'claude-opus-4-7' }, DEFAULT_LIMITS, { label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' })
        expect(levels()).toEqual([
            t('assistant.reasoning.auto'),
            t('assistant.reasoning.minimal'),
            t('assistant.reasoning.low'),
            t('assistant.reasoning.medium'),
            t('assistant.reasoning.high'),
            t('assistant.reasoning.xhigh'),
            t('assistant.reasoning.max'),
        ])
        expect(thinkingHint()).toContain(t('assistant.model.reasoning_no_off'))
        expect(thinkingHint()).not.toContain(t('assistant.model.reasoning_hint'))
    })

    it('keeps a stored level the model no longer offers, so the row still says what is saved', () => {
        // The reader changed the provider under a model that was set to a level the new service cannot read;
        // the option stays in the list rather than the select falling back to a level that is not stored.
        open({ reasoning: 'max', model: 'gemini-2.5-flash' }, DEFAULT_LIMITS, { label: 'Google', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' })
        expect(levels()).toContain(t('assistant.reasoning.max'))
        expect(select()?.value).toBe('max')
    })

    it('honours the dialect the reader pinned on the provider', () => {
        // A gateway on an internal host: nothing about the address or the id says DeepSeek, so the pin is
        // the only thing that can put the vendor's own ladder in this list.
        open({ model: 'my-deployment' }, DEFAULT_LIMITS, { label: 'Gateway', baseUrl: 'https://gw.internal.example/v1', reasoningDialect: 'deepseek' })
        expect(levels()).toContain(t('assistant.reasoning.high'))
        expect(levels()).not.toContain(t('assistant.reasoning.xhigh'))
        expect(levels()).toContain(t('assistant.reasoning.off'))
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
