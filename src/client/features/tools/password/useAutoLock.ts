import { useEffect, useRef } from 'react'
import { usePasswordVaultStore } from './store'

export const DEFAULT_AUTO_LOCK_TIMEOUT = 5 * 60 * 1000 // 5 minutes

/**
 * Locks the vault after a period without interaction, and immediately when the tab is left or loses
 * focus.
 *
 * The previous version only armed a timer on `window.blur`, so a reader who stayed on the tab got no
 * lock at all, and a tab switch that kept focus never locked either. Activity now re-arms an idle
 * timer, and `visibilitychange` covers the cases `blur` misses.
 */
export function useAutoLock(timeoutMs = DEFAULT_AUTO_LOCK_TIMEOUT) {
  const isUnlocked = usePasswordVaultStore((s) => s.isUnlocked)
  const lock = usePasswordVaultStore((s) => s.lock)
  const touchActivity = usePasswordVaultStore((s) => s.touchActivity)

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

    const arm = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        lock()
      }, timeoutMs)
    }

    const handleBlur = () => {
      blurTimeRef.current = Date.now()
      arm()
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
      arm()
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') handleBlur()
      else handleFocus()
    }

    const handleActivity = () => {
      touchActivity()
      arm()
    }

    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pointerdown', handleActivity, { passive: true })
    window.addEventListener('keydown', handleActivity)
    arm()

    return () => {
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pointerdown', handleActivity)
      window.removeEventListener('keydown', handleActivity)
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [isUnlocked, lock, touchActivity, timeoutMs])
}
