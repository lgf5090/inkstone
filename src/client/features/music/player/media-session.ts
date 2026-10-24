/**
 * What the operating system shows in its media controls, and the buttons it can press.
 *
 * None of this changes playback by itself: the handlers are the player store's own actions, wired in
 * once. A browser without `navigator.mediaSession`, or one that refuses a particular action, keeps
 * playing — the lock screen is an enhancement, not the transport.
 */
export interface MediaSessionMetadata {
  title: string
  artist: string
  album: string
  /** Absolute or same-origin cover URL. The OS fetches it itself. */
  artworkUrl: string
}

export interface MediaSessionHandlers {
  play: () => void
  pause: () => void
  stop: () => void
  next: () => void
  previous: () => void
  /** Absolute position in milliseconds. */
  seek: (positionMs: number) => void
  /** Relative jump in milliseconds, positive forward. */
  seekBy: (deltaMs: number) => void
}

export type MediaSessionPlaybackState = 'none' | 'paused' | 'playing'

function session(): MediaSession | null {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null
  return navigator.mediaSession ?? null
}

function absoluteArtwork(url: string): string {
  if (!url || typeof window === 'undefined') return url
  try {
    return new URL(url, window.location.href).href
  } catch {
    // An unparseable artwork URL simply means no artwork; metadata is still worth setting.
    return ''
  }
}

export function updateMediaSessionMetadata(metadata: MediaSessionMetadata | null): void {
  const target = session()
  if (!target) return
  try {
    if (!metadata) {
      target.metadata = null
      return
    }
    if (typeof MediaMetadata === 'undefined') return
    const artworkUrl = absoluteArtwork(metadata.artworkUrl)
    target.metadata = new MediaMetadata({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      artwork: artworkUrl ? [{ src: artworkUrl, sizes: '512x512' }] : [],
    })
  } catch {
    // Some engines reject artwork or the constructor itself. The track keeps playing; the lock
    // screen shows whatever it held before.
  }
}

export function updateMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
  const target = session()
  if (!target) return
  try {
    target.playbackState = state
  } catch {
    // A read-only or unsupported playbackState is not a playback failure.
  }
}

export function updateMediaSessionPosition(positionMs: number, durationMs: number, rate: number): void {
  const target = session()
  if (!target || typeof target.setPositionState !== 'function') return
  try {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      target.setPositionState()
      return
    }
    const position = Math.min(durationMs, Math.max(0, Number.isFinite(positionMs) ? positionMs : 0)) / 1000
    const duration = durationMs / 1000
    target.setPositionState({
      duration,
      position,
      playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
    })
  } catch {
    // Position state is validated by the browser; an out-of-range value is dropped until the next
    // time update rather than interrupting playback.
  }
}

/**
 * Wire the OS buttons to the player.
 *
 * Actions a browser does not implement throw from `setActionHandler`; each is attempted on its own so
 * one missing action does not leave the rest unbound. The returned cleanup unbinds only what it bound.
 */
export function bindMediaSessionHandlers(handlers: MediaSessionHandlers): () => void {
  const target = session()
  if (!target) return () => {}

  const bound: MediaSessionAction[] = []
  const bind = (action: MediaSessionAction, handler: MediaSessionActionHandler): void => {
    try {
      target.setActionHandler(action, handler)
      bound.push(action)
    } catch {
      // Unsupported action in this browser; the rest of the controls still work.
    }
  }

  bind('play', () => handlers.play())
  bind('pause', () => handlers.pause())
  bind('stop', () => handlers.stop())
  bind('previoustrack', () => handlers.previous())
  bind('nexttrack', () => handlers.next())
  bind('seekbackward', (details) => handlers.seekBy(-(details.seekOffset ?? 10) * 1000))
  bind('seekforward', (details) => handlers.seekBy((details.seekOffset ?? 10) * 1000))
  bind('seekto', (details) => {
    if (typeof details.seekTime === 'number') handlers.seek(details.seekTime * 1000)
  })

  return () => {
    for (const action of bound) {
      try {
        target.setActionHandler(action, null)
      } catch {
        // The action was accepted before; a browser that now refuses to clear it is already gone.
      }
    }
  }
}
