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
import type { AssistantProvider, AssistantVendorModel } from '@shared/assistant'
import { PROVIDER_PRESETS } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ProviderForm } from './AssistantModelTab'
import { useAssistant } from './assistant-store'

const original = useAssistant.getState()
const onCloseSpy = vi.fn()
let root: Root
let container: HTMLDivElement

const geminiBox = () => document.querySelector<HTMLInputElement>(
  `input[aria-label="${t('assistant.settings.endpoint_other')} ${t('assistant.settings.protocol.gemini')}"]`,
)
const baseBox = () => document.querySelector<HTMLInputElement>('input.font-mono')
const submit = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.textContent?.trim() === t('assistant.settings.add_provider'))
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
/** The trigger is the only control that both shows a preset name and owns the panel. */
const presetTrigger = (label: string) => buttons().find((node) => node.textContent?.trim() === label && node.hasAttribute('aria-expanded'))
/** Rows inside the open panel, as opposed to the trigger, which keeps showing the current preset. */
const presetRows = (label: string) => [...(document.querySelector('ul')?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  .filter((node) => node.textContent?.trim() === label)
const presetSearch = () => document.querySelector<HTMLInputElement>(`input[aria-label="${t('assistant.settings.preset_search')}"]`)
const keyBox = () => document.querySelector<HTMLInputElement>('input[type="password"]')
/** The models box, named by what the preset seeded rather than by its place in the form. */
const modelsBox = () => [...document.querySelectorAll<HTMLInputElement>('input')].find((node) => node.value.includes('deepseek-chat'))
const fetchButton = () => buttons().find((node) => node.textContent?.trim() === t('assistant.settings.models_fetch'))
const pickerRow = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((node) => node.textContent?.includes(label))
const pickerUse = (count: number) => buttons().find((node) => node.textContent?.trim() === t('assistant.picker.use', { count }))

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
  useAssistant.setState({ ...original, addProvider: vi.fn(async () => null), updateProvider: vi.fn(async () => true) })
  await act(async () => { root.render(createElement(ProviderForm, { open: true, onClose: () => undefined })) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('choosing a vendor from the preset list', () => {
  it('finds a preset by its address and seeds the address box from it', () => {
    const first = PROVIDER_PRESETS[0]!
    const gemini = PROVIDER_PRESETS.find((entry) => entry.id === 'gemini')!
    expect(presetTrigger(first.label), 'the preset trigger is not rendered').toBeTruthy()
    act(() => { presetTrigger(first.label)!.click() })
    expect(presetSearch(), 'the search box is not rendered').toBeTruthy()
    // The address is searched too: a reader who remembers the host but not the display name gets there.
    act(() => { type(presetSearch()!, 'generativelanguage') })
    const row = presetRows(gemini.label)[0]
    expect(row, 'the matching preset is not offered').toBeTruthy()
    expect(presetRows(first.label), 'a preset that no longer matches is still offered').toHaveLength(0)
    act(() => { row?.click() })
    expect(baseBox()?.value).toBe(gemini.baseUrl)
    expect(presetTrigger(gemini.label), 'the trigger does not show the chosen preset').toBeTruthy()
  })

  it('says so when nothing matches, rather than showing an empty panel', () => {
    act(() => { presetTrigger(PROVIDER_PRESETS[0]!.label)!.click() })
    act(() => { type(presetSearch()!, 'zzz-nothing') })
    expect(document.body.textContent).toContain(t('assistant.settings.preset_none'))
  })
})

describe('saving a provider', () => {
  it('sends the mark the chosen preset seeded', async () => {
    await act(async () => { submit()!.click() })
    expect(vi.mocked(useAssistant.getState().addProvider)).toHaveBeenCalledWith(
      expect.objectContaining({ icon: 'brand:deepseek' }),
      expect.any(Function),
    )
  })

  it('hands the created row back so its model listing can be opened', async () => {
    const created = {
      id: 'p1', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', hasKey: true, endpoints: {},
    } as unknown as AssistantProvider
    const onCreated = vi.fn()
    // The route's answer is stubbed rather than the whole store re-set, so nothing re-renders mid-test.
    vi.mocked(useAssistant.getState().addProvider).mockResolvedValue(created)
    await act(async () => { root.render(createElement(ProviderForm, { open: true, onClose: onCloseSpy, onCreated })) })
    await act(async () => { submit()!.click() })
    expect(onCreated).toHaveBeenCalledWith(created)
    // The form closes first: the listing opens on top of the settings screen, not of this dialog.
    expect(onCloseSpy).toHaveBeenCalled()
  })
})

describe('asking the vendor what a key can call, before saving', () => {
  const listed: AssistantVendorModel[] = [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', ownedBy: 'google', created: 1 },
  ]

  it('says what it is waiting for instead of offering a dead button', () => {
    expect(fetchButton()?.disabled, 'without a key there is nothing to ask with').toBe(true)
    expect(document.body.textContent).toContain(t('assistant.settings.models_fetch_hint'))
  })

  it('puts the ticked ids into the models box the form will send', async () => {
    // The listing is the vendor's answer, so it is stubbed at the store's own door rather than fetched.
    act(() => {
      useAssistant.setState({
        loadDraftVendorModels: vi.fn(async () => {
          useAssistant.setState({ vendorModels: listed, vendorModelsLoading: false, vendorModelsError: null })
        }),
      })
    })
    const box = modelsBox()
    expect(box, 'the models box is not rendered').toBeTruthy()
    act(() => { type(keyBox()!, 'sk-test-123456') })
    await act(async () => { fetchButton()!.click() })
    const row = pickerRow('Gemini 2.5 Flash')
    expect(row, 'the vendor row is not offered').toBeTruthy()
    await act(async () => { row!.click() })
    await act(async () => { pickerUse(1)!.click() })
    expect(box!.value).toBe('gemini-2.5-flash')
    // The dialog is gone again: the ids land in the form, which is still open behind it.
    expect(pickerRow('Gemini 2.5 Flash')).toBeFalsy()
  })
})

describe('the thinking dialect a provider is pinned to', () => {
  const dialectSelect = () => document.querySelector<HTMLSelectElement>(`select[aria-label="${t('assistant.settings.dialect')}"]`)
  const dialectValues = () => [...(dialectSelect()?.options ?? [])].map((option) => option.value)
  /** The protocol select has no label of its own; its options are what identify it. */
  const protocolSelect = () => [...document.querySelectorAll<HTMLSelectElement>('select')]
    .find((node) => [...node.options].some((option) => option.value === 'anthropic'))
  const choose = (node: HTMLSelectElement | null | undefined, value: string, name: string) => {
    expect(node, `${name} is not rendered`).toBeTruthy()
    act(() => {
      node!.value = value
      node!.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const sentBody = async () => {
    await act(async () => { submit()!.click() })
    return vi.mocked(useAssistant.getState().addProvider).mock.calls[0]?.[0] as Record<string, unknown>
  }

  it('starts on automatic, which sends no pin at all', async () => {
    expect(dialectSelect()?.value).toBe('')
    expect(dialectSelect()?.querySelector('option')?.textContent).toBe(t('assistant.settings.dialect.auto'))
    expect((await sentBody()).reasoningDialect).toBe(null)
  })

  it('offers only the dialects the chosen wire can carry', () => {
    // An effort shape means nothing in a Gemini body, so the list is the reader's protocol's own set rather
    // than every dialect the app knows about.
    expect(dialectValues()).toEqual(['', 'openai', 'deepseek', 'qwen', 'openrouter'])
    choose(protocolSelect(), 'anthropic', 'the protocol select')
    expect(dialectValues()).toEqual(['', 'claude-budget', 'claude-effort'])
    choose(protocolSelect(), 'gemini', 'the protocol select')
    expect(dialectValues()).toEqual(['', 'gemini-budget', 'gemini-level'])
  })

  it('sends the pin the reader chose', async () => {
    choose(dialectSelect(), 'deepseek', 'the dialect select')
    expect((await sentBody()).reasoningDialect).toBe('deepseek')
  })

  it('drops a pin that no longer fits after the protocol is switched', async () => {
    choose(dialectSelect(), 'deepseek', 'the dialect select')
    choose(protocolSelect(), 'anthropic', 'the protocol select')
    expect(dialectSelect()?.value, 'the stale pin is still shown as taken').toBe('')
    expect((await sentBody()).reasoningDialect).toBe(null)
  })

  it('reads back the pin a saved provider carries', async () => {
    const provider = {
      id: 'p1', label: 'Gateway', protocol: 'openai', baseUrl: 'https://gw.internal.example/v1',
      endpoints: {}, hasKey: true, icon: '', keyHint: '1234', reasoningDialect: 'qwen', createdAt: 1, updatedAt: 1,
    } as unknown as AssistantProvider
    await act(async () => { root.render(createElement(ProviderForm, { open: true, provider, onClose: () => undefined })) })
    expect(dialectSelect()?.value).toBe('qwen')
    await act(async () => {
      buttons().find((node) => node.textContent?.trim() === t('assistant.settings.edit_provider'))!.click()
    })
    expect((vi.mocked(useAssistant.getState().updateProvider).mock.calls[0]?.[1] as Record<string, unknown>).reasoningDialect).toBe('qwen')
  })
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

/**
 * The edit form opens with an empty password box, because the plaintext is not ours to show again.
 * What the reader must not read into that is "my key is gone": the box names the stored key by its
 * last four characters and says a blank save keeps it, and a blank save has to actually keep it.
 */
describe('the key box of a provider that already has one', () => {
  const saved = {
    id: 'p1', label: 'Gateway', protocol: 'openai', baseUrl: 'https://gw.internal.example/v1',
    endpoints: {}, hasKey: true, icon: '', keyHint: '1234', reasoningDialect: null, createdAt: 1, updatedAt: 1,
  } as unknown as AssistantProvider
  const editButton = () => buttons().find((node) => node.textContent?.trim() === t('assistant.settings.edit_provider'))
  /** The note a field declares it is described by, reached through the association alone. */
  const describedBy = (field: HTMLInputElement) => (field.getAttribute('aria-describedby') ?? '')
    .split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
  const openEditor = async (provider: AssistantProvider = saved) => {
    await act(async () => {
      root.render(createElement(ProviderForm, { open: true, provider, onClose: () => undefined }))
    })
  }
  const sentBody = async () => {
    await act(async () => { editButton()!.click() })
    return vi.mocked(useAssistant.getState().updateProvider).mock.calls[0]?.[1] as Record<string, unknown>
  }

  it('names the stored key by its last four and says a blank box keeps it', async () => {
    await openEditor()
    const field = keyBox()
    expect(field, 'the key field is not rendered').toBeTruthy()
    // The box is empty — that is the point — but it is not silent about why.
    expect(field!.value).toBe('')
    expect(field!.placeholder).toBe(t('assistant.settings.api_key_saved_placeholder', { hint: '1234' }))
    expect(describedBy(field!)).toContain(t('assistant.settings.api_key_edit_hint', { hint: '1234' }))
  })

  it('sends no key at all when the box was left alone, so the stored one survives', async () => {
    await openEditor()
    const body = await sentBody()
    // Not an empty string: an omitted field is what tells the worker to keep the ciphertext.
    expect('apiKey' in body).toBe(false)
  })

  it('sends a replacement when the reader types one', async () => {
    await openEditor()
    act(() => { type(keyBox()!, 'sk-new-9999') })
    expect((await sentBody()).apiKey).toBe('sk-new-9999')
  })

  it('falls back to a mask-free claim when the store kept no last-four hint', async () => {
    await openEditor({ ...saved, icon: '', keyHint: '' } as AssistantProvider)
    expect(keyBox()!.placeholder).toBe(t('assistant.settings.api_key_saved_placeholder_nohint'))
    expect(describedBy(keyBox()!)).toContain(t('assistant.settings.api_key_edit_hint_nohint'))
  })

  it('offers a paste prompt when the provider has no key yet', async () => {
    await openEditor({ ...saved, hasKey: false, icon: '', keyHint: '' } as AssistantProvider)
    expect(keyBox()!.placeholder).toBe(t('assistant.settings.api_key_placeholder'))
    expect(describedBy(keyBox()!)).toContain(t('assistant.settings.api_key_hint'))
  })
})

/**
 * The answer to the save, and what the form does with it.
 *
 * The form used to close on every press because the store's write resolved the same whether the route
 * took it or refused it — so the reader watched a dialog disappear over a model that was never saved. A
 * refusal now stays on the screen, with the reason above the buttons and the draft still in the boxes.
 */
describe('a save the route refuses', () => {
  const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })
  const editButton = () => buttons().find((node) => node.textContent?.trim() === t('assistant.settings.edit_provider'))
  const press = async (node: HTMLButtonElement | undefined, name: string) => {
    expect(node, `${name} is not rendered`).toBeTruthy()
    await act(async () => {
      node!.click()
      await tick()
    })
  }
  const refusal = () => ({
    headline: t('api.error.bad_request'),
    detail: 'The reasoning dialect is not one this protocol speaks.',
  })

  it('keeps the new provider open, with the reason above its buttons', async () => {
    const failure = refusal()
    vi.mocked(useAssistant.getState().addProvider).mockImplementation(async (_body, report) => {
      report?.(failure)
      return null
    })
    await act(async () => { root.render(createElement(ProviderForm, { open: true, onClose: onCloseSpy })) })
    await press(submit(), 'the add button')

    expect(onCloseSpy, 'a refused save closed the form').not.toHaveBeenCalled()
    const alert = document.querySelector('[role="alert"]')
    expect(alert, 'the refusal was said nowhere').toBeTruthy()
    expect(alert?.textContent).toContain(failure.headline)
    // The route's own sentence is the second line: the headline alone names the kind of mistake, not the field.
    expect(alert?.textContent).toContain(failure.detail!)
  })

  it('keeps an edit open when the route refuses it', async () => {
    const failure = refusal()
    vi.mocked(useAssistant.getState().updateProvider).mockImplementation(async (_id, _body, report) => {
      report?.(failure)
      return false
    })
    const provider = {
      id: 'p1', label: 'Gateway', protocol: 'openai', baseUrl: 'https://gw.internal.example/v1',
      endpoints: {}, hasKey: true, icon: '', keyHint: '1234', reasoningDialect: null, createdAt: 1, updatedAt: 1,
    } as unknown as AssistantProvider
    await act(async () => { root.render(createElement(ProviderForm, { open: true, provider, onClose: onCloseSpy })) })
    await press(editButton(), 'the save button')

    expect(onCloseSpy).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(failure.detail!)
  })

  it('holds the button shut while the write is out, and takes no second press', async () => {
    const add = vi.mocked(useAssistant.getState().addProvider)
    let release!: () => void
    add.mockImplementation(() => new Promise<AssistantProvider | null>((resolve) => { release = () => resolve(null) }))
    await act(async () => { root.render(createElement(ProviderForm, { open: true, onClose: onCloseSpy })) })
    await press(submit(), 'the add button')
    expect(add).toHaveBeenCalledTimes(1)
    expect(submit()?.disabled, 'a save in flight can be pressed again').toBe(true)
    expect(submit()?.getAttribute('aria-busy')).toBe('true')
    await press(submit(), 'the add button, again')
    expect(add).toHaveBeenCalledTimes(1)
    await act(async () => {
      release()
      await tick()
    })
    // The write came back with nothing, which is a refusal: the form is still here.
    expect(onCloseSpy).not.toHaveBeenCalled()
  })

  it('closes a save that answers, and only then', async () => {
    const created = {
      id: 'p9', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', hasKey: true, endpoints: {},
    } as unknown as AssistantProvider
    vi.mocked(useAssistant.getState().addProvider).mockResolvedValue(created)
    await act(async () => { root.render(createElement(ProviderForm, { open: true, onClose: onCloseSpy })) })
    await press(submit(), 'the add button')
    expect(onCloseSpy).toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})
