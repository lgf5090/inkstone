/**
 * Session import: a chat log exported somewhere else, read in as threads of this account.
 *
 * This is a different input from the backup restore in `backup.ts`, and only in one way: the file was not
 * written by this app. A backup's rows are known column for known column, so that module can merge by id
 * and say nothing more. Here the reader hands over a ChatGPT or Claude export, a JSONL dump, or a Markdown
 * transcript somebody pasted out of a browser, and the only honest promise about the shape is the one this
 * module keeps — read what can be read, say what could not, and never invent a turn.
 *
 * The rules it borrows from the backup are the ones that still hold when the input is a stranger's file:
 *
 * — nothing is deleted: an import adds a thread and that thread's messages, and rewrites nothing;
 * — a record already in the account is never replaced by a copy out of a file, so a thread the reader
 * edited after importing it stays edited;
 * — every row goes through `importRows`, i.e. `INSERT OR IGNORE` in chunked batches, so a second pass over
 * the same file continues rather than doubling, and one chunk is one D1 transaction;
 * — a reference the account does not own is dropped and said out loud, never kept and hoped for.
 *
 * What the file is *not* allowed to do is choose the ids. A log carrying another deployment's row ids
 * cannot install them here: every write is user-scoped, so a stranger id would either collide with a row
 * that is already this reader's or be the one thing a repeat import could not recognise. Threads and
 * messages are keyed by a fingerprint of their own content instead — see {@link fingerprintId}.
 */

import { MAX_CHAT_ATTACHMENTS, MAX_CONVERSATION_TITLE_CHARS, titleFromMessage } from '@shared/assistant'
import { utf8ByteLength } from '@shared/text-utils'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import type { AssistantStore } from './store'

/**
 * The most file text one import reads.
 *
 * The number the backup restore accepts, for the same reason: this is a Worker with a request-size budget,
 * and a log past it is a file the reader splits rather than one the app quietly truncates. The client is
 * told the number so it can refuse before uploading, but the check here is the one that counts — a browser
 * is not a trust boundary.
 */
export const MAX_SESSION_FILE_BYTES = 4 * 1024 * 1024

/**
 * The JSON body that has to hold {@link MAX_SESSION_FILE_BYTES} of text.
 *
 * The file is posted as `{ filename, text }`, the shape the backup import already uses, and the worst case
 * for one byte of text inside a JSON string is six bytes of escaping (a control character). A smaller
 * ceiling would refuse a file whose text is inside its own limit, which is the one failure this bound must
 * not have.
 */
export const SESSION_IMPORT_BODY_BYTES = MAX_SESSION_FILE_BYTES * 6 + 64 * 1024

/** How many threads one file may bring in, and how many turns a thread, or a whole file, may hold. */
export const MAX_SESSION_THREADS = 50
export const MAX_SESSION_MESSAGES = 2_000
export const MAX_SESSION_IMPORT_MESSAGES = 5_000

/**
 * The most text one imported turn may hold.
 *
 * Not the composer's `MAX_MESSAGE_CHARS`: that bounds what a reader may type into this app, and an answer
 * written somewhere else two years ago was never subject to it. This is the ceiling the backup restore puts
 * on a stored message's content, so the two ways a foreign transcript reaches a row agree.
 */
export const MAX_SESSION_MESSAGE_CHARS = 200_000

/** Lines and records a parse will look at: both are CPU, and CPU is what a big file runs out of. */
const MAX_SESSION_LINES = 50_000
const MAX_SESSION_RECORDS = 20_000
const MAX_JSON_DEPTH = 8

/** One turn as it came out of the file, before this account is asked anything about it. */
interface SessionTurn {
  role: 'user' | 'assistant'
  content: string
  /** When the file says the turn happened, already clamped to the past; null when it says nothing. */
  createdAt: number | null
  /** Ids the file names as that turn's files — each still to be proved to be this account's. */
  attachments: string[]
}

/** One conversation as it came out of the file. */
interface SessionThread {
  title: string
  turns: SessionTurn[]
  noteId: string | null
  folderId: string | null
}

/** What one import did, and every reason anything in the file did not come along. */
export interface SessionImportSummary {
  threads: number
  messages: number
  alreadyImported: number
  skipped: string[]
}

/**
 * Words a log uses for the two ends of a conversation.
 *
 * Lower-cased and trimmed before the lookup. Vendor names are here because an export labels the model with
 * them, and a reader does not care that Claude wrote the answer rather than an assistant.
 */
const ROLE_BY_WORD: Record<string, 'user' | 'assistant'> = {
  user: 'user',
  human: 'user',
  you: 'user',
  prompt: 'user',
  question: 'user',
  q: 'user',
  input: 'user',
  y: 'user',
  assistant: 'assistant',
  ai: 'assistant',
  gpt: 'assistant',
  chatgpt: 'assistant',
  claude: 'assistant',
  model: 'assistant',
  bot: 'assistant',
  inkstone: 'assistant',
  answer: 'assistant',
  output: 'assistant',
  a: 'assistant',
}

/**
 * Roles a log can carry that this app has nowhere to put.
 *
 * The column's own CHECK allows `user` and `assistant` and nothing else, so a system prompt or a tool
 * result cannot be stored even in principle. They are counted and named rather than skipped in silence: a
 * reader whose log had a persona block and three tool calls has to be told that the thread they got is not
 * the whole thread they exported.
 */
const DISCARDED_ROLES = new Set(['system', 'developer', 'tool', 'function', 'critic', 'research', 'commentary'])

/** Where a speaker word may be hiding in a record, in the order the exporters write it. */
const SPEAKER_KEYS = ['role', 'sender', 'speaker', 'from', 'author', 'role_type', 'message'] as const
/** Where the text of a turn may be hiding. */
const TEXT_KEYS = ['content', 'text', 'value', 'message', 'prompt', 'completion', 'output', 'text_content', 'message_content'] as const
/** Where a timestamp may be hiding. */
const TIME_KEYS = ['created_at', 'create_time', 'timestamp', 'time', 'date', 'createdAt'] as const
/** A record holding many conversations rather than one. */
const THREAD_LIST_KEYS = ['conversations', 'chats', 'threads'] as const
/** The lists inside a conversation record that hold its turns. */
const TURN_LIST_KEYS = ['messages', 'chat_messages', 'chat_log', 'turns', 'interaction_log', 'items', 'log'] as const
/** Nested single objects worth one more level of looking. */
const WRAPPER_KEYS = ['message', 'data', 'payload', 'turn', 'request'] as const
/** The fields of a conversation record that point at this notebook's objects. */
const NOTE_KEYS = ['note_id', 'noteId'] as const
const FOLDER_KEYS = ['folder_id', 'folderId'] as const

/**
 * Everything one parse decided that the reader should hear about.
 *
 * Counted rather than thrown: a file with three junk lines out of four hundred is a file worth importing,
 * and the only acceptable outcome for a line that could not be read is a line in the report about it.
 */
interface Sink {
  readonly threads: SessionThread[]
  /** Turns read off records that named no conversation: one thread's worth, in the file's own order. */
  readonly looseTurns: SessionTurn[]
  /** Why a turn did not become a message, tallied by kind. */
  readonly counts: Record<string, number>
  /** The role words that were not recognised, kept so the report names them instead of a bare count. */
  readonly roles: Set<string>
  /** Line numbers that were not JSON, kept for the first few only — a report is not a file dump. */
  readonly badLines: number[]
  /** How much of the file has been looked at, against {@link MAX_SESSION_RECORDS}. */
  records: number
  stopped: boolean
}

function newSink(): Sink {
  return { threads: [], looseTurns: [], counts: {}, roles: new Set(), badLines: [], records: 0, stopped: false }
}

function add(sink: Sink, key: string, amount = 1): void {
  if (amount <= 0) return
  sink.counts[key] = (sink.counts[key] ?? 0) + amount
}

/** Out of the record budget: the parse stops and says it did, rather than running into the CPU wall. */
function outOfBudget(sink: Sink): boolean {
  if (sink.records < MAX_SESSION_RECORDS) return false
  sink.stopped = true
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** One role word off one field: a bare string, or the `role`/`name` of the object the field holds. */
function wordOf(value: unknown): string | null {
  const direct = stringOf(value)
  if (direct) return direct.toLowerCase()
  if (isRecord(value)) {
    const role = stringOf(value.role)
    if (role) return role.toLowerCase()
    const name = stringOf(value.name)
    if (name) return name.toLowerCase()
  }
  return null
}

/**
 * Who said this turn, or null when the record does not say.
 *
 * Two levels deep, because the shapes differ: `{role, content}` is the flat log and
 * `{message: {author: {role}}}` is ChatGPT's. Deeper would be guessing at a shape nobody exports.
 */
function speakerWord(record: Record<string, unknown>, sink: Sink, depth = 0): string | null {
  for (const key of SPEAKER_KEYS) {
    const word = wordOf(record[key])
    // `message` is both a speaker key and a text key: as a speaker it has to hold a role, not prose.
    if (word && (key !== 'message' || ROLE_BY_WORD[word] || DISCARDED_ROLES.has(word))) return word
  }
  if (depth < 1) {
    for (const key of WRAPPER_KEYS) {
      if (!isRecord(record[key])) continue
      const word = speakerWord(record[key] as Record<string, unknown>, sink, depth + 1)
      if (word) return word
    }
  }
  add(sink, 'noSpeaker')
  return null
}

/**
 * The text a value holds, flattened.
 *
 * Content parts are joined rather than picked from: an answer exported as
 * `[{type:'text'}, {type:'text'}]` is one answer with two paragraphs. A part that carries no text is an
 * image or a file, and there are no bytes to store for it here — so it is counted, not folded away.
 */
function textOf(value: unknown, sink: Sink, depth = 0): string {
  if (depth > MAX_JSON_DEPTH || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map((item) => textOf(item, sink, depth + 1))
    const kept = parts.filter((part) => part.trim() !== '')
    add(sink, 'mediaParts', parts.length - kept.length)
    return kept.join('\n\n')
  }
  if (isRecord(value)) {
    // A typed content part says what it is: only the text ones carry anything this table can hold.
    const type = stringOf(value.type)
    if (type && !['text', 'output_text', 'input_text'].includes(type.toLowerCase())) return ''
    for (const key of ['text', 'content', 'parts', 'value', 'message']) {
      if (value[key] === undefined) continue
      const inner = textOf(value[key], sink, depth + 1)
      if (inner.trim()) return inner
    }
  }
  return ''
}

/** The text of one turn, looked for in the same two levels the speaker is looked for in. */
function turnText(record: Record<string, unknown>, sink: Sink, depth = 0): string {
  for (const key of TEXT_KEYS) {
    if (record[key] === undefined) continue
    const text = textOf(record[key], sink, depth + 1)
    if (text.trim()) return text
  }
  if (depth < 1) {
    for (const key of WRAPPER_KEYS) {
      if (!isRecord(record[key])) continue
      const text = turnText(record[key] as Record<string, unknown>, sink, depth + 1)
      if (text.trim()) return text
    }
  }
  return ''
}

/**
 * When the file says this turn happened.
 *
 * Seconds, milliseconds, or a date string — all three are what real exports write. Clamped to no later
 * than now: a thread whose last turn is dated a year ahead would sit at the top of the list forever, and a
 * timestamp out of a file is not a promise about this clock. `null` rather than the import time, so the
 * caller can still tell "the file said nothing" from "the file said this".
 */
function turnTime(record: Record<string, unknown>, depth = 0): number | null {
  for (const key of TIME_KEYS) {
    const value = record[key]
    let numeric: number | null = null
    if (typeof value === 'number' && Number.isFinite(value)) numeric = value
    else if (typeof value === 'string') {
      // ChatGPT writes `"2024-01-05T09:00:00.000Z"`; an all-digit string is an epoch either way.
      numeric = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value)
    }
    if (numeric === null || !Number.isFinite(numeric) || numeric <= 0) continue
    const millis = numeric < 100_000_000_000 ? numeric * 1000 : numeric
    return Math.min(millis, Date.now())
  }
  if (depth < 1) {
    for (const key of WRAPPER_KEYS) {
      if (!isRecord(record[key])) continue
      const at = turnTime(record[key] as Record<string, unknown>, depth + 1)
      if (at !== null) return at
    }
  }
  return null
}

/**
 * The ids a turn names as its files.
 *
 * Only the shape is judged here, by the rule every other route uses (`isValidId`): a ChatGPT attachment is
 * a UUID, which cannot be one of this account's rows, so it is counted as a refused reference rather than
 * carried into a chip that would never open. Whether a well-shaped id belongs to *this* reader is the
 * account's question, asked once later.
 */
function turnAttachments(record: Record<string, unknown>, sink: Sink): string[] {
  const raw = record.attachments ?? record.files
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  const ids: string[] = []
  for (const entry of list) {
    const value = isRecord(entry) ? entry.id ?? entry.file_id ?? entry.fileId : entry
    const id = stringOf(value)
    if (!id || !isValidId(id)) {
      // A UUID, a path, a name: nothing this account's rows can be addressed by.
      add(sink, 'foreignRefs')
      continue
    }
    ids.push(id)
  }
  if (ids.length > MAX_CHAT_ATTACHMENTS) {
    add(sink, 'attachmentCap', ids.length - MAX_CHAT_ATTACHMENTS)
    return ids.slice(0, MAX_CHAT_ATTACHMENTS)
  }
  return ids
}

/** One reference field of a record, refused by shape for the same reason a turn's attachment is. */
function refId(record: Record<string, unknown>, keys: readonly string[], sink: Sink): string | null {
  for (const key of keys) {
    const id = stringOf(record[key])
    if (!id) continue
    if (!isValidId(id)) {
      add(sink, 'foreignRefs')
      return null
    }
    return id
  }
  return null
}

/**
 * A reference read off a conversation and, only when it is a different object, off the record holding it.
 *
 * The nested `conversation` object of this app's own export and the export's top level are the same record
 * for every other shape, and asking the twice-told question of one object would report one bad id twice.
 */
function refFrom(own: Record<string, unknown>, record: Record<string, unknown>, keys: readonly string[], sink: Sink): string | null {
  const found = refId(own, keys, sink)
  if (found || own === record) return found
  return refId(record, keys, sink)
}

/** The first thing that reads as a title, or nothing — an untitled thread is a state, not a failure. */
function threadTitle(record: Record<string, unknown>): string {
  for (const key of ['title', 'name', 'summary'] as const) {
    const title = stringOf(record[key])
    if (title) return title
  }
  return ''
}

/**
 * One turn off one record, or null with the reason already tallied.
 *
 * A record with a role and no text is skipped rather than stored as an empty bubble: a transcript of a turn
 * that said nothing misdescribes the exchange, and the reader hears about it either way.
 */
function readTurn(record: Record<string, unknown>, sink: Sink): SessionTurn | null {
  if (outOfBudget(sink)) return null
  sink.records++
  const word = speakerWord(record, sink)
  if (!word) return null
  const role = ROLE_BY_WORD[word]
  if (!role) {
    if (!DISCARDED_ROLES.has(word)) sink.roles.add(word)
    add(sink, DISCARDED_ROLES.has(word) ? 'discardedRole' : 'unknownRole')
    return null
  }
  const content = turnText(record, sink).trim()
  if (!content) {
    add(sink, 'emptyContent')
    return null
  }
  return { role, content, createdAt: turnTime(record), attachments: turnAttachments(record, sink) }
}

/** A record that names a whole conversation rather than one turn. */
function isConversationRecord(record: Record<string, unknown>): boolean {
  if (record.mapping !== undefined) return true
  if (isRecord(record.conversation)) return true
  return TURN_LIST_KEYS.some((key) => Array.isArray(record[key]))
}

/**
 * The turns of a conversation record, in reading order.
 *
 * `mapping` is ChatGPT's tree: nodes keyed by id, each pointing at its parent and its children, walked
 * parents to children so the transcript reads in the order it was had. Where a node branches — a reply the
 * model regenerated — the branch kept is the last child, the one the conversation went on from in the
 * export's own order, and every sibling left out is counted: two branches stitched into one thread would be
 * a conversation that never happened.
 */
function collectTurns(record: Record<string, unknown>, sink: Sink, depth: number): SessionTurn[] {
  if (record.mapping !== undefined) {
    const walked = walkMapping(record.mapping, sink)
    if (walked.length) return walked
  }
  let sawTurnList = false
  for (const key of TURN_LIST_KEYS) {
    const list = record[key]
    if (!Array.isArray(list)) continue
    sawTurnList = true
    const turns: SessionTurn[] = []
    for (const item of list) {
      if (outOfBudget(sink)) break
      if (!isRecord(item)) {
        add(sink, 'unusableRecords')
        continue
      }
      const turn = readTurn(item, sink)
      if (turn) {
        turns.push(turn)
        continue
      }
      // A nested conversation inside a turn list: a log that groups its own sub-threads.
      if (depth < MAX_JSON_DEPTH && isConversationRecord(item)) turns.push(...collectTurns(item, sink, depth + 1))
    }
    if (turns.length) return turns
  }
  // Nothing grouped its turns, so the record may be one turn itself. A record that did carry an (empty)
  // turn list is an empty conversation, not a turn, and `threadFromRecord` says so once.
  if (sawTurnList) return []
  const own = readTurn(record, sink)
  return own ? [own] : []
}

/** A ChatGPT `mapping`, walked into the order the conversation was had. */
function walkMapping(mapping: unknown, sink: Sink): SessionTurn[] {
  const nodes = Array.isArray(mapping) ? mapping : isRecord(mapping) ? Object.values(mapping) : []
  const byId = new Map<string, Record<string, unknown>>()
  for (const [index, node] of nodes.entries()) {
    if (outOfBudget(sink)) break
    if (!isRecord(node)) {
      add(sink, 'unusableRecords')
      continue
    }
    byId.set(stringOf(node.id) ?? `node-${index}`, node)
  }
  // Two passes: a child may be listed before the parent it points at, so the ids have to all be known
  // before anything can tell a root from a branch.
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const [id, node] of byId) {
    const parent = stringOf(node.parent ?? node.parent_id)
    if (!parent || parent === 'root' || !byId.has(parent)) roots.push(id)
    else children.set(parent, [...(children.get(parent) ?? []), id])
  }
  if (!roots.length && byId.size) roots.push([...byId.keys()][0]!)
  const seen = new Set<string>()
  const turns: SessionTurn[] = []
  for (const root of roots) {
    let id: string | undefined = root
    while (id && !seen.has(id) && !outOfBudget(sink)) {
      seen.add(id)
      const node = byId.get(id)
      if (node) {
        const turn = readTurn(node, sink)
        if (turn) turns.push(turn)
      }
      // Annotated because the loop's own narrowing feeds `children.get(id)` and `id` feeds back off it:
      // without the type the inference runs in a circle and the compiler gives up on `branches`.
      const branches: string[] = children.get(id) ?? []
      add(sink, 'forkedBranches', branches.length - 1)
      id = branches[branches.length - 1]
    }
  }
  // Nodes that never appeared under any root: a mapping whose parent links point at nothing in this file.
  add(sink, 'unreachableNodes', [...byId.keys()].filter((candidate) => !seen.has(candidate)).length)
  return turns
}

/** One conversation record into one thread, when it holds turns worth holding. */
function threadFromRecord(record: Record<string, unknown>, sink: Sink, depth: number): void {
  if (outOfBudget(sink)) return
  const turns = collectTurns(record, sink, depth)
  if (turns.length) {
    const own = isRecord(record.conversation) ? record.conversation : record
    sink.threads.push({
      title: threadTitle(own) || threadTitle(record),
      turns,
      noteId: refFrom(own, record, NOTE_KEYS, sink),
      folderId: refFrom(own, record, FOLDER_KEYS, sink),
    })
    return
  }
  // A turn-shaped record that failed has already been tallied by `readTurn`; only a conversation that came
  // back with nothing to show for it is counted here.
  if (isConversationRecord(record)) add(sink, 'emptyThreads')
}

/**
 * Everything readable in one parsed JSON value.
 *
 * An array whose members are turns is one conversation; an array whose members name conversations is many.
 * A record holding a list of conversations is recursed into that list rather than treated as one. The order
 * is the order the exporters actually write, and a shape nothing matches is tallied, not guessed at.
 */
function readValue(value: unknown, sink: Sink, depth = 0): void {
  if (outOfBudget(sink)) return
  if (depth > MAX_JSON_DEPTH) {
    add(sink, 'tooDeep')
    return
  }
  if (Array.isArray(value)) {
    const conversations: Record<string, unknown>[] = []
    for (const item of value) {
      if (outOfBudget(sink)) break
      if (!isRecord(item)) {
        add(sink, 'unusableRecords')
        continue
      }
      if (isConversationRecord(item)) {
        conversations.push(item)
        continue
      }
      // A flat transcript: turns that name no conversation belong to the one thread this file is.
      const turn = readTurn(item, sink)
      if (turn) sink.looseTurns.push(turn)
    }
    for (const item of conversations) {
      if (outOfBudget(sink)) break
      threadFromRecord(item, sink, depth + 1)
    }
    return
  }
  if (!isRecord(value)) {
    add(sink, 'unusableRecords')
    return
  }
  for (const key of THREAD_LIST_KEYS) {
    const list = value[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (outOfBudget(sink)) break
      if (isRecord(item)) threadFromRecord(item, sink, depth + 1)
      else add(sink, 'unusableRecords')
    }
    return
  }
  threadFromRecord(value, sink, depth)
}

/**
 * A transcript written as Markdown or as plain text.
 *
 * One thread, unless the file opens a `#`/`##` heading between speaker labels — then each such heading
 * starts a thread, which is how a "save the whole chat" Markdown export arrives. A speaker label is a line
 * naming one and then saying something, in either the plain shape (`You: hello`), the inline Markdown shape
 * (`**Assistant:** hello`) or the heading shape ChatGPT writes (`### **User**`), with the full-width colon
 * a Chinese-language interface uses. The labels are Latin words plus a handful of Han ones spelled as
 * escapes: the i18n gate keeps every string under `src/worker` ASCII, and these are data the parser matches
 * against the reader's file, not copy this app renders. A file with no labels at all is not a conversation,
 * and is refused as one rather than imported as an empty thread.
 */
const LATIN_LABELS = ['user', 'human', 'you', 'assistant', 'ai', 'chatgpt', 'claude', 'model', 'bot', 'prompt', 'question', 'system', 'tool']
/** The speaker words a Chinese-language log uses, as escapes for the reason named above. */
const HAN_LABELS: Readonly<Record<string, 'user' | 'assistant'>> = {
  '\u7528\u6237': 'user', // user
  '\u63d0\u95ee': 'user', // question
  '\u63d0\u793a': 'user', // prompt
  '\u6211': 'user', // "I"
  '\u52a9\u624b': 'assistant', // assistant
  '\u6a21\u578b': 'assistant', // model
  '\u7cfb\u7edf': 'assistant', // system: matched, then refused as a role that cannot be stored
}
/**
 * The labels a line of text is allowed to be split on.
 *
 * Not simply every key of `ROLE_BY_WORD`: a transcript's own prose contains lines like `Output: the part
 * that matters`, and a label that splits an answer in two is worse than one that fails to recognise a
 * single-letter abbreviation. The words here are the ones a chat log is actually headed with, plus the
 * discarded ones so a `System:` line is reported as a role that cannot be stored rather than as a mystery.
 */
const ALL_LABELS = [...Object.keys(HAN_LABELS), ...LATIN_LABELS, 'q', 'a', 'y', ...DISCARDED_ROLES].join('|')
const EMPHASIS = '(?:\\*\\*|__|\\*|_)?'
/**
 * `**You:** hello`, `You: hello`, `### Assistant: hello`.
 *
 * The emphasis marker is allowed on either side of the colon, because both shapes are written: a ChatGPT
 * log bolds the label (`**You:**`), a pasted one bolds the whole phrase (`**You: hello**`).
 */
const LABEL_LINE = new RegExp(
  `^\\s{0,3}(?:[-*+]\\s+)?#{0,6}\\s*${EMPHASIS}\\s*(${ALL_LABELS})\\s*${EMPHASIS}\\s*[:\\uFF1A]\\s*${EMPHASIS}\\s*(.*)$`,
  'i',
)
/** `### **User**` — a label on a line of its own, with no colon to hang the text on. */
const LABEL_HEADING = new RegExp(`^\\s{0,3}#{1,6}\\s*${EMPHASIS}\\s*(${ALL_LABELS})\\s*${EMPHASIS}\\s*[:\\uFF1A]?$`, 'i')
/** A thread divider: a top-level or section heading that is not a label. */
const SECTION_HEADING = /^\s{0,3}#{1,2}\s+(.+)$/
/** Deeper headings between turns carry a timestamp or a client decoration, not something anybody said. */
const DEEP_HEADING = /^\s{0,3}#{3,6}\s+\S/

function labelRole(word: string): 'user' | 'assistant' | null {
  return HAN_LABELS[word] ?? ROLE_BY_WORD[word] ?? null
}

function parseTranscript(text: string, sink: Sink): SessionThread[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > MAX_SESSION_LINES) {
    add(sink, 'lineCap', lines.length - MAX_SESSION_LINES)
    lines.length = MAX_SESSION_LINES
    sink.stopped = true
  }
  const threads: SessionThread[] = []
  let current: SessionThread | null = null
  let turn: SessionTurn | null = null
  const closeTurn = () => {
    if (turn && current) {
      const content = turn.content.trim()
      if (content) current.turns.push({ ...turn, content })
      else add(sink, 'emptyContent')
    }
    turn = null
  }
  const flush = () => {
    if (current && current.turns.length) threads.push(current)
    current = null
  }

  for (const line of lines) {
    if (outOfBudget(sink)) break
    const inline = LABEL_LINE.exec(line)
    const heading = inline ? null : LABEL_HEADING.exec(line)
    if (inline || heading) {
      closeTurn()
      const word = ((inline ?? heading)![1] ?? '').trim().toLowerCase()
      const role = labelRole(word)
      if (!role) {
        if (!DISCARDED_ROLES.has(word)) sink.roles.add(word)
        add(sink, DISCARDED_ROLES.has(word) ? 'discardedRole' : 'unknownRole')
        continue
      }
      if (!current) current = { title: '', turns: [], noteId: null, folderId: null }
      turn = { role, content: inline ? (inline[2] ?? '') : '', createdAt: null, attachments: [] }
      sink.records++
      continue
    }
    if (DEEP_HEADING.test(line)) {
      // `##### **Mar 21, 2025, 8:15 am**` is the exporter's own decoration; it is reported, not folded
      // into the answer above it, which would read as something the model said.
      add(sink, 'metaHeadings')
      continue
    }
    const section = !turn ? SECTION_HEADING.exec(line) : null
    if (section) {
      flush()
      current = { title: (section[1] ?? '').trim().slice(0, MAX_CONVERSATION_TITLE_CHARS), turns: [], noteId: null, folderId: null }
      continue
    }
    if (!turn) {
      if (line.trim()) add(sink, 'strayLines')
      continue
    }
    turn.content = `${turn.content}\n${line}`
  }
  closeTurn()
  flush()
  return threads
}

/**
 * A JSONL read: one JSON value per line, junk lines counted and named.
 *
 * `conversations.jsonl` is one conversation per line, `messages.jsonl` is one turn per line, and a real
 * JSON file written with a trailing newline is neither. All three are answered by the same loop, and a line
 * that does not parse is tallied with its number rather than ending the import: a truncated download still
 * holds most of a transcript, and the reader can be told which part came in.
 */
function readLines(text: string, sink: Sink): unknown[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > MAX_SESSION_LINES) {
    add(sink, 'lineCap', lines.length - MAX_SESSION_LINES)
    lines.length = MAX_SESSION_LINES
    sink.stopped = true
  }
  const values: unknown[] = []
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || outOfBudget(sink)) return
    try {
      values.push(JSON.parse(trimmed))
    } catch {
      add(sink, 'badLines')
      if (sink.badLines.length < 5) sink.badLines.push(index + 1)
    }
  })
  return values
}

/** What one file parsed into, plus everything the reader has to be told about what did not parse. */
export interface ParsedSession {
  threads: SessionThread[]
  skipped: string[]
}

/**
 * Read a foreign transcript into threads and turns.
 *
 * No account is consulted here: the parse is a question about the file's shape. The ownership questions
 * come later, once the shape is known. Each shape is tried against a fresh tally, so a file that turns out
 * not to be JSON reports what the Markdown read found and not the JSON read's complaints about it.
 */
export function parseSessionFile(filename: string, text: string): ParsedSession {
  const body = text.replace(/^\uFEFF/, '')
  if (!body.trim()) throw ApiError.badRequest('That file has nothing in it.')

  const looksJson = /^[[{]/.test(body.trimStart())
  const namedJsonl = /\.(?:jsonl|ndjson)$/i.test(filename)
  const firstLine = body.split(/\r?\n/).find((line) => line.trim() !== '')?.trimStart() ?? ''
  const linesLookJson = /^[[{]/.test(firstLine)

  /** One reading of the file into a tally of its own. */
  const read = (shape: (sink: Sink) => void): Sink => {
    const sink = newSink()
    shape(sink)
    return sink
  }
  const wholeJson = (sink: Sink) => {
    try {
      readValue(JSON.parse(body), sink)
    } catch {
      // Not a JSON document. The next shape is the line-by-line read, and a Markdown file whose first line
      // happens to open with a brace lands there too.
    }
  }
  const lineJson = (sink: Sink) => {
    for (const value of readLines(body, sink)) {
      // One line per turn is the `messages.jsonl` shape, and it is one conversation rather than one
      // conversation per line: the reading has to be the file's, not the parser's convenience. A record
      // that carries no turn list and no mapping can only ever be a turn, so it is not handed to the
      // generic reader a second time — that would tally the same failure twice.
      if (isRecord(value) && !isConversationRecord(value)) {
        const turn = readTurn(value, sink)
        if (turn) sink.looseTurns.push(turn)
        continue
      }
      readValue(value, sink)
    }
  }
  const transcript = (sink: Sink) => {
    for (const thread of parseTranscript(body, sink)) sink.threads.push(thread)
  }

  // Each shape is tried against a fresh tally, so a file that turns out not to be JSON reports what the
  // Markdown read found and not the JSON read's complaints about the same bytes. A file whose *first line*
  // opens with a brace is treated as JSONL until proved otherwise, because that is what a log written one
  // record per line looks like and what a whole document does not.
  const jsonish = looksJson || linesLookJson
  const shapes = jsonish && !namedJsonl ? [wholeJson, lineJson, transcript] : [lineJson, wholeJson, transcript]
  let sink = read(shapes[0]!)
  for (const shape of shapes.slice(1)) {
    if (sink.threads.length || sink.looseTurns.length) break
    sink = read(shape)
  }

  // Turns that named no conversation are a thread of their own: a flat log of a chat, titled later from
  // what the reader first asked.
  if (sink.looseTurns.length) {
    sink.threads.push({ title: '', turns: sink.looseTurns, noteId: null, folderId: null })
  }
  const skipped = describeSkips(sink)
  const threads = sink.threads.filter((thread) => thread.turns.length)
  if (!threads.length) {
    // Nothing in any shape carried a turn. The one answer that is not a partial success: the reader is told
    // why in the parse's own words rather than being handed an empty thread to wonder about.
    throw ApiError.badRequest(`No conversation could be read from that file.${skipped.length ? ` ${skipped.join(' ')}` : ''}`)
  }
  if (threads.length > MAX_SESSION_THREADS) {
    skipped.push(`The file holds ${threads.length} conversations and one import reads ${MAX_SESSION_THREADS} threads: ${threads.length - MAX_SESSION_THREADS} were left out.`)
  }
  return { threads: threads.slice(0, MAX_SESSION_THREADS), skipped }
}

/** Every tally this parse kept, in the report's own words. */
function describeSkips(sink: Sink): string[] {
  const notes: string[] = []
  const count = (key: string) => sink.counts[key] ?? 0
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const verb = (n: number) => (n === 1 ? 'was' : 'were')
  const roles = [...sink.roles].slice(0, 5).join(', ')
  if (count('noSpeaker')) notes.push(`${plural(count('noSpeaker'), 'record')} named no speaker and could not be placed`)
  if (count('unknownRole')) notes.push(`${plural(count('unknownRole'), 'turn')} had a role this app cannot store (${roles})`)
  if (count('discardedRole')) notes.push(`${plural(count('discardedRole'), 'turn')} ${verb(count('discardedRole'))} a system or tool turn: the transcript holds only what the reader and the model said`)
  if (count('emptyContent')) notes.push(`${plural(count('emptyContent'), 'turn')} said nothing and ${verb(count('emptyContent'))} not stored`)
  if (count('mediaParts')) notes.push(`${plural(count('mediaParts'), 'part')} of an answer ${verb(count('mediaParts'))} not text (an image or a file) and could not be carried over`)
  if (count('foreignRefs')) notes.push(`${plural(count('foreignRefs'), 'file or page reference')} in the file ${verb(count('foreignRefs'))} not an id this app uses and ${verb(count('foreignRefs'))} dropped`)
  if (count('attachmentCap')) notes.push(`${count('attachmentCap')} attachment(s) over the ${MAX_CHAT_ATTACHMENTS} a turn may carry were dropped`)
  if (count('badLines')) {
    const n = count('badLines')
    const listed = sink.badLines.join(', ')
    const more = n > sink.badLines.length ? ` and ${n - sink.badLines.length} more` : ''
    notes.push(n === 1 ? `line ${listed} is not JSON and was skipped` : `lines ${listed}${more} are not JSON and were skipped`)
  }
  if (count('unusableRecords')) notes.push(`${plural(count('unusableRecords'), 'record')} was not a shape this reader can follow`)
  if (count('unreachableNodes')) notes.push(`${plural(count('unreachableNodes'), 'message')} sat on a branch of the file with no path to it`)
  if (count('forkedBranches')) notes.push(`${plural(count('forkedBranches'), 'regenerated branch')} were left out; a thread follows one branch`)
  if (count('emptyThreads')) notes.push(`${plural(count('emptyThreads'), 'conversation')} in the file held no readable turns`)
  if (count('strayLines')) notes.push(`${plural(count('strayLines'), 'line')} of text sat before any speaker label and was not stored`)
  if (count('metaHeadings')) notes.push(`${plural(count('metaHeadings'), 'heading line')} (a timestamp or a client decoration) ${verb(count('metaHeadings'))} not read as part of an answer`)
  if (count('tooDeep')) notes.push('a part of the file was nested deeper than any exporter writes and was left out')
  if (count('lineCap')) notes.push(`${count('lineCap')} line(s) past the ${MAX_SESSION_LINES} a parse reads were not looked at`)
  if (sink.stopped && !count('lineCap')) notes.push(`the file was too large to read past ${MAX_SESSION_RECORDS} records`)
  return notes
}

/**
 * The 32 symbols `newId` writes ids with.
 *
 * Spelled out here because `lib/id.ts` keeps its own copy private. The drift this could cause is bounded by
 * a test that feeds a derived id to `isValidId` — the same validator the routes answer a bad id with.
 */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/**
 * A 26-character id out of a digest, in the id alphabet and nothing else.
 *
 * Idempotence without a column: the same content always gives the same primary key, so a second import of
 * the same file is an `INSERT OR IGNORE` that changes nothing rather than a second copy of a conversation —
 * and the fingerprint rides in the id instead of asking for a new table or a migration. The seed is the
 * *read* content (title, roles, text), deliberately not the file's bytes and not its timestamps: a
 * re-export of one conversation carries new row ids, a new `exportedAt` and different whitespace, and none
 * of those make it a different conversation. Two genuinely different threads still differ, because they
 * differ here. The cost of the same rule is that a file containing one identical conversation twice yields
 * one thread, which is reported rather than silently merged.
 */
async function fingerprintId(seed: string, salt: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\n${seed}`)))
  let out = ''
  for (let index = 0; index < 26; index++) {
    const bit = index * 5
    const byte = bit >> 3
    const shift = bit & 7
    const value = shift === 0
      ? digest[byte]! & 31
      : ((digest[byte]! << shift) | (digest[byte + 1]! >> (8 - shift))) & 31
    out += ID_ALPHABET[value]
  }
  return out
}

/** The seed one thread's content reduces to: its title, then each turn's role and text in order. */
function threadSeed(thread: SessionThread): string {
  return `${thread.title}\u0001${thread.turns.map((turn) => `${turn.role}\u0000${turn.content}`).join('\u0001')}`
}

/** How a thread is described in the report when it has no title to be described by. */
function threadLabel(thread: SessionThread, index: number): string {
  return thread.title ? `"${thread.title.slice(0, 60)}"` : `thread ${index + 1}`
}

/**
 * Import one exported session file as threads of this account.
 *
 * The order is the one the backup restore follows and for the same reasons: decide every row against this
 * account before writing anything, then write in batches, then count what the batches actually took. A file
 * is not allowed to put more into a row than a live turn may hold, so the ceilings the live writes use are
 * the ceilings here.
 */
export async function importSessionFile(
  store: AssistantStore,
  filename: string,
  text: string,
): Promise<SessionImportSummary> {
  const bytes = utf8ByteLength(text)
  if (bytes > MAX_SESSION_FILE_BYTES) {
    throw ApiError.tooLarge(
      `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB of text, over the ${MAX_SESSION_FILE_BYTES / 1024 / 1024} MB a session import reads. Split it into fewer conversations and import them one at a time.`,
    )
  }
  const parsed = parseSessionFile(filename, text)
  const skipped = [...parsed.skipped]
  const summary: SessionImportSummary = { threads: 0, messages: 0, alreadyImported: 0, skipped }
  const note = (count: number, text: string) => {
    if (count > 0) skipped.push(`${count} ${text}.`)
  }

  // Every file id the threads name, proved against this account in one read. A ChatGPT log cannot carry one
  // of these, but an Inkstone export of a thread can, and an id that is not this reader's is refused for
  // the same reason every other route refuses it: it names another account's row.
  const wantedAttachments = [...new Set(parsed.threads.flatMap((thread) => thread.turns.flatMap((turn) => turn.attachments)))]
  const ownAttachments = new Set(
    wantedAttachments.length ? (await store.chatAttachments(wantedAttachments)).map((row) => row.id) : [],
  )
  note(wantedAttachments.length - ownAttachments.size, 'attachment id(s) the file named that are not files of this account were dropped')

  let totalTurns = 0
  const kept: SessionThread[] = []
  for (const [index, thread] of parsed.threads.entries()) {
    const turns: SessionTurn[] = []
    for (const turn of thread.turns) {
      if (turns.length >= MAX_SESSION_MESSAGES) {
        skipped.push(`${threadLabel(thread, index)} holds ${thread.turns.length} turns: only the first ${MAX_SESSION_MESSAGES} were imported.`)
        break
      }
      if (totalTurns >= MAX_SESSION_IMPORT_MESSAGES) {
        skipped.push(`The file holds more than the ${MAX_SESSION_IMPORT_MESSAGES} messages one import writes; the rest were left out.`)
        break
      }
      let content = turn.content
      if (content.length > MAX_SESSION_MESSAGE_CHARS) {
        skipped.push(`${threadLabel(thread, index)}: a turn of ${content.length} characters was cut to ${MAX_SESSION_MESSAGE_CHARS}.`)
        content = content.slice(0, MAX_SESSION_MESSAGE_CHARS)
      }
      turns.push({ ...turn, content, attachments: turn.attachments.filter((id) => ownAttachments.has(id)) })
      totalTurns++
    }
    if (!turns.length) {
      skipped.push(`${threadLabel(thread, index)} had nothing left to import and was not written.`)
      continue
    }
    kept.push({ ...thread, turns })
  }

  // The two notebook pointers a thread may carry, checked the way the create route checks them: kept when
  // this account owns them, dropped and named when it does not. An export from another deployment is full of
  // ids that mean nothing here, and a thread claiming to belong to a page this notebook does not hold would
  // go on showing a chip with nothing behind it.
  const knownNotes = new Set<string>()
  for (const id of new Set(kept.map((thread) => thread.noteId).filter((id): id is string => id !== null))) {
    if (await store.knownNote(id)) knownNotes.add(id)
    else skipped.push('A thread named a page this notebook does not hold, so it was imported unfiled.')
  }
  const knownFolders = new Set<string>()
  for (const id of new Set(kept.map((thread) => thread.folderId).filter((id): id is string => id !== null))) {
    if (await store.knownFolder(id)) knownFolders.add(id)
    else skipped.push('A thread named a folder this notebook does not hold, so it was imported unfiled.')
  }

  const at = Date.now()
  const threadRows: Record<string, unknown>[] = []
  const messageRows: Record<string, unknown>[] = []
  // Two threads of the same content are one thread: the fingerprint is the primary key, so the second copy
  // would be an ignored insert and a report that over-counted. Said out loud instead.
  const seenThreads = new Set<string>()
  for (const [index, thread] of kept.entries()) {
    const fingerprint = await fingerprintId(threadSeed(thread), 'inkstone-session-thread-v1')
    if (seenThreads.has(fingerprint)) {
      skipped.push(`${threadLabel(thread, index)} is the same conversation as another one in this file, so it was imported once.`)
      continue
    }
    seenThreads.add(fingerprint)
    if (await store.getConversation(fingerprint)) {
      // The thread is here from an earlier pass. Its messages are still asked for below, because a pass that
      // stopped between two batches has to be able to finish rather than be told to start over.
      summary.alreadyImported++
    }
    const title = (thread.title || titleFromMessage(thread.turns.find((turn) => turn.role === 'user')?.content ?? ''))
      .slice(0, MAX_CONVERSATION_TITLE_CHARS)
    const createdAt = thread.turns[0]?.createdAt ?? at
    const lastTurnAt = thread.turns.reduce((latest, turn) => Math.max(latest, turn.createdAt ?? createdAt), createdAt)
    threadRows.push({
      id: fingerprint,
      title,
      // A summary is fed to the model and never shown, so an imported one is left out and recomputed from
      // the messages the reader can actually see — the same rule the backup restore applies.
      summary: null,
      summary_upto: null,
      // Every NOT NULL column of this table is named, because `importRow` binds a column it is not given as
      // NULL and `INSERT OR IGNORE` then drops the whole row without a word. The same reason for messages.
      pinned: 0,
      starred: 0,
      archived: 0,
      folder_id: thread.folderId && knownFolders.has(thread.folderId) ? thread.folderId : null,
      project_id: null,
      parent_id: null,
      note_id: thread.noteId && knownNotes.has(thread.noteId) ? thread.noteId : null,
      created_at: createdAt,
      updated_at: Math.max(lastTurnAt, at),
    })
    for (const [turnIndex, turn] of thread.turns.entries()) {
      messageRows.push({
        id: await fingerprintId(`${fingerprint}\n${turnIndex}\n${turn.role}\n${turn.content}`, 'inkstone-session-message-v1'),
        conversation_id: fingerprint,
        role: turn.role,
        content: turn.content,
        reasoning: '',
        tools: '[]',
        attachments: JSON.stringify(turn.attachments),
        status: 'complete',
        error: null,
        // A turn out of somebody else's model is data, never something to send back: the retry and the
        // continue routes already refuse to re-send a row written this way.
        source: 'import',
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: 0,
        model_label: '',
        sources: '[]',
        feedback: '',
        scopes: '[]',
        created_at: turn.createdAt ?? at - (thread.turns.length - turnIndex),
      })
    }
  }

  try {
    await store.importRows('chat_conversations', threadRows, (landed) => { summary.threads += landed })
    await store.importRows('chat_messages', messageRows, (landed) => { summary.messages += landed })
  } catch (error) {
    // One batch is one transaction, and an import bigger than a batch is more than one batch, so a file
    // that stops here has gone in part way and nothing can un-write it. The answer says how far, and the way
    // on is the same file again: every row here is keyed by its own content, so a second pass writes what is
    // missing and leaves what landed alone.
    if (error instanceof ApiError) throw error
    throw new ApiError(
      500,
      'internal',
      `The import stopped part way: ${summary.threads} thread(s) and ${summary.messages} message(s) had already landed. Importing the same file again continues from there.`,
    )
  }
  if (summary.alreadyImported) {
    skipped.push(`${summary.alreadyImported} thread(s) of this file were already here and were left as they are.`)
  }
  return summary
}
