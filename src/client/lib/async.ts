/**
 * Resolves when the work does or when it has had long enough, so a slow artifact delays what
 * comes next instead of hanging it. The timeout is the contract: the caller cannot wait
 * forever, and it must not learn about a failure it can do nothing about.
 */
export function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, timeoutMs)
    const done = (): void => {
      window.clearTimeout(timer)
      resolve()
    }
    void work.then(done, done)
  })
}
