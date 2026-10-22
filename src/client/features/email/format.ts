import { createElement, type ReactNode } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import { emailSnippet } from '@shared/email/format'
import {
  isEmailSystemFolder,
  type EmailFolder,
  type EmailMessage,
  type EmailSummary,
  type EmailSystemFolder,
} from '@shared/email/model'
import { parseEmailSearchQuery } from '@shared/email/search'
import { localeTag, t } from '../../lib/i18n'
import { isSameDay } from '../../lib/time'

export const SYSTEM_FOLDER_LABEL_KEYS: Record<EmailSystemFolder, MessageKey> = {
  inbox: 'email.folder.inbox',
  sent: 'email.folder.sent',
  draft: 'email.folder.draft',
  archive: 'email.folder.archive',
  trash: 'email.folder.trash',
  spam: 'email.folder.spam',
}

const LIST_EMPTY_KEYS: Record<EmailSystemFolder, MessageKey> = {
  inbox: 'email.list.empty.inbox',
  sent: 'email.list.empty.sent',
  draft: 'email.list.empty.draft',
  archive: 'email.list.empty.archive',
  trash: 'email.list.empty.trash',
  spam: 'email.list.empty.spam',
}

export function folderLabel(folderId: string | null, folders: readonly EmailFolder[]): string {
  if (!folderId) return t('email.folder.custom')
  if (isEmailSystemFolder(folderId)) return t(SYSTEM_FOLDER_LABEL_KEYS[folderId])
  const match = folders.find((folder) => folder.id === folderId)
  return match?.name ?? t('email.folder.custom')
}

export function listEmptyText(folderId: string, searching: boolean): string {
  if (searching) return t('email.list.empty.search')
  if (isEmailSystemFolder(folderId)) return t(LIST_EMPTY_KEYS[folderId])
  return t('email.list.empty.custom')
}

export function messageDateLabel(value: string, now = Date.now()): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date(now)
  if (isSameDay(date, today)) {
    return new Intl.DateTimeFormat(localeTag(), { hour: '2-digit', minute: '2-digit' }).format(date)
  }
  if (date.getFullYear() === today.getFullYear()) {
    return new Intl.DateTimeFormat(localeTag(), { month: 'short', day: 'numeric' }).format(date)
  }
  return new Intl.DateTimeFormat(localeTag(), { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

export function messageFullDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function senderLabel(value: string | null | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return t('email.list.unknown_sender')
  const angle = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(raw)
  if (angle) return angle[1]?.trim() || angle[2]!.trim()
  return raw
}

export function messageSnippet(summary: Pick<EmailSummary, 'snippet'>): string {
  return emailSnippet(summary.snippet, 100)
}

export function messageSubject(message: Pick<EmailSummary, 'subject'>): string {
  const subject = message.subject.trim()
  return subject || t('email.list.no_subject')
}

export function messageRecipients(message: Pick<EmailMessage, 'recipient' | 'cc' | 'bcc'>): string[] {
  return [message.recipient, message.cc, message.bcc]
    .filter((value): value is string => Boolean(value && value.trim()))
}

export function highlightNodes(text: string, query: string | null | undefined): ReactNode {
  if (!query) return text
  const terms = parseEmailSearchQuery(query).query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
  if (terms.length === 0) return text
  const unique = [...new Set(terms)].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(${unique.map(escapeRegExp).join('|')})`, 'gi')
  const parts = text.split(pattern)
  if (parts.length === 1) return text
  const lowered = new Set(unique.map((term) => term.toLowerCase()))
  return parts.map((part, index) => lowered.has(part.toLowerCase())
    ? createElement('mark', {
        key: index,
        className: 'rounded-[var(--r-xs)] bg-[var(--accent-soft)] px-0.5 text-[var(--accent-on-soft)]',
      }, part)
    : part)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
