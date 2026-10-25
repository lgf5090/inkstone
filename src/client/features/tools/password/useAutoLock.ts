import { useEffect, useRef } from 'react'
import { usePasswordVaultStore } from './store'

export const DEFAULT_AUTO_LOCK_TIMEOUT = 5 * 60 * 1000 // 5 minutes

export function useAutoLock(timeoutMs = DEFAULT_AUTO_LOCK_TIMEOUT) {
  const isUnlocked = usePasswordVaultStore((s) => s.isUnlocked)
  const lock = usePasswordVaultStore((s) => s.lock)

  const blurTimeRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isUnlocked) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      blurTimeRef.current = null
      return
    }

    const handleBlur = () => {
      blurTimeRef.current = Date.now()
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        lock()
      }, timeoutMs)
    }

    const handleFocus = () => {
      if (blurTimeRef.current) {
        const elapsed = Date.now() - blurTimeRef.current
        if (elapsed >= timeoutMs) {
          lock()
        }
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      blurTimeRef.current = null
    }

    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleFocus)

    return () => {
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleFocus)
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [isUnlocked, lock, timeoutMs])
}
