/**
 * Connects, hears drops, and runs the retry ladder. It owns no terminal and writes nothing except
 * the short ANSI status notes it puts in the scrollback, so the transport and the xterm surface stay
 * independent of each other.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_RECONNECT_ATTEMPTS, nextRetryDecision } from './session-retry'
import type { TerminalTransport, TerminalTransportFactory, TerminalTransportHandlers } from './transport/types'

export type TerminalSessionPhase = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed'

export interface TerminalSessionView {
  phase: TerminalSessionPhase
  attempt: number
  error: string | null
  manual: boolean
}

export interface TerminalSessionController extends TerminalSessionView {
  cols: number
  rows: number
  send: (data: string) => void
  resize: (cols: number, rows: number) => void
  reconnectNow: () => void
  disconnect: () => void
  simulateDrop: () => void
}

export interface UseTerminalSessionOptions {
  createTransport: TerminalTransportFactory
  initialCols: number
  initialRows: number
  onOutput: (data: string) => void
}

const RETRY_NOTE = (attempt: number, reason?: string) =>
  `\r\n\x1b[33m[inkstone] Connection lost${reason ? ` (${reason})` : ''}. ` +
  `Reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})…\x1b[0m\r\n`

const RECONNECTED_NOTE = '\r\n\x1b[32m[inkstone] Reconnected.\x1b[0m\r\n'

const FAILED_NOTE = '\r\n\x1b[31m[inkstone] Connection failed after the final retry.\x1b[0m\r\n'

const VIEW_INITIAL: TerminalSessionView = { phase: 'connecting', attempt: 0, error: null, manual: false }

export function useTerminalSession(options: UseTerminalSessionOptions): TerminalSessionController {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [view, setView] = useState<TerminalSessionView>(VIEW_INITIAL)
  const [dimensions, setDimensions] = useState({ cols: options.initialCols, rows: options.initialRows })

  const transportRef = useRef<TerminalTransport | null>(null)
  const generationRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const dimensionsRef = useRef(dimensions)
  dimensionsRef.current = dimensions

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  const connect = useCallback((attempt: number) => {
    const generation = ++generationRef.current
    transportRef.current?.dispose()
    const size = dimensionsRef.current
    const transport = optionsRef.current.createTransport({
      onPhase: (event) => {
        if (generation !== generationRef.current) return
        if (event.phase === 'open') {
          setView({ phase: 'open', attempt: 0, error: null, manual: false })
          transport.resize(dimensionsRef.current.cols, dimensionsRef.current.rows)
          if (attempt > 0) optionsRef.current.onOutput(RECONNECTED_NOTE)
          return
        }
        if (event.phase === 'error') {
          scheduleFailure(event.message ?? event.reason ?? 'transport error')
          return
        }
        if (event.phase === 'closed') {
          // `close()` is deliberate and already reflected in state; anything else is a drop.
          if (viewRef.current.manual) return
          scheduleFailure(event.message ?? event.reason)
        }
      },
      onOutput: (data) => {
        if (generation !== generationRef.current) return
        optionsRef.current.onOutput(data)
      },
    } satisfies TerminalTransportHandlers)
    transportRef.current = transport
    setView({ phase: attempt > 0 ? 'reconnecting' : 'connecting', attempt, error: null, manual: false })
    transport.connect(size)

    function scheduleFailure(reason: string | undefined): void {
      const decision = nextRetryDecision(viewRef.current.attempt + 1)
      if (decision.action === 'exhausted') {
        transportRef.current?.dispose()
        transportRef.current = null
        setView({ phase: 'failed', attempt: MAX_RECONNECT_ATTEMPTS, error: reason ?? null, manual: false })
        optionsRef.current.onOutput(FAILED_NOTE)
        return
      }
      setView({ phase: 'reconnecting', attempt: decision.attempt, error: reason ?? null, manual: false })
      optionsRef.current.onOutput(RETRY_NOTE(decision.attempt, reason))
      clearRetryTimer()
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        connect(decision.attempt)
      }, decision.delayMs)
    }
  }, [clearRetryTimer])

  useEffect(() => {
    connect(0)
    return () => {
      generationRef.current += 1
      clearRetryTimer()
      transportRef.current?.dispose()
      transportRef.current = null
    }
  }, [connect, clearRetryTimer])

  const send = useCallback((data: string) => {
    transportRef.current?.send(data)
  }, [])

  const resize = useCallback((cols: number, rows: number) => {
    setDimensions((current) => (current.cols === cols && current.rows === rows ? current : { cols, rows }))
    dimensionsRef.current = { cols, rows }
    transportRef.current?.resize(cols, rows)
  }, [])

  const reconnectNow = useCallback(() => {
    if (viewRef.current.phase === 'open' || viewRef.current.phase === 'connecting') return
    clearRetryTimer()
    connect(1)
  }, [clearRetryTimer, connect])

  const disconnect = useCallback(() => {
    clearRetryTimer()
    generationRef.current += 1
    const transport = transportRef.current
    transportRef.current = null
    transport?.close()
    transport?.dispose()
    setView({ phase: 'closed', attempt: 0, error: null, manual: true })
  }, [clearRetryTimer])

  const simulateDrop = useCallback(() => {
    transportRef.current?.simulateDrop?.()
  }, [])

  return {
    ...view,
    cols: dimensions.cols,
    rows: dimensions.rows,
    send,
    resize,
    reconnectNow,
    disconnect,
    simulateDrop,
  }
}
