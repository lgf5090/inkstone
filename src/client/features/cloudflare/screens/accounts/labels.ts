/**
 * The words the account table and its dialogs put around the values they receive.
 *
 * The feature names and the auth kinds are closed sets, so their catalogue keys live in one map
 * instead of a switch in every component. The result statuses are the one vocabulary the accounts
 * fragment does not carry; they reuse the notebook's generic run outcomes.
 */
import {
  CLOUDFLARE_DEFAULT_FEATURES,
  CLOUDFLARE_FEATURES,
  type CloudflareAuthType,
  type CloudflareFeature,
} from '@shared/cloudflare/model'
import { t } from '../../../../lib/i18n'
import { cfT, type CloudflareMessageKey } from '../../i18n'
import type { BatchStatus } from '../../api/accounts'

const FEATURE_LABEL_KEYS: Record<CloudflareFeature, CloudflareMessageKey> = {
  ai: 'cloudflare.accounts.workers_ai',
  workers: 'cloudflare.accounts.workers_pages',
  browser_render: 'cloudflare.accounts.browser_render',
  dns: 'cloudflare.accounts.dns_management',
  storage: 'cloudflare.accounts.storage_management',
}

export function featureLabel(feature: CloudflareFeature): string {
  return cfT(FEATURE_LABEL_KEYS[feature])
}

/** The features a row has switched on, in the module's canonical order. */
export function enabledFeatures(raw: string): CloudflareFeature[] {
  const list = (raw.trim() || CLOUDFLARE_DEFAULT_FEATURES).split(',').map((part) => part.trim())
  return CLOUDFLARE_FEATURES.filter((feature) => list.includes(feature))
}

export function authTypeLabel(type: CloudflareAuthType, short = false): string {
  if (short) return cfT(type === 'token' ? 'cloudflare.accounts.table.token' : 'cloudflare.accounts.table.key')
  return cfT(type === 'token' ? 'cloudflare.accounts.auth_type_token' : 'cloudflare.accounts.auth_type_key')
}

export function resultStatusLabel(status: BatchStatus): string {
  if (status === 'success') return t('assistant.automations.run_success')
  if (status === 'skipped') return t('assistant.automations.run_skipped')
  return t('assistant.automations.run_error')
}

export function resultStatusTone(status: BatchStatus): 'success' | 'warning' | 'danger' {
  if (status === 'success') return 'success'
  if (status === 'skipped') return 'warning'
  return 'danger'
}
