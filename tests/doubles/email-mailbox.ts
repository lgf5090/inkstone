import { MailboxStore } from '../../src/worker/email/mailbox-store'
import type { EmailData } from '../../src/worker/email/mailbox-store'

export function fakeEmailMailboxNamespace(store: MailboxStore): DurableObjectNamespace {
  const stub = {
    getFolders: () => store.getFolders(),
    createFolder: (name: string) => store.createFolder(name),
    updateFolder: (id: string, name: string) => store.updateFolder(id, name),
    deleteFolder: (id: string, deleteEmails = false) => store.deleteFolder(id, deleteEmails),
    getEmails: (options = {}) => store.getEmails(options),
    countEmails: (options = {}) => store.countEmails(options),
    getThreadedEmails: (options = {}) => store.getThreadedEmails(options),
    countThreadedEmails: (folder: string) => store.countThreadedEmails(folder),
    getEmail: (id: string) => store.getEmail(id),
    getThreadEmails: (threadId: string) => store.getThreadEmails(threadId),
    updateEmail: (id: string, patch: { read?: boolean; starred?: boolean }) => store.updateEmail(id, patch),
    markThreadRead: (threadId: string) => store.markThreadRead(threadId),
    trashEmail: (id: string) => store.trashEmail(id),
    restoreEmail: (id: string) => store.restoreEmail(id),
    listTrash: (options = {}) => store.listTrash(options),
    countTrash: () => store.countTrash(),
    emptyTrash: () => store.emptyTrash(),
    purgeExpiredTrash: (cutoff: number) => store.purgeExpiredTrash(cutoff),
    deleteEmail: (id: string) => store.deleteEmail(id),
    moveEmail: (id: string, folderId: string) => store.moveEmail(id, folderId),
    searchEmails: (options: Parameters<MailboxStore['searchEmails']>[0]) => store.searchEmails(options),
    countSearchResults: (options: Parameters<MailboxStore['countSearchResults']>[0]) => store.countSearchResults(options),
    findThreadBySubject: (subject: string, sender?: string) => store.findThreadBySubject(subject, sender),
    checkSendRateLimit: (now?: number) => store.checkSendRateLimit(now),
    createEmail: (folder: string, email: EmailData) => store.createEmail(folder, email),
    saveDraft: (draftId: string | null, email: EmailData) => store.saveDraft(draftId, email),
    sendDraft: (draftId: string, fields: Parameters<MailboxStore['sendDraft']>[1]) => store.sendDraft(draftId, fields),
    setHasAttachment: (id: string, value: boolean) => store.setHasAttachment(id, value),
    updateDelivery: (id: string, status: string, error: string | null, providerMessageId: string | null = null) =>
      store.updateDelivery(id, status, error, providerMessageId),
    claimInbound: (messageKey: string, now?: number) => store.claimInbound(messageKey, now),
    completeInbound: (messageKey: string) => store.completeInbound(messageKey),
    releaseInbound: (messageKey: string) => store.releaseInbound(messageKey),
    claimOperation: (operationId: string, requestHash: string, messageId: string) =>
      store.claimOperation(operationId, requestHash, messageId),
    deleteAll: () => store.deleteAll(),
  }
  const id = {
    name: 'mailbox',
    toString: () => 'mailbox',
    equals: (other: DurableObjectId) => other.toString() === 'mailbox',
  } as DurableObjectId
  const namespace: DurableObjectNamespace = {
    newUniqueId: () => id,
    idFromName: () => id,
    idFromString: () => id,
    get: () => stub as unknown as DurableObjectStub,
    getByName: () => stub as unknown as DurableObjectStub,
    jurisdiction: () => namespace,
  } as DurableObjectNamespace
  return namespace
}
