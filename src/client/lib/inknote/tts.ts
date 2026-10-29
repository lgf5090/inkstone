/**
 * Read-aloud queue with an injected speaker.
 *
 * The browser adapter (S4-06) supplies `speak/cancel/pause/resume`; this module never touches
 * `window`. A generation token makes callbacks from a cancelled utterance harmless, and the pump is
 * iterative so a synchronous fake speaker cannot overflow the stack on a long note.
 */

export interface TtsSpeaker {
  speak(text: string, rate: number, callbacks: {
    onEnd: () => void
    onError: (error: unknown) => void
  }): void
  cancel(): void
  pause(): void
  resume(): void
}

export interface TtsHandlers {
  /** Called when a sentence starts; `index` is zero-based and `total` counts the whole queue. */
  onSentence?: (text: string, index: number, total: number) => void
  onDone?: () => void
  onError?: (error: unknown) => void
}

export interface TtsQueue {
  start(text: string, rate?: number): void
  pause(): void
  resume(): void
  stop(): void
  isActive(): boolean
}

const SENTENCE_END = /(?<=[\u3002\uff01\uff1f\uff1b!?;])/u

/** Split on terminal punctuation in both scripts, trimming and dropping empty pieces. */
export function splitSentences(text: string): string[] {
  if (!text.trim()) return []
  return text.split(SENTENCE_END).map((sentence) => sentence.trim()).filter(Boolean)
}

export function createTtsQueue(speaker: TtsSpeaker, handlers: TtsHandlers = {}): TtsQueue {
  let token = 0
  let active = false
  let paused = false
  let awaiting = false
  let pumping = false
  let sentences: string[] = []
  let index = 0
  let rate = 1

  const finish = (current: number): void => {
    if (current !== token) return
    active = false
    paused = false
    awaiting = false
    sentences = []
    index = 0
    handlers.onDone?.()
  }

  const pump = (current: number): void => {
    if (current !== token || !active || paused) return
    if (pumping) return
    pumping = true
    try {
      while (current === token && active && !paused && !awaiting) {
        if (index >= sentences.length) {
          finish(current)
          break
        }
        const text = sentences[index]!
        const sentenceIndex = index
        index += 1
        awaiting = true
        handlers.onSentence?.(text, sentenceIndex, sentences.length)
        if (current !== token || !active) break
        try {
          speaker.speak(text, rate, {
            onEnd: () => {
              if (current !== token) return
              awaiting = false
              pump(current)
            },
            onError: (error) => {
              if (current !== token) return
              awaiting = false
              handlers.onError?.(error)
              pump(current)
            },
          })
        } catch (error) {
          awaiting = false
          handlers.onError?.(error)
        }
      }
    } finally {
      pumping = false
    }
  }

  return {
    start(text: string, nextRate = 1): void {
      token += 1
      const current = token
      active = false
      paused = false
      awaiting = false
      sentences = splitSentences(text)
      index = 0
      rate = Number.isFinite(nextRate) ? nextRate : 1
      try {
        speaker.cancel()
      } catch (error) {
        handlers.onError?.(error)
      }
      if (sentences.length === 0) {
        handlers.onDone?.()
        return
      }
      active = true
      pump(current)
    },

    pause(): void {
      if (!active || paused) return
      paused = true
      if (awaiting) {
        try {
          speaker.pause()
        } catch (error) {
          handlers.onError?.(error)
        }
      }
    },

    resume(): void {
      if (!active || !paused) return
      paused = false
      if (awaiting) {
        try {
          speaker.resume()
        } catch (error) {
          handlers.onError?.(error)
        }
      } else {
        pump(token)
      }
    },

    stop(): void {
      token += 1
      const wasActive = active
      active = false
      paused = false
      awaiting = false
      sentences = []
      index = 0
      if (!wasActive) return
      try {
        speaker.cancel()
      } catch (error) {
        handlers.onError?.(error)
      }
    },

    isActive(): boolean {
      return active
    },
  }
}
