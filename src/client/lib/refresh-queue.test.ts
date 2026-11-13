import { describe, expect, it, vi } from 'vitest'
import { createRefreshQueue } from './refresh-queue'

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('the refresh queue', () => {
  it('coalesces a burst into one trailing read and applies the newest value', async () => {
    const reads: ReturnType<typeof deferred<string>>[] = []
    const read = vi.fn(() => {
      const next = deferred<string>()
      reads.push(next)
      return next.promise
    })
    const applied: string[] = []
    const refresh = createRefreshQueue(read, (value) => applied.push(value))

    const first = refresh()
    const second = refresh()
    const third = refresh()
    expect(read).toHaveBeenCalledTimes(1)

    reads[0]!.resolve('first')
    await Promise.all([first, second, third])
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(2)

    reads[1]!.resolve('second')
    await vi.waitFor(() => expect(applied).toEqual(['first', 'second']))
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('drops a slow read that resolves after a newer one', async () => {
    const reads: ReturnType<typeof deferred<string>>[] = []
    const read = vi.fn(() => {
      const next = deferred<string>()
      reads.push(next)
      return next.promise
    })
    const applied: string[] = []
    const refresh = createRefreshQueue(read, (value) => applied.push(value))

    const first = refresh()
    reads[0]!.resolve('old')
    await first

    const second = refresh()
    reads[1]!.resolve('new')
    await second

    expect(applied).toEqual(['old', 'new'])
  })

  it('skips applying a value the caller no longer considers current', async () => {
    const reads: ReturnType<typeof deferred<string>>[] = []
    const read = vi.fn(() => {
      const next = deferred<string>()
      reads.push(next)
      return next.promise
    })
    const applied: string[] = []
    let current = true
    const refresh = createRefreshQueue(read, (value) => applied.push(value), () => current)

    const pending = refresh()
    current = false
    reads[0]!.resolve('stale')
    await pending

    expect(applied).toEqual([])
  })
})
