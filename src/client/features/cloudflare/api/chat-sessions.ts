/** The AI conversation history: sessions and their messages. */
import { cfRequest } from './client'

export interface AiChatSession {
  id: string
  title: string
  pinned: number
  favorite: number
  created_at: number
  updated_at: number
  message_count?: number
}

export interface AiChatMessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

export const chatSessionsApi = {
  list: (params: { q?: string; tab?: 'pinned' | 'favorite' } = {}) => {
    const search = new URLSearchParams()
    if (params.q) search.set('q', params.q)
    if (params.tab) search.set('tab', params.tab)
    const suffix = search.toString()
    return cfRequest<AiChatSession[]>(`/ai/chat/sessions${suffix ? `?${suffix}` : ''}`)
  },
  create: (title?: string) => cfRequest<AiChatSession>('/ai/chat/sessions', { method: 'POST', body: { title } }),
  update: (id: string, patch: { title?: string; pinned?: boolean; favorite?: boolean }) =>
    cfRequest<AiChatSession>(`/ai/chat/sessions/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }),
  remove: (id: string) => cfRequest<{ ok: true }>(`/ai/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  messages: (id: string) =>
    cfRequest<AiChatMessageRow[]>(`/ai/chat/sessions/${encodeURIComponent(id)}/messages`),
  append: (id: string, messages: Array<{ role: string; content: string }>) =>
    cfRequest<AiChatMessageRow[]>(`/ai/chat/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: { messages },
    }),
  clear: (id: string) =>
    cfRequest<{ ok: true }>(`/ai/chat/sessions/${encodeURIComponent(id)}/messages`, { method: 'DELETE' }),
  removeLastAssistant: (id: string) =>
    cfRequest<{ ok: true }>(`/ai/chat/sessions/${encodeURIComponent(id)}/messages/last-assistant`, { method: 'DELETE' }),
}
