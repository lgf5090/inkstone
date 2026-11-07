// Account-level WebSSH settings. Recording is off unless this row explicitly enables it, so a
// deployment that never writes `webssh_settings` produces no recordings and no R2 objects.
// First-connection host-key trust is the opposite: it defaults on, because the reference client
// accepts a first-seen key without a prompt; a changed or revoked key is still blocked regardless.

import type { WebsshRecordingSettingsView } from '@shared/webssh/types'
import { WEBSSH_RECORDING_RETENTION_DAYS } from './constants'

export interface WebsshSettings {
  recording: {
    enabled: boolean
  }
  hostKeys: {
    autoTrustFirst: boolean
  }
}

function defaults(): WebsshSettings {
  return { recording: { enabled: false }, hostKeys: { autoTrustFirst: true } }
}

/** Tolerant of hand-edited or older JSON: recording stays off, auto-trust stays on unless disabled. */
export function parseWebsshSettings(raw: string | null | undefined): WebsshSettings {
  if (!raw) return defaults()
  try {
    const value = JSON.parse(raw) as {
      recording?: { enabled?: unknown }
      hostKeys?: { autoTrustFirst?: unknown }
    }
    return {
      recording: { enabled: value?.recording?.enabled === true },
      // Only an explicit `false` turns the switch off; a missing field from an older row means on.
      hostKeys: { autoTrustFirst: value?.hostKeys?.autoTrustFirst !== false },
    }
  } catch {
    return defaults()
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
  return (await readWebsshSettings(db, userId)).recording.enabled
}

export async function isWebsshAutoTrustFirst(db: D1Database, userId: string): Promise<boolean> {
  return (await readWebsshSettings(db, userId)).hostKeys.autoTrustFirst
}

async function writeWebsshSettings(
  db: D1Database,
  userId: string,
  settings: WebsshSettings,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO webssh_settings (user_id, settings, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
    )
    .bind(userId, JSON.stringify(settings), now)
    .run()
}

/** Merges one field so saving recording settings cannot silently reset the host-key switch. */
export async function setWebsshRecordingEnabled(
  db: D1Database,
  userId: string,
  enabled: boolean,
  now: number,
): Promise<void> {
  const current = await readWebsshSettings(db, userId)
  await writeWebsshSettings(db, userId, { ...current, recording: { enabled } }, now)
}

export async function setWebsshAutoTrustFirst(
  db: D1Database,
  userId: string,
  autoTrustFirst: boolean,
  now: number,
): Promise<void> {
  const current = await readWebsshSettings(db, userId)
  await writeWebsshSettings(db, userId, { ...current, hostKeys: { autoTrustFirst } }, now)
}

export function websshRecordingSettingsView(
  enabled: boolean,
  autoTrustFirst: boolean,
): WebsshRecordingSettingsView {
  return {
    recording: { enabled, retentionDays: WEBSSH_RECORDING_RETENTION_DAYS },
    hostKeys: { autoTrustFirst },
  }
}
