import { createContext, useContext, type ReactNode } from 'react'
import type { AttachmentHubScope } from '@shared/attachment-hub'

const HubScopeContext = createContext<AttachmentHubScope | null>(null)

export function HubScopeProvider({ scope, children }: { scope: AttachmentHubScope; children: ReactNode }) {
  return <HubScopeContext.Provider value={scope}>{children}</HubScopeContext.Provider>
}

/**
 * Every request the hub makes is namespaced by this scope, so a component that cannot see one must
 * fail loudly rather than ask the server for whichever namespace it happened to guess.
 */
export function useHubScope(): AttachmentHubScope {
  const scope = useContext(HubScopeContext)
  if (!scope) throw new Error('attachment-hub components must render inside <AttachmentHub>')
  return scope
}
