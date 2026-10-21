import { useCallback, useEffect, useRef } from 'react'
import {
  clearMemoDraft,
  createMemoDraftDebouncer,
  saveMemoDraft,
  type MemoDraftDebouncer,
  type MemoDraftInput,
} from './state'

export interface MemoDraftOptions {
  userId: string
  scope: string
  enabled: boolean
  value: string
  attachmentIds?: readonly string[]
  spaceId?: string | null
  visibility?: MemoDraftInput['visibility']
}

export interface MemoDraftHandle {
  clearDraft: () => void
}

export function useMemoDraft(options: MemoDraftOptions): MemoDraftHandle {
  const { userId, scope, enabled, value, attachmentIds, spaceId, visibility } = options
  const debouncerRef = useRef<MemoDraftDebouncer<MemoDraftInput> | null>(null)

  useEffect(() => {
    if (!enabled) {
      debouncerRef.current?.cancel()
      debouncerRef.current = null
      return
    }
    const debouncer = createMemoDraftDebouncer<MemoDraftInput>((input) => saveMemoDraft(userId, scope, input))
    debouncerRef.current = debouncer
    const onPageHide = (): void => debouncer.flush()
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') debouncer.flush()
    }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      debouncer.flush()
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibility)
      if (debouncerRef.current === debouncer) debouncerRef.current = null
    }
  }, [enabled, scope, userId])

  useEffect(() => {
    if (!enabled) return
    const debouncer = debouncerRef.current
    if (!debouncer) return
    if (!value.trim() && !(attachmentIds && attachmentIds.length > 0)) {
      debouncer.cancel()
      clearMemoDraft(userId, scope)
      return
    }
    debouncer.schedule({
      content: value,
      attachmentIds: [...(attachmentIds ?? [])],
      spaceId: spaceId ?? null,
      visibility,
    })
  }, [attachmentIds, enabled, scope, spaceId, userId, value, visibility])

  const clearDraft = useCallback((): void => {
    debouncerRef.current?.cancel()
    clearMemoDraft(userId, scope)
  }, [scope, userId])

  return { clearDraft }
}
