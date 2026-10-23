/**
 * Assistant backup: one JSON file out, merged back in.
 *
 * A backup is untrusted input the moment it comes off a disk, so the import rules are the reference
 * project's and they are load-bearing: nothing is deleted, records are matched by id so importing twice
 * is harmless, a newer local edit is never overwritten by an older copy, and a stored automation
 * arrives paused. What that project could not do — because it had one owner and one key — is leave the
 * provider configuration out; this app serves several accounts from one database, so a key from another
 * deployment has no business being installed here.
 */

import type { AssistantImportSummary, AssistantSettings } from '@shared/assistant'
import { clipReasoning, normalizeAssistantSettings, TASK_PRIORITIES, TASK_STATUSES } from '@shared/assistant'
import { parseScheduleSpec } from '@shared/assistant-schedule'
import {
  normalizeReminderTimes,
  parseRepeatRule,
  taskColorOrNull,
  taskIconOrNull,
  TIME_ENTRY_SOURCES,
} from '@shared/todos/model'
import { isTaskOpen } from '@shared/todos/status'
import { ASSISTANT_MEMORY_CATEGORIES, AUTOMATION_KINDS, MAX_ARTIFACT_CONTENT_CHARS, MAX_ARTIFACT_TITLE_CHARS, MAX_AUTOMATION_TARGET_ID_CHARS, MAX_MESSAGE_CHARS, MAX_PROJECT_NOTES } from '@shared/assistant'
import { ApiError } from '../lib/errors'
import { AssistantStore, decodeFeedback, encodeFeedback } from './store'

export const ASSISTANT_BACKUP_FORMAT = 'inkstone-assistant-backup'
export const ASSISTANT_BACKUP_VERSION = 1

/**
 * Settings a backup may never set.
 *
 * `activeModelId` points at a row that only exists in the exporting database, and the cost controls are
 * the reader's own decision — an imported file should not be able to raise the daily AI ceiling.
 */
const IGNORED_SETTINGS = ['activeModelId', 'limits', 'offlineMode'] as const

export interface AssistantBackup {
  format: typeof ASSISTANT_BACKUP_FORMAT
  version: number
  exportedAt: number
  data: { settings: AssistantSettings } & Record<string, unknown>
}

export type ImportSummary = AssistantImportSummary

export async function exportAssistant(store: AssistantStore): Promise<AssistantBackup> {
  const tables = await store.exportTables()
  return {
    format: ASSISTANT_BACKUP_FORMAT,
    version: ASSISTANT_BACKUP_VERSION,
    exportedAt: Date.now(),
    data: {
      settings: await store.getSettings(),
      ...tables,
    },
  }
}

/** A stored repeat rule, read the way the listing reads it: anything unreadable means "does not repeat". */
function storedRepeatRule(value: unknown): { freq: string, interval: number } | null {
  if (typeof value !== 'string') return null
  try {
    return parseRepeatRule(JSON.parse(value))
  } catch {
    return null
  }
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object') : []
}

function numberValue(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

function textValue(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function idValue(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-hjkmnp-tv-z]{26}$/.test(value) ? value : null
}

/**
 * A schedule's folder or page target, kept as the opaque reference it is.
 *
 * Deliberately not `idValue`: that one guards ids that are *keys* of the rows the restore writes, and it
 * would silently empty the column of any value whose shape it dislikes — which is precisely the failure a
 * note-writing schedule cannot absorb, since it would go on firing and writing nothing. The bound is the
 * same one the create applies, and the reference itself is proved where it is used: the sweep reads the
 * target through a query scoped to this account and refuses out loud when it is not there.
 */
function targetIdValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= MAX_AUTOMATION_TARGET_ID_CHARS ? id : null
}

/** The bound the notification writer puts on its pointer; a file must not be able to widen it. */
const NOTIFICATION_LINK_MAX_CHARS = 200

/**
 * Where a restored notice points, kept as the opaque `<app>:<id>` pair it is.
 *
 * Deliberately not `idValue`: the pair is not a key of any row this restore writes — the client is what
 * reads `todo:` and knows what to do with a task it cannot open — so a shape this build does not read is
 * still the notice's own statement of what it was about, and dropping it would bring back a notice that
 * looks the same and does less. Missing and blank both answer null, which is the writer's answer too: a
 * file that predates the column says its notice points nowhere, rather than failing to say anything.
 */
function notificationLinkValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim().slice(0, NOTIFICATION_LINK_MAX_CHARS) || null
}

/**
 * The pending instants one task row of the file names, in either shape the format has had.
 *
 * The current field is `reminders`, the whole pending list. Every file written before it carries a
 * single `remind_at` number instead, and a restore of one of those used to bring back exactly that one
 * alarm while the reader's other four had gone out of the file silently — so the old shape stays
 * readable for a version cycle, and the new one wins whenever both are present.
 */
function fileReminders(task: Record<string, unknown>): number[] {
  if (Array.isArray(task.reminders)) return normalizeReminderTimes(task.reminders.filter((value): value is number => typeof value === 'number'))
  return typeof task.remind_at === 'number' ? normalizeReminderTimes([task.remind_at]) : []
}

export async function importAssistant(store: AssistantStore, raw: Record<string, unknown>): Promise<ImportSummary> {
  if (raw.format !== ASSISTANT_BACKUP_FORMAT) throw ApiError.badRequest('That is not an Inkstone assistant backup.')
  const version = numberValue(raw.version, 1)
  if (version > ASSISTANT_BACKUP_VERSION) throw ApiError.badRequest(`Unsupported assistant backup version ${version}.`)
  const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
    ? raw.data as Record<string, unknown>
    : {}
  const skipped: string[] = []
  const summary: ImportSummary = {
    conversations: 0,
    artifacts: 0,
    artifactVersions: 0,
    messages: 0,
    answerVersions: 0,
    memories: 0,
    tasks: 0,
    projects: 0,
    automations: 0,
    notifications: 0,
    skipped,
  }
  try {
    await mergeBackup(store, data, summary)
  } catch (error) {
    // What D1 can promise is one transaction per batch, and a restore bigger than a batch is more than
    // one batch: a file that stops here has therefore gone in part way, and there is no rollback that can
    // un-write it. So the answer names the rows that landed and says the way on is the same file again —
    // nothing here deletes, every row is matched by id, and a newer local copy is never replaced, so a
    // second pass over the same backup continues instead of doubling anything.
    if (error instanceof ApiError) throw error
    throw new ApiError(500, 'internal', `The backup stopped part way: ${landed(summary)}. Importing the same file again continues from there.`)
  }
  return summary
}

/** The summary's counts, said the way a reader needs them after a restore that stopped. */
const LANDED_LABELS: readonly [key: keyof Omit<ImportSummary, 'skipped'>, label: string][] = [
  ['projects', 'project'], ['conversations', 'conversation'], ['messages', 'message'],
  ['answerVersions', 'answer'], ['artifacts', 'draft'], ['artifactVersions', 'draft version'], ['memories', 'memory'],
  ['tasks', 'task'], ['automations', 'schedule'], ['notifications', 'notification'],
]

function landed(summary: ImportSummary): string {
  const parts = LANDED_LABELS
    .map(([key, label]) => [summary[key], label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`)
  return parts.length ? `${parts.join(' and ')} had already landed` : 'nothing had landed yet'
}

/**
 * One pass per table, each row decided against the account's own copy and written in batches.
 *
 * The order is the dependency order, and it is load-bearing: a thread has to be here before its drafts,
 * messages and tag links can be, and a fork's parent before the parent column can point at it.
 */
async function mergeBackup(store: AssistantStore, data: Record<string, unknown>, summary: ImportSummary): Promise<void> {
  const { skipped } = summary

  for (const project of rows(data.projects)) {
    const id = idValue(project.id)
    if (!id) continue
    const updatedAt = numberValue(project.updated_at, Date.now())
    const name = textValue(project.name, 200) || 'Untitled'
    // What makes a project a context rather than a folder. A brief is read every turn in it, so it
    // gets the same ceiling the route that writes one does; the folders are re-checked against this
    // notebook, because another deployment's folder ids mean nothing here.
    const instructions = textValue(project.instructions, MAX_MESSAGE_CHARS)
    const noteScope = await importProjectScope(store, project.note_scope)
    const noteIds = await importProjectNotes(store, project.note_ids)
    const existing = await store.getProject(id)
    if (existing) {
      // The rule every row here follows: a newer local edit is never replaced by an older copy.
      if (existing.updatedAt >= updatedAt) {
        skipped.push(`project ${id} was newer here`)
        continue
      }
      // The unique index is on the folded name, so adopting a name another project holds would make
      // one file abort the whole restore. The name is the only thing kept back; the brief still lands.
      const taken = await store.findProjectByName(name)
      const nextName = taken && taken.id !== id ? existing.name : name
      if (taken && taken.id !== id) skipped.push(`project ${id} kept its name because "${name}" is taken`)
      await store.importUpdate('chat_projects', id, {
        name: nextName,
        description: textValue(project.description, 2000),
        instructions,
        note_scope: JSON.stringify(noteScope),
        note_ids: JSON.stringify(noteIds),
        updated_at: updatedAt,
      })
    } else {
      let importName = name
      if (await store.findProjectByName(importName)) {
        importName = await uniqueProjectName(store, importName)
        skipped.push(`project ${id} arrived as "${importName}" because "${name}" is taken`)
      }
      await store.importRow('chat_projects', {
        id,
        name: importName,
        description: textValue(project.description, 2000),
        instructions,
        note_scope: JSON.stringify(noteScope),
        note_ids: JSON.stringify(noteIds),
        created_at: numberValue(project.created_at, Date.now()),
        updated_at: updatedAt,
      })
    }
    summary.projects++
  }

  const knownProjects = new Set((await store.listProjects()).map((project) => project.id))

  // Threads whose local copy was newer than the file: their own row is left alone, and so is the fork
  // parent, because both are edits the reader made after this backup was written.
  const keptNewer = new Set<string>()
  const conversationEntries = rows(data.conversations)
  // Which of these threads are already here and when the local copy was last edited, asked once for the
  // whole file instead of once per row: the per-row round trips are what makes a big restore run out of
  // CPU half way through, and half a restored account is the state the caller above has to report.
  const localThreads = await store.storedUpdatedAts(
    'chat_conversations',
    conversationEntries.map((entry) => idValue(entry.id)).filter((id): id is string => id !== null),
  )
  const threadInserts: Record<string, unknown>[] = []
  const threadUpdates: { id: string, row: Record<string, unknown> }[] = []
  for (const conversation of conversationEntries) {
    const id = idValue(conversation.id)
    if (!id) continue
    const updatedAt = numberValue(conversation.updated_at, Date.now())
    const projectId = idValue(conversation.project_id)
    const row = {
      id,
      title: textValue(conversation.title, 200),
      // A summary is fed to the model but never shown, so an imported one is dropped and recomputed
      // from the messages the reader can actually see.
      summary: null,
      summary_upto: null,
      pinned: numberValue(conversation.pinned),
      starred: numberValue(conversation.starred),
      // Named explicitly even though the column has a default: `importRow` binds every column in its own
      // list, and a name it is not given becomes NULL — which a NOT NULL column turns into a dropped row.
      archived: numberValue(conversation.archived),
      // A folder belongs to the notebook, not to the backup: an id the reader does not have any more
      // is dropped rather than left dangling, so the restored row shows up as unfiled.
      folder_id: typeof conversation.folder_id === 'string' && await store.knownFolder(conversation.folder_id)
        ? conversation.folder_id
        : null,
      // The project the thread answers under, when the file carried the project itself.
      project_id: projectId && knownProjects.has(projectId) ? projectId : null,
      // The note the thread was started from. Kept as it is rather than checked against the vault: the
      // note is the reader's own and the backup does not carry notes, so a missing one is a chip with
      // nothing to open — not a reason to make every restored thread forget its origin.
      note_id: typeof conversation.note_id === 'string' && conversation.note_id !== '' ? conversation.note_id : null,
      created_at: numberValue(conversation.created_at, Date.now()),
      updated_at: updatedAt,
    }
    const localAt = localThreads.get(id) ?? null
    if (localAt !== null && localAt >= updatedAt) {
      skipped.push(`conversation ${id} was newer here`)
      keptNewer.add(id)
      continue
    }
    if (localAt !== null) threadUpdates.push({ id, row })
    else threadInserts.push(row)
  }
  // Counted from what the batches wrote, so a restore that stopped between two of them reports the rows
  // that are really in the account rather than the rows the file asked for.
  await store.importRows('chat_conversations', threadInserts, (landed) => { summary.conversations += landed })
  await store.importUpdates('chat_conversations', threadUpdates, (landed) => { summary.conversations += landed })

  // Every conversation that exists here, read as ids rather than through a list page: a library larger
  // than one page would otherwise restore its newest threads whole and drop the rest silently.
  const conversations = new Set(await store.conversationIds())
  // The parent of a fork is only kept when both ends are here. Applied after the loop because a file
  // may list a fork before the thread it was forked from.
  const forkParents: { id: string, row: Record<string, unknown> }[] = []
  for (const conversation of conversationEntries) {
    const id = idValue(conversation.id)
    const parentId = idValue(conversation.parent_id)
    if (!id || !parentId || keptNewer.has(id) || !conversations.has(id) || !conversations.has(parentId)) continue
    forkParents.push({ id, row: { parent_id: parentId } })
  }
  await store.importUpdates('chat_conversations', forkParents)

  // The drafts those threads were keeping. Restored after the conversations, so a draft whose thread did
  // not come back is dropped rather than left orphaned — the panel reads them by conversation id.
  const draftRows: Record<string, unknown>[] = []
  for (const artifact of rows(data.artifacts)) {
    const id = idValue(artifact.id)
    const conversationId = idValue(artifact.conversation_id)
    if (!id || !conversationId || !conversations.has(conversationId)) continue
    // Every column is named because they are all NOT NULL, and `importRow` binds a column it is not given
    // as NULL — which `INSERT OR IGNORE` turns into a silently dropped row. `note_id` is the one exception:
    // it is the seam a later build fills, and null is what a draft that is only a draft carries.
    draftRows.push({
      id,
      conversation_id: conversationId,
      title: textValue(artifact.title, MAX_ARTIFACT_TITLE_CHARS),
      content: textValue(artifact.content, MAX_ARTIFACT_CONTENT_CHARS),
      // The link to the note this draft became. Carrying the draft without it would restore a second copy
      // of a document the reader already has, so it travels — and a link to a note the backup did not
      // carry is left as it is rather than silently re-pointed at nothing.
      note_id: typeof artifact.note_id === 'string' && artifact.note_id !== '' ? artifact.note_id : null,
      // A restored draft whose head number fell back to 1 would point at the wrong snapshot as soon as
      // its history came back with it, so the head number travels with the row.
      version: Math.max(1, numberValue(artifact.version, 1)),
      created_at: numberValue(artifact.created_at, Date.now()),
      updated_at: numberValue(artifact.updated_at, Date.now()),
    })
  }
  await store.importRows('chat_artifacts', draftRows, (landed) => { summary.artifacts += landed })
  // The snapshots come after the drafts they belong to. A version whose draft did not land is skipped
  // rather than left as a row nothing can reach.
  const restoredArtifactIds = new Set(draftRows.map((row) => String(row.id)))
  const artifactVersionRows: Record<string, unknown>[] = []
  for (const version of rows(data.artifact_versions)) {
    const id = idValue(version.id)
    const artifactId = idValue(version.artifact_id)
    const conversationId = idValue(version.conversation_id)
    const versionNumber = numberValue(version.version, 0)
    if (!id || !artifactId || !conversationId || !restoredArtifactIds.has(artifactId) || versionNumber < 1) continue
    const source = version.source === 'user' || version.source === 'assistant' || version.source === 'restore'
      ? version.source
      : 'import'
    artifactVersionRows.push({
      id,
      artifact_id: artifactId,
      conversation_id: conversationId,
      version: versionNumber,
      title: textValue(version.title, MAX_ARTIFACT_TITLE_CHARS),
      content: textValue(version.content, MAX_ARTIFACT_CONTENT_CHARS),
      source,
      message_id: idValue(version.message_id),
      created_at: numberValue(version.created_at, Date.now()),
    })
  }
  await store.importRows('chat_artifact_versions', artifactVersionRows, (landed) => { summary.artifactVersions += landed })
  // Tags are the notebook's objects, so the file's own list of them is checked against this account once
  // rather than once per link.
  const tagLinks = rows(data.conversation_tags)
    .map((link) => ({ conversationId: idValue(link.conversation_id), tagId: idValue(link.tag_id) }))
    .filter((link): link is { conversationId: string, tagId: string } =>
      Boolean(link.conversationId) && Boolean(link.tagId))
  // The account's own tags, read once: whether a link can be restored at all never depends on the link.
  const knownTagIds = new Set((await store.conversationTags()).map((tag) => tag.id))
  const linkRows: Record<string, unknown>[] = []
  for (const link of tagLinks) {
    if (!conversations.has(link.conversationId)) continue
    // A link to a tag the reader deleted is not restored.
    if (!knownTagIds.has(link.tagId)) continue
    linkRows.push({ conversation_id: link.conversationId, tag_id: link.tagId, created_at: Date.now() })
  }
  await store.importRows('chat_conversation_tags', linkRows)

  // Turns whose thread is here, read against the rows already in the account in one pass rather than one
  // query per message: this is the largest table in a backup by a wide margin.
  const messageEntries = rows(data.messages)
  const heldMessages = await store.hasRows('chat_messages', messageEntries.map((entry) => idValue(entry.id)).filter((id): id is string => id !== null))
  const messageRows: Record<string, unknown>[] = []
  for (const message of messageEntries) {
    const id = idValue(message.id)
    const conversationId = idValue(message.conversation_id)
    if (!id || !conversationId || !conversations.has(conversationId)) continue
    if (heldMessages.has(id)) continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    // The verdict and its reason share the `feedback` column, so a restored row keeps both: decode re-reads
    // either encoding, and re-encode writes the canonical form, which is also what bounds a hostile file's
    // reason and drops a value that names no verdict at all.
    const storedFeedback = decodeFeedback(message.feedback)
    const row = {
      id,
      conversation_id: conversationId,
      role,
      content: textValue(message.content, 200_000),
      tools: typeof message.tools === 'string' ? message.tools : '[]',
      // Same reason as every other field here: a column this rebuild does not name is written as NULL,
      // and a NOT NULL column makes INSERT OR IGNORE drop the whole message.
      attachments: typeof message.attachments === 'string' ? message.attachments : '[]',
      // Named for the same reason, and bounded by the same cap the live turn writes under: a file is not
      // allowed to put more in a row than a model is.
      reasoning: typeof message.reasoning === 'string' ? clipReasoning(message.reasoning) : '',
      status: ['complete', 'error', 'cancelled'].includes(String(message.status)) ? message.status : 'complete',
      error: typeof message.error === 'string' ? message.error.slice(0, 1000) : null,
      // A restored message is data, never live owner input: the retry path refuses to re-send one.
      source: 'import',
      input_tokens: numberValue(message.input_tokens),
      output_tokens: numberValue(message.output_tokens),
      duration_ms: numberValue(message.duration_ms),
      model_label: textValue(message.model_label, 200),
      // The pages a searched answer read and the verdict the reader left on it are both shown by the
      // transcript, so a restored row without them is a different row from the one that was saved.
      sources: typeof message.sources === 'string' ? message.sources.slice(0, 64 * 1024) : '[]',
      feedback: encodeFeedback(storedFeedback?.verdict ?? null, storedFeedback?.reason),
      // The scope a turn was asked under, kept for the same reason: a restored transcript that lost it
      // would show an answer with no explanation for why it only knew one note.
      scopes: typeof message.scopes === 'string' ? message.scopes.slice(0, 8 * 1024) : '[]',
      // The follow-up chips the answer volunteered, kept because the transcript renders them off the row: a
      // restored answer that lost them shows fewer questions than the reader saw before. Named for the
      // harder reason than `scopes`: the column is NOT NULL, so a key the restore leaves out is bound NULL
      // and `INSERT OR IGNORE` drops the whole message — the loud half of the failure this table has hit
      // twice for a column that was exported but not rebuilt here.
      suggestions: typeof message.suggestions === 'string' ? message.suggestions.slice(0, 8 * 1024) : '[]',
      // The reader's own keep, with the moment they made it. Named because a column the restore leaves out
      // is written as NULL rather than skipped: the row still lands — the column is nullable — and the
      // answer comes back off the shelf the reader put it on, which is the loss nobody would see.
      saved_at: numberOrNull(message.saved_at),
      created_at: numberValue(message.created_at, Date.now()),
    }
    messageRows.push(row)
  }
  await store.importRows('chat_messages', messageRows, (landed) => { summary.messages += landed })
  // The answers a reader paged away from. They ride with the thread they belong to: a restored
  // conversation whose pager had counted three answers but listed none would lie in its own interface.
  const versionEntries = rows(data.answer_versions)
  const heldVersions = await store.hasRows('chat_answer_versions', versionEntries.map((entry) => idValue(entry.id)).filter((id): id is string => id !== null))
  const versionRows: Record<string, unknown>[] = []
  for (const version of versionEntries) {
    const id = idValue(version.id)
    const messageId = idValue(version.message_id)
    const conversationId = idValue(version.conversation_id)
    if (!id || !messageId || !conversationId || !conversations.has(conversationId)) continue
    if (heldVersions.has(id)) continue
    const row = {
      id,
      message_id: messageId,
      conversation_id: conversationId,
      content: textValue(version.content, 200_000),
      reasoning: typeof version.reasoning === 'string' ? clipReasoning(version.reasoning) : '',
      tools: typeof version.tools === 'string' ? version.tools : '[]',
      model_label: textValue(version.model_label, 200),
      input_tokens: numberValue(version.input_tokens),
      output_tokens: numberValue(version.output_tokens),
      duration_ms: numberValue(version.duration_ms),
      created_at: numberValue(version.created_at, Date.now()),
    }
    versionRows.push(row)
  }
  await store.importRows('chat_answer_versions', versionRows, (landed) => { summary.answerVersions += landed })
  const memoryEntries = rows(data.memories)
  const localMemoryAt = await store.storedUpdatedAts(
    'chat_memories',
    memoryEntries.map((entry) => idValue(entry.id)).filter((id): id is string => id !== null),
  )
  const memoryInserts: Record<string, unknown>[] = []
  const memoryUpdates: { id: string, row: Record<string, unknown> }[] = []
  for (const memory of memoryEntries) {
    const id = idValue(memory.id)
    if (!id) continue
    const updatedAt = numberValue(memory.updated_at, Date.now())
    const projectId = idValue(memory.project_id)
    const existingAt = localMemoryAt.get(id) ?? null
    // Never overwrite a newer local edit with an older backup copy.
    if (existingAt !== null && existingAt >= updatedAt) {
      skipped.push(`memory ${id} was newer here`)
      continue
    }
    const row = {
      id,
      content: textValue(memory.content, 2000) || 'Untitled memory',
      category: oneOf(memory.category, ASSISTANT_MEMORY_CATEGORIES, 'other'),
      source: 'import',
      status: oneOf(memory.status, ['active', 'historical', 'uncertain'], 'active'),
      // A link to a memory that is not here would be a dangling pointer, so it is dropped.
      superseded_by: null,
      valid_from: dateValue(memory.valid_from),
      valid_until: dateValue(memory.valid_until),
      // Same rule as a task's project: a fact filed under a project that did not come with the backup
      // would be a fact no turn can ever recall — worse than an unfiled one, which every turn recalls.
      project_id: projectId && knownProjects.has(projectId) ? projectId : null,
      // The note a fact was written out as is a pointer the memory page shows, so it travels with the
      // fact; a note the backup did not carry is a notebook object, not an assistant one.
      note_id: idValue(memory.note_id),
      created_at: numberValue(memory.created_at, updatedAt),
      updated_at: updatedAt,
    }
    if (existingAt !== null) memoryUpdates.push({ id, row })
    else memoryInserts.push(row)
  }
  await store.importRows('chat_memories', memoryInserts, (landed) => { summary.memories += landed })
  await store.importUpdates('chat_memories', memoryUpdates, (landed) => { summary.memories += landed })
  // Lists travel before the tasks that point at them, so a restored task can keep its list. A list
  // already in the account wins: it is the reader's own object, and the file's copy has no newer claim.
  const listRows: Record<string, unknown>[] = []
  const knownLists = new Set<string>()
  // The nesting is resolved in a second pass on purpose: a file may carry a child list before its parent,
  // and a parent looked up while walking would be dropped for a reason as accidental as array order.
  for (const list of rows(data.task_lists)) {
    const id = idValue(list.id)
    if (id) knownLists.add(id)
  }
  for (const list of rows(data.task_lists)) {
    const id = idValue(list.id)
    if (!id) continue
    // `parent_id` is kept only when it names a list this file actually contains, and a list that names
    // itself is dropped to the top level: that pair is a cycle no screen can draw. Without the check a
    // restored account would hold a child whose parent is nobody, and the list it belongs to would be
    // missing from every screen that reads the nesting.
    const parentId = idValue(list.parent_id)
    listRows.push({
      id,
      name: textValue(list.name, 60) || 'List',
      icon: typeof list.icon === 'string' ? list.icon.slice(0, 40) : null,
      color: typeof list.color === 'string' && /^#[0-9a-f]{6}$/i.test(list.color) ? list.color : null,
      position: numberValue(list.position),
      // The stamp and the parent are the two facts a restored account cannot rediscover: an archived
      // collection that came back un-archived puts every finished day back on the working page, and a
      // child that lost its parent stops being the section it was inside.
      archived_at: numberOrNull(list.archived_at),
      parent_id: parentId !== null && parentId !== id && knownLists.has(parentId) ? parentId : null,
      created_at: numberValue(list.created_at, Date.now()),
      updated_at: numberValue(list.updated_at, Date.now()),
    })
  }
  await store.importRows('todos_lists', listRows)

  const taskEntries = rows(data.tasks)
  const localTaskAt = await store.storedUpdatedAts(
    'todos_tasks',
    taskEntries.map((entry) => idValue(entry.id)).filter((id): id is string => id !== null),
  )
  const taskInserts: Record<string, unknown>[] = []
  const taskUpdates: { id: string, row: Record<string, unknown> }[] = []
  for (const task of taskEntries) {
    const id = idValue(task.id)
    if (!id) continue
    const projectId = idValue(task.project_id)
    const listId = idValue(task.list_id)
    const repeat = storedRepeatRule(task.repeat_rule)
    const status = oneOf(task.status, TASK_STATUSES, 'todo')
    const row = {
      id,
      title: textValue(task.title, 300) || 'Untitled task',
      description: textValue(task.description, 10_000),
      // The shared enums, not a copy: a reader who abandoned a task and restored it as `todo` got work
      // back they had already let go of, and the second half of that story is a rate on the statistics
      // page that no longer describes the plate.
      status,
      priority: oneOf(task.priority, TASK_PRIORITIES, 'medium'),
      due_at: numberOrNull(task.due_at),
      start_at: numberOrNull(task.start_at),
      project_id: projectId && knownProjects.has(projectId) ? projectId : null,
      // A list the file did not carry leaves the task in the inbox rather than pointing at nothing.
      list_id: listId && knownLists.has(listId) ? listId : null,
      // The task's own face, through the same guards that wrote it: a file that names a 400-character
      // icon or a colour outside the palette gets null, which is "wear the list's", not the junk.
      icon: taskIconOrNull(task.icon),
      color: taskColorOrNull(task.color),
      starred: task.starred === true || task.starred === 1 ? 1 : 0,
      repeat_rule: repeat ? JSON.stringify(repeat) : null,
      // The pending instants, both shapes of them folded into one list. They are not a column of the
      // task row — `todos_reminders` owns them, and `importRows` turns this field into those rows — and
      // a fired reminder never comes back as a pending one, because a restore is not a delivery.
      reminders: fileReminders(task),
      note_id: idValue(task.note_id),
      conversation_id: idValue(task.conversation_id),
      created_at: numberValue(task.created_at, Date.now()),
      updated_at: numberValue(task.updated_at, Date.now()),
      completed_at: numberOrNull(task.completed_at),
      // The two day columns are what the statistics' buckets and the streak read, so a restore that
      // forgot them left every restored task with no day at all until a boot backfilled it — and the
      // fingerprint note means a boot after a restore does not come back through that repair.
      // `completed_on` is carried only for a row that ended: naming a finish day for a task still owed
      // would let a file invent a day the reader never closed.
      created_on: dayValue(task.created_on),
      completed_on: isTaskOpen(status) ? null : dayValue(task.completed_on),
      // The planned length travels with the row it belongs to: a restored task that forgot its
      // estimate lost the half of the worklog that compares hours spent against hours intended.
      // Nullable, so a file written before the column exists simply does not name it.
      time_estimate_ms: numberOrNull(task.time_estimate_ms),
      // The shelf travels, unlike the trash: work the reader put away is still theirs, and a restore
      // that lost the stamp would refill today's board with the days they have already closed.
      archived_at: numberOrNull(task.archived_at),
    }
    // A task the reader has checked off or edited here since the file was written stays theirs.
    const localAt = localTaskAt.get(id) ?? null
    if (localAt !== null && localAt >= row.updated_at) {
      skipped.push(`task ${id} was newer here`)
      continue
    }
    if (localAt !== null) taskUpdates.push({ id, row })
    else taskInserts.push(row)
  }
  await store.importRows('todos_tasks', taskInserts, (landed) => { summary.tasks += landed })
  await store.importUpdates('todos_tasks', taskUpdates, (landed) => { summary.tasks += landed })

  // Tags are this app's own objects, like a notebook tag: the file's list is restored first, then a
  // link is kept only when both ends exist here. A link to a tag the reader deleted is not restored.
  const tagRows: Record<string, unknown>[] = []
  for (const tag of rows(data.task_tags)) {
    const id = idValue(tag.id)
    if (!id) continue
    tagRows.push({
      id,
      name: textValue(tag.name, 40) || 'Tag',
      color: typeof tag.color === 'string' && /^#[0-9a-f]{6}$/i.test(tag.color) ? tag.color : null,
      created_at: numberValue(tag.created_at, Date.now()),
      updated_at: numberValue(tag.updated_at, Date.now()),
    })
  }
  await store.importRows('todos_tags', tagRows)
  const liveTags = new Set((await store.listTaskTags()).map((tag) => tag.id))
  const linkEntries = rows(data.task_tag_links)
  const heldTasks = await store.hasRows('todos_tasks', linkEntries.map((entry) => idValue(entry.task_id)).filter((id): id is string => id !== null))
  const taskLinkRows: Record<string, unknown>[] = []
  for (const link of linkEntries) {
    const taskId = idValue(link.task_id)
    const tagId = idValue(link.tag_id)
    if (!taskId || !tagId || !heldTasks.has(taskId) || !liveTags.has(tagId)) continue
    taskLinkRows.push({ task_id: taskId, tag_id: tagId, created_at: Date.now() })
  }
  await store.importRows('todos_tag_links', taskLinkRows)

  const stepEntries = rows(data.task_steps)
  const stepTaskIds = stepEntries.map((entry) => idValue(entry.task_id)).filter((id): id is string => id !== null)
  const tasksWithSteps = await store.hasRows('todos_tasks', stepTaskIds)
  const stepRows: Record<string, unknown>[] = []
  for (const step of stepEntries) {
    const id = idValue(step.id)
    const taskId = idValue(step.task_id)
    if (!id || !taskId || !tasksWithSteps.has(taskId)) continue
    stepRows.push({
      id,
      task_id: taskId,
      text: textValue(step.text, 200),
      done: step.done === true || step.done === 1 ? 1 : 0,
      position: numberValue(step.position),
      created_at: numberValue(step.created_at, Date.now()),
    })
  }
  await store.importRows('todos_steps', stepRows)

  // Which file each task shows. The file's own row lives in the attachment hub and travels in no backup,
  // so a link whose task is not here is dropped rather than left pointing at nothing, and one whose file
  // the device no longer holds resolves to nothing on read — the join that lists a task's files already
  // insists the file belongs to this account, so restoring the link can neither leak nor lie.
  const attachmentEntries = rows(data.task_attachments)
  const attachmentTaskIds = attachmentEntries
    .map((entry) => idValue(entry.task_id))
    .filter((id): id is string => id !== null)
  const tasksWithFiles = await store.hasRows('todos_tasks', attachmentTaskIds)
  const attachmentRows: Record<string, unknown>[] = []
  for (const link of attachmentEntries) {
    const taskId = idValue(link.task_id)
    // An attachment id is one of this app's own ids, so it goes through the same gate as every other
    // key the file names; anything shaped differently cannot be a file of this account.
    const attachmentId = idValue(link.attachment_id)
    if (!taskId || !attachmentId || !tasksWithFiles.has(taskId)) continue
    attachmentRows.push({
      task_id: taskId,
      attachment_id: attachmentId,
      created_at: numberValue(link.created_at, Date.now()),
    })
  }
  await store.importRows('todos_attachments', attachmentRows)

  // The time ledger lands after the tasks it belongs to, and an interval whose task is not here goes
  // with it: the file carries hours spent, and hours no task owns are a fact nothing will ever read
  // again. A row whose `end_at` is missing is skipped for the export's own reason (D13): the running
  // timer is one device's state, and no file gets to resurrect it on another. `day` is the day the
  // server fixed at write time — the restore keeps it rather than recomputing, because the whole
  // point of the column is that the account's calendar, not this machine's clock, decided it.
  const timeEntryEntries = rows(data.task_time_entries)
  const timeEntryTaskIds = timeEntryEntries
    .map((entry) => idValue(entry.task_id))
    .filter((id): id is string => id !== null)
  const tasksWithLedger = await store.hasRows('todos_tasks', timeEntryTaskIds)
  const timeEntryRows: Record<string, unknown>[] = []
  for (const entry of timeEntryEntries) {
    const id = idValue(entry.id)
    const taskId = idValue(entry.task_id)
    const day = dateValue(entry.day)
    const endAt = numberOrNull(entry.end_at)
    if (!id || !taskId || !tasksWithLedger.has(taskId) || day === null || endAt === null) continue
    timeEntryRows.push({
      id,
      task_id: taskId,
      start_at: numberValue(entry.start_at),
      end_at: endAt,
      day,
      source: oneOf(entry.source, TIME_ENTRY_SOURCES, 'timer'),
      created_at: numberValue(entry.created_at, Date.now()),
      updated_at: numberValue(entry.updated_at, Date.now()),
    })
  }
  await store.importRows('todos_time_entries', timeEntryRows)

  // Two things this format leaves out by decision, said on the summary rather than left for the reader to
  // discover by counting what came back. A feed's password hash and a mail address's token are the
  // capability itself, so they go nowhere near a file that may leave the deployment; and the event table
  // the cumulative flow replays is the one history whose rows cost more than the restore ceiling can spare.
  // Both notes are unconditional: the file says nothing about whether the account had either, so the only
  // honest answer is the one given every time.
  skipped.push('calendar feed links and the mail inbox address are not part of a backup — regenerate them in Settings')
  skipped.push('the task history the cumulative flow replays is not part of a backup — the flow starts again from this restore')

  const notificationEntries = rows(data.notifications)
  const heldNotifications = await store.hasRows(
    'chat_notifications',
    notificationEntries.map((entry) => idValue(entry.id)).filter((id): id is string => id !== null),
  )
  const notificationRows: Record<string, unknown>[] = []
  for (const notification of notificationEntries) {
    const id = idValue(notification.id)
    if (!id) continue
    if (heldNotifications.has(id)) continue
    notificationRows.push({
      id,
      title: textValue(notification.title, 200) || 'Reminder',
      body: textValue(notification.body, 8000),
      automation_id: idValue(notification.automation_id),
      // The pointer travels with the notice, and it is named here rather than left to what the row does
      // not say: `importRows` writes the columns the row names and nothing else, so an import that omits
      // this one restores a reminder whose press opens a list instead of the task it was about — the
      // quiet half of the loss, because the row itself still lands.
      link: notificationLinkValue(notification.link),
      subscription_id: idValue(notification.subscription_id),
      read_at: numberOrNull(notification.read_at),
      created_at: numberValue(notification.created_at, Date.now()),
    })
  }
  await store.importRows('chat_notifications', notificationRows, (landed) => { summary.notifications += landed })
  let paused = 0
  const automationRows: Record<string, unknown>[] = []
  for (const automation of rows(data.automations)) {
    const id = idValue(automation.id)
    // A stored schedule is JSON text; a hand-written backup may carry the object.
    const schedule = parseScheduleSpec(
      typeof automation.schedule === 'string'
        ? (() => {
            try {
              return JSON.parse(automation.schedule)
            } catch {
              return null
            }
          })()
        : automation.schedule,
    )
    if (!id || !schedule) continue
    const existing = await store.getAutomation(id)
    if (existing) {
      // The one change a backup may make to a schedule the reader already has is the safe one: pause it.
      if (automation.enabled === false && existing.enabled) {
        await store.updateAutomation(id, { enabled: false, status: 'paused', nextRun: null })
        paused++
      }
      continue
    }
    const automationRow = {
      id,
      name: textValue(automation.name, 200) || 'Imported schedule',
      kind: oneOf(automation.kind, AUTOMATION_KINDS, 'reminder'),
      message: textValue(automation.message, 4000),
      schedule: JSON.stringify(schedule),
      enabled: 0,
      status: 'paused',
      next_run: null,
      last_run: numberOrNull(automation.last_run),
      last_result: typeof automation.last_result === 'string' ? automation.last_result.slice(0, 2000) : null,
      last_error: typeof automation.last_error === 'string' ? automation.last_error.slice(0, 1000) : null,
      run_count: numberValue(automation.run_count),
      // The two targets ride along. A schedule that writes a page and comes back without its target would
      // answer the prompt every time it fires and file the answer nowhere, which is the one failure this
      // row can cause silently — `EXPORT_COLUMNS` has to list the columns for the same reason, or
      // `INSERT OR IGNORE` drops the whole row on the way back in. A target belonging to another account is
      // not resolved here: the row lands paused, and the sweep names the missing page or folder before it
      // spends anything, so the reader sees why rather than watching a schedule that writes nothing.
      target_folder_id: targetIdValue(automation.target_folder_id),
      target_note_id: targetIdValue(automation.target_note_id),
      created_at: numberValue(automation.created_at, Date.now()),
      updated_at: Date.now(),
    }
    automationRows.push(automationRow)
  }
  await store.importRows('chat_automations', automationRows, (landed) => { summary.automations += landed })
  if (summary.automations) skipped.push(`${summary.automations} imported paused`)
  if (paused) skipped.push(`${paused} existing paused by the backup`)

  const importedSettings = data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)
    ? data.settings as Record<string, unknown>
    : {}
  const allowed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(importedSettings)) {
    if ((IGNORED_SETTINGS as readonly string[]).includes(key)) {
      skipped.push(`kept your ${key}`)
      continue
    }
    allowed[key] = value
  }
  // Last, so a file that stopped on its rows never leaves the reader on a language or a switch they did
  // not agree to take.
  if (Object.keys(allowed).length) {
    await store.saveSettings(mergeImportedSettings(await store.getSettings(), allowed))
  }
}

/**
 * A backup may bring the reader's language, timezone and behaviour switches, but never a model, a
 * budget or an offline flag — those are the settings that decide what a file costs and what it touches.
 */
function mergeImportedSettings(current: AssistantSettings, imported: Record<string, unknown>): AssistantSettings {
  const candidate = normalizeAssistantSettings({ ...current, ...imported })
  return {
    ...candidate,
    activeModelId: current.activeModelId,
    limits: current.limits,
    offlineMode: current.offlineMode,
    // The scope names folders by id, and another account's ids mean nothing here.
    noteScope: current.noteScope,
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null
}

function dateValue(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(value) ? value : null
}

/**
 * A calendar day, in the one form the day columns store.
 *
 * Stricter than `dateValue` above because these two are compared as strings against a computed today:
 * a file that wrote `2026` or `2026-1` would land as a day no bucket ever matches, which is the loss
 * again, just quieter.
 */
function dayValue(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/**
 * A project name no existing project already holds.
 *
 * The projects table has a unique index on the folded name, so two accounts' "Client A" cannot both be
 * restored as they were. Renaming the arriving one keeps both, and the conversations the file filed under
 * it keep pointing at it — which a skipped row could not do.
 */
async function uniqueProjectName(store: AssistantStore, base: string): Promise<string> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const candidate = attempt === 1 ? `${base} (imported)` : `${base} (imported ${attempt})`
    if (!(await store.findProjectByName(candidate))) return candidate
  }
  return `${base} (imported ${Date.now()})`
}

/**
 * The folders a restored project reads, kept only when they are folders of this notebook.
 */
async function importProjectScope(store: AssistantStore, value: unknown): Promise<string[]> {
  return jsonIds(value, 12, (id) => store.knownFolder(id))
}

/**
 * The pages a restored project names, kept only when this notebook still holds them.
 *
 * Dropped rather than kept-and-hoped-for, same as a folder id from another deployment: a project that came
 * back naming three deleted pages would answer as if it had read them.
 */
async function importProjectNotes(store: AssistantStore, value: unknown): Promise<string[]> {
  return jsonIds(value, MAX_PROJECT_NOTES, (id) => store.knownNote(id))
}

/**
 * One JSON list of ids off a backup row — text in a file this app wrote, an array in one written by hand —
 * with everything this notebook does not have left out.
 *
 * The column is `TEXT NOT NULL DEFAULT` and arrives through the same `INSERT` the export list drives, so
 * reading it here is also what keeps the two in step: a project row whose selection was never parsed would
 * bind a null into that column and lose the whole row to the ignore.
 */
async function jsonIds(value: unknown, limit: number, known: (id: string) => Promise<boolean>): Promise<string[]> {
  let entries: unknown[] = []
  if (Array.isArray(value)) entries = value
  else if (typeof value === 'string' && value) {
    try {
      const parsed: unknown = JSON.parse(value)
      entries = Array.isArray(parsed) ? parsed : []
    } catch {
      entries = []
    }
  }
  const ids: string[] = []
  for (const entry of entries.slice(0, limit)) {
    const id = idValue(entry)
    if (!id || !(await known(id))) continue
    ids.push(id)
  }
  return ids
}
