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
import { ApiError, CLIENT_ID, routeApiError } from '../../lib/api'
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
  /** The note this thread is being started from, recorded on the conversation the first time. */
  noteId?: string
  retry?: boolean
  /** Which answer to ask again. Absent means the newest turn, which is what the bubble's own button means. */
  messageId?: string
  /** Resume the last answer where it stopped instead of asking anything new. */
  continueTurn?: boolean
  /** The web-search switch: ask this model for a live search this turn. */
  webSearch?: boolean
  /**
   * Which model answers this turn, by id.
   *
   * The worker checks it against this account's own enabled chat models and refuses the request rather
   * than answering on the reader's standing pick, so an id the caller does not own is an error, not a
   * silently different answer.
   */
  modelId?: string
  /** Answer this turn without tools: nothing is offered to the model, and nothing it invents runs. */
  noTools?: boolean
  /** Start the conversation as a temporary one, when this turn is the one that makes it. */
  ephemeral?: boolean
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
      ...(input.noteId ? { noteId: input.noteId } : {}),
      ...(input.webSearch ? { webSearch: true } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.noTools ? { noTools: true } : {}),
      ...(input.ephemeral ? { ephemeral: true } : {}),
      ...(input.retry ? { retry: true } : {}),
      ...(input.retry && input.messageId ? { messageId: input.messageId } : {}),
      ...(input.continueTurn ? { continue: true } : {}),
    }),
    credentials: 'same-origin',
    signal,
  })

  if (!response.ok) {
    // The body is read here, and only the body: on success this response is a stream the helper owns, so
    // it cannot go through `request()`. A refusal is still an ordinary route's refusal, so it is turned
    // into an error by the same factory every other call uses — the bounds that keep a route's reason
    // printable are decided once there, and `stream-refusal.test.ts` holds the two paths to the same answer
    // for the same body rather than letting this one grow a second set of rules.
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // A non-JSON failure still has to surface as an error, not as a stalled stream.
    }
    throw routeApiError(response.status, body)
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
