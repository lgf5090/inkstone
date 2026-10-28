// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InknotePage } from '@shared/inknote/types'
import { renderElement } from '../../../lib/test-render'
import { collectSentences, splitSentences, useInknoteTts, type InknoteTts, type TtsSpeaker } from './use-inknote-tts'

class FakeUtterance {
  lang = ''
  rate = 1
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly text: string) {}
}

function text(id: string, value: string) {
  return {
    id, x: 0.1, y: 0.1, w: 0.6, h: 0.1, text: value, fontSize: 26, color: '#111111',
    align: 'left' as const, bold: false, italic: false, underline: false, hl: null, lh: 1.3, list: null,
  }
}

function page(id: string, texts: ReturnType<typeof text>[]): InknotePage {
  return { id, position: 0, rev: 1, updatedAt: 1, content: { format: 'inknote-page', version: 1, strokes: [], texts, images: [], bg: null } }
}

describe('sentence splitting', () => {
  it('keeps the ender and drops blank sentences', () => {
    expect(splitSentences('第一句。第二句！\n\nThird? Yes;')).toEqual(['第一句。', '第二句！', 'Third?', 'Yes;'])
  })

  it('collects across text boxes and pages', () => {
    const sentences = collectSentences([page('p1', [text('a', 'one. two!')]), page('p2', [text('b', 'three')])])
    expect(sentences.map((entry) => `${entry.pageId}:${entry.textId}:${entry.text}`)).toEqual(['p1:a:one.', 'p1:a:two!', 'p2:b:three'])
  })
})

describe('useInknoteTts', () => {
  let spoken: FakeUtterance[]
  let speaker: TtsSpeaker
  let tts: InknoteTts | null

  function Harness({ pages, activePageId, onPage, onCue }: { pages: InknotePage[]; activePageId: string; onPage: (id: string) => void; onCue: (cue: unknown) => void }) {
    tts = useInknoteTts({ pages, activePageId, activePageIndex: 0, rate: 1.5, language: 'zh-CN', onPage, onCue, speaker })
    return <span>{tts.active ? 'active' : 'idle'}</span>
  }

  beforeEach(() => {
    spoken = []
    speaker = { speak: vi.fn((utterance) => { spoken.push(utterance as unknown as FakeUtterance) }), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() }
    ;(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = FakeUtterance
    tts = null
  })

  it('reads sentence by sentence, follows the page and reports each cue', () => {
    const onPage = vi.fn()
    const onCue = vi.fn()
    const pages = [page('p1', [text('a', 'one. two!')]), page('p2', [text('b', 'three')])]
    const rendered = renderElement(<Harness pages={pages} activePageId="p1" onPage={onPage} onCue={onCue}/>)
    act(() => { tts!.readAll() })
    expect(spoken.map((utterance) => utterance.text)).toEqual(['one.'])
    expect(spoken[0]!.rate).toBe(1.5)
    expect(spoken[0]!.lang).toBe('zh-CN')
    expect(onCue).toHaveBeenLastCalledWith({ pageId: 'p1', textId: 'a' })
    act(() => { spoken[0]!.onend?.() })
    expect(spoken.map((utterance) => utterance.text)).toEqual(['one.', 'two!'])
    act(() => { spoken[1]!.onend?.() })
    expect(spoken.map((utterance) => utterance.text)).toEqual(['one.', 'two!', 'three'])
    expect(onPage).toHaveBeenCalledWith('p2')
    act(() => { tts!.stop() })
    expect(speaker.cancel).toHaveBeenCalled()
    expect(onCue).toHaveBeenLastCalledWith(null)
    rendered.unmount()
  })

  it('reads only the active page, pauses, resumes and refuses an empty page', () => {
    const pages = [page('p1', [text('a', 'alpha. beta.')]), page('p2', [])]
    const rendered = renderElement(<Harness pages={pages} activePageId="p1" onPage={() => {}} onCue={() => {}}/>)
    act(() => { tts!.togglePage() })
    expect(spoken.map((utterance) => utterance.text)).toEqual(['alpha.'])
    act(() => { tts!.pause() })
    expect(speaker.pause).toHaveBeenCalled()
    act(() => { tts!.resume() })
    expect(speaker.resume).toHaveBeenCalled()
    act(() => { tts!.togglePage() })
    expect(speaker.cancel).toHaveBeenCalled()
    rendered.unmount()

    spoken.length = 0
    const empty = renderElement(<Harness pages={[page('p2', [])]} activePageId="p2" onPage={() => {}} onCue={() => {}}/>)
    act(() => { tts!.togglePage() })
    expect(spoken).toHaveLength(0)
    expect(tts!.active).toBe(false)
    empty.unmount()
  })
})
