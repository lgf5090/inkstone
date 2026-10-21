import { Hono } from 'hono'
import { MEMO_AI_TRANSCRIBE_MAX_BYTES } from '@shared/memos/constants'
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
