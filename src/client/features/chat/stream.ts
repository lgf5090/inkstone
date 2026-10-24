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
import type { TodoAssistantContext } from '@shared/todos/assistant-context'
import type { EmailAssistantContext } from '@shared/email/assistant-context'
import type { MusicAssistantContext } from '@shared/music/assistant-context'
import { ApiError, CLIENT_ID, routeApiError } from '../../lib/api'
import { getLocale, t } from '../../lib/i18n'

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
  /** The draft open in the canvas, so the model can read and rewrite it. */
  activeArtifactId?: string
  contextTodo?: TodoAssistantContext
  contextEmail?: EmailAssistantContext
  /** The music screen open beside the dock, so "play this" has a referent. */
  contextMusic?: MusicAssistantContext
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

/**
 * The bytes under a turn stopped arriving, and nothing said why.
 *
 * A turn ends without an answer in two quite different ways, and the reader has to be told about them
 * differently. A refusal arrives as an `error` frame carrying the worker's own sentence, written to be
 * printed; a connection that gives out mid-sentence carries only whatever the browser felt like — today
 * "Failed to fetch", in another engine a network error in a language of its own, and never a translation
 * of anything. So the reading loop names its own failure with this type and keeps the browser's text as
 * `cause`: for the console of whoever has to debug it, never for a bubble.
 *
 * `name` is set here and read as text by the store, not by `instanceof`: a test that mocks this module
 * usually replaces only the one function it needs, and then answers a missing export by throwing — the
 * class would be the thing under test for the wrong reason. Rename it and `assistant-store.ts` is the
 * file that stops saying the right sentence.
 */
export class StreamDisconnectedError extends Error {
  constructor(message: string, options: { cause?: unknown }) {
    super(message, options)
    this.name = 'StreamDisconnectedError'
  }
}

export async function streamAssistantTurn(
  input: StreamTurnInput,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  // The request is made inside the `try` below, and that placement is the whole point: a turn can lose its
  // connection before there is a response to read at all, and then the only thing the browser has to say
  // for itself is "Failed to fetch" — a sentence no reader was given, and no translator knows.
  let response: Response
  try {
    response = await fetch('/api/assistant/chat', {
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
        ...(input.activeArtifactId ? { activeArtifactId: input.activeArtifactId } : {}),
        ...(input.contextTodo ? { contextTodo: input.contextTodo } : {}),
        ...(input.contextMusic ? { contextMusic: input.contextMusic } : {}),
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
  } catch (error) {
    // The stop the reader pressed, again the one exception: an abort is the reader's own act and goes back
    // exactly as it came, or `send` would tell them their network is down because their finger was here.
    if (signal.aborted) throw error
    // Everything else is the same fact `request()` already answers for every other call in the app — the
    // request never got an answer — so it is answered with the same error and the same catalog sentence,
    // not with a third line written here. Deliberately not `StreamDisconnectedError`: that one points the
    // reader at `assistant.chat.continue`, and a turn the worker was never told about has no half answer to
    // carry on.
    throw new ApiError(0, 'offline', t('api.no_network_connection'))
  }

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

  // Building the reader is the engine's own work: `TextDecoderStream` is what turns the bytes into text, and
  // an engine without that constructor, or one that will not pipe this body, fails right here — before a
  // single word of the answer has been read. Left bare, that failure is a `TypeError` in English, and the
  // bubble prints whatever the thrower handed up, which is the rule this turn has already agreed to break
  // twice above. So it is said from the catalog instead.
  //
  // Deliberately not `StreamDisconnectedError`: the line the store answers that with,
  // `assistant.chat.stream_disconnected`, ends by telling the reader to press the continue control, and
  // `ChatView.tsx`'s `canContinueAnswer` draws that control only for an answer with words in it. Nothing
  // arrived on this path, so the control is not on the screen and the sentence would name a button the
  // reader cannot press — the mistake `39ba8131` refused to make for the comparison column, for the same
  // reason. This one states the fact and nothing else, which is also why it reads correctly in the
  // comparison's column.
  //
  // There is no `signal.aborted` exception here, unlike the two catches either side of it, because there is
  // nothing to except: building a reader is synchronous, so the stop the reader pressed cannot be what made
  // this throw.
  let reader: ReadableStreamDefaultReader<string>
  try {
    reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  } catch (error) {
    const failure = new ApiError(502, 'internal', t('assistant.chat.stream_reader_unavailable'))
    // The engine's text stays on the error as its `cause` — the same place the reading loop puts it, for
    // whoever has to debug this rather than read it — and the reader gets the catalog line above.
    failure.cause = error
    throw failure
  }
  let buffer = ''
  for (;;) {
    // A read that fails is the connection giving out under a turn the worker never refused. The stop the
    // reader pressed is the one exception, and `signal` is the proof of it: that stream is closed on
    // purpose, so its rejection goes back exactly as it came and the caller keeps treating it as a stop.
    let chunk
    try {
      chunk = await reader.read()
    } catch (error) {
      if (signal.aborted) throw error
      throw new StreamDisconnectedError('The assistant stream ended before the turn was answered.', { cause: error })
    }
    const { value, done } = chunk
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
      if (!data) {
        // Nothing to hand on: a comment line, which is what the worker's keepalive is. Skipping the frame
        // is right and skipping this index along with it is not — the buffer is now `boundary + 2` bytes
        // shorter than the number below was measured against, so the next cut would be taken from the
        // wrong place: it would slice the middle out of the following frame, and once the buffer runs out
        // it would never find another `\n\n` to stop on. Read the boundary again before going round.
        boundary = buffer.indexOf('\n\n')
        continue
      }
      try {
        onEvent(JSON.parse(data) as ChatStreamEvent)
      } catch (error) {
        // Best-effort on purpose, and it stays that way: a frame this reader cannot parse is one frame
        // lost, and the answer keeps arriving after it. Throwing would trade the rest of a reply the
        // reader is watching for a line the transport wrote badly, so the frame is skipped and only the
        // parse failure is recorded — the frame's own text is an answer's worth of reading material and
        // does not belong in a console log.
        console.warn('[inkstone] an assistant stream frame could not be parsed and was skipped', error)
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}
