import type { Env } from '../../env'
import {
  CryptoUnavailableError,
  decryptDatabaseSecret,
  encryptDatabaseSecret,
} from '../../lib/crypto'
import { ApiError } from '../../lib/errors'

export function assertCredentialVault(env: Env): void {
  if (!env.CREDENTIAL_VAULT) throw new CryptoUnavailableError()
}

export async function sealConnectionSecret(
  env: Env,
  connectionId: string,
  token: string,
): Promise<string> {
  assertCredentialVault(env)
  return await encryptDatabaseSecret(env, connectionId, token)
}

export async function openConnectionSecret(
  env: Env,
  connectionId: string,
  ciphertext: string,
): Promise<string> {
  if (!ciphertext) throw ApiError.badRequest('The database connection has no stored credential')
  assertCredentialVault(env)
  const token = await decryptDatabaseSecret(env, connectionId, ciphertext)
  if (!token) {
    throw new CryptoUnavailableError('The stored database credential could not be opened')
  }
  return token
}
