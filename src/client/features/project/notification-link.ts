export interface ProjectNotificationTarget {
  boardId: string
  cardId: string
}

/** The card a project notice points at, or null when the tail is not this app's pair. */
export function projectCardFromNotificationLink(link: string | null | undefined): ProjectNotificationTarget | null {
  const match = /^project:([^:]+):([^:]+)$/.exec(link ?? '')
  return match ? { boardId: match[1]!, cardId: match[2]! } : null
}
