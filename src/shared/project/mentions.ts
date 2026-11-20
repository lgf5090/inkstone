/**
 * D-7: who a comment notifies — the members it @mentions plus the subscribers watching the card or
 * board, never the author. Pure so tests can pin the set without a database.
 */
const MENTION = /@([\p{L}\p{N}_-]+)/gu

/** The members a body actually names, which is the subset a `mentions` preference still delivers. */
export function projectCommentMentionedIds(
  memberIds: readonly string[],
  body: string,
  memberNames: Readonly<Record<string, string>> = {},
): string[] {
  const mentioned = new Set<string>()
  for (const match of body.matchAll(MENTION)) mentioned.add(match[1]!)
  const lowered = body.toLowerCase()
  const out: string[] = []
  for (const id of memberIds) {
    const name = memberNames[id]
    // A handle is opaque, so a reader mentions the name they see; names may contain spaces and the
    // token above stops at one, which is why the whole body is also checked.
    if (mentioned.has(id) || (name && lowered.includes(`@${name.toLowerCase()}`))) out.push(id)
  }
  return out
}

export function projectCommentNotificationTargets(
  memberIds: readonly string[],
  watcherIds: readonly string[],
  body: string,
  authorId: string,
  memberNames: Readonly<Record<string, string>> = {},
): string[] {
  const targets = new Set(projectCommentMentionedIds(memberIds, body, memberNames))
  for (const id of watcherIds) targets.add(id)
  targets.delete(authorId)
  return [...targets]
}