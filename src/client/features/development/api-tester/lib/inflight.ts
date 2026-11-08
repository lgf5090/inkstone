/** One in-flight controller per tab, so a send in one tab cannot abort a send in another. */
const controllers = new Map<string, AbortController>()

/** Starts a request for a tab, aborting only that tab's earlier request. */
export function beginRequest(tabId: string): AbortController {
  controllers.get(tabId)?.abort()
  const controller = new AbortController()
  controllers.set(tabId, controller)
  return controller
}

export function cancelRequest(tabId: string): void {
  controllers.get(tabId)?.abort()
}

/** Aborts every tab's request, for a workspace switch or module teardown. */
export function cancelAllRequests(): void {
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
}

/** Unregisters `controller` if it is still the one this tab owns. */
export function endRequest(tabId: string, controller: AbortController): boolean {
  if (controllers.get(tabId) !== controller) return false
  controllers.delete(tabId)
  return true
}

/** Whether this controller is still the request the tab should publish results for. */
export function isCurrentRequest(tabId: string, controller: AbortController): boolean {
  return controllers.get(tabId) === controller
}

/** Drops a tab's request entirely: abort it and forget it, so a late result is not published. */
export function discardRequest(tabId: string): void {
  controllers.get(tabId)?.abort()
  controllers.delete(tabId)
}
