export async function spaceBelongsToUser(
  db: D1Database,
  userId: string,
  spaceId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM memos_spaces WHERE id = ?1 AND user_id = ?2`)
    .bind(spaceId, userId)
    .first<{ id: string }>()
  return row !== null
}
