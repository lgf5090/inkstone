import { ApiError } from '../lib/errors'
import { acquireLease } from '../lib/lease'
import type { Env } from '../env'

const SETTINGS_LEASE_MS = 5_000

export async function withEmailSettingsLock<T>(env: Env, accountId: string, task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let release: Awaited<ReturnType<typeof acquireLease>> | null = null
    try {
      release = await acquireLease(
        env.DB,
        `email_settings_lock:${accountId}`,
        SETTINGS_LEASE_MS,
        'The mailbox settings are being changed; try again in a moment',
      )
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
        continue
      }
      throw error
    }
    try {
      return await task()
    } finally {
      await release()
    }
  }
  throw new ApiError(409, 'conflict', 'The mailbox settings are being changed; try again in a moment')
}
