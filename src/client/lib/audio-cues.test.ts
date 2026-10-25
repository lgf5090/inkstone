// @vitest-environment jsdom
/**
 * The cues a focus session makes, synthesised rather than downloaded.
 *
 * D9 is the reason this file exists: a white-noise loop costs megabytes and an autoplay policy mutes it
 * at exactly the moment a reader wants it, while a tick is one short oscillator pulse and a chime is two
 * of them under an exponential decay. Nothing here has a file behind it, so the whole contract worth
 * testing is that the sounds arrive when they are supposed to and — the half that is easy to get wrong —
 * that a page with no Web Audio at all is left with a working session and no error.
 *
 * The context is made inside the caller's stack, which is where the "start focus" press puts it, and the
 * module holds one of them for the life of a session: a context per cue would be a device per beep, and
 * browsers cap how many a page may hold. `releaseCues` is the other half of that lifecycle and is what
 * the session teardown calls, so the next session pays for a fresh context at its own gesture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playCue, releaseCues, unlockCues } from './audio-cues'

type Mock = ReturnType<typeof vi.fn>

/**
 * A gain *node*, which owns a gain *param* — the two are separate objects in the real graph, and a stub
 * that flattens them answers `node.gain.setValueAtTime` with a method that does not exist.
 */
interface GainStub {
  gain: {
    value: number
    setValueAtTime: Mock
    exponentialRampToValueAtTime: Mock
    linearRampToValueAtTime: Mock
  }
  connect: Mock
}

interface OscillatorStub {
  type: string
  frequency: { value: number, setValueAtTime: Mock }
  connect: Mock
  start: Mock
  stop: Mock
}

interface ContextStub {
  state: string
  currentTime: number
  destination: object
  oscillators: OscillatorStub[]
  gains: GainStub[]
  createOscillator: Mock
  createGain: Mock
  resume: Mock
  close: Mock
}

/** Every context the module has been handed since the last reset, so a case can read the one it made. */
let contexts: ContextStub[] = []

function makeOscillator(): OscillatorStub {
  return {
    type: 'sine',
    frequency: { value: 0, setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
}

function makeGain(): GainStub {
  return {
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  }
}

function makeContext(state: 'running' | 'suspended'): ContextStub {
  const oscillators: OscillatorStub[] = []
  const gains: GainStub[] = []
  const context: ContextStub = {
    state,
    currentTime: 12.5,
    destination: { name: 'destination' },
    oscillators,
    gains,
    createOscillator: vi.fn(() => {
      const node = makeOscillator()
      oscillators.push(node)
      return node
    }),
    createGain: vi.fn(() => {
      const node = makeGain()
      gains.push(node)
      return node
    }),
    resume: vi.fn(() => {
      context.state = 'running'
      return Promise.resolve()
    }),
    close: vi.fn(() => Promise.resolve()),
  }
  return context
}

/** Stand in for the platform object, and remember every context the module asks for. */
function stubAudioContext(state: 'running' | 'suspended' = 'running'): Mock {
  // A `function` rather than an arrow: the module under test builds the context with `new`, and a mock
  // whose implementation is not constructible is a mock that warns it may not answer that call.
  const ctor = vi.fn(function create() {
    const context = makeContext(state)
    contexts.push(context)
    return context
  })
  vi.stubGlobal('AudioContext', ctor)
  return ctor
}

/** The one cue-maker has built since the reset. Cases that unlocked know it exists. */
function theContext(): ContextStub {
  const context = contexts[0]
  if (!context) throw new Error('the cue module made no AudioContext')
  return context
}

beforeEach(() => {
  localStorage.clear()
  contexts = []
  releaseCues()
})

afterEach(() => {
  releaseCues()
  vi.unstubAllGlobals()
})

describe('the cue module on a page with Web Audio', () => {
  it('makes the context only when it is asked for, and inside the caller’s stack', () => {
    const ctor = stubAudioContext()
    expect(ctor).not.toHaveBeenCalled()
    unlockCues()
    expect(ctor).toHaveBeenCalledTimes(1)
  })

  it('reuses the one context across a whole session', () => {
    stubAudioContext()
    unlockCues()
    unlockCues()
    expect(contexts.length).toBe(1)
    playCue('tick')
    playCue('chime')
    expect(contexts.length).toBe(1)
  })

  it('resumes a suspended context rather than building a second one', () => {
    // A browser parks a context it has not been handed a gesture for. Building another would leak a
    // device and still play nothing, so the answer is to wake the one the module already holds.
    stubAudioContext('suspended')
    unlockCues()
    expect(contexts.length).toBe(1)
    expect(theContext().resume).toHaveBeenCalledTimes(1)
  })

  it('plays a tick as one short pulse on one oscillator', () => {
    stubAudioContext()
    unlockCues()
    playCue('tick')
    const context = theContext()
    expect(context.oscillators.length).toBe(1)
    const oscillator = context.oscillators[0]!
    expect(oscillator.start).toHaveBeenCalledTimes(1)
    // A pulse is a start and a stop a few tens of milliseconds apart; a node never stopped is a tone.
    const started = Number(oscillator.start.mock.calls[0]![0])
    const stopped = Number(oscillator.stop.mock.calls[0]![0])
    expect(stopped - started).toBeGreaterThan(0)
    expect(stopped - started).toBeLessThan(0.2)
  })

  it('plays a chime as two oscillators under one decaying envelope', () => {
    stubAudioContext()
    unlockCues()
    playCue('chime')
    const context = theContext()
    expect(context.oscillators.length).toBe(2)
    expect(context.oscillators.every((node) => node.stop.mock.calls.length === 1)).toBe(true)
    // The decay is what makes it a chime rather than a beep: the gain is ramped down, not switched off.
    expect(context.gains.some((node) => node.gain.exponentialRampToValueAtTime.mock.calls.length > 0)).toBe(true)
    const partials = context.oscillators.map((node) => node.frequency.setValueAtTime.mock.calls[0]![0])
    expect(new Set(partials).size).toBe(2)
  })

  it('reaches the destination through the gain it made rather than straight from the oscillator', () => {
    stubAudioContext()
    unlockCues()
    playCue('chime')
    const context = theContext()
    expect(context.gains.some((gain) => gain.connect.mock.calls.some((call) => call[0] === context.destination))).toBe(true)
  })

  it('plays nothing at all when the context was never unlocked', () => {
    // A cue asked for outside a gesture is the case the autoplay policy punishes. Silence is the honest
    // answer, and it must not be an exception on the way there.
    releaseCues()
    const ctor = stubAudioContext()
    expect(() => playCue('tick')).not.toThrow()
    expect(ctor).not.toHaveBeenCalled()
    expect(contexts.length).toBe(0)
  })

  it('swallows a platform that throws and stays usable afterwards', () => {
    stubAudioContext()
    unlockCues()
    const context = theContext()
    context.createOscillator.mockImplementation(() => {
      throw new Error('the audio thread refused the node')
    })
    expect(() => playCue('tick')).not.toThrow()
    const restored = makeOscillator()
    context.createOscillator.mockImplementation(() => restored)
    expect(() => playCue('chime')).not.toThrow()
    // The cue after the failure reached the graph: the module did not mark itself broken.
    expect(restored.start).toHaveBeenCalled()
  })

  it('releases the device it was holding, and makes a fresh one at the next gesture', () => {
    stubAudioContext()
    unlockCues()
    expect(theContext().close).not.toHaveBeenCalled()
    releaseCues()
    expect(theContext().close).toHaveBeenCalledTimes(1)
    contexts = []
    unlockCues()
    expect(contexts.length).toBe(1)
  })
})

describe('the cue module on a page without Web Audio', () => {
  it('has no AudioContext to find in jsdom', () => {
    // The premise of the two cases below, stated rather than assumed: if a future jsdom grows Web Audio,
    // this fails and the silent path gets a real stub instead of an absent global.
    expect(window.AudioContext).toBeUndefined()
    expect((window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext).toBeUndefined()
  })

  it('unlocks and plays without throwing', () => {
    expect(() => unlockCues()).not.toThrow()
    expect(() => playCue('tick')).not.toThrow()
    expect(() => playCue('chime')).not.toThrow()
    expect(() => releaseCues()).not.toThrow()
  })

  it('finds webkitAudioContext where that is all a browser offers', () => {
    vi.stubGlobal('webkitAudioContext', vi.fn(function create() {
      const context = makeContext('running')
      contexts.push(context)
      return context
    }))
    unlockCues()
    expect(contexts.length).toBe(1)
    expect(() => playCue('tick')).not.toThrow()
  })
})
