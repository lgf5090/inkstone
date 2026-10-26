/**
 * The Cloudflare account credential bundle, and the only place it is stored.
 *
 * The reference module kept encrypted tokens in its own SQLite table. This deployment keeps the
 * ciphertext as a file in the R2 bucket instead — one file per account — because the vault is an
 * encryption oracle rather than a store, and because a credential is not relational data: nothing
 * joins to it, and deleting the account must delete it in one step.
 *
 * Path: `cloudflare/txt/accounts/<accountId>.txt`. The second segment is the file kind, so a future
 * secret that is not text (a key pair, a certificate) gets its own kind instead of a second scheme.
 * Contents are the vault's `v1.` ciphertext; plaintext never reaches the bucket.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { decryptCloudflareAccountSecret, encryptCloudflareAccountSecret } from '../lib/crypto'

export interface CloudflareCredentials {
  api_token?: string
  api_key?: string
  password?: string
}

export const CLOUDFLARE_CREDENTIAL_PREFIX = 'cloudflare/txt/accounts/'

export function accountCredentialKey(accountId: string): string {
  return `${CLOUDFLARE_CREDENTIAL_PREFIX}${accountId}.txt`
}

function bucket(env: Env): R2Bucket {
  if (!env.FILES) {
    throw new ApiError(
      503,
      'storage_unavailable',
      'This deployment has no R2 bucket, so Cloudflare account credentials cannot be stored',
    )
  }
  return env.FILES
}

/** The bundle as stored, or null when the account has no file (an unverified import, or none yet). */
export async function readAccountCredentials(
  env: Env,
  accountId: string,
): Promise<CloudflareCredentials | null> {
  const object = await bucket(env).get(accountCredentialKey(accountId))
  if (!object) return null
  const stored = (await object.text()).trim()
  if (!stored) return null
  const record = await decryptCloudflareAccountSecret(env, accountId, stored)
  if (!record) return null
  const out: CloudflareCredentials = {}
  for (const key of ['api_token', 'api_key', 'password'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Merge a patch into the stored bundle and rewrite the file.
 *
 * An `undefined` field is "not mentioned"; an empty string is "clear this one". When the merge leaves
 * nothing behind the file is removed rather than written empty, so `has_credentials` stays a fact
 * rather than a guess.
 */
export async function writeAccountCredentials(
  env: Env,
  accountId: string,
  patch: CloudflareCredentials,
): Promise<boolean> {
  const current = (await readAccountCredentials(env, accountId)) ?? {}
  const next: Record<string, string> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === '') delete next[key]
    else next[key] = value
  }
  if (Object.keys(next).length === 0) {
    await deleteAccountCredentials(env, accountId)
    return false
  }
  const sealed = await encryptCloudflareAccountSecret(env, accountId, next)
  await bucket(env).put(accountCredentialKey(accountId), sealed, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  })
  return true
}

export async function deleteAccountCredentials(env: Env, accountId: string): Promise<void> {
  await bucket(env).delete(accountCredentialKey(accountId))
}
