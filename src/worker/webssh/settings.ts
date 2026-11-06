// Account-level WebSSH settings. Recording is off unless this row explicitly enables it, so a
// deployment that never writes `webssh_settings` produces no recordings and no R2 objects.

import type { WebsshRecordingSettingsView } from '@shared/webssh/types'
import { WEBSSH_RECORDING_RETENTION_DAYS } from './constants'

export interface WebsshSettings {
  recording: {
    enabled: boolean
  }
}

function recordingOff(): WebsshSettings {
  return { recording: { enabled: false } }
}

/** Tolerant of hand-edited or older JSON: anything unreadable means recording stays off. */
export function parseWebsshSettings(raw: string | null | undefined): WebsshSettings {
  if (!raw) return recordingOff()
  try {
    const value = JSON.parse(raw) as { recording?: { enabled?: unknown } }
    return { recording: { enabled: value?.recording?.enabled === true } }
  } catch {
    return recordingOff()
  }
}

export async function readWebsshSettings(db: D1Database, userId: string): Promise<WebsshSettings> {
  const row = await db
    .prepare(`SELECT settings FROM webssh_settings WHERE user_id = ?1`)
    .bind(userId)
    .first<{ settings: string }>()
  return parseWebsshSettings(row?.settings)
}

export async function isWebsshRecordingEnabled(db: D1Database, userId: string): Promise<boolean> {
  const settings = await readWebsshSettings(db, userId)
  return settings.recording.enabled
}

export async function setWebsshRecordingEnabled(
  db: D1Database,
  userId: string,
  enabled: boolean,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO webssh_settings (user_id, settings, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
    )
    .bind(userId, JSON.stringify({ recording: { enabled } }), now)
    .run()
}

export function websshRecordingSettingsView(enabled: boolean): WebsshRecordingSettingsView {
  return { recording: { enabled, retentionDays: WEBSSH_RECORDING_RETENTION_DAYS } }
}
