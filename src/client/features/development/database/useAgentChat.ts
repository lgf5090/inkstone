import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../../lib/i18n'
import { streamAgentChat } from './api'
import type { AgentMessage, AgentMessagePart, AgentStatus } from './types'

export interface UseAgentChatOptions {
  onToolComplete?: () => void
}

export interface UseAgentChatResult {
  messages: AgentMessage[]
  status: AgentStatus
  sendMessage: (text: string) => void
  stop: () => void
  clear: () => void
}

function appendText(parts: AgentMessagePart[], text: string): AgentMessagePart[] {
  if (!text) return parts
  const last = parts[parts.length - 1]
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { type: 'text', text: last.text + text }]
  }
  return [...parts, { type: 'text', text }]
}

export function useAgentChat({ onToolComplete }: UseAgentChatOptions = {}): UseAgentChatResult {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [status, setStatus] = useState<AgentStatus>('idle')
  const abortRef = useRef<AbortController | null>(null)
  const currentRef = useRef<AgentMessage | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const completeRef = useRef(onToolComplete)
  completeRef.current = onToolComplete

  useEffect(() => () => {
    abortRef.current?.abort()
  }, [])

  const commit = useCallback((message: AgentMessage) => {
    setMessages((current) => {
      const index = current.findIndex((entry) => entry.id === message.id)
      if (index < 0) return [...current, message]
      const next = [...current]
      next[index] = message
      return next
    })
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    const current = currentRef.current
    currentRef.current = null
    if (current && (current.content.trim() || current.parts.length > 0)) commit(current)
    setStatus('idle')
  }, [commit])

  const clear = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    currentRef.current = null
    setMessages([])
    setStatus('idle')
  }, [])

  const sendMessage = useCallback((text: string) => {
    const value = text.trim()
    if (!value || status === 'submitted' || status === 'streaming') return
    const user: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: value,
      parts: [{ type: 'text', text: value }],
      createdAt: Date.now(),
    }
    const assistant: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      parts: [],
      createdAt: Date.now(),
    }
    const history = messagesRef.current.map((message) => ({ role: message.role, content: message.content }))
    setMessages((current) => [...current, user])
    currentRef.current = assistant
    setStatus('submitted')
    const controller = new AbortController()
    abortRef.current = controller

    void streamAgentChat([...history, { role: 'user', content: value }], (event) => {
      const current = currentRef.current
      if (!current) return
      if (event.type === 'start') {
        setStatus('streaming')
        return
      }
      if (event.type === 'delta') {
        current.content += event.content
        current.parts = appendText(current.parts, event.content)
        commit({ ...current, parts: [...current.parts] })
        return
      }
      if (event.type === 'reasoning') {
        return
      }
      if (event.type === 'tool_calls') {
        let parts = current.parts
        for (const call of event.calls) {
          parts = [...parts, { type: 'tool-call', callId: call.id, toolName: call.name, state: 'running' }]
        }
        current.parts = parts
        commit({ ...current, parts: [...parts] })
        return
      }
      if (event.type === 'tool_results') {
        let parts = current.parts
        for (const result of event.results) {
          parts = parts.map((part) => part.type === 'tool-call' && part.callId === result.id
            ? { ...part, state: result.isError ? 'output-error' : 'result' }
            : part)
        }
        current.parts = parts
        commit({ ...current, parts: [...parts] })
        completeRef.current?.()
        return
      }
      if (event.type === 'done') {
        if (current.content.trim() || current.parts.length > 0) commit(current)
        currentRef.current = null
        setStatus('idle')
        abortRef.current = null
      }
    }, controller.signal)
      .catch((cause) => {
        if (controller.signal.aborted) return
        const message = (cause as { code?: unknown })?.code === 'no_model'
          ? t('development.database.ai.no_model')
          : cause instanceof Error ? cause.message : String(cause)
        const errorMessage: AgentMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `⚠️ ${message}`,
          parts: [{ type: 'text', text: `⚠️ ${message}` }],
          createdAt: Date.now(),
        }
        setMessages((current) => [...current, errorMessage])
        currentRef.current = null
        setStatus('error')
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null
      })
  }, [commit, status])

  return { messages, status, sendMessage, stop, clear }
}
