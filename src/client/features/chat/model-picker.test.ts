// @vitest-environment jsdom
/**
 * The picker that turns a vendor's listing into the reader's models.
 *
 * Two halves are pinned: the filter over the list (search, "not added yet", the families the account
 * actually reports), and the drive — the ticks have to reach the store as the set the provider is made to
 * match, and a listing that failed must leave the manual entry reachable rather than an empty dialog.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantModel, AssistantProvider, AssistantVendorModel } from '@shared/assistant'
import { MAX_PROVIDER_MODELS } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { api } from '../../lib/api'
import { ModelPickerDialog, pickerRows, vendorFamilies } from './ModelPickerDialog'
import { useAssistant } from './assistant-store'

vi.mock('../../lib/api', () => ({
  // The store's failure path names the class, so the mock has to carry it.
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      vendorModels: vi.fn(async () => ({ ok: true, error: null, models: [] })),
      createModel: vi.fn(async (body: Record<string, unknown>) => ({ model: body })),
      deleteModel: vi.fn(async () => ({ deleted: true })),
      settings: vi.fn(async () => ({ settings: {}, models: [] })),
    },
  },
}))

const PROVIDER: AssistantProvider = {
  id: 'p1', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', endpoints: {},
  hasKey: true, icon: '', keyHint: '', reasoningDialect: null, createdAt: 1, updatedAt: 1,
}

function vendor(id: string, over: Partial<AssistantVendorModel> = {}): AssistantVendorModel {
  return { id, label: over.label ?? id, ownedBy: over.ownedBy ?? 'deepseek', created: over.created ?? 100, ...over }
}

function model(id: string, vendorId: string): AssistantModel {
  return {
    id, providerId: 'p1', model: vendorId, label: vendorId, temperature: null, maxOutputTokens: 4096,
    enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat', kind: 'text',
    supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [], protocol: null,
    fallbackModelId: null,
    inputPrice: null, outputPrice: null, priceCurrency: '', pricePeriods: [], icon: '',
  }
}

const LISTED = [
  vendor('deepseek-chat', { created: 300 }),
  vendor('deepseek-reasoner', { created: 200, label: 'DeepSeek Reasoner' }),
  vendor('other-model', { ownedBy: 'other-vendor', created: 100 }),
]

const original = useAssistant.getState()
let root: Root
let container: HTMLDivElement

const buttons = () => [...document.body.querySelectorAll('button')]
const rows = () => buttons().filter((node) => node.getAttribute('role') === 'checkbox')
const rowFor = (id: string) => rows().find((node) => node.textContent?.includes(id))
const click = async (node: Element | undefined) => {
  if (!node) throw new Error('control is missing')
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useAssistant.setState({
    ...original,
    models: [model('m1', 'deepseek-chat')],
    vendorModels: LISTED,
    vendorModelsError: null,
    vendorModelsLoading: false,
    loadVendorModels: vi.fn(async () => undefined),
    syncVendorModels: vi.fn(async () => ({ added: 2, removed: 0 })),
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('the list the picker shows', () => {
  it('sorts newest first and marks what the account already has', () => {
    const listed = pickerRows(LISTED, [model('m1', 'deepseek-chat')], '', null, false)
    expect(listed.map((row) => row.model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner', 'other-model'])
    expect(listed[0]?.added).toBe(true)
    expect(listed[1]?.added).toBe(false)
  })

  it('keeps what the words match, and only the new ones when asked', () => {
    expect(pickerRows(LISTED, [], 'reasoner', null, false).map((row) => row.model.id)).toEqual(['deepseek-reasoner'])
    expect(pickerRows(LISTED, [model('m1', 'deepseek-chat')], '', null, true).map((row) => row.model.id))
      .toEqual(['deepseek-reasoner', 'other-model'])
  })

  it('filters by the family the vendor itself reported', () => {
    expect(vendorFamilies(LISTED)).toEqual(['deepseek', 'other-vendor'])
    expect(pickerRows(LISTED, [], '', 'other-vendor', false).map((row) => row.model.id)).toEqual(['other-model'])
  })
})

describe('the dialog', () => {
  async function openDialog() {
    const props = { provider: PROVIDER, onSynced: vi.fn(), onClose: vi.fn(), onCustom: vi.fn() }
    await act(async () => { root.render(createElement(ModelPickerDialog, props)) })
    return props
  }

  function typeInto(node: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('asks this provider for its own list when it opens', async () => {
    await openDialog()
    expect(useAssistant.getState().loadVendorModels).toHaveBeenCalledWith('p1')
  })

  it('opens holding the models this provider already has, and hands the whole set to the store', async () => {
    await openDialog()
    expect(rows()).toHaveLength(3)
    // The row's own model is ticked, so the save is what makes the listing and the account agree.
    expect(rowFor('deepseek-chat')?.getAttribute('aria-checked')).toBe('true')
    await click(rowFor('deepseek-reasoner'))
    await click(rowFor('other-model'))
    expect(rowFor('deepseek-reasoner')?.getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain(t('assistant.picker.add', { count: 2 }))
    // A second press takes the tick back off, or a mis-click could not be undone.
    await click(rowFor('deepseek-reasoner'))
    expect(rowFor('deepseek-reasoner')?.getAttribute('aria-checked')).toBe('false')
    expect(document.body.textContent).toContain(t('assistant.picker.add', { count: 1 }))
    // Unticking a row the account has is a removal, and the footer says so in its own number.
    await click(rowFor('deepseek-chat'))
    expect(document.body.textContent).toContain(`${t('assistant.picker.add', { count: 1 })} · ${t('assistant.picker.remove', { count: 1 })}`)
    await click(rowFor('deepseek-chat'))
    await click(rowFor('deepseek-reasoner'))
    await click(buttons().find((node) => node.textContent?.includes(t('assistant.picker.apply'))))
    expect(useAssistant.getState().syncVendorModels)
      .toHaveBeenCalledWith('p1', ['other-model', 'deepseek-chat', 'deepseek-reasoner'])
  })

  it('cannot be pressed until a tick would change something', async () => {
    const props = await openDialog()
    const apply = () => buttons().find((node) => node.textContent?.trim() === t('assistant.picker.apply'))
    expect(apply()?.hasAttribute('disabled')).toBe(true)
    await click(rowFor('deepseek-reasoner'))
    expect(apply()?.hasAttribute('disabled')).toBe(false)
    await click(rowFor('deepseek-reasoner'))
    expect(apply()?.hasAttribute('disabled')).toBe(true)
    expect(props.onSynced, 'nothing was asked for').not.toHaveBeenCalled()
  })

  it('narrows the list as the reader types', async () => {
    await openDialog()
    const input = document.querySelector('input')
    if (!input) throw new Error('the search box is missing')
    await act(async () => { typeInto(input, 'reasoner') })
    expect(rows().map((node) => node.textContent)).toHaveLength(1)
    expect(rowFor('deepseek-reasoner')).toBeTruthy()
  })

  it('says the listing failed and still offers the manual entry', async () => {
    useAssistant.setState({ vendorModels: [], vendorModelsError: 'HTTP 401: Invalid API key' })
    const props = await openDialog()
    expect(document.body.textContent).toContain('HTTP 401')
    expect(rows()).toHaveLength(0)
    await click(buttons().find((node) => node.textContent?.includes(t('assistant.picker.custom'))))
    expect(props.onCustom).toHaveBeenCalledTimes(1)
  })
})

describe('the same dialog on a provider the form has not saved', () => {
  const DRAFT = { protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-draft-1', label: 'DeepSeek' }

  it('asks with the key in the form and hands the ids back instead of writing rows', async () => {
    const loadDraft = vi.fn(async () => undefined)
    act(() => { useAssistant.setState({ loadDraftVendorModels: loadDraft }) })
    const onPicked = vi.fn()
    await act(async () => {
      root.render(createElement(ModelPickerDialog, {
        draft: DRAFT,
        existing: ['deepseek-chat'],
        onPicked,
        onClose: vi.fn(),
      }))
    })
    expect(loadDraft).toHaveBeenCalledWith({ protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-draft-1' })
    // An id the form is already holding is marked, so the reader does not add it twice.
    expect(rowFor('deepseek-chat')?.textContent).toContain(t('assistant.picker.already'))
    await click(rowFor('deepseek-reasoner'))
    await click(buttons().find((node) => node.textContent?.includes(t('assistant.picker.use', { count: 2 }))))
    expect(onPicked).toHaveBeenCalledWith(['deepseek-chat', 'deepseek-reasoner'])
    expect(useAssistant.getState().syncVendorModels, 'nothing may be written before the provider exists').not.toHaveBeenCalled()
  })

  it('stops at the cap the create call honours, so no tick is dropped afterwards', async () => {
    const many = Array.from({ length: MAX_PROVIDER_MODELS + 1 }, (_, index) => vendor(`m-${index}`))
    act(() => {
      useAssistant.setState({ vendorModels: many, loadDraftVendorModels: vi.fn(async () => undefined) })
    })
    const onPicked = vi.fn()
    await act(async () => {
      root.render(createElement(ModelPickerDialog, { draft: DRAFT, onPicked, onClose: vi.fn() }))
    })
    for (const entry of many) await click(rowFor(entry.id))
    expect(document.body.textContent).toContain(t('assistant.picker.cap', { count: MAX_PROVIDER_MODELS }))
    await click(buttons().find((node) => node.textContent?.includes(t('assistant.picker.use', { count: MAX_PROVIDER_MODELS }))))
    expect(onPicked.mock.calls[0]?.[0]).toHaveLength(MAX_PROVIDER_MODELS)
  })
})

describe('making the account match the ticks', () => {
  it('posts each missing id once with the vendor’s label, drops the unticked one, and keeps going past a refusal', async () => {
    useAssistant.setState({
      ...original,
      models: [model('m1', 'deepseek-chat'), model('m2', 'hand-typed')],
      vendorModels: LISTED,
      loadSettings: vi.fn(async () => undefined),
    }, true)
    vi.mocked(api.assistant.createModel).mockImplementationOnce(async () => {
      throw new Error('duplicate')
    })
    const result = await useAssistant.getState().syncVendorModels('p1', ['deepseek-reasoner', 'other-model'])
    expect(result).toEqual({ added: 1, removed: 1 })
    expect(api.assistant.createModel).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.assistant.createModel).mock.calls[1]?.[0])
      .toMatchObject({ providerId: 'p1', model: 'other-model', label: 'other-model' })
    // The unticked id is one the vendor listed, so the account drops it — and the id the reader typed in
    // is not the listing's to name, so it stays.
    expect(api.assistant.deleteModel).toHaveBeenCalledTimes(1)
    expect(api.assistant.deleteModel).toHaveBeenCalledWith('m1')
  })
})
