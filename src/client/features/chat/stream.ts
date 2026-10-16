/**
 * Reading the assistant's streamed reply.
 *
 * The API helper in `lib/api` parses a JSON body, which is exactly the wrong shape for a turn: the
 * reader should watch the answer arrive. So this is the one place in the app that consumes a
 * `ReadableStream` by hand, and it carries the same three headers every other write does — without
 * `X-Inkstone-Client` the worker refuses the request before it reaches the assistant.
 */

import { CLIENT_HEADER } from '@shared/constants'
import type { AssistantTurnScope, ChatStreamEvent } from '@shared/assistant'
import { ApiError, CLIENT_ID } from '../../lib/api'
import { getLocale } from '../../lib/i18n'

export interface StreamTurnInput {
  conversationId?: string
  message: string
  /** Attachment ids the reader hung on this turn. */
  attachments?: string[]
  /** Tools the reader asked for with `/`, by name. */
  tools?: string[]
  /** Note tags and folders the reader pinned with `#`. */
  scopes?: AssistantTurnScope[]
  /** The note the reader had open, so "this note" has a referent. */
  contextNoteId?: string
  /** The folder the notebook was filtered to, as a hint about what they were looking at. */
  contextFolderId?: string
  retry?: boolean
  /** The web-search switch: ask this model for a live search this turn. */
  webSearch?: boolean
}

export async function streamAssistantTurn(
  input: StreamTurnInput,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/assistant/chat', {
    method: 'POST',
    headers: {
      [CLIENT_HEADER]: '1',
      'X-Inkstone-Origin': CLIENT_ID,
      'Accept-Language': getLocale(),
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      message: input.message,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.tools?.length ? { tools: input.tools } : {}),
      ...(input.scopes?.length ? { scopes: input.scopes } : {}),
      ...(input.contextNoteId ? { contextNoteId: input.contextNoteId } : {}),
      ...(input.contextFolderId ? { contextFolderId: input.contextFolderId } : {}),
      ...(input.webSearch ? { webSearch: true } : {}),
      ...(input.retry ? { retry: true } : {}),
    }),
    credentials: 'same-origin',
    signal,
  })

  if (!response.ok) {
    let code = 'unknown'
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json() as { error?: { code?: string, message?: string } }
      code = body.error?.code ?? code
      message = body.error?.message ?? message
    } catch {
      // A non-JSON failure still has to surface as an error, not as a stalled stream.
    }
    throw new ApiError(response.status, code, message)
  }
  if (!response.body) {
    throw new ApiError(502, 'internal', 'The assistant returned no stream.')
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      try {
        onEvent(JSON.parse(data) as ChatStreamEvent)
      } catch {
        // A frame we cannot read is not worth losing the rest of the answer over.
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}
