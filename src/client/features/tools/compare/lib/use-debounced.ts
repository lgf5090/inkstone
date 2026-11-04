/** A value that settles after the reader stops typing, so a diff is not recomputed per keystroke. */
import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const handle = window.setTimeout(() => setSettled(value), delayMs)
    return () => window.clearTimeout(handle)
  }, [value, delayMs])
  return settled
}
