import { ApiError } from '../../lib/errors'

/**
 * Short-lived proof that the reader re-entered the master password.
 *
 * The token is bound to the user id and to the stored verifier: changing the master password
 * invalidates every token that was issued before it, and a session cookie alone cannot mint one.
 * Two minutes is long enough to finish the confirmation dialog and short enough that a token left in
 * a tab is useless by the time somebody finds it.
 */
export const CONFIRM_TOKEN_TTL_MS = 2 * 60 * 1000

const CONFIRM_SCOPE = 'password-dangerous'

interface ConfirmPayload {
  v: 1
  uid: string
  exp: number
  scope: typeof CONFIRM_SCOPE
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function hmacKey(masterHash: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`password-confirm:${masterHash}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function issueConfirmToken(
  masterHash: string,
  userId: string,
  now = Date.now(),
): Promise<string> {
  const payload: ConfirmPayload = { v: 1, uid: userId, exp: now + CONFIRM_TOKEN_TTL_MS, scope: CONFIRM_SCOPE }
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(masterHash), new TextEncoder().encode(encoded))
  return `${encoded}.${base64url(new Uint8Array(signature))}`
}

export function reauthRequired(): ApiError {
  return new ApiError(401, 'reauth_required', 'Enter the master password again to confirm this action')
}

export async function verifyConfirmToken(
  masterHash: string,
  userId: string,
  token: string | undefined,
  now = Date.now(),
): Promise<void> {
  if (!token) throw reauthRequired()
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) throw reauthRequired()

  let valid = false
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(masterHash),
      fromBase64url(signature),
      new TextEncoder().encode(encoded),
    )
  } catch {
    throw reauthRequired()
  }
  if (!valid) throw reauthRequired()

  let payload: ConfirmPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(encoded))) as ConfirmPayload
  } catch {
    throw reauthRequired()
  }
  if (
    payload.v !== 1 ||
    payload.scope !== CONFIRM_SCOPE ||
    payload.uid !== userId ||
    !Number.isFinite(payload.exp) ||
    payload.exp < now
  ) {
    throw reauthRequired()
  }
}
