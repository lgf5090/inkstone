import { describe, expect, it } from 'vitest'
import { ReadingClock, READING_IDLE_MS } from '../src/client/features/reading/reading-clock'

const NOW = 1_760_000_000_000

describe('ReadingClock', () => {
  it('counts only the time since the previous flush', () => {
    const clock = new ReadingClock(NOW)
    expect(clock.tick(NOW + 15_000)).toBe(15)
    expect(clock.tick(NOW + 20_000)).toBe(5)
    expect(clock.tick(NOW + 20_000)).toBe(0)
  })

  it('does not count the same leaving interval twice', () => {
    const clock = new ReadingClock(NOW)
    expect(clock.tick(NOW + 15_000)).toBe(15)
    expect(clock.tick(NOW + 18_000)).toBe(3)
    expect(clock.tick(NOW + 18_000)).toBe(0)
  })

  it('stops after the idle limit and discards a long inactive gap on wake', () => {
    const clock = new ReadingClock(NOW)
    expect(clock.tick(NOW + READING_IDLE_MS)).toBe(90)
    expect(clock.tick(NOW + READING_IDLE_MS + 60_000)).toBe(0)
    clock.wake(NOW + READING_IDLE_MS + 120_000)
    expect(clock.tick(NOW + READING_IDLE_MS + 135_000)).toBe(15)
  })

  it('does not count hidden-tab time', () => {
    const clock = new ReadingClock(NOW)
    expect(clock.tick(NOW + 60_000, false)).toBe(0)
    expect(clock.tick(NOW + 75_000, true)).toBe(15)
  })
})
