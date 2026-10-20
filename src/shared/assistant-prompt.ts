/**
 * Assembling the assistant's system prompt.
 *
 * The worker builds the prompt, not the browser: a reader's own client must not be able to edit the
 * rules that decide what the model may touch. The wording comes from the two prompt catalogs, chosen
 * by the reader's interface language, so a Chinese reader gets a Chinese answer without anyone
 * translating it twice.
 */

import type { PromptMemory } from './assistant-memory'
import type { AssistantPromptKey } from './locales/en-US-assistant-prompt'
import { EN_US_ASSISTANT_PROMPT } from './locales/en-US-assistant-prompt'
import { ZH_CN_ASSISTANT_PROMPT } from './locales/zh-CN-assistant-prompt'

export type PromptLanguage = 'en-US' | 'zh-CN'

/** Both catalogs are the same set of keys; the parity test is what keeps that true. */
type PromptCatalog = Record<AssistantPromptKey, string>

const CATALOGS: Record<PromptLanguage, PromptCatalog> = {
  'en-US': EN_US_ASSISTANT_PROMPT,
  'zh-CN': ZH_CN_ASSISTANT_PROMPT,
}

export function promptCatalog(language: PromptLanguage): PromptCatalog {
  return CATALOGS[language] ?? CATALOGS['en-US']
}

/** Only the keys actually supplied are substituted, so a literal `{"json": …}` survives. */
export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match))
}

export interface SystemPromptContext {
  agentName: string
  language: PromptLanguage
  timezone: string
  /** Already rendered in the reader's timezone; the prompt never asks the model to convert. */
  localTime: string
  autoMemory: boolean
  memories: PromptMemory[]
  conversationSummary?: string | null
  noteScope: string[]
  /** Folder names the scope refers to, resolved by the caller for display. */
  noteScopeLabels?: string[]
  /** Note tags the reader pinned to this one turn with `#`. */
  noteTagLabels?: string[]
  /** Notes the reader pinned to this one turn as context chips, resolved to their titles. */
  pinnedNotes?: Array<{ id: string, title: string }>
  /** Tool names the reader pinned to this one turn with `/`. */
  turnTools?: string[]
  /** The note the reader had open when they asked, so "this note" has a referent. */
  openNote?: { id: string, title: string } | null
  /**
   * The draft in the canvas, when the reader has one open.
   *
   * `truncated` says the body was reduced to its head and tail; the prompt tells the model to read the
   * rest with a tool rather than guess at what it cannot see.
   */
  artifact?: { title: string, version: number, content: string, truncated: boolean } | null
  /** The project this conversation belongs to, whose brief and knowledge it inherits. */
  project?: { name: string, instructions: string } | null
  /** The folder the notebook was filtered to, named as a path. */
  browsingFolder?: string | null
  scheduled?: boolean
  /** This turn resumes an answer that was cut off, so the model is told to pick it up mid-sentence. */
  continuing?: boolean
  /** The reader's own standing instructions, appended after the built-in rules. */
  customInstructions?: string | null
}

export function buildSystemPrompt(context: SystemPromptContext): string {
  const catalog = promptCatalog(context.language)
  const sections = [
    fill(catalog.identity, { name: context.agentName }),
    catalog.personality,
    `${catalog.rules}\n${context.autoMemory ? catalog.rule_auto_memory : catalog.rule_explicit_memory}`,
    // The reader's own rules come after the built-in ones and before anything about this turn: they are
    // the house style, not a way to grant the assistant powers the rules above withheld.
    context.customInstructions?.trim()
      ? fill(catalog.custom_instructions, { instructions: context.customInstructions.trim() })
      : '',
    fill(catalog.clock, { when: context.localTime, timezone: context.timezone }),
    context.noteScope.length
      ? fill(catalog.note_scope_folders, { folders: (context.noteScopeLabels?.length ? context.noteScopeLabels : context.noteScope).join(', ') })
      : catalog.note_scope_all,
    // The tag filter is a second narrowing on top of the folder scope, so it only says anything when the
    // reader pinned tags; the note tools enforce the same thing in SQL, and this line is what stops the
    // model from searching for something it was told to ignore.
    context.noteTagLabels?.length
      ? fill(catalog.note_scope_tags, { tags: context.noteTagLabels.join(', ') })
      : '',
    context.turnTools?.length
      ? fill(catalog.turn_tools, { tools: context.turnTools.join(', ') })
      : '',
    // What the reader added by hand, beside the note they had open. A pinned note is readable for this
    // turn, which is the one thing a chip promises that the folder scope cannot — so it is named here
    // rather than left for the model to discover with a search that the scope would have filtered out.
    context.pinnedNotes?.length
      ? fill(catalog.note_pinned, {
        notes: context.pinnedNotes.map((note) => `"${note.title}" (id ${note.id})`).join(', '),
      })
      : '',
    // What the reader had on screen. It sits after the scope lines on purpose: the scope is what the
    // turn is *allowed* to reach, and this is what it was *asked* about, so the permission reads first.
    context.project
      ? fill(catalog.project_brief, { name: context.project.name, instructions: context.project.instructions })
      : '',
    context.artifact
      ? [
        fill(catalog.canvas_draft, {
          title: context.artifact.title || catalog.canvas_untitled,
          version: context.artifact.version,
          // A draft may contain the tag's own closing form in a code block. Escaping it keeps the data
          // inside the fence the prompt says it is in, rather than letting text close the wrapper.
          content: context.artifact.content.replace(/<\/draft>/gi, '<\\/draft>'),
        }),
        context.artifact.truncated ? catalog.canvas_draft_truncated : '',
      ].filter(Boolean).join('\n')
      : '',
    context.openNote
      ? fill(catalog.open_note, { title: context.openNote.title, id: context.openNote.id })
      : '',
    context.browsingFolder
      ? fill(catalog.browsing_folder, { folder: context.browsingFolder })
      : '',
  ].filter(Boolean)

  const line = (memory: PromptMemory) => `- [${memory.category}] ${memory.content}${memory.note ? ` (${memory.note})` : ''}`
  const current = context.memories.filter((memory) => memory.status === 'active')
  const uncertain = context.memories.filter((memory) => memory.status === 'uncertain')
  const past = context.memories.filter((memory) => memory.status === 'historical')
  if (current.length) {
    sections.push(fill(catalog.memories_current, { lines: current.map(line).join('\n') }))
  }
  if (uncertain.length) {
    sections.push(fill(catalog.memories_uncertain, { lines: uncertain.map(line).join('\n') }))
  }
  if (past.length) {
    sections.push(fill(catalog.memories_past, { lines: past.map(line).join('\n') }))
  }
  if (context.conversationSummary) {
    sections.push(fill(catalog.summary, { summary: context.conversationSummary }))
  }
  if (context.scheduled) sections.push(catalog.scheduled_run)
  if (context.continuing) sections.push(catalog.continuing)
  return sections.join('\n\n')
}

export const SUMMARIZER_SYSTEM_PROMPT_LIMIT = 2_000

export function summarizerPrompt(language: PromptLanguage, previous: string | null, transcript: string): string {
  return fill(promptCatalog(language).summarizer_user, { previous: previous || '(none)', transcript })
}

export function conflictCheckPrompt(language: PromptLanguage, older: string, newer: string): string {
  return fill(promptCatalog(language).conflict_user, {
    older: JSON.stringify(older.slice(0, 500)),
    newer: JSON.stringify(newer.slice(0, 500)),
  })
}

/**
 * The naming pass: one cheap call that turns a conversation's first exchange into a title and three
 * follow-up questions.
 *
 * Both halves arrive from one request, because the two are the same act of reading — "what is this thread
 * about, and what would the reader want to ask next" — and paying for a second call to split them would burn
 * the reader's key for nothing. The prompt asks for bare JSON, the same way the conflict judge does, so a
 * vendor that honours the `structured` field returns an object and one that ignores it returns an object in
 * prose the caller can still brace-match. The question and answer are bounded here: the naming pass has no
 * business reading a forty-thousand-character reply, and what it needs to name a thread fits in a few hundred.
 */
export function namingPrompt(language: PromptLanguage, question: string, answer: string): { system: string, user: string } {
  const catalog = promptCatalog(language)
  return {
    system: catalog.naming_system,
    user: fill(catalog.naming_user, {
      question: question.slice(0, 1_000),
      answer: answer.slice(0, 2_000),
    }),
  }
}

export function offlineAnswer(language: PromptLanguage, echo: string): string {
  return fill(promptCatalog(language).offline_answer, { echo })
}
