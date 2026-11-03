/**
 * Assembling the assistant's prompt.
 *
 * The worker builds the prompt, not the browser: a reader's own client must not be able to edit the
 * rules that decide what the model may touch. The wording comes from the two prompt catalogs, chosen
 * by the reader's interface language, so a Chinese reader gets a Chinese answer without anyone
 * translating it twice.
 *
 * The prompt is built in two halves, and the split is what makes a vendor's prompt cache worth having.
 * The standing half — identity, personality, rules, the reader's own instructions and the note scope —
 * is the same on every request a conversation makes, so it stays the system message and is the prefix a
 * cache can keep. Everything that describes *this* turn — the clock, the pins, the open note, the
 * memories, the summary, the page the reader is on — changes between turns (the clock changes between
 * minutes), and putting one changing line in the system message invalidated everything after it,
 * including the whole tool block. Those sections now travel as a tail block on the turn's last user
 * message instead. The clock is still stated, and every section keeps the wording that says its
 * contents are data rather than instructions.
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
  /** An Agent may turn the clock off; default is on. */
  timeAware?: boolean
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
  /** The saved skill texts an Agent carries; the arrangement around them is applied elsewhere. */
  skills?: Array<{ title: string, content: string }>
  /** The folder the notebook was filtered to, named as a path. */
  browsingFolder?: string | null
  scheduled?: boolean
  /** This turn resumes an answer that was cut off, so the model is told to pick it up mid-sentence. */
  continuing?: boolean
  /** The reader's own standing instructions, appended after the built-in rules. */
  customInstructions?: string | null
}

/** The two halves a request sends separately: the stable system message and this turn's tail block. */
export interface PromptParts {
  /** The standing instructions. Identical on every request in a conversation, so a cache can keep it. */
  system: string
  /** What describes this one turn; empty when there is nothing to add. */
  turnContext: string
}

/**
 * The standing half: everything that does not change between turns of one conversation.
 *
 * Only these sections are safe in a system message. Anything whose text can move between two requests —
 * a clock reading, a memory list, a summary, an open note — belongs to `turnContext`, because a vendor's
 * prefix cache stops at the first byte that differs.
 */
function systemSections(context: SystemPromptContext): string[] {
  const catalog = promptCatalog(context.language)
  return [
    fill(catalog.identity, { name: context.agentName }),
    catalog.personality,
    `${catalog.rules}\n${context.autoMemory ? catalog.rule_auto_memory : catalog.rule_explicit_memory}`,
    // The reader's own rules come after the built-in ones and before anything about this turn: they are
    // the house style, not a way to grant the assistant powers the rules above withheld.
    context.customInstructions?.trim()
      ? fill(catalog.custom_instructions, { instructions: context.customInstructions.trim() })
      : '',
    context.noteScope.length
      ? fill(catalog.note_scope_folders, { folders: (context.noteScopeLabels?.length ? context.noteScopeLabels : context.noteScope).join(', ') })
      : catalog.note_scope_all,
    // The tag filter is a second narrowing on top of the folder scope, so it only says anything when the
    // reader pinned tags; the note tools enforce the same thing in SQL, and this line is what stops the
    // model from searching for something it was told to ignore.
    context.noteTagLabels?.length
      ? fill(catalog.note_scope_tags, { tags: context.noteTagLabels.join(', ') })
      : '',
    // A scheduled run is decided before its first request and holds for every step of it.
    context.scheduled ? catalog.scheduled_run : '',
  ].filter(Boolean)
}

/**
 * The changing half: what describes this turn and would invalidate a cached prefix if it sat in front.
 *
 * The order is deliberately "what the turn was asked about" after "what it may reach", the same reading
 * the old system prompt had: the scope is a permission and sits in the standing half, while the pins,
 * the open note and the page are what the reader pointed at.
 */
function turnContextSections(context: SystemPromptContext): string[] {
  const catalog = promptCatalog(context.language)
  const line = (memory: PromptMemory) => `- [${memory.category}] ${memory.content}${memory.note ? ` (${memory.note})` : ''}`
  const current = context.memories.filter((memory) => memory.status === 'active')
  const uncertain = context.memories.filter((memory) => memory.status === 'uncertain')
  const past = context.memories.filter((memory) => memory.status === 'historical')
  return [
    catalog.turn_context_header,
    context.timeAware === false ? '' : fill(catalog.clock, { when: context.localTime, timezone: context.timezone }),
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
    context.project
      ? fill(catalog.project_brief, { name: context.project.name, instructions: context.project.instructions })
      : '',
    context.skills?.length
      ? fill(catalog.project_skills, {
        skills: context.skills.map((skill) => `## ${skill.title}\n${skill.content}`).join('\n\n'),
      })
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
    current.length ? fill(catalog.memories_current, { lines: current.map(line).join('\n') }) : '',
    uncertain.length ? fill(catalog.memories_uncertain, { lines: uncertain.map(line).join('\n') }) : '',
    past.length ? fill(catalog.memories_past, { lines: past.map(line).join('\n') }) : '',
    context.conversationSummary ? fill(catalog.summary, { summary: context.conversationSummary }) : '',
    context.continuing ? catalog.continuing : '',
  ].filter(Boolean)
}

/** The prompt as the two halves a request actually sends. */
export function buildPromptParts(context: SystemPromptContext): PromptParts {
  return {
    system: systemSections(context).join('\n\n'),
    turnContext: turnContextSections(context).join('\n\n'),
  }
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
