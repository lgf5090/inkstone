/**
 * Tags and properties, suggested by the assistant and written into the front matter.
 *
 * A note's front matter is the half of it that a reader forgets to maintain: the body gets written and
 * the tags stay empty. Asking the model for a list of tags is cheap, and the answer is checkable — a
 * tag is a word, a property is a key and a scalar — so the model's answer is parsed into a shape this
 * module controls and shown to the reader before anything is written.
 *
 * Nothing is applied silently. A suggestion is a proposal about a note the reader owns, and front
 * matter is where their own conventions live; the confirmation names every change it is about to make.
 */
import { isUsableTagName, parseFrontMatter, setFrontMatterValue } from '@shared/markdown-utils'
import { confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { askAboutNote } from './note-ai'

export interface NoteSuggestion {
  tags: string[]
  properties: Record<string, string>
}

/** How much of a suggestion is worth reading. Past this it is a rewrite of the note, not metadata. */
const MAX_TAGS = 6
const MAX_PROPERTIES = 6
const MAX_KEY = 40
const MAX_VALUE = 200

/** The JSON object inside an answer that was probably wrapped in prose, or in a fence. */
function jsonBody(text: string): string | null {
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/i.exec(text)
  const raw = fenced?.[1] ?? text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  return start === -1 || end <= start ? null : raw.slice(start, end + 1)
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim().replace(/^#/, '').trim()
    if (!isUsableTagName(tag)) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

/**
 * Properties are flat scalars only.
 *
 * A nested object or a list would be a structure the reader did not ask for, and one this module
 * cannot describe in the confirmation sentence — so it is dropped rather than guessed at.
 */
function cleanProperties(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const properties: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(properties).length >= MAX_PROPERTIES) break
    const key = rawKey.trim()
    // `tags` is written by the tag pass, with its own list handling; a second writer would fight it.
    if (!key || key.length > MAX_KEY || /[:#\n\r]/.test(key) || key.toLowerCase() === 'tags') continue
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue
    const text = String(rawValue).trim()
    if (!text || text.length > MAX_VALUE) continue
    properties[key] = text
  }
  return properties
}

/** Read a suggestion out of whatever the model actually answered. */
export function parseNoteSuggestion(text: string): NoteSuggestion | null {
  const body = jsonBody(text)
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const tags = cleanTags(record.tags)
  const properties = cleanProperties(record.properties)
  return tags.length || Object.keys(properties).length ? { tags, properties } : null
}

/** The existing tags of a note, without the leading `#` that a tag-shaped alias may carry. */
function existingTags(content: string): string[] {
  const data = parseFrontMatter(content).data
  const raw = data.tags ?? data.tag
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\uFF0C]/) : []
  return list
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().replace(/^#/, '').trim())
    .filter(Boolean)
}

/**
 * Write a suggestion into the note's front matter.
 *
 * Tags are merged rather than replaced — the note's own tags are not the model's to remove — and the
 * result goes through the same `setFrontMatterValue` the properties panel uses, so a note without
 * front matter gains one instead of quietly ignoring the write.
 */
export function applyNoteSuggestion(noteId: string, suggestion: NoteSuggestion): boolean {
  const state = useNotes.getState()
  const content = state.contents[noteId]
  if (content === undefined) {
    useUi.getState().toast({ title: t('assistant.edit.note_gone'), tone: 'danger' })
    return false
  }
  let next = content
  const known = existingTags(next)
  const added = suggestion.tags.filter((tag) => !known.some((entry) => entry.toLowerCase() === tag.toLowerCase()))
  if (added.length) next = setFrontMatterValue(next, 'tags', [...known, ...added])
  for (const [key, value] of Object.entries(suggestion.properties)) next = setFrontMatterValue(next, key, value)
  if (next === content) return false
  state.editContent(noteId, next)
  return true
}

/** How a proposal reads in the confirmation: every tag and every key it is about to write. */
function describe(suggestion: NoteSuggestion): string {
  const parts: string[] = []
  if (suggestion.tags.length) parts.push(`${t('assistant.suggest.tags')}: ${suggestion.tags.join(', ')}`)
  const properties = Object.entries(suggestion.properties).map(([key, value]) => `${key}: ${value}`)
  if (properties.length) parts.push(`${t('assistant.suggest.properties')}: ${properties.join(', ')}`)
  return parts.join(' · ')
}

/**
 * Ask for suggestions, show them, and write them if the reader agrees.
 *
 * Returns what was applied, so a caller that opened a menu can say whether anything happened.
 */
export async function suggestNoteMeta(noteId: string): Promise<NoteSuggestion | null> {
  const toast = useUi.getState().toast
  const answer = await askAboutNote(noteId, t('assistant.suggest.prompt'))
  if (!answer) return null
  const suggestion = parseNoteSuggestion(answer)
  if (!suggestion) {
    toast({ title: t('assistant.suggest.unreadable'), tone: 'warning' })
    return null
  }
  const accepted = await confirm({
    title: t('assistant.suggest.confirm_title'),
    description: describe(suggestion),
    confirmLabel: t('assistant.suggest.apply'),
  })
  if (!accepted) return null
  if (!applyNoteSuggestion(noteId, suggestion)) {
    toast({ title: t('assistant.suggest.unchanged'), tone: 'warning' })
    return null
  }
  toast({ title: t('assistant.suggest.applied'), tone: 'success' })
  return suggestion
}
