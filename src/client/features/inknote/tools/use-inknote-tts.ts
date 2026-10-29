/** Sentence-by-sentence read-aloud for one page or the whole note, with a highlight cue per sentence. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InknotePage } from '@shared/inknote/types'

export interface TtsSentence {
  pageId: string
  pageIndex: number
  textId: string
  text: string
}

export interface TtsCue {
  pageId: string
  textId: string
}

/** Splits on the sentence enders Chinese and English share, keeping each ender with its sentence. */
export function splitSentences(value: string): string[] {
  const matches = value.match(/[^\u3002\uFF01\uFF1F\uFF1B!?;\n.]+[\u3002\uFF01\uFF1F\uFF1B!?;.]?/g) ?? []
  return matches.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0)
}

export function collectSentences(pages: readonly InknotePage[]): TtsSentence[] {
  const sentences: TtsSentence[] = []
  pages.forEach((page, pageIndex) => {
    for (const item of page.content.texts) {
      for (const text of splitSentences(item.text)) sentences.push({ pageId: page.id, pageIndex, textId: item.id, text })
    }
  })
  return sentences
}

/** The subset of `speechSynthesis` the hook needs, so tests can answer without a voice engine. */
export interface TtsSpeaker {
  speak: (utterance: SpeechSynthesisUtterance) => void
  cancel: () => void
  pause: () => void
  resume: () => void
}

interface Options {
  pages: InknotePage[]
  activePageId: string | null
  activePageIndex: number
  rate: number
  language: string
  onPage: (pageId: string) => void
  onCue: (cue: TtsCue | null) => void
  speaker?: TtsSpeaker
}

export interface InknoteTts {
  active: boolean
  paused: boolean
  supported: boolean
  togglePage: () => void
  readAll: () => void
  pause: () => void
  resume: () => void
  stop: () => void
}

export function useInknoteTts({ pages, activePageId, activePageIndex, rate, language, onPage, onCue, speaker }: Options): InknoteTts {
  const supported = typeof window !== 'undefined' && (Boolean(speaker) || typeof window.speechSynthesis !== 'undefined')
  const [active, setActive] = useState(false)
  const [paused, setPaused] = useState(false)
  const queue = useRef<TtsSentence[]>([])
  const cursor = useRef(0)
  const live = useRef({ pages, activePageId, activePageIndex, rate, language, onPage, onCue })
  live.current = { pages, activePageId, activePageIndex, rate, language, onPage, onCue }
  const voice = useRef<TtsSpeaker | null>(speaker ?? null)
  if (!voice.current && typeof window !== 'undefined' && window.speechSynthesis) voice.current = window.speechSynthesis

  const stop = useCallback(() => {
    queue.current = []
    cursor.current = 0
    setActive(false)
    setPaused(false)
    voice.current?.cancel()
    live.current.onCue(null)
  }, [])

  const speakNext = useCallback(() => {
    const next = queue.current[cursor.current]
    if (!next) { stop(); return }
    cursor.current += 1
    if (live.current.activePageId !== next.pageId) live.current.onPage(next.pageId)
    live.current.onCue({ pageId: next.pageId, textId: next.textId })
    const synthesis = voice.current
    if (!synthesis) { stop(); return }
    const utterance = new SpeechSynthesisUtterance(next.text)
    utterance.lang = live.current.language
    utterance.rate = live.current.rate
    utterance.onend = () => { if (queue.current.length) speakNext() }
    utterance.onerror = () => stop()
    synthesis.speak(utterance)
  }, [stop])

  const begin = useCallback((sentences: TtsSentence[]) => {
    voice.current?.cancel()
    if (sentences.length === 0) { live.current.onCue(null); setActive(false); return }
    queue.current = sentences
    cursor.current = 0
    setActive(true)
    setPaused(false)
    speakNext()
  }, [speakNext])

  const togglePage = useCallback(() => {
    if (active) { stop(); return }
    const page = live.current.pages[live.current.activePageIndex]
    begin(page ? collectSentences([page]) : [])
  }, [active, begin, stop])

  const readAll = useCallback(() => {
    if (active) { stop(); return }
    begin(collectSentences(live.current.pages))
  }, [active, begin, stop])

  const pause = useCallback(() => { voice.current?.pause(); setPaused(true) }, [])
  const resume = useCallback(() => { voice.current?.resume(); setPaused(false) }, [])
  useEffect(() => () => { voice.current?.cancel(); live.current.onCue(null) }, [])

  return useMemo(() => ({ active, paused, supported, togglePage, readAll, pause, resume, stop }), [active, paused, supported, togglePage, readAll, pause, resume, stop])
}
