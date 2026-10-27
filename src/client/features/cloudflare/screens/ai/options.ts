/**
 * The AI workspace's pure parts: option lists, model-family rules and request bodies.
 *
 * Keeping these out of the tab components is what makes the rules testable without a browser — which
 * parameters belong to the Stable Diffusion family, how a TTS schema becomes a form, what a session
 * title falls back to. The components only hold layout and state.
 */
import type {
  AiAudioRequest,
  AiChatMessage,
  AiChatRequest,
  AiImageRequest,
  AiModel,
  AiTranslateRequest,
} from '../../api/ai'
import type { AiChatSession } from '../../api/chat-sessions'

export const AUTO_ACCOUNT = 'auto'
export const NEURON_QUOTA = 10_000

export interface LanguageOption {
  value: string
  label: string
}

export const M2M100_LANGUAGES: readonly LanguageOption[] = [
  { label: 'English', value: 'en' },
  { label: 'Chinese', value: 'zh' },
  { label: 'Japanese', value: 'ja' },
  { label: 'Korean', value: 'ko' },
  { label: 'French', value: 'fr' },
  { label: 'German', value: 'de' },
  { label: 'Spanish', value: 'es' },
  { label: 'Portuguese', value: 'pt' },
  { label: 'Russian', value: 'ru' },
  { label: 'Italian', value: 'it' },
  { label: 'Arabic', value: 'ar' },
  { label: 'Hindi', value: 'hi' },
]

export const INDICTRANS2_LANGUAGES: readonly LanguageOption[] = [
  { label: 'Hindi (Devanagari)', value: 'hin_Deva' },
  { label: 'Bengali (Bengali script)', value: 'ben_Beng' },
  { label: 'Tamil (Tamil script)', value: 'tam_Taml' },
  { label: 'Telugu (Telugu script)', value: 'tel_Telu' },
  { label: 'Marathi (Devanagari)', value: 'mar_Deva' },
  { label: 'Gujarati (Gujarati script)', value: 'guj_Gujr' },
  { label: 'Kannada (Kannada script)', value: 'kan_Knda' },
  { label: 'Malayalam (Malayalam script)', value: 'mal_Mlym' },
  { label: 'Punjabi (Gurmukhi)', value: 'pan_Guru' },
  { label: 'Urdu (Arabic script)', value: 'urd_Arab' },
  { label: 'Nepali (Devanagari)', value: 'npi_Deva' },
  { label: 'Odia (Odia script)', value: 'ory_Orya' },
  { label: 'Assamese (Bengali script)', value: 'asm_Beng' },
  { label: 'Sanskrit (Devanagari)', value: 'san_Deva' },
  { label: 'Sindhi (Arabic script)', value: 'snd_Arab' },
  { label: 'Maithili (Devanagari)', value: 'mai_Deva' },
  { label: 'Bhojpuri (Devanagari)', value: 'bho_Deva' },
  { label: 'Dogri (Devanagari)', value: 'doi_Deva' },
  { label: 'Konkani (Devanagari)', value: 'gom_Deva' },
  { label: 'Manipuri (Meitei Mayek)', value: 'mni_Mtei' },
]

export const AUDIO_LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { label: 'English (en)', value: 'en' },
  { label: 'Chinese (zh)', value: 'zh' },
  { label: 'Japanese (ja)', value: 'ja' },
  { label: 'Korean (ko)', value: 'ko' },
  { label: 'French (fr)', value: 'fr' },
  { label: 'Spanish (es)', value: 'es' },
  { label: 'German (de)', value: 'de' },
  { label: 'Portuguese (pt)', value: 'pt' },
  { label: 'Russian (ru)', value: 'ru' },
  { label: 'Italian (it)', value: 'it' },
]

export type ImageMode = 'text-to-image' | 'image-to-image'

/** A `cloudflare_enabled_features` string with no entries means every feature is on. */
export function accountHasAiFeature(enabledFeatures: string): boolean {
  const features = enabledFeatures.split(',').map((item) => item.trim()).filter(Boolean)
  return features.length === 0 || features.includes('ai')
}

export function isFluxModel(model: string): boolean {
  return model.includes('flux')
}

export function isFlux2Model(model: string): boolean {
  return model.includes('flux-2')
}

export function isSdModel(model: string): boolean {
  return model.includes('stable-diffusion')
}

/** The image-to-image capability the model lists imply, including the no-list fallback. */
export function supportsImageToImage(model: string, imageToImageIds: ReadonlySet<string>): boolean {
  if (!model) return false
  if (imageToImageIds.has(model)) return true
  if (imageToImageIds.size > 0) return false
  return isFlux2Model(model) || !isFluxModel(model)
}

export interface ImageBodyInput {
  model: string
  prompt: string
  mode: ImageMode
  accountId: string
  image?: string
  strength?: number
  numSteps?: number
  width?: number
  height?: number
  guidance?: number
  negativePrompt?: string
}

/**
 * The image request body the reference module sends: SD parameters only exist for SD models, and
 * strength only makes sense while editing an existing image.
 */
export function buildImageBody(input: ImageBodyInput): AiImageRequest {
  const body: AiImageRequest = { model: input.model, prompt: input.prompt }
  if (input.accountId && input.accountId !== AUTO_ACCOUNT) body.accountId = input.accountId
  if (input.mode === 'image-to-image' && input.image) {
    body.image = input.image
    if (isSdModel(input.model) && input.strength !== undefined) body.strength = input.strength
  }
  if (input.numSteps && input.numSteps > 0) body.num_steps = input.numSteps
  if (isSdModel(input.model)) {
    if (input.width) body.width = input.width
    if (input.height) body.height = input.height
    if (input.guidance) body.guidance = input.guidance
    const negative = input.negativePrompt?.trim()
    if (negative) body.negative_prompt = negative
  }
  return body
}

export interface ChatSampling {
  max_tokens: number
  temperature: number
  top_p: number
  presence_penalty: number
  frequency_penalty: number
}

export const CHAT_PARAM_DEFAULTS: ChatSampling = {
  max_tokens: 4096,
  temperature: 1,
  top_p: 1,
  presence_penalty: 0,
  frequency_penalty: 0,
}

export interface ChatBodyInput {
  model: string
  messages: AiChatMessage[]
  params: ChatSampling
  accountId: string
  stream: boolean
}

/** Only max_tokens is always sent; the sampler fields ride along when they differ from the defaults. */
export function buildChatBody(input: ChatBodyInput): AiChatRequest {
  const params = input.params
  const rawTokens = Number.isFinite(params.max_tokens) ? params.max_tokens : CHAT_PARAM_DEFAULTS.max_tokens
  const body: AiChatRequest = {
    model: input.model,
    messages: input.messages,
    max_tokens: Math.min(8192, Math.max(1, Math.round(rawTokens))),
  }
  if (params.temperature !== CHAT_PARAM_DEFAULTS.temperature) body.temperature = params.temperature
  if (params.top_p !== CHAT_PARAM_DEFAULTS.top_p) body.top_p = params.top_p
  if (params.presence_penalty !== CHAT_PARAM_DEFAULTS.presence_penalty) {
    body.presence_penalty = params.presence_penalty
  }
  if (params.frequency_penalty !== CHAT_PARAM_DEFAULTS.frequency_penalty) {
    body.frequency_penalty = params.frequency_penalty
  }
  if (input.stream) body.stream = true
  if (input.accountId && input.accountId !== AUTO_ACCOUNT) body.accountId = input.accountId
  return body
}

export type AudioAdvancedKind = 'enum' | 'number' | 'text'

export interface AudioAdvancedField {
  name: string
  kind: AudioAdvancedKind
  options?: readonly string[]
  defaultValue: string
  min?: number
  max?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Turn a TTS model's JSON schema parameters into the fields the advanced panel draws. */
export function audioAdvancedFields(model: AiModel | null | undefined): AudioAdvancedField[] {
  const params = model?.advanced_params
  if (!params) return []
  const fields: AudioAdvancedField[] = []
  for (const [name, raw] of Object.entries(params)) {
    const definition = asRecord(raw)
    if (!definition) continue
    const enumValues = Array.isArray(definition.enum) ? definition.enum.map(String) : null
    const numeric = definition.type === 'number' || definition.type === 'integer'
    const field: AudioAdvancedField = {
      name,
      kind: enumValues ? 'enum' : numeric ? 'number' : 'text',
      defaultValue: definition.default == null ? '' : String(definition.default),
    }
    if (enumValues) field.options = enumValues
    if (typeof definition.min === 'number') field.min = definition.min
    if (typeof definition.max === 'number') field.max = definition.max
    fields.push(field)
  }
  return fields
}

/** The choices a field offers: a declared enum, or the built-in language list for `lang`. */
export function audioFieldChoices(field: AudioAdvancedField): readonly LanguageOption[] | null {
  if (field.name === 'lang') return AUDIO_LANGUAGE_OPTIONS
  return field.options?.map((value) => ({ label: value, value })) ?? null
}

export function initialAudioValues(fields: readonly AudioAdvancedField[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of fields) values[field.name] = field.defaultValue
  return values
}

export interface AudioBodyInput {
  model: string
  text: string
  voice: string
  accountId: string
  fields: readonly AudioAdvancedField[]
  values: Readonly<Record<string, string>>
}

/** Empty advanced inputs are omitted rather than sent as blank strings. */
export function buildAudioBody(input: AudioBodyInput): AiAudioRequest {
  const body: AiAudioRequest = { model: input.model, input: input.text }
  if (input.voice) body.voice = input.voice
  if (input.accountId && input.accountId !== AUTO_ACCOUNT) body.accountId = input.accountId
  for (const field of input.fields) {
    const raw = input.values[field.name]?.trim()
    if (!raw) continue
    if (field.kind === 'number') {
      const value = Number(raw)
      if (Number.isFinite(value)) body[field.name] = value
      continue
    }
    body[field.name] = raw
  }
  return body
}

export interface TranslateBodyInput {
  model: string
  text: string
  sourceLang: string
  targetLang: string
  accountId: string
}

export function buildTranslateBody(input: TranslateBodyInput): AiTranslateRequest {
  const body: AiTranslateRequest = {
    model: input.model,
    text: input.text,
    target_lang: input.targetLang,
  }
  if (input.sourceLang && input.sourceLang !== AUTO_ACCOUNT) body.source_lang = input.sourceLang
  if (input.accountId && input.accountId !== AUTO_ACCOUNT) body.accountId = input.accountId
  return body
}

export function isIndicTransModel(model: string): boolean {
  return model.includes('indictrans2')
}

/** An SSE error event carries the upstream message; `readChatDelta` deliberately ignores it. */
export function chatStreamError(payload: string): string | null {
  if (payload.trim() === '[DONE]') return null
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed === null || typeof parsed !== 'object' || !('error' in parsed)) return null
    const error = (parsed as { error: unknown }).error
    if (typeof error === 'string') return error
    if (error !== null && typeof error === 'object') {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string') return message
      return JSON.stringify(error)
    }
    return String(error)
  } catch {
    // A malformed payload is not an error event; the delta parser reports it as empty.
    return null
  }
}

/** The server creates sessions with an empty title; a title someone typed is never overwritten. */
export function shouldAutoNameSession(session: Pick<AiChatSession, 'title'> | null): boolean {
  return session !== null && session.title.trim() === ''
}

export function sessionTitleFromAnswer(answer: string, question: string): string {
  const cleaned = answer
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
    .slice(0, 24)
  if (cleaned) return cleaned
  return question.replace(/\s+/g, ' ').trim().slice(0, 20)
}

export function sortChatSessions(sessions: readonly AiChatSession[]): AiChatSession[] {
  return [...sessions].sort((left, right) => (
    right.pinned - left.pinned || right.updated_at - left.updated_at
  ))
}

export function shortModelId(modelId: string): string {
  return modelId.replace(/^@cf\//, '')
}

export function sharePercent(value: number, total: number): string {
  if (!total) return '0.0'
  return ((value / total) * 100).toFixed(1)
}

export type SessionFilterTab = 'all' | 'pinned' | 'favorite'

/** The sidebar filters the loaded rows itself; a session list is small enough to keep in memory. */
export function filterChatSessions(
  sessions: readonly AiChatSession[],
  tab: SessionFilterTab,
  query = '',
): AiChatSession[] {
  const needle = query.trim().toLowerCase()
  return sessions.filter((session) => {
    if (tab === 'pinned' && !session.pinned) return false
    if (tab === 'favorite' && !session.favorite) return false
    return !needle || session.title.toLowerCase().includes(needle)
  })
}

/** A session starts with an empty title because the first answer supplies it later. */
export function sessionDisplayTitle(title: string, fallback: string): string {
  return title.trim() || fallback
}

export const IMAGE_SIZE_PRESETS = [
  { value: '512', label: '512 × 512', width: 512, height: 512 },
  { value: '768', label: '768 × 768', width: 768, height: 768 },
  { value: '1024', label: '1024 × 1024', width: 1024, height: 1024 },
] as const

export type ImageSizePresetValue = (typeof IMAGE_SIZE_PRESETS)[number]['value']
export type ImageSizePreset = (typeof IMAGE_SIZE_PRESETS)[number]

export function resolveImageSize(value: string): ImageSizePreset {
  return IMAGE_SIZE_PRESETS.find((preset) => preset.value === value) ?? IMAGE_SIZE_PRESETS[2]
}

export const TRANSLATE_MODELS = [
  { value: '@cf/meta/m2m100-1.2b', label: 'M2M100 1.2B' },
  { value: '@cf/ai4bharat/indictrans2-en-indic-1B', label: 'IndicTrans2 EN→Indic 1B' },
] as const

export const DEFAULT_TRANSLATE_MODEL = TRANSLATE_MODELS[0].value

/** IndicTrans2 only translates from English; M2M100 accepts an auto-detected source. */
export function translationSourceLanguages(model: string): readonly LanguageOption[] {
  if (isIndicTransModel(model)) return [{ label: 'English', value: 'en' }]
  return M2M100_LANGUAGES
}

export function translationTargetLanguages(model: string): readonly LanguageOption[] {
  return isIndicTransModel(model) ? INDICTRANS2_LANGUAGES : M2M100_LANGUAGES
}

/** The language pair a model starts on, and the pair the swap control restores. */
export function defaultTranslationPair(model: string): { source: string; target: string } {
  return isIndicTransModel(model)
    ? { source: 'en', target: 'hin_Deva' }
    : { source: AUTO_ACCOUNT, target: 'en' }
}
