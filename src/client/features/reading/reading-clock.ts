export const READING_IDLE_MS = 90_000

export class ReadingClock {
  private lastFlushAt: number
  private lastActivityAt: number

  constructor(now = Date.now()) {
    this.lastFlushAt = now
    this.lastActivityAt = now
  }

  wake(now = Date.now()): void {
    if (now - this.lastActivityAt > READING_IDLE_MS) this.lastFlushAt = now
    this.lastActivityAt = now
  }

  tick(now = Date.now(), visible = true): number {
    if (!visible || now - this.lastActivityAt > READING_IDLE_MS) {
      this.lastFlushAt = now
      return 0
    }
    const seconds = Math.floor((now - this.lastFlushAt) / 1000)
    this.lastFlushAt = now
    return Math.max(0, seconds)
  }
}
