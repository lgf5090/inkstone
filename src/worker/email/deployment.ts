import type { EmailDeploymentSettings, EmailSendingProvider } from '@shared/email/deployment'
import { normalizeDeploymentDomains } from '@shared/email/deployment'
import type { Env } from '../env'

const ROW_ID = 'deployment'

interface DeploymentRow {
  id: string
  domains: string
  provider: string
  resend_from: string
  resend_key_ciphertext: string
  resend_key_hint: string
  updated_at: number
}

export interface StoredEmailDeployment {
  domains: string[]
  provider: EmailSendingProvider
  resendFrom: string
  resendKeyCiphertext: string
  resendKeyHint: string
  updatedAt: number
}

function provider(value: string): EmailSendingProvider {
  return value === 'resend' ? 'resend' : 'cloudflare'
}

function storedDomains(raw: string): string[] {
  try {
    return normalizeDeploymentDomains(JSON.parse(raw) as unknown)
  } catch {
    return []
  }
}

export async function readEmailDeployment(db: D1Database): Promise<StoredEmailDeployment | null> {
  const row = await db.prepare(
    `SELECT id, domains, provider, resend_from, resend_key_ciphertext, resend_key_hint, updated_at
       FROM email_deployment_settings WHERE id = ?1`,
  ).bind(ROW_ID).first<DeploymentRow>()
  if (!row) return null
  return {
    domains: storedDomains(row.domains),
    provider: provider(row.provider),
    resendFrom: row.resend_from,
    resendKeyCiphertext: row.resend_key_ciphertext,
    resendKeyHint: row.resend_key_hint,
    updatedAt: row.updated_at,
  }
}

export function envEmailDomains(env: Env): string[] {
  const raw = (env.EMAIL_DOMAINS ?? env.MAIL_DOMAIN ?? '').trim()
  if (!raw) return []
  return [...new Set(raw.split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean))]
}

export async function effectiveEmailDomains(env: Env, db: D1Database): Promise<string[]> {
  const stored = await readEmailDeployment(db)
  return [...new Set([...envEmailDomains(env), ...(stored?.domains ?? [])])]
}

export async function publicEmailDeployment(env: Env, db: D1Database): Promise<EmailDeploymentSettings> {
  const stored = await readEmailDeployment(db)
  return {
    domains: stored?.domains ?? [],
    provider: stored?.provider ?? 'cloudflare',
    resendFrom: stored?.resendFrom ?? '',
    hasResendKey: Boolean(stored?.resendKeyCiphertext),
    resendKeyHint: stored?.resendKeyHint ?? '',
    envDomains: envEmailDomains(env),
    cloudflareSending: Boolean(env.EMAIL),
    attachmentsAvailable: Boolean(env.FILES) && Boolean(env.EMAIL_MAILBOX),
    updatedAt: stored ? new Date(stored.updatedAt).toISOString() : null,
  }
}

export async function writeEmailDeployment(
  db: D1Database,
  patch: {
    domains: string[]
    provider: EmailSendingProvider
    resendFrom: string
    resendKeyCiphertext?: string
    resendKeyHint?: string
  },
): Promise<void> {
  const existing = await readEmailDeployment(db)
  const ciphertext = patch.resendKeyCiphertext !== undefined
    ? patch.resendKeyCiphertext
    : existing?.resendKeyCiphertext ?? ''
  const hint = patch.resendKeyHint !== undefined
    ? patch.resendKeyHint
    : existing?.resendKeyHint ?? ''
  await db.prepare(
    `INSERT INTO email_deployment_settings (id, domains, provider, resend_from, resend_key_ciphertext, resend_key_hint, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET
       domains = excluded.domains,
       provider = excluded.provider,
       resend_from = excluded.resend_from,
       resend_key_ciphertext = excluded.resend_key_ciphertext,
       resend_key_hint = excluded.resend_key_hint,
       updated_at = excluded.updated_at`,
  ).bind(
    ROW_ID,
    JSON.stringify(patch.domains),
    patch.provider,
    patch.resendFrom,
    ciphertext,
    hint,
    Date.now(),
  ).run()
}
