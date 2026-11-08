import { createHash, createPublicKey } from 'node:crypto'
import type { Env } from '../../env'
import { decryptCerthubAccountKey, encryptCerthubAccountKey } from '../../lib/crypto'
import { ApiError } from '../../lib/errors'
import { newId } from '../../lib/id'
import type { CerthubCa, CerthubKeyAlgorithm } from '@shared/development/certhub/types'
import { directoryFor, eabFor } from './acme/directories'
import { buildAcmeClient, registerAccount, type AcmeBundle } from './acme/client'
import { findAccount, findAccountForCa, insertAccount, updateAccount, type AccountRow } from './store'
import { generateKey } from './crypto/keys'

const EAB_REQUIRED: ReadonlySet<CerthubCa> = new Set(['google-trust', 'zerossl', 'sslcom'])

export function keyFingerprint(privateKeyPem: string): string {
  const publicKey = createPublicKey(privateKeyPem)
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  return createHash('sha256').update(der).digest('hex')
}

export async function accountBundle(
  env: Env,
  account: AccountRow,
  keyAlgorithm: CerthubKeyAlgorithm,
): Promise<AcmeBundle> {
  const privateKey = await decryptCerthubAccountKey(env, account.id, account.key_ciphertext)
  if (!privateKey) throw new ApiError(503, 'vault_unavailable', 'The ACME account key could not be decrypted')
  return buildAcmeClient(env, account.ca, keyAlgorithm, privateKey, account.environment, account.account_url)
}

export async function ensureAccount(
  env: Env,
  db: D1Database,
  userId: string,
  ca: CerthubCa,
  environment: 'production' | 'staging',
  keyAlgorithm: CerthubKeyAlgorithm,
  contactEmail: string,
): Promise<{ account: AccountRow; bundle: AcmeBundle }> {
  if (EAB_REQUIRED.has(ca) && !eabFor(env, ca)) {
    throw new ApiError(503, 'config_unavailable', `The deployment is missing the ${ca} external account binding`)
  }
  const existing = await findAccountForCa(db, userId, ca, environment)
  if (existing) {
    const bundle = await accountBundle(env, existing, keyAlgorithm)
    if (!existing.account_url) {
      const accountUrl = await registerAccount(bundle, contactEmail)
      await updateAccount(db, userId, existing.id, { account_url: accountUrl, updated_at: Date.now(), last_used_at: Date.now() })
      existing.account_url = accountUrl
    }
    await updateAccount(db, userId, existing.id, { last_used_at: Date.now() })
    return { account: existing, bundle }
  }
  const privateKey = await generateKey('eccp256')
  const accountId = newId()
  const now = Date.now()
  const row: AccountRow = {
    user_id: userId,
    id: accountId,
    ca,
    environment,
    directory_url: directoryFor(ca, environment, keyAlgorithm, env.CERTHUB_ACME_DIRECTORY),
    account_url: '',
    key_ciphertext: await encryptCerthubAccountKey(env, accountId, privateKey),
    key_fingerprint: keyFingerprint(privateKey),
    contact_email: contactEmail,
    status: 'active',
    last_error_code: null,
    last_error_message: null,
    last_used_at: now,
    created_at: now,
    updated_at: now,
  }
  await insertAccount(db, row)
  const bundle = buildAcmeClient(env, ca, keyAlgorithm, privateKey, environment, '')
  try {
    const accountUrl = await registerAccount(bundle, contactEmail)
    await updateAccount(db, userId, accountId, { account_url: accountUrl, updated_at: Date.now() })
    row.account_url = accountUrl
    return { account: row, bundle }
  } catch (error) {
    await updateAccount(db, userId, accountId, {
      status: 'error',
      last_error_code: 'account_registration_failed',
      last_error_message: error instanceof Error ? error.message.slice(0, 160) : 'account registration failed',
      updated_at: Date.now(),
    })
    throw error
  }
}

export async function importAccountKey(
  env: Env,
  db: D1Database,
  userId: string,
  ca: CerthubCa,
  environment: 'production' | 'staging',
  keyAlgorithm: CerthubKeyAlgorithm,
  keyPem: string,
  contactEmail: string,
): Promise<AccountRow> {
  try {
    createPublicKey(keyPem)
  } catch {
    throw ApiError.badRequest('The private key is not a valid PEM key')
  }
  if (EAB_REQUIRED.has(ca) && !eabFor(env, ca)) {
    throw new ApiError(503, 'config_unavailable', `The deployment is missing the ${ca} external account binding`)
  }
  const accountId = newId()
  const now = Date.now()
  const row: AccountRow = {
    user_id: userId,
    id: accountId,
    ca,
    environment,
    directory_url: directoryFor(ca, environment, keyAlgorithm, env.CERTHUB_ACME_DIRECTORY),
    account_url: '',
    key_ciphertext: await encryptCerthubAccountKey(env, accountId, keyPem),
    key_fingerprint: keyFingerprint(keyPem),
    contact_email: contactEmail,
    status: 'active',
    last_error_code: null,
    last_error_message: null,
    last_used_at: now,
    created_at: now,
    updated_at: now,
  }
  await insertAccount(db, row)
  const bundle = buildAcmeClient(env, ca, keyAlgorithm, keyPem, environment, '')
  try {
    const accountUrl = await registerAccount(bundle, contactEmail)
    await updateAccount(db, userId, accountId, { account_url: accountUrl, updated_at: Date.now() })
    row.account_url = accountUrl
    return row
  } catch (error) {
    await updateAccount(db, userId, accountId, {
      status: 'error',
      last_error_code: 'account_registration_failed',
      last_error_message: error instanceof Error ? error.message.slice(0, 160) : 'account registration failed',
      updated_at: Date.now(),
    })
    throw error
  }
}

export async function rotateAccountKey(
  env: Env,
  db: D1Database,
  userId: string,
  accountId: string,
): Promise<AccountRow> {
  const account = await findAccount(db, userId, accountId)
  if (!account) throw ApiError.notFound('The ACME account was not found')
  const active = await db.prepare(`SELECT COUNT(*) AS c FROM development_certhub_orders
    WHERE user_id = ?1 AND account_id = ?2 AND status IN ('issued','expired')`)
    .bind(userId, accountId).first<{ c: number }>()
  if (Number(active?.c ?? 0) > 0) {
    throw new ApiError(409, 'conflict', 'Rotate the account only after its active certificates are revoked or expired')
  }
  const privateKey = await generateKey('eccp256')
  const bundle = buildAcmeClient(env, account.ca, 'eccp256', privateKey, account.environment, account.account_url)
  const accountUrl = await registerAccount(bundle, account.contact_email)
  const keyCiphertext = await encryptCerthubAccountKey(env, accountId, privateKey)
  const fingerprint = keyFingerprint(privateKey)
  await updateAccount(db, userId, accountId, {
    account_url: accountUrl,
    key_ciphertext: keyCiphertext,
    key_fingerprint: fingerprint,
    status: 'active',
    last_error_code: null,
    last_error_message: null,
    updated_at: Date.now(),
  })
  return { ...account, account_url: accountUrl, key_ciphertext: keyCiphertext, key_fingerprint: fingerprint }
}
