export const EMAIL_PATH = '/email'

export type EmailComposeMode = 'new' | 'reply' | 'reply-all' | 'forward'

export type EmailAddress =
  | { kind: 'home' }
  | { kind: 'contacts' }
  | { kind: 'settings'; accountId: string }
  | { kind: 'stats'; accountId: string }
  | { kind: 'rules'; accountId: string }
  | { kind: 'templates'; accountId: string }
  | { kind: 'search'; accountId: string; query: string; messageId: string | null; contactId?: string | null }
  | {
      kind: 'mailbox'
      accountId: string
      folderId: string
      messageId: string | null
      compose: EmailComposeMode | null
      draftId: string | null
    }

function composeMode(value: string | null): EmailComposeMode | null {
  return value === 'new' || value === 'reply' || value === 'reply-all' || value === 'forward' ? value : null
}

export function parseEmailAddress(pathname: string, search = ''): EmailAddress {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (trimmed === EMAIL_PATH) return { kind: 'home' }
  if (trimmed === `${EMAIL_PATH}/contacts`) return { kind: 'contacts' }
  const params = new URLSearchParams(search)
  const parts = trimmed.slice(EMAIL_PATH.length + 1).split('/').filter(Boolean)
  if (parts[0] !== 'accounts' || !parts[1]) return { kind: 'home' }
  const accountId = parts[1]
  if (parts[2] === 'settings') return { kind: 'settings', accountId }
  if (parts[2] === 'stats') return { kind: 'stats', accountId }
  if (parts[2] === 'rules') return { kind: 'rules', accountId }
  if (parts[2] === 'templates') return { kind: 'templates', accountId }
  if (parts[2] === 'search') {
    return {
      kind: 'search',
      accountId,
      query: params.get('q') ?? '',
      messageId: params.get('message'),
      contactId: params.get('contact'),
    }
  }
  if (parts[2] === 'folders' && parts[3]) {
    return {
      kind: 'mailbox',
      accountId,
      folderId: parts[3],
      messageId: params.get('message'),
      compose: composeMode(params.get('compose')),
      draftId: params.get('draft'),
    }
  }
  return {
    kind: 'mailbox',
    accountId,
    folderId: 'inbox',
    messageId: params.get('message'),
    compose: composeMode(params.get('compose')),
    draftId: params.get('draft'),
  }
}

export function isEmailPath(pathname: string): boolean {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return trimmed === EMAIL_PATH || trimmed.startsWith(`${EMAIL_PATH}/`)
}

export function emailAccountPath(accountId: string): string {
  return `${EMAIL_PATH}/accounts/${encodeURIComponent(accountId)}`
}

export function emailFolderPath(accountId: string, folderId: string): string {
  return `${EMAIL_PATH}/accounts/${encodeURIComponent(accountId)}/folders/${encodeURIComponent(folderId)}`
}

export function emailMessagePath(accountId: string, folderId: string, messageId: string): string {
  return `${emailFolderPath(accountId, folderId)}?message=${encodeURIComponent(messageId)}`
}

export function emailSearchPath(accountId: string, query: string): string {
  return `${EMAIL_PATH}/accounts/${encodeURIComponent(accountId)}/search?q=${encodeURIComponent(query)}`
}

export function emailSettingsPath(accountId: string): string {
  return `${EMAIL_PATH}/accounts/${encodeURIComponent(accountId)}/settings`
}

export function emailStatsPath(accountId: string): string {
  return `${EMAIL_PATH}/accounts/${encodeURIComponent(accountId)}/stats`
}

export function emailRulesPath(accountId: string): string {
  return `${EMAIL_PATH}/accounts/${encodeURIComponent(accountId)}/rules`
}

export function emailTemplatesPath(accountId: string): string {
  return `${EMAIL_PATH}/accounts/${encodeURIComponent(accountId)}/templates`
}

export function emailContactsPath(): string {
  return `${EMAIL_PATH}/contacts`
}
