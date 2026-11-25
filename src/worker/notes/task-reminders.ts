import { normalizeAssistantSettings, type AssistantSettings } from '@shared/assistant'
import { EN_US_NOTE_NOTIFY } from '../../shared/locales/en-US-note-notify'
import { ZH_CN_NOTE_NOTIFY } from '../../shared/locales/zh-CN-note-notify'
import type { Env } from '../env'
import { AssistantStore } from '../assistant/store'
import { newPushFanoutTally, NotificationPushFanout, type PushFanoutTally } from '../assistant/push-fanout'

const SWEEP_LIMIT = 50
const DAY_MS = 86_400_000

type WaitUntil = (task: Promise<unknown>) => void

interface DueNoteTask {
  user_id: string
  id: string
  note_id: string
  title: string
  due_day: string
}

export interface NoteTaskReminderSweepResult {
  due: number
  sent: number
  claimed: number
  skipped: number
  failed: number
  push: Promise<PushFanoutTally>
}

function copyFor(language: AssistantSettings['language']) {
  return language === 'en-US' ? EN_US_NOTE_NOTIFY : ZH_CN_NOTE_NOTIFY
}

function localDay(now: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(now))
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
    return `${value('year')}-${value('month')}-${value('day')}`
  }
  catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}

export async function sweepNoteTaskReminders(
  env: Env,
  now = Date.now(),
  waitUntil?: WaitUntil,
): Promise<NoteTaskReminderSweepResult> {
  const maxDay = new Date(now + DAY_MS).toISOString().slice(0, 10)
  const { results } = await env.DB.prepare(
    `SELECT r.user_id, r.id, r.note_id, r.title, r.due_day
       FROM note_task_reminders r
       JOIN notes n ON n.user_id = r.user_id AND n.id = r.note_id
      WHERE r.fired_at IS NULL AND r.completed = 0 AND r.due_day <= ?1
        AND n.deleted_at IS NULL AND n.is_encrypted = 0
      ORDER BY r.due_day ASC, r.id ASC LIMIT ?2`,
  ).bind(maxDay, SWEEP_LIMIT).all<DueNoteTask>()

  const fanout = new NotificationPushFanout(env)
  const stores = new Map<string, AssistantStore>()
  let sent = 0
  let claimed = 0
  let skipped = 0
  let failed = 0

  for (const row of results) {
    try {
      let store = stores.get(row.user_id)
      if (!store) {
        store = new AssistantStore(env.DB, row.user_id, env)
        stores.set(row.user_id, store)
      }
      const settings = normalizeAssistantSettings(await store.getSettings())
      if (row.due_day > localDay(now, settings.timezone)) {
        skipped++
        continue
      }
      const claim = await env.DB.prepare(
        `UPDATE note_task_reminders SET fired_at = ?3
          WHERE user_id = ?1 AND id = ?2 AND fired_at IS NULL AND completed = 0
            AND EXISTS (
              SELECT 1 FROM notes n
               WHERE n.user_id = ?1 AND n.id = note_task_reminders.note_id
                 AND n.deleted_at IS NULL AND n.is_encrypted = 0
            )`,
      ).bind(row.user_id, row.id, now).run()
      if ((claim.meta.changes ?? 0) === 0) {
        claimed++
        continue
      }
      const copy = copyFor(settings.language)
      const notification = await store.createNotification({
        title: `${copy.title} · ${row.title}`,
        body: copy.due.replace('{when}', row.due_day),
        link: `note:${row.note_id}`,
      })
      fanout.track(row.user_id, notification.id)
      sent++
    }
    catch (error) {
      failed++
      console.error('[inkstone] note task reminder failed:', error instanceof Error ? error.message : error)
    }
  }

  const push = fanout.empty ? Promise.resolve(newPushFanoutTally()) : fanout.flush()
  if (waitUntil) waitUntil(push)
  else await push
  return { due: results.length, sent, claimed, skipped, failed, push }
}
