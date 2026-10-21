/**
 * Email-to-task: the address half.
 *
 * A token is 40 characters drawn from the same 32-symbol alphabet the rest of the worker's
 * unguessable names use, so it is 200 bits of `crypto.getRandomValues` output and valid unquoted in
 * an email local part. The address is always `u+<token>@<MAIL_DOMAIN>`: the `u+` prefix is what lets
 * one mailbox's addresses be recognised without asking the database, and the token itself is the
 * whole authentication — there is no sender allowlist and no password beside it.
 *
 * `MAIL_DOMAIN` is a deployment variable rather than a constant because the domain belongs to the
 * deployment: a self-hosted instance routes its own mail. It must be a bare hostname; a value with a
 * scheme, a path or an `@` is treated as unset rather than pasted into an address, because an address
 * nobody can deliver to is worse than an honest 503.
 */
import type { Env } from '../env'

/** How many random characters an address token carries. 40 × 5 bits = 200 bits. */
export const MAIL_TOKEN_CHARS = 40

/** The 32-symbol alphabet, the same one `lib/id.ts` uses for ids and slugs. */
const MAIL_TOKEN_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/**
 * The token shape as a recipient spells it: exactly what `newMailToken` can produce.
 *
 * Reading the shape before the database means a mistyped or guessed recipient never causes a query,
 * and `i`, `l`, `o` and `u` cannot appear in a real token, so a scanner cannot even learn which
 * characters the alphabet uses from the timing of its guesses.
 */
export const MAIL_TOKEN_RE = /^[0-9a-hjkmnp-tv-z]{40}$/

/** One DNS label: letters, digits and inner hyphens, never a leading or trailing hyphen. */
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'

/** A bare hostname made of at least two labels; no scheme, port, path or trailing dot survives. */
const DOMAIN_RE = new RegExp(`^(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`)

/** A fresh address token. Uniform because 256 is a multiple of the 32-symbol alphabet. */
export function newMailToken(): string {
  const bytes = new Uint8Array(MAIL_TOKEN_CHARS)
  crypto.getRandomValues(bytes)
  let token = ''
  for (let index = 0; index < bytes.length; index++) token += MAIL_TOKEN_ALPHABET[bytes[index]! & 31]
  return token
}

/** The `MAIL_DOMAIN` a deployment configured, normalized, or null when it is missing or unusable. */
export function mailDomain(env: Env): string | null {
  const value = (env.MAIL_DOMAIN ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!value || value.length > 253 || !DOMAIN_RE.test(value)) return null
  return value
}

/** The address a token is delivered to. The domain is already normalized by `mailDomain`. */
export function mailAddress(domain: string, token: string): string {
  return `u+${token}@${domain}`
}
