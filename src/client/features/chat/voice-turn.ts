/**
 * A voice conversation that runs through the assistant the reader already has.
 *
 * Speech recognition and speech synthesis are the browser's, but the middle is the ordinary turn: the
 * same tools, note scope, memory and model as typing. That is the fallback when no realtime voice model
 * is configured, and it is deliberately the more capable of the two — a voice question about a note is
 * answered from the note.
 *
 * The controller owns the microphone for exactly as long as it is active. Every asynchronous callback
 * carries a generation, so a result or a spoken answer that arrives after a stop cannot restart a mic
 * the reader has already put down.
 */
import { toPlainText } from '@shared/markdown-utils'
import { t } from '../../lib/i18n'
import type { AnswerResult } from './editor-ai'
import { voiceRefusal, type SpeechEngine, type SpeechResultEvent } from './voice-engine'

export type VoiceTurnPhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

export interface VoiceTurnDeps {
  language: string
  createRecognition: () => SpeechEngine | null
  send: (text: string) => Promise<AnswerResult>
  speak: (text: string, language: string, handlers: { onDone: () => void, onError: () => void }) => boolean
  cancelSpeech: () => void
  onPhase: (phase: VoiceTurnPhase) => void
  onLine: (role: 'user' | 'assistant', text: string) => void
  onError: (message: string) => void
}

export class VoiceTurnController {
  private engine: SpeechEngine | null = null
  private active = false
  private phase: VoiceTurnPhase = 'idle'
  private generation = 0
  private restartTimer = 0

  constructor(private readonly deps: VoiceTurnDeps) {}

  start(): void {
    if (this.active) return
    this.active = true
    this.listen()
  }

  stop(): void {
    this.active = false
    this.generation++
    window.clearTimeout(this.restartTimer)
    const engine = this.engine
    this.engine = null
    engine?.stop()
    this.deps.cancelSpeech()
    this.setPhase('idle')
  }

  private setPhase(phase: VoiceTurnPhase): void {
    this.phase = phase
    this.deps.onPhase(phase)
  }

  private fail(message: string): void {
    this.deps.onError(message)
    this.setPhase('error')
  }

  private listen(): void {
    if (!this.active) return
    const engine = this.deps.createRecognition()
    if (!engine) {
      this.fail(t('assistant.composer.voice_unsupported'))
      return
    }
    const generation = ++this.generation
    let heard = false
    engine.lang = this.deps.language
    engine.continuous = true
    engine.interimResults = false
    engine.onresult = (event: SpeechResultEvent) => {
      if (!this.active || generation !== this.generation) return
      for (let index = Math.max(event.resultIndex ?? 0, 0); index < event.results.length; index++) {
        const result = event.results[index]
        if (!result?.isFinal) continue
        const text = result[0]?.transcript?.trim()
        if (!text) continue
        heard = true
        this.engine = null
        engine.stop()
        this.submit(text)
        return
      }
    }
    engine.onend = () => {
      if (this.engine === engine) this.engine = null
      if (!this.active || generation !== this.generation) return
      // Silence ends a browser session on its own. The conversation is still open, so open the mic
      // again after a beat; a reader who is thinking gets the next sentence rather than a dead panel.
      if (!heard && this.phase === 'listening') {
        this.restartTimer = window.setTimeout(() => {
          if (this.active && generation === this.generation && this.phase === 'listening') this.listen()
        }, 300)
      }
    }
    engine.onerror = (event) => {
      if (!this.active || generation !== this.generation) return
      this.engine = null
      const refusal = voiceRefusal(event?.error)
      if (refusal) this.fail(refusal)
    }
    this.engine = engine
    this.setPhase('listening')
    try {
      engine.start()
    } catch {
      this.engine = null
      this.fail(t('assistant.composer.voice_failed'))
    }
  }

  private submit(text: string): void {
    this.deps.onLine('user', text)
    this.setPhase('thinking')
    void this.deps.send(text).then((result) => {
      if (!this.active) return
      if (result.status !== 'ok') {
        this.fail(result.status === 'busy'
          ? t('assistant.voice.busy')
          : result.status === 'failed' ? result.error || t('assistant.voice.turn_failed') : t('assistant.voice.turn_failed'))
        return
      }
      this.deps.onLine('assistant', result.text)
      this.setPhase('speaking')
      const spoken = this.deps.speak(toPlainText(result.text), this.deps.language, {
        onDone: () => { if (this.active) this.listen() },
        onError: () => { if (this.active) this.listen() },
      })
      // A browser without speech synthesis still has a usable screen transcript; carry on listening
      // rather than stopping the conversation at the first answer.
      if (!spoken && this.active) this.listen()
    }).catch((error: unknown) => {
      if (!this.active) return
      this.fail(error instanceof Error ? error.message : t('assistant.voice.turn_failed'))
    })
  }
}
