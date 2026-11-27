const KEY_PREFIX = 'clouddrive-media-progress'
const RESUME_EDGE_SECONDS = 5
const SAVE_INTERVAL_MS = 5_000

interface StoredProgress {
  time: number
  duration: number
  updatedAt: number
}

function keyFor(userId: string, entryId: string): string {
  return `${KEY_PREFIX}:${userId}:${entryId}`
}

export function readMediaProgress(userId: string, entryId: string, duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null
  try {
    const raw = localStorage.getItem(keyFor(userId, entryId))
    if (!raw) return null
    const stored = JSON.parse(raw) as StoredProgress
    if (!Number.isFinite(stored.time) || !Number.isFinite(stored.duration)) return null
    if (Math.abs(stored.duration - duration) > 0.5) return null
    if (stored.time <= RESUME_EDGE_SECONDS || stored.time >= duration - RESUME_EDGE_SECONDS) return null
    return stored.time
  } catch (error) {
    console.warn('[inkstone] CloudDrive could not read media progress:', error)
    return null
  }
}

export function saveMediaProgress(userId: string, entryId: string, time: number, duration: number): void {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return
  try {
    const stored: StoredProgress = { time, duration, updatedAt: Date.now() }
    localStorage.setItem(keyFor(userId, entryId), JSON.stringify(stored))
  } catch (error) {
    console.warn('[inkstone] CloudDrive could not save media progress:', error)
  }
}

export function mediaProgressSaveInterval(): number {
  return SAVE_INTERVAL_MS
}
