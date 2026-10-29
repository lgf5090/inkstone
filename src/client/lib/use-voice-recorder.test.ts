// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from './test-render'
import {
  useVoiceRecorder,
  type VoiceRecorder,
  type VoiceRecorderOptions,
} from './use-voice-recorder'

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static deferStop = false

  static isTypeSupported(type: string): boolean {
    return type === 'audio/webm;codecs=opus'
  }

  state: RecordingState = 'inactive'
  readonly mimeType: string
  readonly options: MediaRecorderOptions | undefined
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly stream: MediaStream, options?: MediaRecorderOptions) {
    this.options = options
    this.mimeType = options?.mimeType ?? 'audio/webm'
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    if (!FakeMediaRecorder.deferStop) this.finish()
  }

  finish(): void {
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.()
  }
}

function fakeStream(tracks: FakeTrack[] = [{ stop: vi.fn() }]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream
}

const TEST_ERROR_KEYS = {
  unsupported: 'test.unsupported',
  denied: 'test.denied',
  noMic: 'test.no_mic',
  failed: 'test.failed',
}

let mediaDevices: { getUserMedia: ReturnType<typeof vi.fn> }
let view: RenderedElement | null = null
let mounted: VoiceRecorder | null = null

function Harness({ options }: { options?: VoiceRecorderOptions }): ReactElement {
  mounted = useVoiceRecorder(options)
  return createElement('div')
}

function current(): VoiceRecorder {
  if (!mounted) throw new Error('the recorder is not mounted')
  return mounted
}

async function start(options?: VoiceRecorderOptions): Promise<string | null> {
  view = renderElement(createElement(Harness, { options }))
  let answer: string | null = null
  await act(async () => {
    answer = await current().start()
  })
  return answer
}

async function stop(): Promise<File | null> {
  let file: File | null = null
  await act(async () => {
    file = await current().stop()
  })
  return file
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.deferStop = false
  mounted = null
  mediaDevices = { getUserMedia: vi.fn() }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  mounted = null
  document.body.innerHTML = ''
  Reflect.deleteProperty(navigator, 'mediaDevices')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the voice recorder', () => {
  it('asks for the microphone, records with Opus WebM and answers with a File', async () => {
    const tracks = [{ stop: vi.fn() }]
    const stream = fakeStream(tracks)
    mediaDevices.getUserMedia.mockResolvedValue(stream)

    expect(await start()).toBeNull()
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(current().status).toBe('recording')
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    const recorder = FakeMediaRecorder.instances[0]!
    expect(recorder.stream).toBe(stream)
    expect(recorder.mimeType).toBe('audio/webm;codecs=opus')
    expect(recorder.state).toBe('recording')

    const file = await stop()

    expect(current().status).toBe('idle')
    expect(file?.name).toMatch(/^memo-voice-\d+\.webm$/)
    expect(file?.type).toBe('audio/webm;codecs=opus')
    expect(file?.size).toBe(5)
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1)
  })

  it('answers a refused permission with the caller\'s denied key and opens no recorder', async () => {
    mediaDevices.getUserMedia.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    )

    expect(await start({ errorKeys: TEST_ERROR_KEYS })).toBe('test.denied')
    expect(current().status).toBe('idle')
    expect(current().error).toBeNull()
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })

  it('reports a recorder error with the failed key and releases the microphone', async () => {
    const tracks = [{ stop: vi.fn() }]
    mediaDevices.getUserMedia.mockResolvedValue(fakeStream(tracks))
    await start({ errorKeys: TEST_ERROR_KEYS })

    act(() => { FakeMediaRecorder.instances[0]!.onerror?.() })

    expect(current().error).toBe('test.failed')
    expect(current().status).toBe('idle')
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1)
  })

  it('stops the recorder, the tracks and the clock when it unmounts mid-recording', async () => {
    vi.useFakeTimers()
    const tracks = [{ stop: vi.fn() }]
    mediaDevices.getUserMedia.mockResolvedValue(fakeStream(tracks))
    await start()
    const recorder = FakeMediaRecorder.instances[0]!
    expect(recorder.state).toBe('recording')

    view!.unmount()
    view = null

    expect(recorder.state).toBe('inactive')
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers every stop during one session with the same promise', async () => {
    FakeMediaRecorder.deferStop = true
    mediaDevices.getUserMedia.mockResolvedValue(fakeStream())
    await start()
    const recorder = FakeMediaRecorder.instances[0]!

    let first: Promise<File | null> | null = null
    let second: Promise<File | null> | null = null
    act(() => {
      first = current().stop()
      second = current().stop()
    })

    expect(second).toBe(first)
    act(() => { recorder.finish() })
    const file = await first!
    expect(file?.size).toBe(5)
    expect(current().status).toBe('idle')
  })

  it('passes audioBitsPerSecond and the caller\'s file prefix to the recording', async () => {
    mediaDevices.getUserMedia.mockResolvedValue(fakeStream())

    expect(await start({
      filePrefix: 'inknote-recording',
      audioBitsPerSecond: 64_000,
      errorKeys: TEST_ERROR_KEYS,
    })).toBeNull()

    const recorder = FakeMediaRecorder.instances[0]!
    expect(recorder.options?.mimeType).toBe('audio/webm;codecs=opus')
    expect(recorder.options?.audioBitsPerSecond).toBe(64_000)

    const file = await stop()
    expect(file?.name).toMatch(/^inknote-recording-\d+\.webm$/)
    expect(file?.type).toBe('audio/webm;codecs=opus')
  })
})
