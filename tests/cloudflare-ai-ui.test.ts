import { describe, expect, it } from 'vitest'
import type { AiChatSession } from '../src/client/features/cloudflare/api/chat-sessions'
import {
  AUDIO_LANGUAGE_OPTIONS,
  CHAT_PARAM_DEFAULTS,
  IMAGE_SIZE_PRESETS,
  INDICTRANS2_LANGUAGES,
  M2M100_LANGUAGES,
  audioAdvancedFields,
  audioFieldChoices,
  buildAudioBody,
  buildChatBody,
  buildImageBody,
  buildTranslateBody,
  defaultTranslationPair,
  filterChatSessions,
  initialAudioValues,
  isIndicTransModel,
  resolveImageSize,
  sessionDisplayTitle,
  sessionTitleFromAnswer,
  sharePercent,
  sortChatSessions,
  translationSourceLanguages,
  translationTargetLanguages,
  type AudioAdvancedField,
} from '../src/client/features/cloudflare/screens/ai/options'

function session(overrides: Partial<AiChatSession> = {}): AiChatSession {
  return {
    id: 's1',
    title: 'Session',
    pinned: 0,
    favorite: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

describe('AI option lists', () => {
  it('carries the M2M100 and IndicTrans2 language tables', () => {
    expect(M2M100_LANGUAGES.map((entry) => entry.value)).toEqual(
      expect.arrayContaining(['en', 'zh', 'ja', 'hi']),
    )
    expect(M2M100_LANGUAGES).toHaveLength(12)
    expect(INDICTRANS2_LANGUAGES.map((entry) => entry.value)).toContain('hin_Deva')
    expect(INDICTRANS2_LANGUAGES.length).toBeGreaterThanOrEqual(20)
    expect(AUDIO_LANGUAGE_OPTIONS.map((entry) => entry.value)).toContain('en')
  })

  it('follows the model family when choosing the translation pair', () => {
    expect(isIndicTransModel('@cf/ai4bharat/indictrans2-en-indic-1B')).toBe(true)
    expect(defaultTranslationPair('@cf/meta/m2m100-1.2b')).toEqual({ source: 'auto', target: 'en' })
    expect(defaultTranslationPair('@cf/ai4bharat/indictrans2-en-indic-1B')).toEqual({
      source: 'en',
      target: 'hin_Deva',
    })
    expect(translationSourceLanguages('@cf/ai4bharat/indictrans2-en-indic-1B')).toEqual([
      { label: 'English', value: 'en' },
    ])
    expect(translationTargetLanguages('@cf/meta/m2m100-1.2b')).toBe(M2M100_LANGUAGES)
  })
})

describe('image request building', () => {
  it('exposes square size presets and falls back to 1024', () => {
    expect(IMAGE_SIZE_PRESETS.map((entry) => entry.width)).toEqual([512, 768, 1024])
    expect(resolveImageSize('512')).toMatchObject({ width: 512, height: 512 })
    expect(resolveImageSize('nope')).toMatchObject({ width: 1024, height: 1024 })
  })

  it('sends Stable Diffusion parameters only to an SD model', () => {
    const body = buildImageBody({
      model: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
      prompt: 'a lighthouse',
      mode: 'image-to-image',
      accountId: 'auto',
      image: 'base64',
      strength: 0.55,
      numSteps: 20,
      width: 768,
      height: 768,
      guidance: 7.5,
      negativePrompt: ' blur ',
    })
    expect(body).toEqual({
      model: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
      prompt: 'a lighthouse',
      image: 'base64',
      strength: 0.55,
      num_steps: 20,
      width: 768,
      height: 768,
      guidance: 7.5,
      negative_prompt: 'blur',
    })
  })

  it('drops SD-only fields for FLUX and names the account when it is explicit', () => {
    const body = buildImageBody({
      model: '@cf/black-forest-labs/flux-1-schnell',
      prompt: 'a kite',
      mode: 'image-to-image',
      accountId: 'acc-1',
      image: 'base64',
      strength: 0.9,
      numSteps: 4,
      width: 1024,
      height: 1024,
      guidance: 3,
      negativePrompt: 'none',
    })
    expect(body).toEqual({
      model: '@cf/black-forest-labs/flux-1-schnell',
      prompt: 'a kite',
      accountId: 'acc-1',
      image: 'base64',
      num_steps: 4,
    })
  })
})

describe('chat request building', () => {
  const messages = [{ role: 'user' as const, content: 'hello' }]

  it('sends only max_tokens while the sampler is at its defaults', () => {
    const body = buildChatBody({
      model: 'model',
      messages,
      params: CHAT_PARAM_DEFAULTS,
      accountId: 'auto',
      stream: false,
    })
    expect(body).toEqual({ model: 'model', messages, max_tokens: 4096 })
  })

  it('adds changed sampler fields, clamps tokens and marks a stream', () => {
    const body = buildChatBody({
      model: 'model',
      messages,
      params: { ...CHAT_PARAM_DEFAULTS, max_tokens: 999_999, temperature: 0.4, top_p: 0.9 },
      accountId: 'acc',
      stream: true,
    })
    expect(body.max_tokens).toBe(8192)
    expect(body.temperature).toBe(0.4)
    expect(body.top_p).toBe(0.9)
    expect(body.presence_penalty).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.accountId).toBe('acc')
  })

  it('names a session from the answer, then from the question', () => {
    expect(sessionTitleFromAnswer('  "A short title"  ', 'question')).toBe('A short title')
    expect(sessionTitleFromAnswer('', 'How do I bake bread?')).toBe('How do I bake bread?')
    expect(sessionTitleFromAnswer('x'.repeat(40), 'q')).toHaveLength(24)
  })
})

describe('TTS schema and request building', () => {
  const model = {
    id: 'tts',
    speakers: ['alloy', 'echo'],
    default_speaker: 'alloy',
    advanced_params: {
      container: { enum: ['mp3', 'wav'], default: 'mp3' },
      speed: { type: 'number', default: 1, min: 0.5, max: 2 },
      note: { type: 'string', default: '' },
    },
  }

  it('turns schema properties into fields and choices', () => {
    const fields = audioAdvancedFields(model)
    expect(fields.map((field) => [field.name, field.kind])).toEqual([
      ['container', 'enum'],
      ['speed', 'number'],
      ['note', 'text'],
    ])
    const container = fields[0]!
    expect(audioFieldChoices(container)?.map((entry) => entry.value)).toEqual(['mp3', 'wav'])
    const lang: AudioAdvancedField = { name: 'lang', kind: 'enum', defaultValue: 'en' }
    expect(audioFieldChoices(lang)).toBe(AUDIO_LANGUAGE_OPTIONS)
    expect(initialAudioValues(fields)).toEqual({ container: 'mp3', speed: '1', note: '' })
  })

  it('omits blank advanced values and converts numbers', () => {
    const fields: AudioAdvancedField[] = audioAdvancedFields(model)
    const body = buildAudioBody({
      model: 'tts',
      text: 'Hello',
      voice: 'echo',
      accountId: 'auto',
      fields,
      values: { container: '', speed: '1.25', note: '  ' },
    })
    expect(body).toEqual({ model: 'tts', input: 'Hello', voice: 'echo', speed: 1.25 })
  })
})

describe('translation request building', () => {
  it('drops an auto source and keeps the target', () => {
    const body = buildTranslateBody({
      model: '@cf/meta/m2m100-1.2b',
      text: 'Hello',
      sourceLang: 'auto',
      targetLang: 'zh',
      accountId: 'auto',
    })
    expect(body).toEqual({
      model: '@cf/meta/m2m100-1.2b',
      text: 'Hello',
      target_lang: 'zh',
    })
  })

  it('names an explicit source and account', () => {
    const body = buildTranslateBody({
      model: '@cf/ai4bharat/indictrans2-en-indic-1B',
      text: 'Hello',
      sourceLang: 'en',
      targetLang: 'hin_Deva',
      accountId: 'acc',
    })
    expect(body).toMatchObject({ source_lang: 'en', accountId: 'acc' })
  })
})

describe('session formatting and filtering', () => {
  const sessions = [
    session({ id: 'a', title: 'Weekly plan', pinned: 1, updated_at: 10 }),
    session({ id: 'b', title: 'Trip ideas', favorite: 1, updated_at: 30 }),
    session({ id: 'c', title: 'Weekly review', updated_at: 20 }),
  ]

  it('filters by tab and title', () => {
    expect(filterChatSessions(sessions, 'all').map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(filterChatSessions(sessions, 'pinned').map((row) => row.id)).toEqual(['a'])
    expect(filterChatSessions(sessions, 'favorite').map((row) => row.id)).toEqual(['b'])
    expect(filterChatSessions(sessions, 'all', 'week').map((row) => row.id)).toEqual(['a', 'c'])
    expect(filterChatSessions(sessions, 'all', 'nothing')).toEqual([])
  })

  it('sorts pinned first, then newest', () => {
    expect(sortChatSessions(sessions).map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('shows the fallback while the server title is empty', () => {
    expect(sessionDisplayTitle('', 'New chat')).toBe('New chat')
    expect(sessionDisplayTitle('  Kept  ', 'New chat')).toBe('Kept')
  })

  it('formats a share with one decimal and guards a zero total', () => {
    expect(sharePercent(25, 100)).toBe('25.0')
    expect(sharePercent(1, 0)).toBe('0.0')
  })
})
