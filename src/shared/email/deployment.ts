import { isValidEmailAddress } from './format'

export const EMAIL_DEPLOYMENT_DOMAINS_MAX = 10
export const EMAIL_RESEND_FROM_MAX_CHARS = 320
export const EMAIL_RESEND_KEY_MAX_CHARS = 4096

export type EmailSendingProvider = 'cloudflare' | 'resend'

export interface EmailDeploymentSettings {
  domains: string[]
  provider: EmailSendingProvider
  resendFrom: string
  hasResendKey: boolean
  resendKeyHint: string
  envDomains: string[]
  updatedAt: string | null
}

export interface EmailDeploymentPatch {
  domains?: string[]
  provider?: EmailSendingProvider
  resendFrom?: string
  resendApiKey?: string | null
}

export function normalizeDeploymentDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

export function normalizeDeploymentDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const domain = normalizeDeploymentDomain(entry)
    if (!domain || out.includes(domain)) continue
    out.push(domain)
  }
  return out.slice(0, EMAIL_DEPLOYMENT_DOMAINS_MAX)
}

export function isValidDeploymentDomain(value: string): boolean {
  const domain = normalizeDeploymentDomain(value)
  if (domain.length < 1 || domain.length > 253) return false
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
}

export function isValidResendFrom(value: string): boolean {
  const text = value.trim()
  if (!text || text.length > EMAIL_RESEND_FROM_MAX_CHARS) return false
  const match = /^(.*?)<([^<>]+)>$/.exec(text)
  const address = (match ? match[2]! : text).trim()
  return isValidEmailAddress(address)
}

export function isValidReplyTo(value: string): boolean {
  const text = value.trim()
  return text === '' || isValidEmailAddress(text)
}
