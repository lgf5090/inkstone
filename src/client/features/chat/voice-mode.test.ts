// @vitest-environment jsdom
/**
 * The voice panel's opening screen.
 *
 * The engines themselves have their own tests; what this file pins is the choice the reader is offered
 * before anything is recorded: which engine is possible, which one is preselected, why Start is dim, and
 * where a reader with no realtime model is sent to create one.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantModel, type AssistantSettings } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { VoiceMode } from './VoiceMode'
import { useAssistant } from './assistant-store'

function model(overrides: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'deepseek-flash', label: 'DeepSeek Flash',
    temperature: 0.7, maxOutputTokens: 8192, enabled: true, reasoning: 'auto', contextTokens: null, vision: true,
    purpose: 'chat', kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null,
    customParams: [], protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null,
    priceCurrency: '', ...overrides,
  }
}

const settings = (overrides: Partial<AssistantSettings> = {}): AssistantSettings => ({
  ...DEFAULT_ASSISTANT_SETTINGS,
  ...overrides,
})

/** The browser features the panel asks about before it offers either engine. */
function giveMicrophoneAndWebRtc(): void {
  class Recognition {}
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition })
  Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: class {} })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [], getTracks: () => [] })) },
  })
}

const original = useAssistant.getState()
let root: Root
let host: HTMLElement

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byText = (text: string) => buttons().find((node) => node.textContent?.trim() === text)

async function show(state: Partial<ReturnType<typeof useAssistant.getState>>, onClose = (): void => {}): Promise<void> {
  useAssistant.setState({ ...original, settings: settings(), models: [], ...state })
  await act(async () => { root.render(createElement(VoiceMode, { onClose })) })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  giveMicrophoneAndWebRtc()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.restoreAllMocks()
})

describe('opening voice mode', () => {
  it('starts on the assistant turn when no realtime model is enabled', async () => {
    await show({ settings: settings({ activeModelId: 'm1' }), models: [model()] })
    expect(document.body.textContent).toContain(t('assistant.voice.turn_desc'))
    expect(document.body.textContent).not.toContain(t('assistant.voice.realtime_model'))
    expect(byText(t('assistant.voice.start'))?.disabled).toBe(false)
  })

  it('starts on realtime and needs no chat model when a realtime model exists', async () => {
    await show({
      settings: settings({ activeModelId: null }),
      models: [model({ id: 'r1', model: 'gpt-realtime', label: 'GPT Realtime', purpose: 'realtime' })],
    })
    expect(document.body.textContent).toContain(t('assistant.voice.realtime_desc'))
    expect(document.body.textContent).toContain(t('assistant.voice.realtime_model'))
    expect(document.body.textContent).toContain('GPT Realtime')
    expect(byText(t('assistant.voice.start'))?.disabled).toBe(false)
  })

  it('keeps Start dim and names the missing chat model', async () => {
    await show({ settings: settings({ activeModelId: null }), models: [] })
    expect(document.body.textContent).toContain(t('assistant.voice.no_turn_model'))
    expect(byText(t('assistant.voice.start'))?.disabled).toBe(true)
  })

  it('explains missing realtime configuration and opens model settings from there', async () => {
    const onClose = vi.fn()
    await show({ settings: settings({ activeModelId: 'm1' }), models: [model()] }, onClose)

    const realtimeOption = byText(t('assistant.voice.engine_realtime'))
    await act(async () => { realtimeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(document.body.textContent).toContain(t('assistant.voice.no_realtime'))
    const openSettings = byText(t('assistant.voice.open_model_settings'))
    expect(openSettings).toBeTruthy()
    await act(async () => { openSettings?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useAssistant.getState().view).toBe('settings')
  })
})
