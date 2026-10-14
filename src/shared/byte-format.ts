/**
 * The one place a byte count is turned into the text a reader reads.
 *
 * Four copies of this lived on the worker side alone, each rounding differently: one kept bytes,
 * one printed `Math.ceil` of KB and MB, two printed `toFixed(1)` of MB only, and the interface had
 * two more. A quota warning and the row beside it could therefore disagree about the same number.
 * This is the version the interface already used for attachments, versions and storage stats, so a
 * server-side limit and the client-side bar under it say the same thing.
 */

/** Units stepped by 1024, the way the sizes a reader compares against a limit are counted. */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Above this the single decimal adds nothing a reader acts on. */
const WHOLE_NUMBER_CEILING = 100

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const at = Math.min(
    BYTE_UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  )
  const value = bytes / 1024 ** at
  return `${value >= WHOLE_NUMBER_CEILING || at === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[at]}`
}
