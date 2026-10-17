// @vitest-environment jsdom
/**
 * What the model editor does with the answer to its own save.
 *
 * The dialog used to close the instant Save was pressed, because the write behind it answered the same way
 * whether it worked or was refused — so a refusal looked exactly like a saved model, and the draft the
 * reader had just typed was gone with the dialog. What is pinned here is the other contract: the dialog
 * waits for the answer, closes only on a yes, keeps the draft on a no, says the no above its own buttons,
 * and cannot be dismissed out from under a write that is still in flight.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AssistantModel, AssistantProvider } from '@shared/assistant'
import { DEFAULT_LIMITS } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ModelEditorDialog, type ModelDraft } from './ModelEditorDialog'
import type { ReportFailure } from './assistant-store'

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1',
    providerId: 'p1',
    model: 'deepseek-flash',
    label: 'DeepSeek Flash',
    temperature: null,
    maxOutputTokens: 8192,
    enabled: true,
    reasoning: 'auto',
    contextTokens: null,
    vision: false,
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

const PROVIDER: AssistantProvider = {
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
}

/** The route's answer to a model whose name came back empty, as the store hands it to a form. */
const refused = () => ({ headline: t('api.error.bad_request'), detail: 'A model name is required.' })

let root: Root
let host: HTMLElement
let closed: Mock<() => void>

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')
const saveButton = () => buttons().find((node) => node.textContent?.includes(t('assistant.model.save')))
const alert = () => document.body.querySelector<HTMLElement>('[role="alert"]')
const nameBox = () => document.body.querySelector<HTMLInputElement>(`input[aria-label="${t('assistant.model.name')}"]`)

function type(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

/** A press whose answer arrives a tick later, so the dialog's waiting state is the one being measured. */
async function press(node: HTMLElement | undefined, name: string) {
  expect(node, `${name} is not rendered`).toBeTruthy()
  await act(async () => {
    node!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function render(onSave: (draft: ModelDraft, report: ReportFailure) => Promise<boolean>) {
  act(() => {
    root.render(createElement(ModelEditorDialog, {
      model: model(),
      provider: PROVIDER,
      models: [],
      limits: DEFAULT_LIMITS,
      onClose: closed,
      onSave,
    }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  closed = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('saving a model', () => {
  it('keeps the draft and prints the refusal when the write is refused', async () => {
    const onSave = vi.fn(async (_draft: ModelDraft, report: ReportFailure) => {
      report(refused())
      return false
    })
    render(onSave)
    await act(async () => { type(nameBox()!, 'Renamed by hand') })
    await press(saveButton(), 'the save button')

    expect(dialog(), 'a refused save closed the dialog').toBeTruthy()
    expect(closed).not.toHaveBeenCalled()
    expect(nameBox()?.value).toBe('Renamed by hand')
    expect(alert()?.textContent).toContain(refused().headline)
    expect(alert()?.textContent).toContain('A model name is required.')
  })

  it('closes when the write answers yes', async () => {
    render(async () => true)
    await press(saveButton(), 'the save button')
    expect(closed).toHaveBeenCalled()
    expect(alert()).toBeNull()
  })

  it('says the plain line when a refusal comes back without a reason', async () => {
    render(async () => false)
    await press(saveButton(), 'the save button')
    expect(closed).not.toHaveBeenCalled()
    expect(alert()?.textContent).toContain(t('assistant.toast.failed'))
  })

  it('holds the button shut while the write is in flight, and takes a second press for none', async () => {
    let release!: () => void
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { release = () => resolve(true) }))
    render(onSave)
    await act(async () => { saveButton()!.click() })

    expect(saveButton()?.disabled, 'a save in flight is still pressable').toBe(true)
    expect(saveButton()?.getAttribute('aria-busy')).toBe('true')
    await press(saveButton(), 'the save button, again')
    expect(onSave).toHaveBeenCalledTimes(1)

    await act(async () => { release() })
    expect(closed).toHaveBeenCalled()
  })

  it('takes Escape and the backdrop off a save that is still in flight', async () => {
    let release!: () => void
    render(() => new Promise<boolean>((resolve) => { release = () => resolve(true) }))
    await act(async () => { saveButton()!.click() })

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closed, 'Escape dismissed a dialog with a write in flight').not.toHaveBeenCalled()
    const scrim = document.body.querySelector<HTMLElement>('.anim-fade')
    await act(async () => { scrim!.click() })
    expect(closed, 'the backdrop dismissed a dialog with a write in flight').not.toHaveBeenCalled()

    await act(async () => { release() })
    expect(closed).toHaveBeenCalled()
  })

  it('refuses to send a model with no name, and says so at the field', async () => {
    const onSave = vi.fn(async () => true)
    render(onSave)
    await act(async () => { type(nameBox()!, '   ') })

    expect(saveButton()?.disabled, 'a nameless model can still be sent').toBe(true)
    expect(document.body.textContent).toContain(t('assistant.model.name_required'))
    await press(saveButton(), 'the save button')
    expect(onSave).not.toHaveBeenCalled()

    await act(async () => { type(nameBox()!, 'Back again') })
    expect(saveButton()?.disabled).toBe(false)
    expect(document.body.textContent).not.toContain(t('assistant.model.name_required'))
  })

  it('retires the refusal once the reader has gone back to the draft', async () => {
    const onSave = vi.fn(async (_draft: ModelDraft, report: ReportFailure) => {
      report(refused())
      return false
    })
    render(onSave)
    await press(saveButton(), 'the save button')
    expect(alert(), 'the first refusal never appeared').toBeTruthy()
    await act(async () => { type(nameBox()!, 'Edited after the refusal') })
    expect(alert(), 'the line outlived the draft it was about').toBeNull()
  })
})
