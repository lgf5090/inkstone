export const CERTHUB_CAS = ['lets-encrypt', 'google-trust', 'zerossl', 'sslcom', 'buypass'] as const
export type CerthubCa = (typeof CERTHUB_CAS)[number]

export const CERTHUB_KEY_ALGORITHMS = ['rsa2048', 'eccp256', 'eccp384'] as const
export type CerthubKeyAlgorithm = (typeof CERTHUB_KEY_ALGORITHMS)[number]

export const CERTHUB_CHALLENGE_MODES = ['dns-01', 'http-01'] as const
export type CerthubChallengeMode = (typeof CERTHUB_CHALLENGE_MODES)[number]

export const CERTHUB_ORDER_STATUSES = [
  'queued',
  'creating_order',
  'awaiting_dns',
  'awaiting_http',
  'validating',
  'ready',
  'finalizing',
  'issued',
  'failed',
  'revoked',
  'expired',
  'canceled',
  'deleting',
] as const
export type CerthubOrderStatus = (typeof CERTHUB_ORDER_STATUSES)[number]

export const CERTHUB_DOMAIN_STATUSES = ['pending', 'prepared', 'validating', 'valid', 'invalid', 'expired'] as const
export type CerthubDomainStatus = (typeof CERTHUB_DOMAIN_STATUSES)[number]

export const CERTHUB_ACTIONS = [
  'advance',
  'verify',
  'verify_domain',
  'regenerate',
  'renew',
  'revoke',
  'purge_key',
  'cancel',
  'delete',
] as const
export type CerthubAction = (typeof CERTHUB_ACTIONS)[number]

export const CERTHUB_TOKEN_SCOPES = ['read', 'issue', 'revoke', 'read-key'] as const
export type CerthubTokenScope = (typeof CERTHUB_TOKEN_SCOPES)[number]

export type CerthubActor = 'user' | 'api' | 'system' | 'owner'
export type CerthubEventLevel = 'info' | 'warn' | 'error'
export type CerthubDnsProviderKind = 'cloudflare' | 'dcv-delegate'

export interface CerthubSubject {
  country?: string
  state?: string
  locality?: string
  organization?: string
  organizationUnit?: string
}

export interface CerthubDomainInput {
  name: string
  wildcard?: boolean
  primary?: boolean
  challengeMode?: CerthubChallengeMode
  dnsProviderId?: string
}

export interface CerthubDomainView {
  id: string
  name: string
  fqdn: string
  wildcard: boolean
  primary: boolean
  challengeMode: CerthubChallengeMode
  status: CerthubDomainStatus
  recordName: string
  recordType: 'TXT' | 'CNAME' | 'HTTP'
  recordValue: string
  dnsProviderId: string
  validatedAt: number | null
  errorCode: string | null
  errorMessage: string | null
}

export interface CerthubOrderView {
  id: string
  status: CerthubOrderStatus
  ca: CerthubCa
  environment: 'production' | 'staging'
  keyAlgorithm: CerthubKeyAlgorithm
  autoRenew: boolean
  subject: CerthubSubject
  primaryDomain: string
  domains: CerthubDomainView[]
  createdAt: number
  updatedAt: number
  issuedAt: number | null
  certNotBefore: number | null
  certNotAfter: number | null
  renewAt: number | null
  revokedAt: number | null
  revokeReason: number | null
  failureCode: string | null
  failureMessage: string | null
  hasCertificate: boolean
  hasPrivateKey: boolean
  keyFingerprint: string
  serialNumber: string
  issuer: string
  daysLeft: number | null
}

export interface CerthubOrderSummary {
  id: string
  status: CerthubOrderStatus
  ca: CerthubCa
  keyAlgorithm: CerthubKeyAlgorithm
  autoRenew: boolean
  primaryDomain: string
  domainCount: number
  createdAt: number
  updatedAt: number
  certNotAfter: number | null
  renewAt: number | null
  failureCode: string | null
  hasCertificate: boolean
  hasPrivateKey: boolean
  daysLeft: number | null
}

export interface CerthubEventView {
  id: string
  orderId: string
  domainId: string
  actor: CerthubActor
  kind: string
  level: CerthubEventLevel
  messageCode: string
  detail: Record<string, unknown>
  createdAt: number
}

export interface CerthubAccountView {
  id: string
  ca: CerthubCa
  environment: 'production' | 'staging'
  directoryUrl: string
  accountUrl: string
  keyFingerprint: string
  status: 'active' | 'deactivated' | 'error'
  lastErrorCode: string | null
  lastErrorCodeMessage?: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export interface CerthubDnsProviderView {
  id: string
  kind: CerthubDnsProviderKind
  label: string
  zoneId: string
  zoneName: string
  accountEmail: string
  configured: boolean
  status: 'active' | 'error' | 'disabled'
  lastCheckedAt: number | null
  lastErrorCode: string | null
  createdAt: number
  updatedAt: number
}

export interface CerthubSettingsView {
  defaultCa: CerthubCa
  defaultKeyAlgorithm: CerthubKeyAlgorithm
  defaultChallengeMode: CerthubChallengeMode
  defaultAutoRenew: boolean
  renewDaysBefore: number
  notifyOnIssued: boolean
  notifyOnFailed: boolean
  notifyOnExpiring: boolean
  notifyOnExpired: boolean
  maxActiveCerts: number
  requireReauthForKeys: boolean
}

export interface CerthubTokenView {
  id: string
  name: string
  prefix: string
  scopes: CerthubTokenScope[]
  expiresAt: number | null
  lastUsedAt: number | null
  revokedAt: number | null
  createdAt: number
}

export interface CerthubQuotaView {
  maxActiveCerts: number
  activeCerts: number
  pendingOrders: number
  dailyUsed: number
  dailyLimit: number
  monthlyUsed: number
  monthlyLimit: number
}

export interface CerthubOverview {
  counts: Record<CerthubOrderStatus | 'expiringSoon', number>
  recentOrders: CerthubOrderSummary[]
  recentEvents: CerthubEventView[]
  quota: CerthubQuotaView
}

export interface CerthubConfigView {
  enabledCas: CerthubCa[]
  maxOrdersPerDay: number
  maxOrdersPerMonth: number
  maxPendingOrders: number
  maxActiveCertsDefault: number
  maxDomainsPerOrder: number
  acmeTimeoutMs: number
  jobBatchSize: number
}

export interface CerthubApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export interface CerthubListResponse<T> {
  ok: true
  data: {
    items: T[]
    nextCursor: string | null
  }
}

export interface CerthubItemResponse<T> {
  ok: true
  data: T
}

export interface CerthubCreateOrderResponse {
  ok: true
  data: {
    order: CerthubOrderView
    jobId: string
    reused: boolean
  }
}
