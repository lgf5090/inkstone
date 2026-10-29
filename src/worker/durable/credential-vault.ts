import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../lib/encoding'
import { evaluateInternalGuard } from '../lib/internal-auth'
import type { Env } from '../env'


const MASTER_KEY_NAME = 'backup-master-key-v1'
const MASTER_KEY_BYTES = 32
/**
 * The API Tester's state is one encrypted archive, so the vault accepts a larger request for that
 * scope alone. Every other scope still bounds its own fields to a few kilobytes below, and D1's row
 * limit is what keeps this number from growing further.
 */
const MAX_REQUEST_BYTES = 1_500_000
const MAX_CIPHERTEXT_LENGTH = 1_400_000
/**
 * `ai:` carries the chat assistant's provider key. The scope is the account id, so a ciphertext stored
 * for one reader cannot be replayed against another's derived key even by someone who can write rows.
 *
 * `mcp:` carries one server's outbound OAuth material, scoped to that server's id rather than the account
 * so a token minted for one third party cannot be read back out of another's row.
 *
 * `channel:` carries one notification channel's whole configuration, scoped to that channel's row id.
 *
 * `memo-webhook:` carries one memo webhook's signing secret, scoped to that webhook's row id.
 *
 * `youtube:` carries the instance's YouTube Data API key. The instance id is a fixed sentinel because one
 * deployment has exactly one key, and the worker secret is the fallback when no key is stored here.
 */
const CREDENTIAL_SCOPE_PATTERN = /^(?:backup|totp|ai|mcp|channel|memo-webhook|email|music|music-mount|cloudflare-account|database|github|apitester-history|apitester-ws|apitester|imgbed|youtube|nav):[0-9a-hjkmnp-tv-z]{26}$/
const CIPHERTEXT_PATTERN = /^v1\.([A-Za-z0-9_-]+)$/
const HKDF_SALT = utf8('inkstone.backup-credentials.v1')
const BACKUP_SECRET_FIELDS = new Set(['password', 'accessKeyId', 'secretAccessKey'])
const TOTP_SECRET_FIELDS = new Set(['secret'])
const AI_SECRET_FIELDS = new Set(['apiKey'])
const MCP_SECRET_FIELDS = new Set(['blob'])
const MEMO_WEBHOOK_SECRET_FIELDS = new Set(['secret'])
const EMAIL_SECRET_FIELDS = new Set(['secret'])
const MUSIC_SECRET_FIELDS = new Set(['cookie'])
const MUSIC_MOUNT_SECRET_FIELDS = new Set(['token'])
const CLOUDFLARE_ACCOUNT_SECRET_FIELDS = new Set(['api_token', 'api_key', 'password'])
const DATABASE_SECRET_FIELDS = new Set(['token'])
const GITHUB_SECRET_FIELDS = new Set(['token'])
const YOUTUBE_SECRET_FIELDS = new Set(['apiKey'])
const APITESTER_STATE_FIELDS = new Set(['blob'])
const APITESTER_HISTORY_FIELDS = new Set(['blob'])
const APITESTER_WS_FIELDS = new Set(['payload'])
const NAV_SECRET_FIELDS = new Set(['password'])
/**
 * A channel bundle is not a fixed key list: which fields exist is what the channel definition says, and
 * the nine of them share no vocabulary at all (`botToken`/`chatId`, `serverUrl`/`appToken`, `sendKey`…).
 * So the policy is structural — bounded field names, string or boolean values — rather than a whitelist
 * that would have to be edited in step with every channel form. The switch fields are booleans because
 * the settings screen reads them back as booleans; forcing them to `"true"` would make the form lie.
 */
const CHANNEL_FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/
const MAX_CHANNEL_FIELDS = 24
/**
 * How long one field of a record may be, by scope.
 *
 * A password, a TOTP secret and an API key are all short things, and the 4 kB bound is what stops a row
 * from being used to smuggle an archive into the vault. An OAuth token set is not: an access token, a
 * refresh token, a client secret and an in-flight verifier are each somebody else's opaque string, and the
 * large identity providers write JWTs of several kilobytes routinely. The bound stays per scope so the
 * extra room is exactly as wide as the one kind of credential that needs it.
 */
const MAX_FIELD_LENGTH: Record<string, number> = {
  mcp: 16 * 1024,
  music: 8 * 1024,
  'music-mount': 8 * 1024,
  apitester: 1_400_000,
  'apitester-history': 64_000,
  'apitester-ws': 16_000,
}
const DEFAULT_MAX_FIELD_LENGTH = 4096

type CredentialRecord = Record<string, string | boolean>

export class CredentialVault implements DurableObject {
  private masterKeyPromise: Promise<CryptoKey> | null = null

  constructor(private readonly state: DurableObjectState, private readonly env?: Env) {}

  async fetch(request: Request): Promise<Response> {
    const guard = evaluateInternalGuard(this.env, request)
    if (guard === 'denied') return jsonError(401, 'unauthorized')
    if (guard === 'misconfigured') return jsonError(500, 'server_misconfigured')
    if (request.method !== 'POST') return jsonError(404, 'not_found')

    const body = await readBody(request)
    if (!body) return jsonError(400, 'invalid_request')

    if (new URL(request.url).pathname === '/encrypt') {
      if (!isScope(body.scope) || !isCredentialRecord(body.scope, body.value)) {
        return jsonError(400, 'invalid_request')
      }
      const plaintext = utf8(JSON.stringify(body.value))
      if (plaintext.byteLength > MAX_REQUEST_BYTES) return jsonError(413, 'payload_too_large')
      const ciphertext = await this.encrypt(body.scope, plaintext)
      return Response.json({ ciphertext })
    }

    if (new URL(request.url).pathname === '/decrypt') {
      if (
        !isScope(body.scope) ||
        typeof body.ciphertext !== 'string' ||
        body.ciphertext.length > MAX_CIPHERTEXT_LENGTH
      ) {
        return jsonError(400, 'invalid_request')
      }
      const value = await this.decrypt(body.scope, body.ciphertext)
      return value ? Response.json({ value }) : jsonError(422, 'invalid_ciphertext')
    }

    return jsonError(404, 'not_found')
  }

  private async encrypt(scope: string, plaintext: Uint8Array): Promise<string> {
    const key = await this.targetKey(scope)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: associatedData(scope) as BufferSource,
      },
      key,
      plaintext as BufferSource,
    )
    const packed = new Uint8Array(iv.byteLength + encrypted.byteLength)
    packed.set(iv)
    packed.set(new Uint8Array(encrypted), iv.byteLength)
    return `v1.${toBase64Url(packed)}`
  }

  private async decrypt(scope: string, ciphertext: string): Promise<CredentialRecord | null> {
    const match = CIPHERTEXT_PATTERN.exec(ciphertext)
    if (!match) return null
    try {
      const packed = fromBase64Url(match[1]!)
      if (packed.byteLength <= 12) return null
      const key = await this.targetKey(scope)
      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: packed.subarray(0, 12) as BufferSource,
          additionalData: associatedData(scope) as BufferSource,
        },
        key,
        packed.subarray(12) as BufferSource,
      )
      const value: unknown = JSON.parse(fromUtf8(decrypted))
      return isCredentialRecord(scope, value) ? value : null
    } catch {
      return null
    }
  }

  private async targetKey(scope: string): Promise<CryptoKey> {
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: HKDF_SALT as BufferSource,
        info: utf8(scope) as BufferSource,
      },
      await this.masterKey(),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  private masterKey(): Promise<CryptoKey> {
    if (!this.masterKeyPromise) {
      this.masterKeyPromise = this.state.blockConcurrencyWhile(async () => {
        let encoded = await this.state.storage.get<string>(MASTER_KEY_NAME)
        if (encoded === undefined) {
          encoded = toBase64Url(crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES)))
          await this.state.storage.put(MASTER_KEY_NAME, encoded)
        }

        let raw: Uint8Array
        try {
          raw = fromBase64Url(encoded)
        } catch {
          throw new Error('credential_vault_master_key_corrupt')
        }
        if (raw.byteLength !== MASTER_KEY_BYTES) {
          throw new Error('credential_vault_master_key_corrupt')
        }
        return crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey'])
      })
    }
    return this.masterKeyPromise
  }
}

function associatedData(scope: string): Uint8Array {
  return utf8(`inkstone:credential-vault:v1:${scope}`)
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text()
    if (utf8(text).byteLength > MAX_REQUEST_BYTES) return null
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function isScope(value: unknown): value is string {
  return typeof value === 'string' && CREDENTIAL_SCOPE_PATTERN.test(value)
}

/**
 * The two request guards, exported for the test that builds a sample configuration out of every channel
 * definition and asks whether the vault would take it.
 *
 * They are not product API. The reason they are here is that the only other thing that could have caught
 * the mismatch — the channel routes' own tests — runs against a vault double that accepts anything, so a
 * policy the real vault rejects and the double swallows can only be proven against this file.
 */
export { isScope, isCredentialRecord }

function isCredentialRecord(scope: string, value: unknown): value is CredentialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  if (scope.startsWith('channel:') || scope.startsWith('imgbed:')) {
    const cap = DEFAULT_MAX_FIELD_LENGTH
    if (entries.length < 1 || entries.length > MAX_CHANNEL_FIELDS) return false
    return entries.every(([key, field]) => CHANNEL_FIELD_NAME.test(key) && (
      typeof field === 'boolean'
      || (typeof field === 'string' && field.length > 0 && field.length <= cap)
    ))
  }
  const allowed = scope.startsWith('totp:')
    ? TOTP_SECRET_FIELDS
    : scope.startsWith('ai:')
      ? AI_SECRET_FIELDS
      : scope.startsWith('mcp:')
        ? MCP_SECRET_FIELDS
        : scope.startsWith('memo-webhook:')
          ? MEMO_WEBHOOK_SECRET_FIELDS
          : scope.startsWith('email:')
            ? EMAIL_SECRET_FIELDS
            : scope.startsWith('music-mount:')
              ? MUSIC_MOUNT_SECRET_FIELDS
              : scope.startsWith('music:')
                ? MUSIC_SECRET_FIELDS
                : scope.startsWith('cloudflare-account:')
                  ? CLOUDFLARE_ACCOUNT_SECRET_FIELDS
                  : scope.startsWith('database:')
                    ? DATABASE_SECRET_FIELDS
                    : scope.startsWith('github:')
                      ? GITHUB_SECRET_FIELDS
                      : scope.startsWith('youtube:')
                      ? YOUTUBE_SECRET_FIELDS
                      : scope.startsWith('apitester-ws:')
                      ? APITESTER_WS_FIELDS
                      : scope.startsWith('apitester-history:')
                        ? APITESTER_HISTORY_FIELDS
                        : scope.startsWith('nav:')
                          ? NAV_SECRET_FIELDS
                        : scope.startsWith('apitester:')
                          ? APITESTER_STATE_FIELDS
                          : BACKUP_SECRET_FIELDS
  const cap = MAX_FIELD_LENGTH[scope.split(':')[0]!] ?? DEFAULT_MAX_FIELD_LENGTH
  if (entries.length < 1 || entries.length > allowed.size) return false
  return entries.every(
    ([key, field]) =>
      allowed.has(key) &&
      typeof field === 'string' &&
      field.length > 0 &&
      field.length <= cap,
  )
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status })
}
