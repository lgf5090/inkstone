/**
 * D-7: who a comment notifies — the members it @mentions plus the subscribers watching the card or
 * board, never the author. Pure so tests can pin the set without a database.
 */
const MENTION = /@([\p{L}\p{N}_-]+)/gu

export function projectCommentNotificationTargets(
  memberIds: readonly string[],
  watcherIds: readonly string[],
  body: string,
  authorId: string,
  memberNames: Readonly<Record<string, string>> = {},
): string[] {
  const mentioned = new Set<string>()
  for (const match of body.matchAll(MENTION)) mentioned.add(match[1]!)
  const lowered = body.toLowerCase()
  const targets = new Set<string>()
  for (const id of memberIds) {
    const name = memberNames[id]
    // A handle is opaque, so a reader mentions the name they see; names may contain spaces and the
    // token above stops at one, which is why the whole body is also checked.
    if (mentioned.has(id) || (name && lowered.includes(`@${name.toLowerCase()}`))) targets.add(id)
  }
  for (const id of watcherIds) targets.add(id)
  targets.delete(authorId)
  return [...targets]
}