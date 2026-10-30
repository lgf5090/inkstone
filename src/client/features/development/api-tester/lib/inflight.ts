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

/** Unregisters `controller` if it is still the one this tab owns. */
export function endRequest(tabId: string, controller: AbortController): void {
  if (controllers.get(tabId) === controller) controllers.delete(tabId)
}
