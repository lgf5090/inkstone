import { useEffect, useRef } from 'react'
import { useAssistant } from './assistant-store'

export function useAssistantToolRefresh(tools: ReadonlySet<string>, refresh: () => void | Promise<void>): void {
  const turn = useAssistant((state) => state.turn)
  const refreshed = useRef('')
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])
  useEffect(() => {
    if (!turn?.done) return
    const relevant = turn.tools.filter((tool) => tools.has(tool.name))
    const fingerprint = JSON.stringify(relevant.map((tool) => ({
      id: tool.id,
      name: tool.name,
      status: tool.status,
      approval: tool.approval?.status ?? null,
    })))
    if (!fingerprint || fingerprint === refreshed.current) return
    refreshed.current = fingerprint
    if (relevant.some((tool) => tool.status === 'success' && tool.approval?.status !== 'pending')) {
      void refreshRef.current()
    }
  }, [tools, turn])
}
