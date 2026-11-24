import { LIMITS } from '@shared/constants'

export function versionRetentionOffsetSql(userIdPlaceholder: string): string {
  return `COALESCE((
    SELECT MAX(1, MIN(${LIMITS.versionsPerNoteMax}, CAST(json_extract(settings, '$.notes.versionRetentionCount') AS INTEGER)))
      FROM users WHERE id = ${userIdPlaceholder}
  ), ${LIMITS.versionsPerNote})`
}
