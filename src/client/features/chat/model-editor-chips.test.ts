/**
 * The model editor's quick picks and the badges the list derives from them.
 *
 * The chips exist so a reader sets 256K without typing 262144, and the badges exist so the same facts are
 * readable without opening the editor. Both are pinned by what they change in the draft, not by markup.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AssistantModel, AssistantProvider } from '@shared/assistant'
import { DEFAULT_LIMITS, MAX_TOKEN_CEILING, TOKEN_STEPS, formatTokenStep } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ContextMenu, formatContext } from './ComposerControls'
import { ModelEditorDialog, draftFromModel, type ModelDraft } from './ModelEditorDialog'
import type { ReportFailure } from './assistant-store'


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
        vendorContextTokens: null,
        vendorMaxOutputTokens: null,
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
/** The presets one named row offers, read off their own labels. */
const rowLabels = (row: string) => {
    const scope = [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
        .find((node) => node.getAttribute('aria-label') === row)
    expect(scope, `${row} row is not rendered`).toBeTruthy()
    return [...scope!.querySelectorAll('button[aria-pressed]')].map((node) => node.textContent?.trim())
}
/** The note under the output field: its hint, and the warning line the ceiling adds to it. */
const outputNote = () => [...document.body.querySelectorAll('p')]
    .find((node) => node.textContent?.includes(t('assistant.model.max_output_hint')))

function open(over: Partial<AssistantModel> = {}, limits = DEFAULT_LIMITS, providerOver: Partial<AssistantProvider> = {}) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    // Saving waits for the write's answer now, so the stub has to give one: true, which is the case in
    // which the dialog is allowed to close and nothing is printed above its buttons.
    const saved: Mock<(draft: ModelDraft, report: ReportFailure) => Promise<boolean>> = vi.fn(async () => true)
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

const save = async () => {
    await act(async () => {
        press(buttons().find((node) => node.textContent?.includes(t('assistant.model.save'))), 'the save button')
    })
}

describe('the quick picks', () => {
    it('labels each step with the number the reader reads off the button', () => {
        // A token is counted in binary: 1K is 1024, so the label and the stored number are the same fact.
        expect(TOKEN_STEPS.map(formatTokenStep)).toEqual(['1K', '4K', '8K', '16K', '32K', '64K', '128K', '192K', '200K', '256K', '400K', '512K', '1M'])
        expect(formatTokenStep(1024)).toBe('1K')
        expect(formatTokenStep(1_048_576)).toBe('1M')
        // A count that is not on the ladder — a default nobody picked, or a number somebody typed — still has
        // to read as a size. Four million shown as 4000000 is a wall of digits with no unit in it.
        expect(formatTokenStep(MAX_TOKEN_CEILING)).toBe('~4M')
        expect(formatTokenStep(DEFAULT_LIMITS.maxContextTokens)).toBe('~6K')
        // Under a K the number is already the shortest honest answer, so it stays the number.
        expect(formatTokenStep(1000)).toBe('1000')
        expect(formatTokenStep(512)).toBe('512')
    })

    it('gives every token field the same ladder, the small windows included', () => {
        open()
        const row = (name: string) => [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
            .find((node) => node.getAttribute('aria-label') === name)
        const labels = (name: string) => [...row(name)!.querySelectorAll('button[aria-pressed]')].map((node) => node.textContent?.trim())
        const context = labels(t('assistant.model.context'))
        // One setting, one set of picks: the model editor used to stop at 128K and start there, so 32K of
        // context — the default the budget tab answers with — could not be picked at all.
        expect(context).toEqual(labels(t('assistant.model.max_input')))
        expect(labels(t('assistant.model.max_input'))).toEqual(labels(t('assistant.model.max_output')))
        expect(context).toEqual(['1K', '4K', '8K', '16K', '32K', '64K', '128K', '192K', '200K', '256K', '400K', '512K', '1M'])
        expect(context).toContain('32K')
        expect(context).toContain('64K')
    })
    it('marks the stored value, and only that one, as taken', () => {
        open({ contextTokens: 262_144 })
        const context = t('assistant.model.context')
        expect(chip('256K', context)?.getAttribute('aria-pressed')).toBe('true')
        expect(chip('400K', context)?.getAttribute('aria-pressed')).toBe('false')
        press(chip('400K', context), 'the 400K preset')
        const row = [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
            .find((node) => node.getAttribute('aria-label') === t('assistant.model.context'))
        expect([...row!.querySelectorAll('button[aria-pressed="true"]')].map((node) => node.textContent?.trim())).toEqual(['400K'])
    })
    it('sends the picked step into the draft', async () => {
        const { saved } = open()
        press(chip('400K', t('assistant.model.context')), 'the 400K preset')
        await save()
        expect(saved.mock.calls[0]?.[0].contextTokens).toBe(409_600)
    })
    it('offers a preset for the input ceiling and the output ceiling too', async () => {
        const { saved } = open()
        press(chip('128K', t('assistant.model.max_input')), 'the 128K input preset')
        press(chip('16K', t('assistant.model.max_output')), 'the 16K output preset')
        await save()
        const draft = saved.mock.calls[0]?.[0]
        expect(draft.maxInputTokens).toBe(131_072)
        expect(draft.maxOutputTokens).toBe(16_384)
    })

    // A reply cannot be longer than the window it is written inside. Offering 1M of output on a model the
    // reader has just declared as holding 64K invites a provider rejection that used to come back as a
    // sentence with nothing in it to act on.
    it('stops offering output presets above the window the model declares', () => {
        open({ contextTokens: 65_536 })
        const row = [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
            .find((node) => node.getAttribute('aria-label') === t('assistant.model.max_output'))
        const labels = [...row!.querySelectorAll('button[aria-pressed]')].map((node) => node.textContent?.trim())
        expect(labels).toContain('64K')
        expect(labels).not.toContain('128K')
        expect(labels).not.toContain('1M')
    })

    it('keeps a stored output ceiling pickable even when it is past the window', () => {
        // The reader has to be able to see the number they are being asked to lower, and a row that hid it
        // would show nothing as selected and leave them hunting for it.
        open({ contextTokens: 65_536, maxOutputTokens: 262_144 })
        expect(chip('256K', t('assistant.model.max_output'))?.getAttribute('aria-pressed')).toBe('true')
    })

    it('leaves the whole ladder on the table for a model whose window nobody declared', () => {
        // The account's context budget is a limit on what to send, not a claim about any model's window,
        // and its default is smaller than the default output ceiling. Filtering by it would silently
        // shorten every answer from a reader who never opened either field.
        open({ contextTokens: null })
        const row = [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
            .find((node) => node.getAttribute('aria-label') === t('assistant.model.max_output'))
        expect([...row!.querySelectorAll('button[aria-pressed]')].map((node) => node.textContent?.trim()))
            .toEqual(TOKEN_STEPS.map((tokens) => formatTokenStep(tokens)))
    })

    // The vendor's own number is a second source for the same ceiling, and the reader never has to know
    // what the model's page says for the ladder to respect it.
    it('cuts the output ladder by the ceiling the vendor stated, not only by a hand-declared window', () => {
        open({ vendorMaxOutputTokens: 8_192, maxOutputTokens: null })
        const labels = rowLabels(t('assistant.model.max_output'))
        expect(labels).toContain('8K')
        expect(labels).not.toContain('16K')
        expect(labels).not.toContain('1M')
        // The window row keeps the whole ladder: the ceiling is on the answer, not on what the model holds.
        expect(rowLabels(t('assistant.model.context'))).toEqual(TOKEN_STEPS.map((tokens) => formatTokenStep(tokens)))
    })

    it('cuts the output ladder by the window the vendor stated when the reader declared none', () => {
        open({ vendorContextTokens: 65_536 })
        const labels = rowLabels(t('assistant.model.max_output'))
        expect(labels).toContain('64K')
        expect(labels).not.toContain('128K')
    })

    it('holds the tighter of the vendor’s ceiling and the reader’s window', () => {
        // A model declared to hold a million of context and stated to answer eight thousand at a time is
        // the exact shape of the complaint: the field was reachable, and the provider said no.
        open({ contextTokens: 1_048_576, vendorMaxOutputTokens: 8_192 })
        expect(rowLabels(t('assistant.model.max_output'))).not.toContain('128K')
    })

    it('says the figure and that the vendor stated it when the stored ceiling is past it', () => {
        open({ vendorMaxOutputTokens: 8_192, maxOutputTokens: 262_144 })
        expect(outputNote()?.textContent).toContain(t('assistant.model.limit_over_vendor', { tokens: '8K' }))
        expect(outputNote()?.textContent).not.toContain(t('assistant.model.limit_over_declared', { tokens: '8K' }))
    })

    it('names the reader’s own window as the bound when nobody else stated one', () => {
        open({ contextTokens: 65_536, maxOutputTokens: 262_144 })
        expect(outputNote()?.textContent).toContain(t('assistant.model.limit_over_declared', { tokens: '64K' }))
        expect(outputNote()?.textContent).not.toContain(t('assistant.model.limit_over_vendor', { tokens: '64K' }))
    })

    it('adds nothing to the note while no bound is known, however large the number in the field is', () => {
        // The paragraph is the field's description, so a warning that is not there must not be in it: an
        // invented ceiling would tell the reader their 1M is a problem nobody stated.
        open({ maxOutputTokens: 1_048_576 })
        expect(outputNote()?.textContent).toBe(t('assistant.model.max_output_hint'))
    })

    it('lays the shared ladder out as even rows of seven rather than a ragged three', () => {
        open()
        const row = [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
            .find((node) => node.getAttribute('aria-label') === t('assistant.model.context'))
        expect(row, 'the context row is not rendered').toBeTruthy()
        // The dialog is the tallest surface in settings; seven to a line keeps the three token fields to two
        // rows each, with the vendor windows on the second one.
        expect(row!.className).toContain('grid-cols-7')
        expect(row!.querySelectorAll('button')).toHaveLength(TOKEN_STEPS.length)
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

    it('reads a model with no output number back as unset', async () => {
        const { saved } = open({ maxOutputTokens: null })
        expect(box(t('assistant.model.max_output'))?.value).toBe('')
        await save()
        expect(saved.mock.calls[0]?.[0].maxOutputTokens).toBe(null)
    })

    it('takes the number out when the field is emptied', async () => {
        const { saved } = open({ maxOutputTokens: 8192 })
        const field = box(t('assistant.model.max_output'))!
        expect(field.value).toBe('8192')
        act(() => type(field, ''))
        expect(field.value).toBe('')
        await save()
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

    it('clears a number by pressing the preset that is already taken', async () => {
        const { saved } = open({ maxOutputTokens: 16_384 })
        const row = t('assistant.model.max_output')
        expect(chip('16K', row)?.getAttribute('aria-pressed')).toBe('true')
        press(chip('16K', row), 'the 16K preset')
        expect(chip('16K', row)?.getAttribute('aria-pressed')).toBe('false')
        expect(box(row)?.value).toBe('')
        await save()
        expect(saved.mock.calls[0]?.[0].maxOutputTokens).toBe(null)
    })
})

describe('the input modality chips', () => {
    it('adds and removes one modality without disturbing the other', async () => {
        const { saved } = open({ modalities: ['audio'] })
        expect(chip(t('assistant.model.modality.audio'))?.getAttribute('aria-pressed')).toBe('true')
        expect(chip(t('assistant.model.modality.video'))?.getAttribute('aria-pressed')).toBe('false')
        press(chip(t('assistant.model.modality.video')), 'the video chip')
        press(chip(t('assistant.model.modality.audio')), 'the audio chip')
        await save()
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
    it('read back what a model has, and send what the reader sets', async () => {
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
        await save()
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

    it('starts on the provider and sends what the reader picks', async () => {
        const { saved } = open()
        expect(protocolSelect()?.value).toBe('')
        expect(protocolSelect()?.querySelector('option')?.textContent).toBe(t('assistant.model.protocol.follow'))
        act(() => {
            const node = protocolSelect()!
            node.value = 'anthropic'
            node.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await save()
        expect(saved.mock.calls[0]?.[0].protocol).toBe('anthropic')
    })

    it('reads back a model that already names one', () => {
        open({ protocol: 'gemini' })
        expect(protocolSelect()?.value).toBe('gemini')
    })
})

/**
 * The third screen that holds a context number: the composer's own chip.
 *
 * It used to carry a ladder of its own, ending where the editor's began, so the reader met two sets of
 * budgets for one setting. All three now come from `TOKEN_STEPS`.
 */
describe('the context budget the composer offers', () => {
    it('snaps to the ladder the model editor and the budget tab use', async () => {
        const host = document.createElement('div')
        document.body.appendChild(host)
        const menuRoot = createRoot(host)
        await act(async () => { menuRoot.render(createElement(ContextMenu, { value: null, onPick: vi.fn() })) })
        await act(async () => {
            document.body.querySelector<HTMLButtonElement>('button')!
                .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        })
        const picks = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
            .map((node) => node.textContent?.trim())
        expect(picks).toEqual([t('assistant.context.follow_global'), ...TOKEN_STEPS.map(formatContext)])
        await act(async () => { menuRoot.unmount() })
        host.remove()
    })
})
