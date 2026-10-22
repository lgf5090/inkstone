// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMO_PREFERENCES_DEFAULTS } from '@shared/memos/constants'
import type { MemoAttachment, MemoPreferences } from '@shared/memos/types'
import { ApiError } from '../../../lib/api'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { AttachmentAudio } from './AttachmentMedia'

const api = vi.hoisted(() => ({
  preferences: { get: vi.fn() },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, memosApi: api }
})

const ai = vi.hoisted(() => ({
  providers: vi.fn(),
  transcribe: vi.fn(),
}))

vi.mock('../ai-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai-client')>()
  return { ...actual, memoAi: ai }
})

let view: RenderedElement | null = null

function attachment(overrides: Partial<MemoAttachment> = {}): MemoAttachment {
  return {
    id: 'audio-1',
    filename: 'voice.mp3',
    mime: 'audio/mpeg',
    size: 4096,
    width: null,
    height: null,
    url: '/api/memos/files/voice',
    thumbnailUrl: null,
    motion: null,
    mediaMetadata: null,
    createdAt: 1_700_000_000,
    ...overrides,
  }
}

function preferences(overrides: Partial<MemoPreferences> = {}): MemoPreferences {
  return { ...MEMO_PREFERENCES_DEFAULTS, ...overrides }
}

async function flush(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function render(): HTMLElement {
  view = renderElement(createElement(AttachmentAudio, { attachment: attachment() }))
  return view.container
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

function buttonNamed(root: ParentNode, label: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) throw new Error(`no button named ${label}`)
  return button
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find((item) => item.textContent?.includes(text))
  if (!button) throw new Error(`no button containing ${text}`)
  return button
}

function audioElement(root: HTMLElement): HTMLAudioElement {
  const audio = root.querySelector('audio')
  if (!audio) throw new Error('no audio element')
  return audio
}

function setFieldValue(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  installTestGlobals()
  vi.clearAllMocks()
  useUi.setState({ toasts: [] })
  api.preferences.get.mockResolvedValue(preferences())
  ai.providers.mockResolvedValue([
    { id: 'provider-1', label: 'OpenAI', protocol: 'openai', models: ['whisper-1'] },
  ])
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  vi.unstubAllGlobals()
})

describe('the memo audio card', () => {
  it('plays, skips ten seconds, seeks and cycles the playback speed', async () => {
    const host = render()
    await flush()
    const audio = audioElement(host)
    const play = vi.fn(() => Promise.resolve())
    const pause = vi.fn()
    Object.defineProperty(audio, 'play', { configurable: true, value: play })
    Object.defineProperty(audio, 'pause', { configurable: true, value: pause })
    Object.defineProperty(audio, 'duration', { configurable: true, value: 100 })
    act(() => { audio.dispatchEvent(new Event('loadedmetadata')) })
    await flush()

    click(buttonNamed(host, t('memos.media.audio_play')))
    await flush()
    expect(play).toHaveBeenCalledTimes(1)
    expect(buttonNamed(host, t('memos.media.audio_pause'))).not.toBeNull()

    click(buttonNamed(host, t('memos.media.audio_forward', { seconds: 10 })))
    expect(audio.currentTime).toBe(10)
    click(buttonNamed(host, t('memos.media.audio_back', { seconds: 10 })))
    expect(audio.currentTime).toBe(0)

    const seek = host.querySelector<HTMLInputElement>('input[type="range"]')
    expect(seek).not.toBeNull()
    setFieldValue(seek!, '42')
    expect(audio.currentTime).toBe(42)

    click(buttonNamed(host, t('memos.media.audio_speed', { speed: '1\u00d7' })))
    expect(audio.playbackRate).toBe(1.5)
    expect(buttonNamed(host, t('memos.media.audio_speed', { speed: '1.5\u00d7' }))).not.toBeNull()

    click(buttonNamed(host, t('memos.media.audio_pause')))
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('keeps transcription disabled while the account has no provider', async () => {
    ai.providers.mockResolvedValue([])
    const host = render()
    await flush(2)
    const transcribe = buttonWithText(host, t('memos.media.transcribe'))
    expect(transcribe.disabled).toBe(true)
  })

  it('downloads the audio, transcribes it and offers the text in a dialog', async () => {
    ai.transcribe.mockResolvedValue({ text: 'Hello from the recording.' })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(['audio'], { type: 'audio/mpeg' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const host = render()
    await flush(2)

    click(buttonWithText(host, t('memos.media.transcribe')))
    await flush(2)

    expect(fetchMock).toHaveBeenCalledWith('/api/memos/files/voice', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(ai.transcribe).toHaveBeenCalledTimes(1)
    const form = ai.transcribe.mock.calls[0]![0] as FormData
    expect((form.get('file') as File).name).toBe('voice.mp3')
    expect(form.get('providerId')).toBe('provider-1')
    expect(form.get('model')).toBe('whisper-1')

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Hello from the recording.')
    expect(dialog?.textContent).toContain('voice.mp3')

    click(buttonWithText(dialog!, t('common.copy')))
    await flush()
    expect(writeText).toHaveBeenCalledWith('Hello from the recording.')
    expect(dialog?.textContent).toContain(t('common.copied'))

    click(buttonWithText(dialog!, t('common.close')))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reports a failed transcription without disturbing playback', async () => {
    ai.transcribe.mockRejectedValue(new ApiError(502, 'internal', 'The provider refused the request.'))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(['audio'], { type: 'audio/mpeg' }),
    })))
    const host = render()
    await flush(2)

    click(buttonWithText(host, t('memos.media.transcribe')))
    await flush(2)

    expect(host.querySelector('audio')).not.toBeNull()
    expect(host.querySelector('input[type="range"]')).not.toBeNull()
    const toast = useUi.getState().toasts.find((item) => item.title === t('memos.media.transcribe_failed'))
    expect(toast?.tone).toBe('danger')
    expect(toast?.description).toBe('The provider refused the request.')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
