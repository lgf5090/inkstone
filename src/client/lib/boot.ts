
/**
 * The start-up overlay belongs to the document, and so does the code that answers a failed boot:
 * `public/boot.js` runs before any module, which is the only way to still be running when the module
 * graph itself is what failed to load. These two calls are its client-side seam — a rejection out of
 * `start()` is reported instead of dying as an unhandled rejection that leaves the overlay pulsing
 * forever, and a rendered app releases the reload guard so the next deploy can recover the same way.
 */
interface BootRecovery {
  fail: () => void
  ready: () => void
}

const bootRecovery = (): BootRecovery | undefined =>
  (window as Window & { __inkstoneBoot?: BootRecovery }).__inkstoneBoot

export function dismissBootScreen(): void {
  const boot = document.getElementById('boot')
  if (!boot) return
  boot.classList.add('done')
  window.setTimeout(() => boot.remove(), 400)
}

export function reportBootFailure(error: unknown): void {
  // Nothing is rendered and the overlay has no room for detail, so the console is the record of why.
  console.error('[inkstone] start-up failed', error)
  bootRecovery()?.fail()
}

export function reportBootReady(): void {
  bootRecovery()?.ready()
}
