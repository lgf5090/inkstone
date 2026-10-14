/**
 * The one D1 read the avatar byte route makes.
 *
 * `avatars/storage.ts` owns the object side of an avatar — the bytes, the key, the cleanup — and this
 * owns the account side. The shape follows `share/store.ts`: a module of free functions over a
 * `D1Database`, returning rows or booleans and never a `Response`, so the route keeps validation,
 * status codes and the headers it answers with.
 *
 * There is deliberately no session user here, so no `user_id` scoping is possible — and none is
 * needed for the safety of this read. `GET /api/avatars/:storage/:userId/:file` sits outside
 * `requireAuth`: an `<img>` tag on a shared note cannot carry a session cookie, so the picture has to
 * be reachable by a stranger. What makes the read safe is that the caller names both halves of a pair
 * this account wrote — the object id minted by `persistUploadedAvatar` and the `avatar_url` preference
 * stored from it — and the statement only answers when the account's stored preference still *is* that
 * address. A guesser would have to know an id that is 128 bits of randomness, and a changed or cleared
 * avatar stops answering immediately. The same reason `findShareBySlug` has no `user_id`.
 */

/**
 * Whether `userId` still serves `preference` as its avatar.
 *
 * Both columns are compared against the same request path on purpose: matching the id alone would
 * hand out whatever object the address named, and matching the preference alone would let one account
 * read another's object by guessing the same address.
 */
export async function avatarOwnerMatchesPreference(
  db: D1Database,
  userId: string,
  preference: string,
): Promise<boolean> {
  const owner = await db
    .prepare(`SELECT id FROM users WHERE id = ?1 AND avatar_url = ?2`)
    .bind(userId, preference)
    .first<{ id: string }>()
  return owner !== null
}
