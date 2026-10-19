/**
 * The one thing a wire stub needs to know about the naming pass.
 *
 * Every answer that finishes whole is followed by one cheap call to the same model, asking what the reader
 * would want to ask next. It is not part of the turn's own traffic, so a test that counts what one question
 * cost — calls, steps, tokens, lease renewals — has to answer it and step over it. Recognising it by the
 * instructions it carries is the only reading that does not depend on ordering: it is the last call, yes,
 * but "the last call" is exactly what a test about retries cannot say.
 */
import { DEFAULT_ASSISTANT_SETTINGS } from '../../src/shared/assistant'
import { promptCatalog } from '../../src/shared/assistant-prompt'

const NAMING_SYSTEM = promptCatalog(DEFAULT_ASSISTANT_SETTINGS.language).naming_system

/** Whether this request body is the follow-up pass rather than the turn's own step. */
export function isNamingRequest(body: unknown): boolean {
  return JSON.stringify(body ?? '').includes(NAMING_SYSTEM)
}

/**
 * An answer the pass finds nothing in: plain words, no braces, so no title and no follow-ups.
 *
 * Returning the turn's own canned reply here would be the trap — a reply that happens to quote a JSON object
 * would be read as the model naming the thread, and the test would be asserting a rename it never asked for.
 *
 * It does carry a usage frame, and a fixed one: the pass is billed for what it spends, so a test that reads
 * the day's totals has to be able to name the amount it is adding. 40 in / 20 out is what the naming cases
 * in `assistant-title-suggestions.test.ts` report, so the two files agree on one number.
 */
export const NAMING_USAGE = { inputTokens: 40, outputTokens: 20 }

export function namingAnswer(): Response {
  const encoder = new TextEncoder()
  const frames = [
    `data: ${JSON.stringify({
      choices: [{ index: 0, finish_reason: null, delta: { content: 'The pass was asked and answered nothing.' } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [], usage: { prompt_tokens: NAMING_USAGE.inputTokens, completion_tokens: NAMING_USAGE.outputTokens },
    })}\n\n`,
    'data: [DONE]\n\n',
  ]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}
