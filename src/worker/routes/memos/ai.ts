import { Hono } from 'hono'
import { MEMO_AI_TRANSCRIBE_MAX_BYTES } from '@shared/memos/constants'
import { AssistantStore } from '../../assistant/store'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import { readFormDataWithinLimit } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import {
  MEMO_TRANSCRIBE_FORM_MAX_BYTES,
  MEMO_TRANSCRIBE_MIME_TYPES,
  normalizeMemoTranscriptionMime,
  transcribeMemoAudio,
} from '../../memos/transcribe'

export const memoAiRoutes = new Hono<AppBindings>()

memoAiRoutes.use('*', requireMemoUser)

/**
 * The account's providers as the composer's microphone may spend them.
 *
 * A recording has no picker of its own: the composer takes the first provider and model this answers
 * with, so the listing carries only what a transcription call could use — an enabled text model — and
 * otherwise stays in the order the reader's own provider list has. The protocol travels as stored,
 * because the caller is what knows an Anthropic provider has no audio endpoint to send to.
 *
 * Only the label, protocol and model ids travel: the ciphertext, the key hint and the base address
 * stay in the worker, because a browser has nothing to do with any of them.
 */
memoAiRoutes.get('/providers', async (c) => {
  const store = new AssistantStore(c.env.DB, c.get('userId'), c.env)
  const [providers, models] = await Promise.all([store.listProviders(), store.listModels()])
  const transcribable = models.filter((model) => (
    model.enabled && model.purpose === 'chat' && model.kind === 'text'
  ))
  return c.json({
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      protocol: provider.protocol,
      models: transcribable
        .filter((model) => model.providerId === provider.id)
        .map((model) => model.model),
    })),
  })
})

memoAiRoutes.post('/transcribe', async (c) => {
  const form = await readFormDataWithinLimit(c.req, MEMO_TRANSCRIBE_FORM_MAX_BYTES)

  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing audio file field')
  if (!file.size) throw ApiError.badRequest('The audio file is empty')
  if (file.size > MEMO_AI_TRANSCRIBE_MAX_BYTES) {
    throw ApiError.tooLarge(
      `The audio exceeds the ${MEMO_AI_TRANSCRIBE_MAX_BYTES / 1024 / 1024} MB limit`,
    )
  }
  if (!normalizeMemoTranscriptionMime(file.type)) {
    throw new ApiError(
      415,
      'bad_request',
      `Unsupported audio type. Use one of: ${MEMO_TRANSCRIBE_MIME_TYPES.join(', ')}`,
    )
  }

  const providerId = textField(form, 'providerId')?.trim() || null
  if (providerId !== null && !isValidId(providerId)) {
    throw ApiError.badRequest('Invalid transcription provider id')
  }

  const result = await transcribeMemoAudio(c.env, {
    userId: c.get('userId'),
    providerId,
    model: textField(form, 'model'),
    language: textField(form, 'language'),
    prompt: textField(form, 'prompt'),
    audio: {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      filename: file.name,
    },
  })
  return c.json(result)
})

function textField(form: FormData, name: string): string | null {
  const value = form.get(name)
  if (value === null) return null
  if (typeof value !== 'string') throw ApiError.badRequest(`Invalid ${name} field`)
  return value
}
