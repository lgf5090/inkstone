// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo } from '@shared/memos/types'
import { ApiError } from '../../../lib/api'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { MEMO_QUERY_DEFAULTS, useMemos } from '../state'
import { MemoComposer } from './MemoComposer'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  comments: { list: vi.fn(), create: vi.fn() },
  relations: { get: vi.fn(), put: vi.fn() },
  reactions: { list: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  views: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), validate: vi.fn() },
  preferences: { get: vi.fn(), patch: vi.fn() },
  spaces: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  attachments: { list: vi.fn(), upload: vi.fn(), delete: vi.fn(), batchDelete: vi.fn(), prune: vi.fn() },
}))

const ai = vi.hoisted(() => ({
  providers: vi.fn(),
  transcribe: vi.fn(),
}))

vi.mock('../api', () => ({ memosApi: api }))
vi.mock('../ai-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai-client')>()
  return { ...actual, memoAi: ai }
})

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []

  static isTypeSupported(type: string): boolean {
    return type === 'audio/webm;codecs=opus'
  }

  state: RecordingState = 'inactive'
  readonly mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/webm'
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.()
  }
}

function fakeStream(tracks: FakeTrack[] = [{ stop: vi.fn() }]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream
}

function memo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'memo-1',
    content: 'first memo',
    title: '',
    snippet: '',
    tags: [],
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: null,
    location: null,
    properties: {
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: false,
    },
    attachments: [],
    reactions: [],
    relations: [],
    commentCount: 0,
    rev: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

let mediaDevices: { getUserMedia: ReturnType<typeof vi.fn> }
let view: RenderedElement | null = null

function editorText(container: HTMLElement): string {
  return container.querySelector('.cm-content')?.textContent ?? ''
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function micButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`missing ${label} button`)
  return found
}

function toastTitles(): string[] {
  return useUi.getState().toasts.map((toast) => toast.title)
}

async function recordOnce(): Promise<void> {
  click(micButton(view!.container, t('memos.composer.voice_record')))
  await flush()
  click(micButton(view!.container, t('memos.composer.voice_stop')))
  await flush()
}

beforeEach(async () => {
  await initI18n()
  localStorage.clear()
  useMemos.getState().reset()
  useMemos.setState({ items: [], status: 'ready', query: { ...MEMO_QUERY_DEFAULTS } })
  useUi.setState({ toasts: [] })
  vi.clearAllMocks()
  FakeMediaRecorder.instances = []
  api.spaces.list.mockResolvedValue({ spaces: [] })
  api.preferences.get.mockResolvedValue({
    defaultVisibility: 'private',
    enableDoubleClickEdit: true,
    saveMediaMetadata: true,
    reactions: [],
    tagRules: [],
    enableLinkPreview: true,
    enableReverseGeocoding: false,
  })
  api.create.mockResolvedValue(memo({ id: 'new-memo' }))
  ai.providers.mockResolvedValue([
    { id: 'provider-1', label: 'OpenAI', protocol: 'openai', models: ['whisper-1'] },
  ])
  ai.transcribe.mockResolvedValue({ text: 'Hello from the recording.' })
  mediaDevices = { getUserMedia: vi.fn().mockResolvedValue(fakeStream()) }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  Reflect.deleteProperty(navigator, 'mediaDevices')
  vi.unstubAllGlobals()
})

describe('the composer microphone', () => {
  it('records, transcribes and inserts the transcript at the cursor', async () => {
    view = renderElement(createElement(MemoComposer, {}))
    await flush()

    await recordOnce()

    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(ai.providers).toHaveBeenCalledTimes(1)
    expect(ai.transcribe).toHaveBeenCalledTimes(1)
    const form = ai.transcribe.mock.calls[0]![0] as FormData
    expect(form.get('providerId')).toBe('provider-1')
    expect(form.get('model')).toBe('whisper-1')
    const file = form.get('file') as File
    expect(file.name).toMatch(/^memo-voice-\d+\.webm$/)
    expect(file.type).toBe('audio/webm;codecs=opus')
    expect(editorText(view.container)).toContain('Hello from the recording.')
    expect(toastTitles()).toContain(t('memos.composer.voice_transcribed'))

    const submit = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(t('memos.composer.save')))
    click(submit!)
    await flush()
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Hello from the recording.'),
    }))
  })

  it('sends the saved provider, model, language and prompt', async () => {
    api.preferences.get.mockResolvedValue({
      defaultVisibility: 'private',
      enableDoubleClickEdit: true,
      saveMediaMetadata: true,
      reactions: [],
      tagRules: [],
      enableLinkPreview: true,
      enableReverseGeocoding: false,
      transcriptionProviderId: 'provider-2',
      transcriptionModel: 'whisper-large',
      transcriptionLanguage: 'zh-CN',
      transcriptionPrompt: 'Inkstone notes',
    })
    ai.providers.mockResolvedValue([
      { id: 'provider-1', label: 'OpenAI', protocol: 'openai', models: ['whisper-1'] },
      { id: 'provider-2', label: 'Gateway', protocol: 'openai', models: ['whisper-small', 'whisper-large'] },
    ])
    view = renderElement(createElement(MemoComposer, {}))
    await flush()

    await recordOnce()

    const form = ai.transcribe.mock.calls[0]![0] as FormData
    expect(form.get('providerId')).toBe('provider-2')
    expect(form.get('model')).toBe('whisper-large')
    expect(form.get('language')).toBe('zh-CN')
    expect(form.get('prompt')).toBe('Inkstone notes')
  })

  it('names the provider and model settings when the account has nothing to transcribe with', async () => {
    ai.providers.mockResolvedValue([
      { id: 'claude', label: 'Claude', protocol: 'anthropic', models: ['claude-sonnet-4'] },
    ])
    view = renderElement(createElement(MemoComposer, {}))
    await flush()

    await recordOnce()

    expect(ai.transcribe).not.toHaveBeenCalled()
    const refusal = useUi.getState().toasts.find((toast) => toast.title === t('memos.composer.voice_no_provider'))
    expect(refusal?.description).toBe(t('memos.composer.voice_no_provider_hint'))
    expect(view.container.querySelector('.cm-placeholder')).not.toBeNull()
  })

  it('keeps the microphone and the save button disabled while the transcript is on its way', async () => {
    let release: (result: { text: string }) => void = () => {}
    ai.transcribe.mockReturnValue(new Promise((resolve) => { release = resolve }))
    view = renderElement(createElement(MemoComposer, {}))
    await flush()

    await recordOnce()

    expect(micButton(view.container, t('memos.composer.voice_record')).disabled).toBe(true)
    const save = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(t('memos.composer.save')))
    expect(save?.disabled).toBe(true)
    expect(view.container.textContent).toContain(t('memos.composer.voice_transcribing'))

    release({ text: 'Later words.' })
    await flush()

    expect(editorText(view.container)).toContain('Later words.')
    expect(micButton(view.container, t('memos.composer.voice_record')).disabled).toBe(false)
  })

  it('reports a refused transcription and leaves the memo untouched', async () => {
    ai.transcribe.mockRejectedValue(new ApiError(502, 'internal', 'The provider refused the request.'))
    view = renderElement(createElement(MemoComposer, {}))
    await flush()

    await recordOnce()

    const failure = useUi.getState().toasts.find((toast) => toast.title === t('memos.composer.voice_failed'))
    expect(failure?.tone).toBe('danger')
    expect(failure?.description).toBe('The provider refused the request.')
    expect(view.container.querySelector('.cm-placeholder')).not.toBeNull()
  })
})
