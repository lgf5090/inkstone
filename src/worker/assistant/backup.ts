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
import { normalizeAssistantSettings } from '@shared/assistant'
import { parseScheduleSpec } from '@shared/assistant-schedule'
import { ASSISTANT_MEMORY_CATEGORIES, AUTOMATION_KINDS } from '@shared/assistant'
import { ApiError } from '../lib/errors'
import { AssistantStore } from './store'

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
    messages: 0,
    answerVersions: 0,
    memories: 0,
    tasks: 0,
    projects: 0,
    automations: 0,
    notifications: 0,
    skipped,
  }

  for (const project of rows(data.projects)) {
    const id = idValue(project.id)
    if (!id) continue
    if (await store.hasRow('chat_projects', id)) {
      await store.importUpdate('chat_projects', id, {
        name: textValue(project.name, 200),
        description: textValue(project.description, 2000),
        updated_at: numberValue(project.updated_at, Date.now()),
      })
    } else {
      await store.importRow('chat_projects', {
        id,
        name: textValue(project.name, 200) || 'Untitled',
        description: textValue(project.description, 2000),
        created_at: numberValue(project.created_at, Date.now()),
        updated_at: numberValue(project.updated_at, Date.now()),
      })
    }
    summary.projects++
  }

  const knownProjects = new Set((await store.listProjects()).map((project) => project.id))

  for (const conversation of rows(data.conversations)) {
    const id = idValue(conversation.id)
    if (!id) continue
    const row = {
      id,
      title: textValue(conversation.title, 200),
      // A summary is fed to the model but never shown, so an imported one is dropped and recomputed
      // from the messages the reader can actually see.
      summary: null,
      summary_upto: null,
      pinned: numberValue(conversation.pinned),
      starred: numberValue(conversation.starred),
      // A folder belongs to the notebook, not to the backup: an id the reader does not have any more
      // is dropped rather than left dangling, so the restored row shows up as unfiled.
      folder_id: typeof conversation.folder_id === 'string' && await store.knownFolder(conversation.folder_id)
        ? conversation.folder_id
        : null,
      created_at: numberValue(conversation.created_at, Date.now()),
      updated_at: numberValue(conversation.updated_at, Date.now()),
    }
    if (await store.hasRow('chat_conversations', id)) await store.importUpdate('chat_conversations', id, row)
    else await store.importRow('chat_conversations', row)
    summary.conversations++
  }

  const conversations = new Set((await store.listConversations(undefined, { limit: 500 })).map((entry) => entry.id))

  for (const link of rows(data.conversation_tags)) {
    const conversationId = idValue(link.conversation_id)
    const tagId = idValue(link.tag_id)
    if (!conversationId || !tagId || !conversations.has(conversationId)) continue
    // Tags are the notebook's objects; a link to one the reader deleted is not restored.
    if (!(await store.knownTag(tagId))) continue
    await store.addConversationTag(conversationId, tagId)
  }
  for (const message of rows(data.messages)) {
    const id = idValue(message.id)
    const conversationId = idValue(message.conversation_id)
    if (!id || !conversationId || !conversations.has(conversationId)) continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const row = {
      id,
      conversation_id: conversationId,
      role,
      content: textValue(message.content, 200_000),
      tools: typeof message.tools === 'string' ? message.tools : '[]',
      // Same reason as every other field here: a column this rebuild does not name is written as NULL,
      // and a NOT NULL column makes INSERT OR IGNORE drop the whole message.
      attachments: typeof message.attachments === 'string' ? message.attachments : '[]',
      status: ['complete', 'error', 'cancelled'].includes(String(message.status)) ? message.status : 'complete',
      error: typeof message.error === 'string' ? message.error.slice(0, 1000) : null,
      // A restored message is data, never live owner input: the retry path refuses to re-send one.
      source: 'import',
      input_tokens: numberValue(message.input_tokens),
      output_tokens: numberValue(message.output_tokens),
      duration_ms: numberValue(message.duration_ms),
      model_label: textValue(message.model_label, 200),
      created_at: numberValue(message.created_at, Date.now()),
    }
    if (await store.hasRow('chat_messages', id)) continue
    await store.importRow('chat_messages', row)
    summary.messages++
  }

  // The answers a reader paged away from. They ride with the thread they belong to: a restored
  // conversation whose pager had counted three answers but listed none would lie in its own interface.
  for (const version of rows(data.answer_versions)) {
    const id = idValue(version.id)
    const messageId = idValue(version.message_id)
    const conversationId = idValue(version.conversation_id)
    if (!id || !messageId || !conversationId || !conversations.has(conversationId)) continue
    const row = {
      id,
      message_id: messageId,
      conversation_id: conversationId,
      content: textValue(version.content, 200_000),
      tools: typeof version.tools === 'string' ? version.tools : '[]',
      model_label: textValue(version.model_label, 200),
      input_tokens: numberValue(version.input_tokens),
      output_tokens: numberValue(version.output_tokens),
      duration_ms: numberValue(version.duration_ms),
      created_at: numberValue(version.created_at, Date.now()),
    }
    if (await store.hasRow('chat_answer_versions', id)) continue
    await store.importRow('chat_answer_versions', row)
    summary.answerVersions++
  }

  for (const memory of rows(data.memories)) {
    const id = idValue(memory.id)
    if (!id) continue
    const updatedAt = numberValue(memory.updated_at, Date.now())
    const existing = await store.getMemory(id)
    // Never overwrite a newer local edit with an older backup copy.
    if (existing && existing.updatedAt >= updatedAt) {
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
      created_at: numberValue(memory.created_at, updatedAt),
      updated_at: updatedAt,
    }
    if (existing) await store.importUpdate('chat_memories', id, row)
    else await store.importRow('chat_memories', row)
    summary.memories++
  }
  for (const task of rows(data.tasks)) {
    const id = idValue(task.id)
    if (!id) continue
    const projectId = idValue(task.project_id)
    const row = {
      id,
      title: textValue(task.title, 300) || 'Untitled task',
      description: textValue(task.description, 10_000),
      status: oneOf(task.status, ['todo', 'in_progress', 'done'], 'todo'),
      priority: oneOf(task.priority, ['low', 'medium', 'high', 'urgent'], 'medium'),
      due_at: numberOrNull(task.due_at),
      project_id: projectId && knownProjects.has(projectId) ? projectId : null,
      created_at: numberValue(task.created_at, Date.now()),
      updated_at: numberValue(task.updated_at, Date.now()),
      completed_at: numberOrNull(task.completed_at),
    }
    if (await store.hasRow('chat_tasks', id)) await store.importUpdate('chat_tasks', id, row)
    else await store.importRow('chat_tasks', row)
    summary.tasks++
  }

  for (const notification of rows(data.notifications)) {
    const id = idValue(notification.id)
    if (!id) continue
    if (await store.hasRow('chat_notifications', id)) continue
    await store.importRow('chat_notifications', {
      id,
      title: textValue(notification.title, 200) || 'Reminder',
      body: textValue(notification.body, 8000),
      automation_id: idValue(notification.automation_id),
      read_at: numberOrNull(notification.read_at),
      created_at: numberValue(notification.created_at, Date.now()),
    })
    summary.notifications++
  }

  let paused = 0
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
    await store.importRow('chat_automations', {
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
      created_at: numberValue(automation.created_at, Date.now()),
      updated_at: Date.now(),
    })
    summary.automations++
  }
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
  if (Object.keys(allowed).length) {
    await store.saveSettings(mergeImportedSettings(await store.getSettings(), allowed))
  }
  return summary
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
