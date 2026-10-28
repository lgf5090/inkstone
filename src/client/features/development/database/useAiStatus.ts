import { useCallback, useEffect, useState } from 'react'
import { getAiStatus } from './api'

export interface AiStatusState {
  configured: boolean | null
  modelLabel: string
  failed: boolean
  reload: () => void
}

export function useAiStatus(): AiStatusState {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [modelLabel, setModelLabel] = useState('')
  const [failed, setFailed] = useState(false)
  const reload = useCallback(() => {
    setFailed(false)
    void getAiStatus()
      .then((status) => {
        setConfigured(status.configured)
        setModelLabel(status.modelLabel ?? '')
      })
      .catch(() => {
        setConfigured(null)
        setModelLabel('')
        setFailed(true)
      })
  }, [])
  useEffect(() => {
    reload()
  }, [reload])
  return { configured, modelLabel, failed, reload }
}
