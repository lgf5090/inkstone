/**
 * The minute sweep that runs what is due.
 *
 * Wired into the worker's cron handler alongside the existing queue drains, and deliberately kept out
 * of the hourly branch: a reminder is cheap and late delivery is visible, while the heavy work that
 * runs on the hour (backups, attachment cleanup) must not be able to take the reminders down with it.
 *
 * A routine that calls a model can outlive the sweep that started it, so each automation is claimed
 * before it runs and the claim is only released when it is re-armed — which is what stops a slow AI
 * digest from being started twice by two overlapping ticks.
 *
 * What a routine delivers is a row in `chat_notifications`, and the Web Push nudge that may follow it is
 * not part of the delivery: see `deliver` below and `assistant/push-fanout.ts` for why a push service that
 * refuses cannot make a run fail.
 */

import type { AssistantSettings, Automation } from '@shared/assistant'
import { promptCatalog } from '@shared/assistant-prompt'
import { localDayBounds } from '@shared/assistant-time'
import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import { EN_US_TODO_NOTIFY } from '../../shared/locales/en-US-todo-notify'
import { ZH_CN_TODO_NOTIFY } from '../../shared/locales/zh-CN-todo-notify'
import type { Env } from '../env'
import { normalizeAssistantSettings } from '@shared/assistant'
import { initializeDatabase } from '../db/schema'
import { assertNoteQuota } from '../db/quota'
import type { NoteRow } from '../db/rows'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'
import { FoldersStore } from '../folders/store'
import { NotesStore, type NotePatchColumns } from '../notes/store'
import { AssistantStore, dueAutomations } from './store'
import { AutomationService } from './automations'
import { AssistantRunner } from './runner'
import { loadModelAndProvider } from './model-config'
import { newPushFanoutTally, NotificationPushFanout, type PushFanoutTally } from './push-fanout'

/** How many automations one sweep will start, so a backlog cannot monopolise the cron invocation. */
export const DUE_SWEEP_LIMIT = 20

/**
 * How long one scheduled prompt's model call is allowed to run before it is aborted.
 *
 * Nothing is waiting on the answer the way a chat turn is: a digest arrives when it arrives, and the
 * reader is told by the notification it eventually produces. What has to be bounded is the other
 * direction — a hung upstream would otherwise hold the automation's claim, and the sweep that finds
 * it again would start the same digest a second time.
 */
const SCHEDULED_PROMPT_DEADLINE_MS = 90_000

/**
 * How different a rewritten page has to be before the text it replaces is kept as a version.
 *
 * A routine that overwrites a standing page every morning is the one write that can lose a day of the
 * reader's own editing without them looking, so the previous body is snapshotted on the same rule the
 * editor's save uses — the same reason `routes/notes.ts` keeps its own copy of this number.
 */
const SNAPSHOT_DIFF_THRESHOLD = 400

export interface SweepResult {
  started: number
  failed: number
  /**
   * What the nudges this tick queued cost, once they were sent.
   *
   * A promise rather than the numbers themselves because the sends deliberately run outside the sweep's
   * awaited path: the rows are the delivery, and waiting for a push service to answer would make the tick
   * — and every automation after it — a hostage of a service it does not need. It resolves with counts even
   * when every device refused, so awaiting it is how a caller (or a test) sees that nothing got through.
   */
  push: Promise<PushFanoutTally>
}

/** The shape of `ctx.waitUntil`, which is how a cron fire keeps the sends alive without waiting on them. */
export type SweepWaitUntil = (task: Promise<unknown>) => void

export async function runDueAssistantAutomations(
  env: Env,
  now = Date.now(),
  waitUntil?: SweepWaitUntil,
): Promise<SweepResult> {
  const due = await dueAutomations(env.DB, now, DUE_SWEEP_LIMIT)
  const fanout = new NotificationPushFanout(env)
  let started = 0
  let failed = 0
  for (const entry of due) {
    try {
      await runOne(env, entry.userId, entry.automation, fanout)
      started++
    } catch (error) {
      failed++
      console.error('[inkstone] assistant automation failed:', error instanceof Error ? error.message : error)
    }
  }
  // Nothing delivered means nothing to say: the subscription table is not read at all, so a tick that ran
  // no routine costs no credential lookup and no request.
  const push = fanout.empty ? Promise.resolve(newPushFanoutTally()) : fanout.flush()
  if (waitUntil) waitUntil(push)
  else await push
  return { started, failed, push }
}

async function runOne(env: Env, userId: string, automation: Automation, fanout: NotificationPushFanout): Promise<void> {
  const db = env.DB
  const { ftsEnabled } = await initializeDatabase(env)
  const store = new AssistantStore(db, userId, env)
  const settings = normalizeAssistantSettings(await store.getSettings())
  const service = new AutomationService(store, settings)
  const runner = new AssistantRunner({
    store,
    env,
    ftsEnabled,
    origin: env.PUBLIC_URL ?? '',
    settings,
  })
  const catalog = promptCatalog(settings.language)
  // The notebook's own persistence layer, not a statement of our own: see `fileAnswer` for why writing a
  // routine's answer anywhere else leaves the reader a page the notebook has never heard of.
  const notes = new NotesStore(db, userId, ftsEnabled)
  const folders = new FoldersStore(db, userId)

  /**
   * Delivers one thing this routine has to say: the row, then the queue for a nudge.
   *
   * The order is the rule and it is not negotiable here. `createNotification` is awaited and unchecked,
   * because the row is the delivery: a reader who is nowhere near the app when 07:00 passes still finds
   * this in their notification list. What the fan-out is handed afterwards is the account and the row's id,
   * never the title or the body: a device that refuses, or a deployment with no VAPID keys, has to leave
   * this run looking exactly as it did before pushes existed.
   */
  const deliver = async (input: { title: string, body: string }): Promise<void> => {
    const notification = await store.createNotification({ ...input, automationId: automation.id })
    fanout.track(userId, notification.id)
  }

  await service.fire(automation, async (entry) => {
    switch (entry.kind) {
      case 'reminder': {
        // A plain reminder never spends AI: the message is the whole answer.
        await deliver({ title: entry.message || entry.name, body: entry.message || entry.name })
        return { status: 'success' as const, result: 'delivered' }
      }
      case 'task_digest': {
        const body = await digestBody(store, settings)
        await deliver({ title: entry.name, body })
        if (entry.message) {
          // A digest can carry the reader's own note as well as the computed list.
          await deliver({ title: entry.name, body: entry.message })
        }
        return { status: 'success' as const, result: body.slice(0, 300) }
      }
      case 'assistant_prompt': {
        const blocked = await spendBlocker(store, settings, catalog, entry, deliver)
        if (blocked) return blocked
        const text = await askScheduledPrompt(runner, entry)
        await deliver({ title: entry.name, body: text })
        return { status: 'success' as const, result: text.slice(0, 300) }
      }
      case 'note_write': {
        // The target is proved before the budget is read and long before the model is asked: a routine
        // whose folder was deleted should say so and cost nothing, not answer a whole page into nowhere.
        const target = await resolveWriteTarget(notes, folders, entry)
        const blocked = await spendBlocker(store, settings, catalog, entry, deliver)
        if (blocked) return blocked
        const text = await askScheduledPrompt(runner, entry)
        const written = await fileAnswer(db, userId, notes, entry, target, text)
        await deliver({ title: entry.name, body: `${written.summary}\n\n${text}` })
        return { status: 'success' as const, result: written.summary.slice(0, 300), noteId: written.noteId }
      }
    }
  })
}

/**
 * Whether this turn may spend scheduled AI at all, answered before anything is asked.
 *
 * The two kinds that call a model share the rule, and the refusal has to be the same shape for both: a
 * notification saying it was skipped, and a receipt saying why. Kept as a blocker rather than a boolean
 * because the reason is what the run list shows. The skip is delivered through the same `deliver` as an
 * answer is: "the budget ran out" is exactly the event a reader should be nudged about, and it is the row
 * they will read.
 */
async function spendBlocker(
  store: AssistantStore,
  settings: ReturnType<typeof normalizeAssistantSettings>,
  catalog: ReturnType<typeof promptCatalog>,
  entry: Automation,
  deliver: (input: { title: string, body: string }) => Promise<void>,
): Promise<{ status: 'skipped', result: string } | null> {
  const today = await store.todayUsage()
  if (today.scheduledRuns >= settings.limits.maxScheduledRunsPerDay || !settings.limits.maxScheduledRunsPerDay) {
    await deliver({ title: entry.name, body: catalog.digest_skipped })
    return { status: 'skipped', result: 'scheduled ai budget reached' }
  }
  const resolved = await loadModelAndProvider(store, settings)
  if (!resolved.model || !resolved.provider) {
    await deliver({ title: entry.name, body: catalog.digest_skipped })
    return { status: 'skipped', result: 'no model configured' }
  }
  return null
}

/** One scheduled model call, bounded so a hung upstream cannot hold the claim past the next sweep. */
async function askScheduledPrompt(runner: AssistantRunner, entry: Automation): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SCHEDULED_PROMPT_DEADLINE_MS)
  try {
    return await runner.runScheduledPrompt(entry.message || entry.name, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Where a note-writing routine's answer goes: into a folder as a new page, or onto one page it refills. */
type WriteTarget =
  | { kind: 'folder', folderId: string }
  | { kind: 'note', note: NoteRow }

/**
 * The page or folder the routine was pointed at, proved to still be there.
 *
 * Runs before any model call, and the two failures are told apart because they want different sentences:
 * a page that has been deleted is named, so the reader knows which standing note to point the schedule
 * at again, and a folder that is gone is named too where its row can still be read. A target that points
 * at another account's row reads as missing rather than as someone else's, which is the answer the note
 * routes give for the same id.
 */
async function resolveWriteTarget(
  notes: NotesStore,
  folders: FoldersStore,
  automation: Automation,
): Promise<WriteTarget> {
  if (automation.targetNoteId) {
    const note = await notes.noteRow(automation.targetNoteId)
    if (!note) {
      throw new Error('The page this routine rewrites is gone, so nothing was written.')
    }
    if (note.deleted_at !== null) {
      throw new Error(`The page “${note.title}” this routine rewrites is in the trash, so nothing was written.`)
    }
    return { kind: 'note', note }
  }
  if (automation.targetFolderId) {
    if (await folders.liveFolderRow(automation.targetFolderId)) {
      return { kind: 'folder', folderId: automation.targetFolderId }
    }
    const trashed = await folders.folderRow(automation.targetFolderId)
    throw new Error(trashed
      ? `The folder “${trashed.name}” this routine files into is gone, so nothing was written.`
      : 'The folder this routine files into is gone, so nothing was written.')
  }
  // The create refuses a note-writing schedule with no target, so a row that reaches here is one the
  // column arrived under later or was written around the API; refusing it out loud is the honest answer.
  throw new Error('This note-writing schedule has no target, so nothing was written.')
}

/** What one writing run left behind: the page it holds, and the sentence that says which. */
interface WrittenAnswer {
  noteId: string
  summary: string
}

/**
 * Files the answer through the notebook's own write path.
 *
 * This is the load-bearing decision of the whole feature. `NotesStore` is what `routes/notes.ts` uses,
 * so one call here lands the row together with its tags and wiki links, its embedding and full-text queue
 * rows, its guarded record in `changes` and — for a rewrite — the version the page had before. Writing
 * the same page with a bare `INSERT`, or from the browser with `api.notes.create`, is what an earlier
 * round of this feature did, and both leave the reader a note the notebook has never heard of: it is in
 * no listing, cannot be opened, and no device finds out it exists. The server writes because the cron is
 * what has the answer — nobody's tab is open at 07:00 — and the `changes` row is how every tab that does
 * open later learns of the page, on the same cursor the note routes broadcast.
 *
 * The index queues are not drained from here on purpose: the same cron fire that found this routine
 * drains them (`worker/index.ts`), so the page is searchable on the tick that made it.
 */
async function fileAnswer(
  db: Env['DB'],
  userId: string,
  notes: NotesStore,
  automation: Automation,
  target: WriteTarget,
  text: string,
): Promise<WrittenAnswer> {
  const { words, chars } = countText(text)
  const excerpt = deriveExcerpt(text)
  const contentHash = await sha256Hex(text)

  if (target.kind === 'folder') {
    const title = truncateText(automation.name.trim(), LIMITS.titleMaxLength)
    const id = newId()
    const now = Date.now()
    await assertNoteQuota(db, userId)
    const { row, created } = await notes.create({
      id,
      folderId: target.folderId,
      title,
      content: text,
      excerpt,
      words,
      chars,
      isStarred: false,
      contentHash,
      now,
    })
    // `create` ignores an id that turned out to be taken rather than failing, and a fresh `newId()` losing
    // that race is a collision worth saying out loud: the answer exists in nobody's notebook otherwise.
    if (!created || !row) throw new Error(`The note “${title}” could not be filed, so nothing was written.`)
    return { noteId: row.id, summary: `Wrote “${row.title}”` }
  }

  const current = target.note
  // The same body the page already carries is not a write: nothing moved, so no revision, no version and
  // no link rebuild are earned. The run still names the page, because that is what the reader asked about.
  if (current.content_hash === contentHash) {
    return { noteId: current.id, summary: `Left “${current.title}” as it was` }
  }
  const columns: NotePatchColumns = {
    content: text,
    content_hash: contentHash,
    excerpt,
    word_count: words,
    char_count: chars,
  }
  const patch = await notes.patch({
    current,
    expectedRev: current.rev,
    columns,
    title: current.title,
    content: text,
    contentHash,
    now: Math.max(Date.now(), current.updated_at + 1),
    contentChanged: true,
    titleChanged: false,
    derive: true,
    snapshot: current.content
      ? {
          preserve: false,
          bigChange: Math.abs(text.length - current.content.length) >= SNAPSHOT_DIFF_THRESHOLD,
        }
      : null,
  })
  if (!patch.applied) {
    throw new Error(`The page “${current.title}” was edited while this routine was answering, so it was left alone.`)
  }
  return { noteId: current.id, summary: `Updated “${patch.next.title}”` }
}

/**
 * The digest is computed, not generated.
 *
 * A summary of what is due needs the reader's own task rows, and asking a model to list them costs a
 * request, can miss one, and can invent one. The reference project got this right and the shape is
 * kept: today and overdue first, then the open count that is neither.
 *
 * The words are the to-do app's, not the model's: they live in the same small notification catalog the
 * reminder sweep reads, because this runs on a cron tick with no request and therefore no interface
 * catalog to borrow. The first line is the sentence the reader asked for — today's count, then the
 * overdue count — and the lists underneath are its evidence.
 */
function digestCopyFor(language: AssistantSettings['language']) {
  return language === 'en-US' ? EN_US_TODO_NOTIFY : ZH_CN_TODO_NOTIFY
}

/** Sit the counts into a catalog sentence without pulling the interface's formatter in. */
function fill(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)
}

export async function digestBody(
  store: AssistantStore,
  settings: { timezone: string, language: AssistantSettings['language'] },
): Promise<string> {
  const copy = digestCopyFor(settings.language)
  const bounds = localDayBounds(settings.timezone)
  const now = Date.now()
  const open = await store.listTasks({ status: 'open', limit: 200 })
  const overdue = open.filter((task) => task.dueAt !== null && task.dueAt < now)
  const today = open.filter((task) => task.dueAt !== null && task.dueAt >= now && task.dueAt < bounds.end)
  const rest = open.length - overdue.length - today.length
  const parts: string[] = [
    fill(copy.digestSummary, { today: String(today.length), overdue: String(overdue.length) }),
  ]
  if (overdue.length) parts.push(`**${copy.digestOverdue}**\n${overdue.map((task) => `- ${task.title}`).join('\n')}`)
  if (today.length) parts.push(`**${copy.digestToday}**\n${today.map((task) => `- ${task.title}`).join('\n')}`)
  if (!overdue.length && !today.length) parts.push(copy.digestNone)
  if (rest > 0) parts.push(fill(copy.digestRest, { count: String(rest) }))
  return parts.join('\n\n')
}
