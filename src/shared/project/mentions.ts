/**
 * D-7: who a comment notifies — the members it @mentions plus the subscribers watching the card or
 * board, never the author. Pure so tests can pin the set without a database.
 */
const MENTION = /@([a-zA-Z0-9_-]+)/g

export function projectCommentNotificationTargets(
  memberIds: readonly string[],
  watcherIds: readonly string[],
  body: string,
  authorId: string,
): string[] {
  const mentioned = new Set<string>()
  for (const match of body.matchAll(MENTION)) mentioned.add(match[1]!)
  const targets = new Set<string>()
  for (const id of memberIds) if (mentioned.has(id)) targets.add(id)
  for (const id of watcherIds) targets.add(id)
  targets.delete(authorId)
  return [...targets]
}