import { MEMO_PAT_BYTES } from '@shared/memos/constants'
import { sha256Hex, timingSafeEqual, toBase64Url } from '../lib/encoding'

const SHARE_TOKEN_BYTES = 32
const TOKEN_PREFIX_LENGTH = 16

export function createOpaqueToken(prefix: string, bytes = MEMO_PAT_BYTES): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes))
  return `${prefix}${toBase64Url(random)}`
}

export function hashOpaqueToken(token: string): Promise<string> {
  return sha256Hex(token)
}

export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LENGTH)
}

export async function createShareToken(): Promise<{ token: string; hash: string }> {
  const token = createOpaqueToken('', SHARE_TOKEN_BYTES)
  return { token, hash: await hashOpaqueToken(token) }
}

export const constantTimeEqual = timingSafeEqual
