// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReadAloud } from '../src/client/features/reading/reader/use-read-aloud'
import { splitSpeechSentences } from '../src/client/features/reading/engine/read-aloud'
import { installTestGlobals } from '../src/client/lib/test-render'
import type { EpubStageHandle } from '../src/client/features/reading/reader/EpubStage'

const speech = vi.hoisted(() => ({
  canSpeak: vi.fn(() => true),
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
  pauseSpeaking: vi.fn(),
  resumeSpeaking: vi.fn(),
}))
vi.mock('../src/client/lib/speech', () => speech)

let root: Root | null = null
let host: HTMLDivElement

beforeEach(() => {
  installTestGlobals()
  vi.useFakeTimers()
  vi.clearAllMocks()
  speech.canSpeak.mockReturnValue(true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  host.remove()
  vi.useRealTimers()
})

describe('splitSpeechSentences', () => {
  it('keeps sentence offsets into the chapter', () => {
    expect(splitSpeechSentences('第一句。第二句！', 10)).toEqual([
      { text: '第一句。', start: 10, end: 14 },
      { text: '第二句！', start: 14, end: 18 },
    ])
  })
})

describe('useReadAloud', () => {
  it('speaks sentence by sentence, follows the text and pauses', async () => {
    const stage = {
      current: vi.fn(() => ({ kind: 'epub' as const, chapter: 0, offset: 0 })),
      readAloud: vi.fn(() => ({ text: '第一句。第二句。', offset: 0, language: 'zh-CN' })),
      goTo: vi.fn(),
    }
    let api!: ReturnType<typeof useReadAloud>
    function Harness() {
      api = useReadAloud({ stage: { current: stage } as unknown as { current: EpubStageHandle | null }, bookId: 'b1', language: 'zh-CN', rate: 1, sleepMinutes: 0, onError: vi.fn() })
      return createElement('div', null,
        createElement('button', { onClick: api.play }, 'play'),
        createElement('button', { onClick: api.pause }, 'pause'),
        createElement('span', null, api.sentences[api.index]?.text),
      )
    }
    act(() => root!.render(createElement(Harness)))
    act(() => host.querySelector('button')!.click())
    expect(speech.speak).toHaveBeenCalledTimes(1)
    expect(speech.speak.mock.calls[0]?.[0]).toBe('第一句。')
    act(() => speech.speak.mock.calls[0]?.[2].onDone())
    expect(speech.speak.mock.calls[1]?.[0]).toBe('第二句。')
    expect(host.textContent).toContain('第二句。')
    act(() => [...host.querySelectorAll('button')].find((one) => one.textContent === 'pause')!.click())
    expect(speech.pauseSpeaking).toHaveBeenCalledTimes(1)
    expect(api.paused).toBe(true)
  })

  it('stops after the configured sleep timer', async () => {
    const stage = {
      current: vi.fn(() => ({ kind: 'epub' as const, chapter: 0, offset: 0 })),
      readAloud: vi.fn(() => ({ text: '第一句。', offset: 0, language: 'zh-CN' })),
      goTo: vi.fn(),
    }
    let api!: ReturnType<typeof useReadAloud>
    function Harness() {
      api = useReadAloud({ stage: { current: stage } as unknown as { current: EpubStageHandle | null }, bookId: 'b1', language: 'zh-CN', rate: 1, sleepMinutes: 1, onError: vi.fn() })
      return createElement('button', { onClick: api.play }, 'play')
    }
    act(() => root!.render(createElement(Harness)))
    act(() => host.querySelector('button')!.click())
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(speech.stopSpeaking).toHaveBeenCalledTimes(1)
    expect(api.playing).toBe(false)
  })
})
