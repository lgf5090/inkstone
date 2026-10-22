import { useEffect, useRef } from 'react'
import { useAssistant } from './assistant-store'

export function useAssistantToolRefresh(tools: ReadonlySet<string>, refresh: () => void | Promise<void>): void {
  const turn = useAssistant((state) => state.turn)
  const refreshed = useRef<number | null>(null)
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])
  useEffect(() => {
    if (!turn?.done || turn.token === undefined) return
    if (refreshed.current === turn.token) return
    refreshed.current = turn.token
    if (turn.tools.some((tool) => tools.has(tool.name) && tool.status === 'success')) {
      void refreshRef.current()
    }
  }, [tools, turn])
}
