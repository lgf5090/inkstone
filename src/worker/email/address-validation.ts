import { isValidEmailAddress } from '@shared/email/format'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'

const LOCAL_PART_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/i

export function configuredAddresses(env: Pick<Env, 'EMAIL_ADDRESSES'>): string[] {
  return (env.EMAIL_ADDRESSES ?? '')
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)
}

function validateLocalPart(localPart: string): string {
  const value = localPart.trim().toLowerCase()
  if (!value || !LOCAL_PART_RE.test(value) || value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    throw new ApiError(400, 'email_address_invalid', 'The mailbox local part is not valid')
  }
  if (value.startsWith('u+')) throw new ApiError(400, 'email_address_reserved', 'The u+ prefix is reserved')
  return value
}

export function buildAddress(
  localPart: string,
  domain: string,
  allowed: readonly string[],
  env: Pick<Env, 'EMAIL_ADDRESSES'>,
): string {
  const wantedDomain = domain.trim().toLowerCase().replace(/\.$/, '')
  if (!wantedDomain || !allowed.includes(wantedDomain)) {
    throw new ApiError(400, 'email_domain_not_allowed', 'The mailbox domain is not configured')
  }
  const address = `${validateLocalPart(localPart)}@${wantedDomain}`
  const allowlist = configuredAddresses(env)
  if (allowlist.length && !allowlist.includes(address)) {
    throw new ApiError(403, 'email_forbidden', 'This address is not in EMAIL_ADDRESSES')
  }
  if (!isValidEmailAddress(address)) throw new ApiError(400, 'email_address_invalid', 'The mailbox address is not valid')
  return address
}

export function validateMailboxAddress(
  value: string,
  allowed: readonly string[],
  env: Pick<Env, 'EMAIL_ADDRESSES'>,
): string {
  const parts = value.trim().split('@')
  if (parts.length !== 2) throw new ApiError(400, 'email_address_invalid', 'The mailbox address is not valid')
  return buildAddress(parts[0]!, parts[1]!, allowed, env)
}
