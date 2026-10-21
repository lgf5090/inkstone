// @vitest-environment jsdom
import { act, createElement, useState, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useMemoRecorder } from './use-memo-recorder'

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

let mediaDevices: { getUserMedia: ReturnType<typeof vi.fn> }
let view: RenderedElement | null = null

function Harness(): ReactElement {
  const recorder = useMemoRecorder()
  const [startAnswer, setStartAnswer] = useState('none')
  const [stopped, setStopped] = useState('none')
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'status' }, recorder.status),
    createElement('span', { 'data-testid': 'seconds' }, String(recorder.seconds)),
    createElement('span', { 'data-testid': 'start-answer' }, startAnswer),
    createElement('span', { 'data-testid': 'file' }, stopped),
    createElement('span', { 'data-testid': 'error' }, recorder.error ?? 'none'),
    createElement('button', {
      onClick: () => {
        void recorder.start().then((answer) => setStartAnswer(answer ?? 'ok'))
      },
    }, 'start'),
    createElement('button', {
      onClick: () => {
        void recorder.stop().then((file) => {
          setStopped(file ? `${file.name}|${file.type}|${file.size}` : 'none')
        })
      },
    }, 'stop'),
  )
}

function read(container: HTMLElement, id: string): string {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === text)
  if (!found) throw new Error(`missing ${text} button`)
  return found
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

beforeEach(() => {
  FakeMediaRecorder.instances = []
  mediaDevices = { getUserMedia: vi.fn() }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  Reflect.deleteProperty(navigator, 'mediaDevices')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the memo recorder', () => {
  it('asks for the microphone, records with Opus WebM and answers with a File', async () => {
    const tracks = [{ stop: vi.fn() }]
    const stream = fakeStream(tracks)
    mediaDevices.getUserMedia.mockResolvedValue(stream)
    view = renderElement(createElement(Harness))

    click(button(view.container, 'start'))
    await flush()

    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(read(view.container, 'status')).toBe('recording')
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe('audio/webm;codecs=opus')
    expect(FakeMediaRecorder.instances[0]!.stream).toBe(stream)
    expect(FakeMediaRecorder.instances[0]!.state).toBe('recording')

    click(button(view.container, 'stop'))
    await flush()

    expect(read(view.container, 'status')).toBe('idle')
    expect(read(view.container, 'file')).toMatch(/^memo-voice-\d+\.webm\|audio\/webm;codecs=opus\|5$/)
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1)
  })

  it('counts whole seconds while recording', async () => {
    vi.useFakeTimers()
    mediaDevices.getUserMedia.mockResolvedValue(fakeStream())
    view = renderElement(createElement(Harness))

    click(button(view.container, 'start'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(read(view.container, 'status')).toBe('recording')

    act(() => { vi.advanceTimersByTime(2000) })
    expect(read(view.container, 'seconds')).toBe('2')
  })

  it('reports a refused permission without opening a recorder', async () => {
    mediaDevices.getUserMedia.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    )
    view = renderElement(createElement(Harness))

    click(button(view.container, 'start'))
    await flush()

    expect(read(view.container, 'start-answer')).toBe('memos.composer.voice_denied')
    expect(read(view.container, 'status')).toBe('idle')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })

  it('reports a recorder failure instead of ending in silence', async () => {
    const tracks = [{ stop: vi.fn() }]
    mediaDevices.getUserMedia.mockResolvedValue(fakeStream(tracks))
    view = renderElement(createElement(Harness))
    click(button(view.container, 'start'))
    await flush()

    act(() => { FakeMediaRecorder.instances[0]!.onerror?.() })

    expect(read(view.container, 'error')).toBe('memos.composer.voice_failed')
    expect(read(view.container, 'status')).toBe('idle')
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1)
  })

  it('stops the tracks, the recorder and the clock when it unmounts mid-recording', async () => {
    vi.useFakeTimers()
    const tracks = [{ stop: vi.fn() }]
    mediaDevices.getUserMedia.mockResolvedValue(fakeStream(tracks))
    view = renderElement(createElement(Harness))
    click(button(view.container, 'start'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const recorder = FakeMediaRecorder.instances[0]!
    expect(recorder.state).toBe('recording')

    view.unmount()
    view = null

    expect(recorder.state).toBe('inactive')
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
