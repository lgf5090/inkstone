import type { EmailErrorCode } from '@shared/email/model'
import type { MessageKey } from '@shared/locales/en-US'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'

const EMAIL_ERROR_KEYS: Record<EmailErrorCode, MessageKey> = {
  email_account_not_found: 'email.errors.account_not_found',
  email_account_exists: 'email.errors.account_exists',
  email_address_invalid: 'email.errors.address_invalid',
  email_address_reserved: 'email.errors.address_reserved',
  email_domain_not_allowed: 'email.errors.domain_not_allowed',
  email_forbidden: 'email.errors.forbidden',
  email_mailbox_unavailable: 'email.errors.mailbox_unavailable',
  email_folder_not_found: 'email.errors.folder_not_found',
  email_folder_exists: 'email.errors.folder_exists',
  email_folder_reserved: 'email.errors.folder_reserved',
  email_folder_not_deletable: 'email.errors.folder_not_deletable',
  email_message_not_found: 'email.errors.message_not_found',
  email_attachment_not_found: 'email.errors.attachment_not_found',
  email_attachment_locked: 'email.errors.attachment_locked',
  email_attachment_too_large: 'email.errors.attachment_too_large',
  email_settings_invalid: 'email.errors.settings_invalid',
  email_draft_invalid: 'email.errors.draft_invalid',
  email_send_unavailable: 'email.errors.send_unavailable',
  email_send_failed: 'email.errors.send_failed',
  email_rate_limited: 'email.errors.rate_limited',
  email_quota_exceeded: 'email.errors.quota_exceeded',
  email_not_in_trash: 'email.errors.not_in_trash',
  email_not_retryable: 'email.errors.not_retryable',
  email_auto_draft_unavailable: 'email.errors.auto_draft_unavailable',
  email_export_too_large: 'email.errors.export_too_large',
  email_backup_no_target: 'email.errors.backup_no_target',
}

export function emailErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const key = EMAIL_ERROR_KEYS[error.code as EmailErrorCode]
    if (key) return t(key)
    return error.message || t('email.errors.unknown')
  }
  if (error instanceof Error && error.message) return error.message
  return t('email.errors.unknown')
}
