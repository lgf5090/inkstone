/**
 * The ten-band equalizer, wired between the shared audio element and the speakers.
 *
 * A `MediaElementAudioSourceNode` can only be created once per element, and a source that fails to
 * connect leaves the element silent, so every step here degrades to "no equalizer" instead of
 * throwing. The caller keeps playing; the settings panel can say that this source cannot be shaped.
 *
 * The graph is `source -> 10 x peaking BiquadFilter -> gain -> destination`. The gain stage stays at
 * unity: the audio element owns the volume, and keeping one place responsible for loudness means the
 * equalizer can be bypassed without a jump in level.
 */
export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

export const EQ_GAIN_RANGE = { min: -12, max: 12 } as const

export type EqPresetName =
  | 'flat'
  | 'pop'
  | 'rock'
  | 'classical'
  | 'jazz'
  | 'hiphop'
  | 'vocal'
  | 'dance'
  | 'acoustic'
  | 'custom'

type NamedPreset = Exclude<EqPresetName, 'custom'>

/** Gains ordered exactly like {@link EQ_FREQUENCIES}. */
export const EQ_PRESETS: Record<NamedPreset, readonly number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pop: [-1.5, 3.5, 5.5, 3.5, -0.5, -1.5, 1.5, 2.5, 2.5, 2.5],
  rock: [4.5, 3.5, 2, 0.5, -0.5, -1, 0.5, 2, 2.5, 3.5],
  classical: [3.5, 3, 2.5, 1.5, -0.5, -1.5, -1.5, 0.5, 2, 3],
  jazz: [3, 2, 1.5, 2, -1, -1.5, -0.5, 1, 2.5, 3],
  hiphop: [5, 4.5, 3, 1.5, -0.5, -1, 0.5, 1.5, 2, 2.5],
  vocal: [-2, -1.5, -1, 0.5, 2, 3.5, 3, 1.5, 0.5, 0],
  dance: [4, 3.5, 2.5, 1, 0, -0.5, 1.5, 2.5, 3, 2.5],
  acoustic: [2, 1.5, 1, 1.5, 2, 1.5, 2, 2.5, 2, 1.5],
}

export const DEFAULT_EQ_PRESET: NamedPreset = 'flat'
export const DEFAULT_EQ_GAINS: readonly number[] = EQ_PRESETS.flat
export const EQ_PRESET_NAMES: readonly EqPresetName[] = [
  'flat',
  'pop',
  'rock',
  'classical',
  'jazz',
  'hiphop',
  'vocal',
  'dance',
  'acoustic',
  'custom',
]

export interface EqSettings {
  enabled: boolean
  leveling: boolean
  preset: EqPresetName
  /** Ten gains, ordered like {@link EQ_FREQUENCIES}. Kept even for a named preset so a panel can edit it. */
  gains: number[]
}

export const DEFAULT_EQ_SETTINGS: EqSettings = {
  enabled: false,
  leveling: false,
  preset: DEFAULT_EQ_PRESET,
  gains: [...DEFAULT_EQ_GAINS],
}

export type EqUnavailableReason = 'unsupported' | 'cross-origin' | 'failed'

function clampGain(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(EQ_GAIN_RANGE.max, Math.max(EQ_GAIN_RANGE.min, value))
}

function isPresetName(value: unknown): value is EqPresetName {
  return typeof value === 'string' && (EQ_PRESET_NAMES as readonly string[]).includes(value)
}

/** The gains a preset stands for, or the flat curve for `custom`, which has no fixed answer. */
export function eqPresetGains(preset: EqPresetName): number[] {
  return preset === 'custom' ? [...DEFAULT_EQ_GAINS] : [...EQ_PRESETS[preset]]
}

/** The named preset a curve matches, or null when the reader has moved a band off every preset. */
export function matchEqPreset(gains: readonly number[]): NamedPreset | null {
  for (const preset of EQ_PRESET_NAMES) {
    if (preset === 'custom') continue
    const curve = EQ_PRESETS[preset]
    if (curve.every((gain, index) => Math.abs((gains[index] ?? 0) - gain) < 0.1)) return preset
  }
  return null
}

/**
 * Turn whatever was stored into a usable setting.
 *
 * A named preset wins over the stored curve: the two can only disagree because a write was interrupted,
 * and the name is what the panel shows. Clamping is used for gains instead of dropping them, for the
 * same reason a slider stops at its end rather than jumping back to zero.
 */
export function sanitizeEqSettings(value: unknown): EqSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_EQ_SETTINGS, gains: [...DEFAULT_EQ_GAINS] }
  const record = value as Partial<EqSettings>
  const preset = isPresetName(record.preset) ? record.preset : DEFAULT_EQ_PRESET
  const stored = Array.isArray(record.gains) ? record.gains : DEFAULT_EQ_GAINS
  const gains = preset === 'custom'
    ? EQ_FREQUENCIES.map((_, index) => clampGain(typeof stored[index] === 'number' ? stored[index]! : 0))
    : eqPresetGains(preset)
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_EQ_SETTINGS.enabled,
    leveling: typeof record.leveling === 'boolean' ? record.leveling : DEFAULT_EQ_SETTINGS.leveling,
    preset,
    gains,
  }
}

/**
 * A same-origin stream is the only one an `AudioContext` can read; a cross-origin one would be
 * rendered as silence. The app streams through `/api/music/stream`, so this is a guard against a
 * custom source that hands back another host, not a limitation of the normal path.
 */
function isSameOrigin(url: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URL(url, window.location.href).origin === window.location.origin
  } catch {
    // An unparseable URL cannot be routed through the graph; the player falls back to direct output.
    return false
  }
}

function audioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  const candidate = window.AudioContext
  return typeof candidate === 'function' ? candidate : null
}

export class MusicEqualizer {
  private context: AudioContext | null = null
  private source: MediaElementAudioSourceNode | null = null
  private filters: BiquadFilterNode[] = []
  private gain: GainNode | null = null
  private compressor: DynamicsCompressorNode | null = null
  private element: HTMLAudioElement | null = null
  private enabled = DEFAULT_EQ_SETTINGS.enabled
  private leveling = DEFAULT_EQ_SETTINGS.leveling
  private gains = [...DEFAULT_EQ_GAINS]
  private normalizationGain = 1
  private reason: EqUnavailableReason | null = null

  /** Whether an `AudioContext` graph is attached to the element the engine is playing through. */
  get available(): boolean {
    return this.source !== null && this.context !== null
  }

  get unavailableReason(): EqUnavailableReason | null {
    return this.reason
  }

  get currentGains(): number[] {
    return [...this.gains]
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Attach the graph to the element, once.
   *
   * Returns false — and keeps returning false — when this browser cannot build the graph or the source
   * is not same-origin. The caller does not branch on it beyond telling the reader; audio still plays
   * through the element's own output.
   */
  connect(element: HTMLAudioElement, url: string): boolean {
    if (!isSameOrigin(url)) {
      this.reason = 'cross-origin'
      return false
    }
    if (this.element === element && this.source) {
      return true
    }
    const Context = audioContextConstructor()
    if (!Context) {
      this.reason = 'unsupported'
      return false
    }
    // A browser can only ever capture one element once. If a previous graph exists for another
    // element, leave it alone rather than half-building a second one.
    if (this.source) return false

    let context: AudioContext | null = null
    let source: MediaElementAudioSourceNode | null = null
    try {
      context = new Context()
      source = context.createMediaElementSource(element)
      const gain = context.createGain()
      const compressor = context.createDynamicsCompressor()
      compressor.threshold.value = -24
      compressor.knee.value = 24
      compressor.ratio.value = 4
      compressor.attack.value = 0.003
      compressor.release.value = 0.25
      const filters = EQ_FREQUENCIES.map((frequency, index) => {
        const filter = context!.createBiquadFilter()
        filter.type = 'peaking'
        filter.frequency.value = frequency
        filter.Q.value = 1
        filter.gain.value = this.gains[index] ?? 0
        return filter
      })
      this.context = context
      this.source = source
      this.gain = gain
      this.compressor = compressor
      this.filters = filters
      this.element = element
      this.reason = null
      this.applyEnabled()
      return true
    } catch {
      // Building the graph failed. If the element was captured before the failure there is no way
      // back to direct output, so the best remaining move is to route the captured source straight
      // to the destination and report the equalizer as unavailable.
      this.reason = 'failed'
      this.source = null
      this.filters = []
      this.gain = null
      this.compressor = null
      this.element = null
      if (context && source) {
        try {
          source.connect(context.destination)
          this.context = context
        } catch {
          // Nothing else can be done; the engine still owns the element and will report its own error.
          this.context = null
        }
      } else {
        this.context = null
      }
      return false
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (this.available) this.applyEnabled()
  }

  setLeveling(leveling: boolean): void {
    this.leveling = leveling
    if (this.available) this.applyEnabled()
  }

  /** A linear gain from the provider's measured loudness; 1 leaves the track alone. */
  setNormalizationGain(gain: number): void {
    this.normalizationGain = Number.isFinite(gain) && gain > 0 ? gain : 1
    if (this.gain && this.context) {
      this.gain.gain.setValueAtTime(this.normalizationGain, this.context.currentTime)
    }
  }

  setGains(gains: readonly number[]): void {
    this.gains = EQ_FREQUENCIES.map((_, index) => clampGain(gains[index] ?? 0))
    this.writeGains()
  }

  setBandGain(index: number, gain: number): void {
    if (index < 0 || index >= EQ_FREQUENCIES.length) return
    this.gains[index] = clampGain(gain)
    const filter = this.filters[index]
    if (filter && this.context) {
      filter.gain.setValueAtTime(this.gains[index]!, this.context.currentTime)
    }
  }

  applyPreset(preset: EqPresetName): void {
    if (preset === 'custom') return
    this.gains = eqPresetGains(preset)
    this.writeGains()
  }

  /** Back to a flat curve and switched off, the state a panel's reset button promises. */
  reset(): void {
    this.enabled = false
    this.leveling = false
    this.gains = [...DEFAULT_EQ_GAINS]
    this.writeGains()
    if (this.available) this.applyEnabled()
  }

  /** Resume a context the browser suspended. Failing here only costs the equalizer, not playback. */
  async resume(): Promise<void> {
    if (!this.context || this.context.state !== 'suspended') return
    try {
      await this.context.resume()
    } catch {
      this.reason = 'failed'
    }
  }

  private writeGains(): void {
    const now = this.context?.currentTime ?? 0
    this.filters.forEach((filter, index) => filter.gain.setValueAtTime(this.gains[index] ?? 0, now))
  }

  private applyEnabled(): void {
    const { source, gain, context, filters, compressor } = this
    if (!source || !gain || !context) return
    try {
      source.disconnect()
      for (const filter of filters) filter.disconnect()
      compressor?.disconnect()
      gain.disconnect()
    } catch {
      // Disconnecting a node that was never connected is legal in some engines and throws in
      // others; the rewire below is what matters.
    }
    try {
      const tail = this.leveling && compressor ? compressor : gain
      if (this.enabled && filters.length > 0) {
        source.connect(filters[0]!)
        filters.forEach((filter, index) => {
          const next = filters[index + 1]
          if (next) filter.connect(next)
        })
        filters[filters.length - 1]!.connect(tail)
      } else {
        source.connect(tail)
      }
      if (this.leveling && compressor) compressor.connect(gain)
      gain.gain.setValueAtTime(this.normalizationGain, context.currentTime)
      gain.connect(context.destination)
    } catch {
      // A broken chain must not silence the track. Direct output is the fallback, and the panel can
      // read `available` to say the equalizer is off.
      this.reason = 'failed'
      try {
        source.connect(context.destination)
      } catch {
        // The element is captured and cannot be rewired again; the engine reports playback errors.
      }
    }
  }
}

export const musicEqualizer = new MusicEqualizer()
