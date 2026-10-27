/**
 * The import path that stores an account before Cloudflare has vouched for it.
 *
 * `createAccount` verifies the credential first, which is right for the add dialog and wrong for a
 * CSV import with `skipVerify`: that option exists so a bulk paste lands in seconds and the screen
 * tests the rows afterwards. This writes the same two things in the same order — the sealed file,
 * then the row — and leaves `cf_account_id` empty, which is exactly the "Unverified" filter.
 *
 * Nothing here talks to Cloudflare, so a row written by this module is inert until `testAccount`
 * probes it.
 */
import type { Env } from '../env'
import { newId } from '../lib/id'
import { DEFAULT_FEATURES } from './accounts'
import { deleteAccountCredentials, writeAccountCredentials } from './credentials'

export interface UnverifiedAccountInput {
  name: string
  email: string
  apiKey: string
  password?: string | null
}

export async function createUnverifiedAccount(
  env: Env,
  userId: string,
  input: UnverifiedAccountInput,
): Promise<string> {
  const id = newId()
  await writeAccountCredentials(env, id, {
    api_key: input.apiKey,
    ...(input.password ? { password: input.password } : {}),
  })
  const now = Date.now()
  try {
    await env.DB.prepare(
      `INSERT INTO cloudflare_account
        (id, user_id, name, auth_type, email, cf_account_id, is_active, enabled_features,
         available_features, has_credentials, created_at, updated_at)
       VALUES (?, ?, ?, 'global_key', ?, NULL, 1, ?, '', 1, ?, ?)`,
    )
      .bind(id, userId, input.name, input.email, DEFAULT_FEATURES, now, now)
      .run()
  } catch (error) {
    await deleteAccountCredentials(env, id).catch(() => undefined)
    throw error
  }
  return id
}
