import { ApiError } from './errors'
import { PASSWORD_MAX_LENGTH, verifyPassword } from './password'
import {
  assertAttemptBudget,
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
} from './throttle'


export async function requireCurrentPassword(
  db: D1Database,
  userId: string,
  input: unknown,
): Promise<string> {
  const throttleKeys = [`pw:${userId}`]
  const workKeys = [{ key: `pw-work:${userId}`, maxAttempts: 8, windowMs: 10 * 60 * 1000 }]
  await assertAttemptBudget(async () => {
    await consumeAttemptBudget(db, workKeys)
    await assertNotLocked(db, throttleKeys)
  })

  const row = await db
    .prepare(`SELECT password_hash FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ password_hash: string }>()
  if (!row) throw ApiError.unauthenticated()

  const password = typeof input === 'string' && input.length <= PASSWORD_MAX_LENGTH ? input : ''
  if (!(await verifyPassword(password, row.password_hash))) {
    await recordLoginFailure(db, throttleKeys)
    throw new ApiError(401, 'wrong_password', "The current password is incorrect")
  }
  await clearLoginFailures(db, [...throttleKeys, workKeys[0]!.key])
  return row.password_hash
}
