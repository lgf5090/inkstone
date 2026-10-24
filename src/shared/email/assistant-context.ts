export interface EmailAssistantContext {
  accountId: string
  address: string
  folderId: string | null
  messageId: string | null
  threadId: string | null
  subject: string | null
  sender: string | null
  recipient: string | null
  date: string | null
  snippet: string | null
  threadCount: number | null
}

export const MAX_EMAIL_CONTEXT_SNIPPET = 300
