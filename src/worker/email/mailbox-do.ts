import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { applyMailboxMigrations, type SqlExec } from './mailbox-schema'
import {
  MailboxStore,
  type EmailData,
  type EmailRestoreData,
  type FolderPatch,
  type FolderRestoreData,
  type InboundRuleInput,
  type InboundRulePlan,
  type ListOptions,
  type SearchOptions,
  type TagPatch,
} from './mailbox-store'
import type { EmailBatchAction } from '@shared/email/model'
import type { EmailSavedSearchInput, EmailSavedSearchPatch } from '@shared/email/searches'
import type { EmailFilterInput, EmailFilterPatch } from '@shared/email/rules'
import type { EmailTemplateInput, EmailTemplatePatch } from '@shared/email/templates'

export class EmailMailbox extends DurableObject<Env> {
  private readonly store: MailboxStore

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    const sql = state.storage.sql as unknown as SqlExec
    applyMailboxMigrations(sql, state.storage)
    this.store = new MailboxStore(sql, state.storage)
  }

  getFolders() { return this.store.getFolders() }
  createFolder(name: string, parentId: string | null = null, color: string | null = null) {
    return this.store.createFolder(name, parentId, color)
  }
  updateFolder(id: string, patch: FolderPatch) { return this.store.updateFolder(id, patch) }
  deleteFolder(id: string, deleteEmails = false) { return this.store.deleteFolder(id, deleteEmails) }
  listTags() { return this.store.listTags() }
  getTag(id: string) { return this.store.getTag(id) }
  findTagByPath(name: string) { return this.store.findTagByPath(name) }
  createTag(name: string, color: string | null = null) { return this.store.createTag(name, color) }
  updateTag(id: string, patch: TagPatch) { return this.store.updateTag(id, patch) }
  deleteTag(id: string) { return this.store.deleteTag(id) }
  attachTag(messageId: string, tagId: string) { return this.store.attachTag(messageId, tagId) }
  detachTag(messageId: string, tagId: string) { return this.store.detachTag(messageId, tagId) }
  attachTagPaths(messageId: string, paths: readonly string[]) { return this.store.attachTagPaths(messageId, paths) }
  listFilters() { return this.store.listFilters() }
  getFilter(id: string) { return this.store.getFilter(id) }
  createFilter(input: EmailFilterInput) { return this.store.createFilter(input) }
  updateFilter(id: string, patch: EmailFilterPatch) { return this.store.updateFilter(id, patch) }
  deleteFilter(id: string) { return this.store.deleteFilter(id) }
  listTemplates() { return this.store.listTemplates() }
  countTemplates() { return this.store.countTemplates() }
  getTemplate(id: string) { return this.store.getTemplate(id) }
  createTemplate(input: EmailTemplateInput) { return this.store.createTemplate(input) }
  updateTemplate(id: string, patch: EmailTemplatePatch) { return this.store.updateTemplate(id, patch) }
  deleteTemplate(id: string) { return this.store.deleteTemplate(id) }
  listSavedSearches() { return this.store.listSavedSearches() }
  countSavedSearches() { return this.store.countSavedSearches() }
  getSavedSearch(id: string) { return this.store.getSavedSearch(id) }
  createSavedSearch(input: EmailSavedSearchInput) { return this.store.createSavedSearch(input) }
  updateSavedSearch(id: string, patch: EmailSavedSearchPatch) { return this.store.updateSavedSearch(id, patch) }
  deleteSavedSearch(id: string) { return this.store.deleteSavedSearch(id) }
  listBlockedSenders() { return this.store.listBlockedSenders() }
  getBlockedSender(address: string) { return this.store.getBlockedSender(address) }
  addBlockedSender(address: string) { return this.store.addBlockedSender(address) }
  removeBlockedSender(address: string) { return this.store.removeBlockedSender(address) }
  isBlockedSender(address: string) { return this.store.isBlockedSender(address) }
  evaluateInboundRules(input: InboundRuleInput): InboundRulePlan { return this.store.evaluateInboundRules(input) }
  mailboxStats(now?: number) { return this.store.mailboxStats(now) }
  listAllEmails() { return this.store.listAllEmails() }
  importFolder(folder: FolderRestoreData) { return this.store.importFolder(folder) }
  importEmail(email: EmailRestoreData) { return this.store.importEmail(email) }
  getEmails(options: ListOptions = {}) { return this.store.getEmails(options) }
  countEmails(options: ListOptions = {}) { return this.store.countEmails(options) }
  getThreadedEmails(options: ListOptions = {}) { return this.store.getThreadedEmails(options) }
  countThreadedEmails(folder: string) { return this.store.countThreadedEmails(folder) }
  getEmail(id: string) { return this.store.getEmail(id) }
  getThreadEmails(threadId: string) { return this.store.getThreadEmails(threadId) }
  hasThread(threadId: string) { return this.store.hasThread(threadId) }
  hasSenderHistory(address: string) { return this.store.hasSenderHistory(address) }
  updateEmail(id: string, patch: { read?: boolean; starred?: boolean; important?: boolean; muted?: boolean }) {
    return this.store.updateEmail(id, patch)
  }
  muteThread(threadId: string, muted: boolean) { return this.store.muteThread(threadId, muted) }
  setFollowUp(id: string, at: number | null) { return this.store.setFollowUp(id, at) }
  wakeFollowUps(now?: number, limit?: number) { return this.store.wakeFollowUps(now, limit) }
  snoozeEmail(id: string, until: number) { return this.store.snoozeEmail(id, until) }
  wakeSnoozed(now?: number, limit?: number) { return this.store.wakeSnoozed(now, limit) }
  markThreadRead(threadId: string) { return this.store.markThreadRead(threadId) }
  trashEmail(id: string) { return this.store.trashEmail(id) }
  restoreEmail(id: string) { return this.store.restoreEmail(id) }
  listTrash(options: { page?: number; limit?: number } = {}) { return this.store.listTrash(options) }
  countTrash() { return this.store.countTrash() }
  emptyTrash() { return this.store.emptyTrash() }
  purgeExpiredTrash(cutoff: number) { return this.store.purgeExpiredTrash(cutoff) }
  deleteEmail(id: string) { return this.store.deleteEmail(id) }
  moveEmail(id: string, folderId: string) { return this.store.moveEmail(id, folderId) }
  batchUpdate(ids: string[], action: EmailBatchAction, folderId?: string) {
    return this.store.batchUpdate(ids, action, folderId)
  }
  searchEmails(options: SearchOptions) { return this.store.searchEmails(options) }
  countSearchResults(options: SearchOptions) { return this.store.countSearchResults(options) }
  findThreadBySubject(subject: string, sender?: string) { return this.store.findThreadBySubject(subject, sender) }
  checkSendRateLimit(now?: number) { return this.store.checkSendRateLimit(now) }
  createEmail(folder: string, email: EmailData) { return this.store.createEmail(folder, email) }
  saveDraft(draftId: string | null, email: EmailData) { return this.store.saveDraft(draftId, email) }
  sendDraft(draftId: string, fields: Parameters<MailboxStore['sendDraft']>[1]) { return this.store.sendDraft(draftId, fields) }
  setHasAttachment(id: string, value: boolean) { return this.store.setHasAttachment(id, value) }
  updateDelivery(id: string, status: string, error: string | null, providerMessageId: string | null = null) {
    return this.store.updateDelivery(id, status, error, providerMessageId)
  }
  claimInbound(messageKey: string, now?: number) { return this.store.claimInbound(messageKey, now) }
  completeInbound(messageKey: string) { return this.store.completeInbound(messageKey) }
  releaseInbound(messageKey: string) { return this.store.releaseInbound(messageKey) }
  claimOperation(operationId: string, requestHash: string, messageId: string) {
    return this.store.claimOperation(operationId, requestHash, messageId)
  }
  deleteAll() { return this.store.deleteAll() }
}
