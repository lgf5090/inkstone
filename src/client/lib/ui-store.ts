import { useUi } from '../store/ui'

export interface UiStoreBridge {
  toast: (message: string, tone?: 'success' | 'error' | 'warning' | 'default') => void
}

const state: UiStoreBridge = {
  toast: (message: string, tone = 'default') => {
    useUi.getState().toast({
      title: message,
      tone: tone === 'error' ? 'danger' : tone,
    })
  },
}

export function useUiStore<T>(selector?: (s: UiStoreBridge) => T): T | UiStoreBridge {
  if (selector) return selector(state)
  return state
}

useUiStore.getState = () => state
