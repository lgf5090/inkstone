import type { EmailTagInput, EmailTagPatch } from '@shared/email/model'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'
import { useEmailStore } from './store'

export function reportEmailFailure(error: unknown): void {
  useUi.getState().toast({ title: t('email.toast.failed'), description: emailErrorText(error), tone: 'danger' })
}

export function emailTagSearchQuery(name: string): string {
  return /\s/.test(name) ? `tag:"${name}"` : `tag:${name}`
}

export async function createEmailTag(accountId: string, input: EmailTagInput): Promise<void> {
  await api.email.createTag(accountId, input)
  await useEmailStore.getState().loadTags(accountId, { silent: true })
}

export async function updateEmailTag(accountId: string, tagId: string, patch: EmailTagPatch): Promise<void> {
  await api.email.updateTag(accountId, tagId, patch)
  await useEmailStore.getState().loadTags(accountId, { silent: true })
}

export async function deleteEmailTag(accountId: string, tagId: string): Promise<void> {
  await api.email.deleteTag(accountId, tagId)
  await useEmailStore.getState().loadTags(accountId, { silent: true })
}

export async function attachEmailTagToMessage(accountId: string, messageId: string, tagId: string): Promise<void> {
  await api.email.attachTag(accountId, messageId, { tagId })
  await useEmailStore.getState().loadTags(accountId, { silent: true })
  await useEmailStore.getState().refresh()
}
