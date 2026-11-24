import {
  EMAIL_ACCOUNT_SETTINGS_MAX_BYTES,
  EMAIL_SIGNATURE_NAME_MAX_CHARS,
  EMAIL_SIGNATURE_TEXT_MAX_CHARS,
  EMAIL_SIGNATURES_MAX,
  EMAIL_VACATION_BODY_MAX_CHARS,
  EMAIL_VACATION_SUBJECT_MAX_CHARS,
  normalizeEmailSignatures,
  normalizeEmailVacation,
  type EmailAccountSettings,
  type EmailSignature,
  type EmailSignatureSettings,
  type EmailVacationSettings,
} from '@shared/email/model'
import { isValidEmailAddress } from '@shared/email/format'
import { ApiError } from '../lib/errors'

const EMAIL_SIGNATURE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function signatureFrom(value: unknown): EmailSignature {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'email_settings_invalid', 'A signature is not valid')
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !EMAIL_SIGNATURE_ID_RE.test(raw.id)) {
    throw new ApiError(400, 'email_settings_invalid', 'A signature id is not valid')
  }
  if (typeof raw.name !== 'string') throw new ApiError(400, 'email_settings_invalid', 'A signature name is not valid')
  const name = raw.name.trim()
  if (!name || name.length > EMAIL_SIGNATURE_NAME_MAX_CHARS) {
    throw new ApiError(400, 'email_settings_invalid', 'A signature name is not valid')
  }
  if (typeof raw.text !== 'string' || raw.text.length > EMAIL_SIGNATURE_TEXT_MAX_CHARS) {
    throw new ApiError(400, 'email_settings_invalid', 'A signature text is not valid')
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new ApiError(400, 'email_settings_invalid', 'A signature enabled flag is not valid')
  }
  const enabled = raw.enabled === undefined ? true : raw.enabled
  return { id: raw.id, name, text: raw.text, enabled }
}

function vacationTimeFrom(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new ApiError(400, 'email_settings_invalid', 'The vacation window is not valid')
    }
    return Math.trunc(value)
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    const time = Date.parse(text)
    if (!Number.isFinite(time) || time < 0) {
      throw new ApiError(400, 'email_settings_invalid', 'The vacation window is not valid')
    }
    return time
  }
  throw new ApiError(400, 'email_settings_invalid', 'The vacation window is not valid')
}

function vacationFrom(value: unknown): EmailVacationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'email_settings_invalid', 'The vacation setting is not valid')
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.enabled !== 'boolean') {
    throw new ApiError(400, 'email_settings_invalid', 'The vacation setting is not valid')
  }
  if (raw.subject !== undefined && typeof raw.subject !== 'string') {
    throw new ApiError(400, 'email_settings_invalid', 'The vacation subject is not valid')
  }
  if (typeof raw.subject === 'string' && raw.subject.length > EMAIL_VACATION_SUBJECT_MAX_CHARS) {
    throw new ApiError(400, 'email_settings_invalid', 'The vacation subject is not valid')
  }
  if (raw.body !== undefined && typeof raw.body !== 'string') {
    throw new ApiError(400, 'email_settings_invalid', 'The vacation body is not valid')
  }
  if (typeof raw.body === 'string' && raw.body.length > EMAIL_VACATION_BODY_MAX_CHARS) {
    throw new ApiError(400, 'email_settings_invalid', 'The vacation body is not valid')
  }
  const start = vacationTimeFrom(raw.start)
  const end = vacationTimeFrom(raw.end)
  if (start !== null && end !== null && start > end) {
    throw new ApiError(400, 'email_settings_invalid', 'The vacation window is not valid')
  }
  return normalizeEmailVacation({
    vacation: {
      enabled: raw.enabled,
      start,
      end,
      subject: typeof raw.subject === 'string' ? raw.subject.trim() : '',
      body: typeof raw.body === 'string' ? raw.body : '',
    },
  })
}

export function settingsFrom(value: unknown): EmailAccountSettings {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'email_settings_invalid', 'The mailbox settings are not an object')
  }
  const raw = value as Record<string, unknown>
  const settings: EmailAccountSettings = {}
  let legacySignature: EmailSignatureSettings | undefined
  if (raw.signature !== undefined) {
    if (!raw.signature || typeof raw.signature !== 'object' || Array.isArray(raw.signature)) {
      throw new ApiError(400, 'email_settings_invalid', 'The signature is not valid')
    }
    const signature = raw.signature as Record<string, unknown>
    if (typeof signature.enabled !== 'boolean' || typeof signature.text !== 'string') {
      throw new ApiError(400, 'email_settings_invalid', 'The signature is not valid')
    }
    legacySignature = {
      enabled: signature.enabled,
      text: signature.text.slice(0, EMAIL_SIGNATURE_TEXT_MAX_CHARS),
    }
  }
  let signatures: EmailSignature[] | undefined
  if (raw.signatures !== undefined) {
    if (!Array.isArray(raw.signatures)) throw new ApiError(400, 'email_settings_invalid', 'The signatures are not valid')
    if (raw.signatures.length > EMAIL_SIGNATURES_MAX) throw new ApiError(400, 'email_settings_invalid', 'There are too many signatures')
    signatures = raw.signatures.map(signatureFrom)
    if (new Set(signatures.map((signature) => signature.id)).size !== signatures.length) {
      throw new ApiError(400, 'email_settings_invalid', 'The signature ids must be unique')
    }
  }
  if (raw.defaultSignatureId !== undefined && typeof raw.defaultSignatureId !== 'string') {
    throw new ApiError(400, 'email_settings_invalid', 'The default signature is not valid')
  }
  const defaultSignatureId = raw.defaultSignatureId as string | undefined
  if (signatures !== undefined) {
    if (defaultSignatureId !== undefined && !signatures.some((signature) => signature.id === defaultSignatureId)) {
      throw new ApiError(400, 'email_settings_invalid', 'The default signature does not exist')
    }
    const normalized = normalizeEmailSignatures({ signatures, defaultSignatureId })
    settings.signatures = normalized.signatures
    settings.defaultSignatureId = normalized.defaultId ?? ''
  } else {
    if (defaultSignatureId !== undefined) throw new ApiError(400, 'email_settings_invalid', 'The default signature does not exist')
    if (legacySignature) {
      const normalized = normalizeEmailSignatures({ signature: legacySignature })
      settings.signatures = normalized.signatures
      if (normalized.defaultId) settings.defaultSignatureId = normalized.defaultId
    }
  }
  if (raw.agentSystemPrompt !== undefined) {
    if (typeof raw.agentSystemPrompt !== 'string') throw new ApiError(400, 'email_settings_invalid', 'The agent prompt is not valid')
    const prompt = raw.agentSystemPrompt.trim()
    settings.agentSystemPrompt = prompt.slice(0, 8000)
  }
  if (raw.autoDraft !== undefined) {
    if (typeof raw.autoDraft !== 'boolean') throw new ApiError(400, 'email_settings_invalid', 'The auto-draft setting is not valid')
    settings.autoDraft = raw.autoDraft
  }
  if (raw.focusedInbox !== undefined) {
    if (typeof raw.focusedInbox !== 'boolean') throw new ApiError(400, 'email_settings_invalid', 'The focused inbox setting is not valid')
    settings.focusedInbox = raw.focusedInbox
  }
  if (raw.replyTo !== undefined) {
    if (typeof raw.replyTo !== 'string' || raw.replyTo.length > 320) {
      throw new ApiError(400, 'email_settings_invalid', 'The reply-to address is not valid')
    }
    const replyTo = raw.replyTo.trim()
    if (replyTo && !isValidEmailAddress(replyTo)) {
      throw new ApiError(400, 'email_settings_invalid', 'The reply-to address is not valid')
    }
    settings.replyTo = replyTo
  }
  if (raw.vacation !== undefined) {
    settings.vacation = vacationFrom(raw.vacation)
  }
  const encoded = JSON.stringify(settings)
  if (encoded.length > EMAIL_ACCOUNT_SETTINGS_MAX_BYTES) throw new ApiError(400, 'email_settings_invalid', 'The mailbox settings are too large')
  return settings
}
