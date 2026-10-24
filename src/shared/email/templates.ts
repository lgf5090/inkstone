export const EMAIL_TEMPLATE_MAX = 100
export const EMAIL_TEMPLATE_NAME_MAX_CHARS = 80
export const EMAIL_TEMPLATE_SUBJECT_MAX_CHARS = 200
export const EMAIL_TEMPLATE_BODY_MAX_CHARS = 20_000

export interface EmailTemplate {
  id: string
  name: string
  subject: string
  body: string
  createdAt: string
  updatedAt: string
}

export interface EmailTemplateInput {
  name: string
  subject: string
  body: string
}

export interface EmailTemplatePatch {
  name?: string
  subject?: string
  body?: string
}

function readName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name.length > EMAIL_TEMPLATE_NAME_MAX_CHARS) return null
  return name
}

function readSubject(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const subject = value.trim()
  return subject.length > EMAIL_TEMPLATE_SUBJECT_MAX_CHARS ? null : subject
}

function readBody(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.length > EMAIL_TEMPLATE_BODY_MAX_CHARS ? null : value
}

export function parseEmailTemplateInput(value: unknown): EmailTemplateInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = readName(raw.name)
  if (!name) return null
  const subject = raw.subject === undefined ? '' : readSubject(raw.subject)
  const body = raw.body === undefined ? '' : readBody(raw.body)
  if (subject === null || body === null) return null
  return { name, subject, body }
}

export function parseEmailTemplatePatch(value: unknown): EmailTemplatePatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const patch: EmailTemplatePatch = {}
  if (raw.name !== undefined) {
    const name = readName(raw.name)
    if (!name) return null
    patch.name = name
  }
  if (raw.subject !== undefined) {
    const subject = readSubject(raw.subject)
    if (subject === null) return null
    patch.subject = subject
  }
  if (raw.body !== undefined) {
    const body = readBody(raw.body)
    if (body === null) return null
    patch.body = body
  }
  return Object.keys(patch).length > 0 ? patch : null
}
