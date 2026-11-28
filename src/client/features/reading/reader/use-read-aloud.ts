import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { canSpeak, pauseSpeaking, resumeSpeaking, speak, stopSpeaking } from '../../../lib/speech'
import { splitSpeechSentences, type SpeechSentence } from '../engine/read-aloud'
import type { EpubStageHandle } from './EpubStage'

export interface ReadAloudOptions {
  stage: RefObject<EpubStageHandle | null>
  bookId: string
  language: string
  rate: number
  sleepMinutes: number
  onError: (message: string) => void
}

export function useReadAloud({ stage, bookId, language, rate, sleepMinutes, onError }: ReadAloudOptions) {
  const [sentences, setSentences] = useState<SpeechSentence[]>([])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [paused, setPaused] = useState(false)
  const indexRef = useRef(0)
  const sentencesRef = useRef<SpeechSentence[]>([])
  const rateRef = useRef(rate)
  const sleepRef = useRef(0)
  rateRef.current = rate

  const stop = useCallback(() => {
    stopSpeaking()
    window.clearTimeout(sleepRef.current)
    setPlaying(false)
    setPaused(false)
  }, [])

  const startSentence = useCallback((next: number) => {
    const list = sentencesRef.current
    const sentence = list[next]
    if (!sentence) {
      stop()
      return
    }
    indexRef.current = next
    setIndex(next)
    const current = stage.current?.current()
    if (current?.kind === 'epub' && sentence.start > current.offset + 240) {
      stage.current?.goTo({ kind: 'epub', chapter: current.chapter, offset: sentence.start })
    }
    speak(sentence.text, language || 'und', {
      onDone: () => startSentence(next + 1),
      onError: () => {
        stop()
        onError('Speech synthesis failed')
      },
    }, rateRef.current)
  }, [language, onError, stage, stop])

  const play = useCallback(() => {
    if (!canSpeak()) {
      onError('Speech synthesis is not available in this browser')
      return
    }
    if (playing && paused) {
      resumeSpeaking()
      setPaused(false)
      return
    }
    const source = stage.current?.readAloud()
    if (!source?.text.trim()) {
      onError('There is no text to read from this position')
      return
    }
    const list = splitSpeechSentences(source.text, source.offset)
    if (!list.length) return
    sentencesRef.current = list
    sentencesRef.current = list.map((sentence) => ({ ...sentence }))
    setSentences(list)
    setPlaying(true)
    setPaused(false)
    startSentence(0)
    if (sleepMinutes > 0) {
      window.clearTimeout(sleepRef.current)
      sleepRef.current = window.setTimeout(stop, sleepMinutes * 60_000)
    }
  }, [language, onError, paused, sleepMinutes, stage, startSentence, stop, playing])

  const pause = useCallback(() => {
    if (!playing || paused) return
    pauseSpeaking()
    setPaused(true)
  }, [paused, playing])

  useEffect(() => stop, [bookId, stop])

  return { sentences, index, playing, paused, play, pause, stop }
}
