/**
 * The sounds the app makes itself, with no audio file behind any of them.
 *
 * Two cues exist here because two are worth the page weight of zero bytes: a tick, which is one short
 * pulse on an oscillator, and a chime, which is two oscillators a fifth apart under one decaying envelope.
 * A white-noise loop would have been the third, and it is the one kind that needs a real recording —
 * several megabytes on the offline shell, for a sound a browser is free to mute (see D9 in
 * `reports/super-productivity-port-plan.md`). Synthesised cues cost nothing to ship, work offline, and
 * cannot fail to download.
 *
 * The lifecycle is the part that decides the shape of this module. An `AudioContext` created outside a
 * user gesture is a context a strict autoplay policy leaves parked, so `unlockCues` exists to be called
 * from inside the press that starts the thing making the noise — and one context is held for the life of
 * that activity rather than made per cue, because a browser caps how many a page may open.
 * `releaseCues` hands the device back when the activity is over.
 *
 * Everything in here is best effort by design, which is the only place this app may swallow an error:
 * a sound nobody hears is a disappointment, and a sound that throws in the middle of a focus block would
 * take the block down with it. Each `catch` says so at the line that does it.
 */

/** What the module can say out loud. The names are the two shapes a cue has, not the settings' words. */
export type AudioCue = 'tick' | 'chime'

/**
 * How loud a cue plays, as a gain multiplier.
 *
 * Deliberately not a setting: nothing in the account offers a volume yet, and a slider nobody has asked
 * for is a control that has to be designed, stored, merged and explained. A reader who wants it quieter
 * has the operating system's own volume, which is the layer that already has a slider.
 */
const CUE_GAIN = 0.16

/** A tick is a click, not a tone: under fifty milliseconds, so the next one can arrive on the second. */
const TICK_SECONDS = 0.045
const TICK_HZ = 1_180

/** The chime's two partials, a perfect fifth apart, and how long the decay is allowed to run. */
const CHIME_HZ = [784, 1_176] as const
const CHIME_SECONDS = 1.1

/** A ramp never reaches zero in exponential terms, and silence is the point of the last sample. */
const NEAR_SILENCE = 0.0001

let context: AudioContext | null = null

/** The constructor this browser answers to, which on an older Safari is only the prefixed one. */
function audioConstructor(): typeof AudioContext | null {
  const scoped = window as unknown as { AudioContext?: typeof AudioContext, webkitAudioContext?: typeof AudioContext }
  return scoped.AudioContext ?? scoped.webkitAudioContext ?? null
}

/**
 * Make the context playable, from inside the gesture that asked for it.
 *
 * A context that already exists is resumed rather than replaced: a second one would be a second device
 * for the page to hold while the first stays parked, which is the failure this function exists to avoid.
 */
export function unlockCues(): void {
  try {
    const Ctor = audioConstructor()
    if (!Ctor) return
    if (!context) context = new Ctor()
    // A context made inside the gesture is not always given a running one — Safari's autoplay policy has
    // long handed back a parked context even here — so the fresh one gets the same wake-up as the old.
    if (context.state === 'suspended') void context.resume()
  } catch {
    // A page that refuses an audio device gets silence. The activity that asked for the cue continues —
    // this is a best-effort background nicety, and the alternative is a thrown error in a click handler.
  }
}

/** Give up the device. The next activity pays for a fresh context at its own gesture. */
export function releaseCues(): void {
  const leaving = context
  context = null
  if (!leaving) return
  try {
    void leaving.close()
  } catch {
    // Closing is the polite end of the lifecycle, not a fact anyone downstream reads.
  }
}

/** Play one cue, if there is a context to play it on and a browser willing to make the nodes. */
export function playCue(cue: AudioCue): void {
  const live = context
  // Nothing was ever unlocked: no gesture, no context, no sound. Said quietly rather than loudly,
  // because a cue is not a promise the surface made to the reader.
  if (!live) return
  try {
    if (cue === 'tick') pulse(live, TICK_HZ, TICK_SECONDS)
    else chime(live)
  } catch {
    // A Web Audio implementation that refuses the graph is a browser problem, not a session problem: the
    // block keeps counting and the reader simply does not hear it end.
  }
}

/** One oscillator, a shaped envelope, and a stop time a few tens of milliseconds out. */
function pulse(context: AudioContext, hz: number, lengthSeconds: number): void {
  const now = context.currentTime
  const oscillator = context.createOscillator()
  const envelope = context.createGain()
  oscillator.type = 'square'
  oscillator.frequency.setValueAtTime(hz, now)
  envelope.gain.setValueAtTime(CUE_GAIN, now)
  envelope.gain.exponentialRampToValueAtTime(NEAR_SILENCE, now + lengthSeconds)
  oscillator.connect(envelope)
  envelope.connect(context.destination)
  oscillator.start(now)
  oscillator.stop(now + lengthSeconds)
}

/** The same shape twice over: two partials sharing one decay, which is what reads as a bell. */
function chime(context: AudioContext): void {
  const now = context.currentTime
  const envelope = context.createGain()
  envelope.gain.setValueAtTime(CUE_GAIN, now)
  envelope.gain.exponentialRampToValueAtTime(NEAR_SILENCE, now + CHIME_SECONDS)
  envelope.connect(context.destination)
  for (const hz of CHIME_HZ) {
    const oscillator = context.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(hz, now)
    oscillator.connect(envelope)
    oscillator.start(now)
    oscillator.stop(now + CHIME_SECONDS)
  }
}
