import type { ImgbedFile } from '@shared/imgbed/model'
import type { ImgbedSecuritySettings } from '@shared/imgbed/settings'

export type ImgbedDeniedReason = 'blocked' | 'whitelist' | 'domain'

export interface FileAccessInput {
  file: Pick<ImgbedFile, 'listType' | 'label'>
  access: ImgbedSecuritySettings['access']
  referer: string | null
  requestHost: string
  admin: boolean
}

export function domainAllowed(referer: string | null, requestHost: string, allowedDomains: string): boolean {
  const configured = String(allowedDomains ?? '').split(',').map((domain) => domain.trim()).filter(Boolean)
  if (!configured.length) return true
  if (!referer) return true
  let host: string
  try { host = new URL(referer).hostname.toLowerCase() } catch { return false }
  configured.push(requestHost)
  return configured.some((domain) => {
    const escaped = domain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|\\.)${escaped}$`).test(host)
  })
}

export function fileAccessDecision(input: FileAccessInput): { allowed: boolean; reason?: ImgbedDeniedReason } {
  if (input.admin) return { allowed: true }
  if (!domainAllowed(input.referer, input.requestHost, input.access.allowedDomains)) {
    return { allowed: false, reason: 'domain' }
  }
  if (input.file.listType === 'White') return { allowed: true }
  if (input.file.listType === 'Block') return { allowed: false, reason: 'blocked' }
  if (input.file.label === 'adult') return { allowed: false, reason: 'blocked' }
  if (input.access.whiteListMode) return { allowed: false, reason: 'whitelist' }
  return { allowed: true }
}

export function publicDirectoryAllowed(dir: string, allowed: string): boolean {
  const entries = String(allowed ?? '').split(',').map((entry) => entry.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean)
  if (!entries.length || entries.includes('*')) return true
  const normalized = String(dir ?? '').replace(/^\/+|\/+$/g, '')
  return entries.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`))
}
