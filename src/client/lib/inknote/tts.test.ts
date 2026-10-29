import { describe, expect, it, vi } from 'vitest'
import { createTtsQueue, splitSentences, type TtsSpeaker } from './tts'

interface Utterance {
  text: string
  rate: number
  onEnd: () => void
  onError: (error: unknown) => void
}

function fakeSpeaker(): { speaker: TtsSpeaker; spoken: Utterance[] } {
  const spoken: Utterance[] = []
  return {
    spoken,
    speaker: {
      speak: (text, rate, callbacks) => {
        spoken.push({ text, rate, onEnd: callbacks.onEnd, onError: callbacks.onError })
      },
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    },
  }
}

describe('splitSentences', () => {
  it('returns no sentences for empty or whitespace text', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences(' \n\t ')).toEqual([])
  })

  it('splits Chinese terminal punctuation and trims each piece', () => {
    expect(splitSentences('\u4f60\u597d\u3002\u4e16\u754c\uff01 \u518d\u89c1\uff1f'))
      .toEqual(['\u4f60\u597d\u3002', '\u4e16\u754c\uff01', '\u518d\u89c1\uff1f'])
    expect(splitSentences('\u4e00\uff1b\u4e8c\uff1b')).toEqual(['\u4e00\uff1b', '\u4e8c\uff1b'])
  })

  it('splits English exclamation, question and semicolon but not a full stop', () => {
    expect(splitSentences('One. Two! Three? Four;')).toEqual(['One. Two!', 'Three?', 'Four;'])
    expect(splitSentences('  a!  b?  ')).toEqual(['a!', 'b?'])
  })

  it('keeps text without terminal punctuation as one sentence', () => {
    expect(splitSentences('no punctuation here')).toEqual(['no punctuation here'])
  })
})

describe('createTtsQueue', () => {
  it('speaks sentences in order and reports progress', () => {
    const { speaker, spoken } = fakeSpeaker()
    const onSentence = vi.fn()
    const onDone = vi.fn()
    const queue = createTtsQueue(speaker, { onSentence, onDone })

    queue.start('a! b? c;', 1.25)
    expect(queue.isActive()).toBe(true)
    expect(spoken.map((item) => item.text)).toEqual(['a!'])
    expect(spoken[0]!.rate).toBe(1.25)
    expect(onSentence).toHaveBeenLastCalledWith('a!', 0, 3)

    spoken[0]!.onEnd()
    expect(spoken.map((item) => item.text)).toEqual(['a!', 'b?'])
    spoken[1]!.onEnd()
    expect(spoken.map((item) => item.text)).toEqual(['a!', 'b?', 'c;'])
    spoken[2]!.onEnd()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(queue.isActive()).toBe(false)
  })

  it('pauses without skipping or repeating, then resumes with the next sentence', () => {
    const { speaker, spoken } = fakeSpeaker()
    const queue = createTtsQueue(speaker)
    queue.start('a! b?')

    queue.pause()
    expect(speaker.pause).toHaveBeenCalledTimes(1)
    spoken[0]!.onEnd()
    expect(spoken).toHaveLength(1)

    queue.resume()
    expect(spoken.map((item) => item.text)).toEqual(['a!', 'b?'])
    queue.pause()
    queue.resume()
    expect(speaker.resume).toHaveBeenCalledTimes(1)
    spoken[1]!.onEnd()
    expect(queue.isActive()).toBe(false)
  })

  it('ignores callbacks after stop and cancels the speaker', () => {
    const { speaker, spoken } = fakeSpeaker()
    const onDone = vi.fn()
    const queue = createTtsQueue(speaker, { onDone })
    queue.start('a! b?')

    queue.stop()
    expect(queue.isActive()).toBe(false)
    expect(speaker.cancel).toHaveBeenCalledTimes(2)
    spoken[0]!.onEnd()
    spoken[0]!.onError(new Error('late'))
    expect(spoken).toHaveLength(1)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('starting again invalidates the previous utterance', () => {
    const { speaker, spoken } = fakeSpeaker()
    const queue = createTtsQueue(speaker)
    queue.start('first! second?')
    queue.start('new!')

    expect(speaker.cancel).toHaveBeenCalledTimes(2)
    spoken[0]!.onEnd()
    expect(spoken.map((item) => item.text)).toEqual(['first!', 'new!'])
    spoken[1]!.onEnd()
    expect(queue.isActive()).toBe(false)
  })

  it('reports an error and continues with the next sentence', () => {
    const { speaker, spoken } = fakeSpeaker()
    const onError = vi.fn()
    const onDone = vi.fn()
    const queue = createTtsQueue(speaker, { onError, onDone })
    queue.start('a! b?')

    const failure = new Error('voice failed')
    spoken[0]!.onError(failure)
    expect(onError).toHaveBeenCalledWith(failure)
    expect(spoken.map((item) => item.text)).toEqual(['a!', 'b?'])
    spoken[1]!.onEnd()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('completes empty text without speaking and can be stopped when idle', () => {
    const { speaker, spoken } = fakeSpeaker()
    const onDone = vi.fn()
    const queue = createTtsQueue(speaker, { onDone })
    queue.start('   ')
    expect(spoken).toEqual([])
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(queue.isActive()).toBe(false)
    queue.stop()
    expect(speaker.cancel).toHaveBeenCalledTimes(1)
  })

  it('survives a synchronous speaker with many sentences', () => {
    const spoken: string[] = []
    const speaker: TtsSpeaker = {
      speak: (text, _rate, callbacks) => {
        spoken.push(text)
        callbacks.onEnd()
      },
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    }
    const onDone = vi.fn()
    const queue = createTtsQueue(speaker, { onDone })
    queue.start('x! '.repeat(500))
    expect(spoken).toHaveLength(500)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(queue.isActive()).toBe(false)
  })
})
