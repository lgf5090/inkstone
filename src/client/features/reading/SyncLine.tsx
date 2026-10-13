/**
 * What the shelf is doing on the wire.
 *
 * A book is tens of megabytes, so an upload without a moving bar reads as a hung app. This is the one
 * place the reader learns whether their notes are on the server yet — including the honest case, which is
 * that they are not.
 */
import { CloudUpload } from 'lucide-react'
import { Button } from '../../components/primitives'
import { t } from '../../lib/i18n'
import { formatPercent } from './position'
import { useLibrary } from './store/library'
import { formatLastRead } from './format-time'

/** Bytes in the unit a reader compares against their own library, not the unit the API counts in. */
function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = Math.max(0, bytes)
  let at = 0
  while (value >= 1024 && at < units.length - 1) {
    value /= 1024
    at += 1
  }
  return `${at === 0 ? value : value.toFixed(1)} ${units[at]}`
}

export function SyncLine() {
  const sync = useLibrary((state) => state.sync)
  const books = useLibrary((state) => state.books)
  const syncPush = useLibrary((state) => state.syncPush)
  const usage = useLibrary((state) => state.usage)
  const busy = sync.phase !== 'idle'
  const percent = sync.total > 0 ? Math.min(1, sync.sent / sync.total) : 0
  const named = sync.bookId ? books.find((one) => one.id === sync.bookId)?.title || '' : ''

  const label = sync.phase === 'uploading'
    ? t('reading.sync_uploading_value0', { value0: named })
    : sync.phase === 'downloading'
      ? t('reading.sync_downloading_value0', { value0: named })
      : sync.phase === 'pushing'
        ? t('reading.sync_pushing')
        : sync.phase === 'pulling'
          ? t('reading.sync_pulling')
          : sync.message
            ? `${t('reading.sync_failed')}: ${sync.message}`
            : sync.at
              ? t('reading.sync_idle_value0', { value0: formatLastRead(sync.at) })
              : t('reading.sync_never')

  return (
    <div className="reader-sync-line flex items-center gap-2 py-1.5">
      <Button
        size="sm"
        variant="ghost"
        icon={<CloudUpload size={13} />}
        disabled={busy}
        onClick={() => void syncPush()}
        aria-label={t('reading.sync_now')}
      >
        {t('reading.sync_now')}
      </Button>
      <span className={`min-w-0 flex-1 truncate text-[11.5px] ${sync.message ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]'}`}>
        {label}
      </span>
      {busy && sync.total > 0 ? (
        <span className="shrink-0 text-[11px] tabular text-[var(--text-tertiary)]">{formatPercent(percent)}</span>
      ) : null}
      {busy ? (
        <span className="reader-sync-track h-[3px] w-24 shrink-0 overflow-hidden rounded-full bg-[var(--border-default)]">
          <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${percent * 100}%` }} />
        </span>
      ) : null}
      {!busy && usage ? (
        <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">
          {t('reading.usage_value0_value1', {
            value0: formatBytes(usage.bytes + usage.covers),
            value1: formatBytes(usage.quotaBytes),
          })}
        </span>
      ) : null}
    </div>
  )
}
