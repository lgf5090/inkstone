export function preferredScrollBehavior(): ScrollBehavior {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'
}

/**
 * How long a copy button stays on its "copied" confirmation before returning to its resting label.
 *
 * The four affordances this replaces each held their own dwell between 1400ms and 1600ms — a
 * difference no reader can perceive, and one that had to be re-decided on every screen that copies
 * something. One value makes the acknowledgement the same length wherever it appears: long enough to
 * read once, short enough that it never outlives the click that caused it.
 */
export const COPY_RESET_MS = 1500
