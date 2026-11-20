/**
 * One reader, at most one request in flight, at most one trailing read.
 *
 * A page that refetches after every write can have two reads in flight at once, and the slower one
 * may land last with an older snapshot. Serialising alone would not help either: a burst of writes
 * deserves one trailing read, not one read each. This keeps the newest result and drops the rest.
 */
export function createRefreshQueue<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  shouldApply: () => boolean = () => true,
): () => Promise<void> {
  let latest = 0
  let inflight: Promise<void> | null = null
  let queued = false

  const run = (): Promise<void> => {
    const token = ++latest
    const task = (async () => {
      const value = await read()
      if (token === latest && shouldApply()) apply(value)
    })()
    inflight = task
    return task.finally(() => {
      if (inflight === task) inflight = null
      if (queued) {
        queued = false
        void run()
      }
    })
  }

  return async (): Promise<void> => {
    if (inflight) {
      queued = true
      await inflight
      return
    }
    await run()
  }
}
