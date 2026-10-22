import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { applyMailboxMigrations, type SqlExec } from './mailbox-schema'
import {
  MailboxStore,
  type EmailData,
  type EmailRestoreData,
  type FolderRestoreData,
  type ListOptions,
  type SearchOptions,
} from './mailbox-store'

export class EmailMailbox extends DurableObject<Env> {
  private readonly store: MailboxStore

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    const sql = state.storage.sql as unknown as SqlExec
    applyMailboxMigrations(sql, state.storage)
    this.store = new MailboxStore(sql, state.storage)
  }

  getFolders() { return this.store.getFolders() }
  createFolder(name: string) { return this.store.createFolder(name) }
  updateFolder(id: string, name: string) { return this.store.updateFolder(id, name) }
  deleteFolder(id: string, deleteEmails = false) { return this.store.deleteFolder(id, deleteEmails) }
  listAllEmails() { return this.store.listAllEmails() }
  importFolder(folder: FolderRestoreData) { return this.store.importFolder(folder) }
  importEmail(email: EmailRestoreData) { return this.store.importEmail(email) }
  getEmails(options: ListOptions = {}) { return this.store.getEmails(options) }
  countEmails(options: { folder?: string; threadId?: string } = {}) { return this.store.countEmails(options) }
  getThreadedEmails(options: ListOptions = {}) { return this.store.getThreadedEmails(options) }
  countThreadedEmails(folder: string) { return this.store.countThreadedEmails(folder) }
  getEmail(id: string) { return this.store.getEmail(id) }
  getThreadEmails(threadId: string) { return this.store.getThreadEmails(threadId) }
  updateEmail(id: string, patch: { read?: boolean; starred?: boolean }) { return this.store.updateEmail(id, patch) }
  markThreadRead(threadId: string) { return this.store.markThreadRead(threadId) }
  trashEmail(id: string) { return this.store.trashEmail(id) }
  restoreEmail(id: string) { return this.store.restoreEmail(id) }
  listTrash(options: { page?: number; limit?: number } = {}) { return this.store.listTrash(options) }
  countTrash() { return this.store.countTrash() }
  emptyTrash() { return this.store.emptyTrash() }
  purgeExpiredTrash(cutoff: number) { return this.store.purgeExpiredTrash(cutoff) }
  deleteEmail(id: string) { return this.store.deleteEmail(id) }
  moveEmail(id: string, folderId: string) { return this.store.moveEmail(id, folderId) }
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
