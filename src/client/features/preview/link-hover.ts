import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { WikiLinkHoverCardState } from '../../types/hover-card'

export const MAX_HOVER_CARD_DEPTH = 4

interface LinkHoverOptions {
  resolve: (link: HTMLElement) => WikiLinkHoverCardState | null
  delay: number
  enabled: boolean
  armOnNonLink?: boolean
  hideGraceMs?: number
}

export interface LinkHoverMachine {
  card: WikiLinkHoverCardState | null
  propose: (link: HTMLElement | null, options?: { immediate?: boolean }) => void
  handleMouseMove: (event: React.MouseEvent) => void
  handleMouseLeave: () => void
  clearPendingHide: () => void
  armHide: (grace?: number) => void
  hideNow: () => void
}

export function useLinkHover({
  resolve,
  delay,
  enabled,
  armOnNonLink = true,
  hideGraceMs = 280,
}: LinkHoverOptions): LinkHoverMachine {
  const [card, setCard] = useState<WikiLinkHoverCardState | null>(null)
  const candidateRef = useRef<HTMLElement | null>(null)
  const openedLinkRef = useRef<HTMLElement | null>(null)
  const resetCandidate = useCallback(() => {
    candidateRef.current = null
    openedLinkRef.current = null
  }, [])
  const timers = useHoverTimers({
    delay,
    grace: hideGraceMs,
    onHide: () => {
      resetCandidate()
      setCard(null)
    },
  })
  const candidate = useHoverCandidateMachine({
    resolve,
    enabled,
    armOnNonLink,
    candidateRef,
    openedLinkRef,
    timers,
    onOpen: (next) => setCard(next),
  })
  const handleMouseLeave = useCallback(() => {
    timers.armHide()
  }, [timers])

  useEffect(() => {
    if (!enabled)
      timers.hideNow()
  }, [enabled, timers.hideNow])

  useEffect(() => () => timers.dispose(), [timers.dispose])

  return {
    card,
    propose: candidate.propose,
    handleMouseMove: candidate.handleMouseMove,
    handleMouseLeave,
    clearPendingHide: timers.clearPendingHide,
    armHide: timers.armHide,
    hideNow: timers.hideNow,
  }
}

type HoverTimers = ReturnType<typeof useHoverTimers>

function useHoverTimers({ delay, grace, onHide }: {
  delay: number
  grace: number
  onHide: () => void
}) {
  const showTimerRef = useRef(0)
  const hideTimerRef = useRef(0)
  const delayRef = useRef(delay)
  delayRef.current = delay
  const graceRef = useRef(grace)
  graceRef.current = grace
  const onHideRef = useRef(onHide)
  onHideRef.current = onHide

  const clearPendingHide = useCallback(() => {
    window.clearTimeout(hideTimerRef.current)
  }, [])

  const hideNow = useCallback(() => {
    window.clearTimeout(showTimerRef.current)
    window.clearTimeout(hideTimerRef.current)
    onHideRef.current()
  }, [])

  const armHide = useCallback((nextGrace = graceRef.current) => {
    window.clearTimeout(showTimerRef.current)
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => onHideRef.current(), nextGrace)
  }, [])

  const scheduleShow = useCallback((fn: () => void) => {
    window.clearTimeout(showTimerRef.current)
    showTimerRef.current = window.setTimeout(fn, delayRef.current)
  }, [])

  const dispose = useCallback(() => {
    window.clearTimeout(showTimerRef.current)
    window.clearTimeout(hideTimerRef.current)
  }, [])

  return useMemo(() => ({
    showTimerRef,
    hideTimerRef,
    clearPendingHide,
    armHide,
    hideNow,
    scheduleShow,
    dispose,
  }), [clearPendingHide, armHide, hideNow, scheduleShow, dispose])
}

function useHoverCandidateMachine({
  resolve,
  enabled,
  armOnNonLink,
  candidateRef,
  openedLinkRef,
  timers,
  onOpen,
}: {
  resolve: (link: HTMLElement) => WikiLinkHoverCardState | null
  enabled: boolean
  armOnNonLink: boolean
  candidateRef: MutableRefObject<HTMLElement | null>
  openedLinkRef: MutableRefObject<HTMLElement | null>
  timers: HoverTimers
  onOpen: (card: WikiLinkHoverCardState) => void
}) {
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const armOnNonLinkRef = useRef(armOnNonLink)
  armOnNonLinkRef.current = armOnNonLink

  const openFor = useCallback((link: HTMLElement) => {
    window.clearTimeout(timers.showTimerRef.current)
    if (!enabledRef.current) return
    const next = resolveRef.current(link)
    candidateRef.current = null
    openedLinkRef.current = link
    if (next) onOpen(next)
  }, [timers, candidateRef, openedLinkRef, onOpen])

  const propose = useCallback((link: HTMLElement | null, options?: { immediate?: boolean }) => {
    if (!link) {
      window.clearTimeout(timers.showTimerRef.current)
      candidateRef.current = null
      timers.armHide()
      return
    }
    if (!enabledRef.current || !isHoverFinePointer()) return
    window.clearTimeout(timers.hideTimerRef.current)
    if (link === candidateRef.current || link === openedLinkRef.current) return
    candidateRef.current = link
    if (options?.immediate) openFor(link)
    else timers.scheduleShow(() => {
      if (candidateRef.current !== link || !enabledRef.current) return
      openFor(link)
    })
  }, [timers, candidateRef, openedLinkRef, openFor])

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (!enabledRef.current || !isHoverFinePointer()) return
    window.clearTimeout(timers.hideTimerRef.current)
    const link = (event.target as HTMLElement).closest<HTMLElement>('[data-wikilink], [data-tag], [data-mdlink], a[href], img[src]')
    if (!link) {
      window.clearTimeout(timers.showTimerRef.current)
      candidateRef.current = null
      if (armOnNonLinkRef.current) timers.armHide()
      return
    }
    propose(link)
  }, [timers, candidateRef, propose])

  return { propose, handleMouseMove }
}

function isHoverFinePointer(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(hover: hover) and (pointer: fine)').matches
}
