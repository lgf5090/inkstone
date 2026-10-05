import type { AppBindings } from '../env'
import { revokeAllMcpApiKeys } from './api-keys'

type OAuthProvider = NonNullable<AppBindings['Bindings']['OAUTH_PROVIDER']>

export async function collectGrantIds(
  oauth: OAuthProvider,
  userId: string,
): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  do {
    const page = await oauth.listUserGrants(userId, { limit: 100, cursor })
    ids.push(...page.items.map((grant) => grant.id))
    cursor = page.cursor
    if (cursor && seenCursors.has(cursor)) {
      throw new Error('OAuth grant pagination returned a repeated cursor')
    }
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return ids
}

export async function revokeLongLivedCredentials(
  db: D1Database,
  oauth: OAuthProvider | undefined,
  userId: string,
): Promise<void> {
  await revokeAllMcpApiKeys(db, userId)
  if (!oauth) return
  const ids = await collectGrantIds(oauth, userId)
  for (let offset = 0; offset < ids.length; offset += 25) {
    await Promise.all(
      ids.slice(offset, offset + 25).map((id) => oauth.revokeGrant(id, userId)),
    )
  }
}
