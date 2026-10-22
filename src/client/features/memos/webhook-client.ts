import type {
  MemoWebhook,
  MemoWebhookCreateResult,
  MemoWebhookInput,
} from '@shared/memos/types'
import { memoRequest } from './api'

export const memoWebhooksClient = {
  async list(signal?: AbortSignal): Promise<MemoWebhook[]> {
    const page = await memoRequest<{ webhooks: MemoWebhook[] }>('/webhooks', { signal })
    return page.webhooks
  },

  create(input: MemoWebhookInput): Promise<MemoWebhookCreateResult> {
    return memoRequest<MemoWebhookCreateResult>('/webhooks', { method: 'POST', body: input })
  },

  update(id: string, input: MemoWebhookInput): Promise<MemoWebhook> {
    return memoRequest<MemoWebhook>(`/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    })
  },

  delete(id: string): Promise<{ ok: true }> {
    return memoRequest<{ ok: true }>(`/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  regenerateSecret(id: string): Promise<MemoWebhookCreateResult> {
    return memoRequest<MemoWebhookCreateResult>(
      `/webhooks/${encodeURIComponent(id)}/secret`,
      { method: 'POST' },
    )
  },
}
