/**
 * The D1 history drawer: search the stored statements, insert one at the caret, or trim the list.
 *
 * The list is read from localStorage by the panel and handed here, so this dialog never sees a stale
 * copy of its own.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../../../components/primitives'
import { Field, Input } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { t as uiT } from '../../../../lib/i18n'
import { SearchField } from '../../components/SearchField'
import { useCfT } from '../../i18n'
import { formatDateTime } from '../../lib/format'
import {
  clampHistoryLimit,
  filterHistory,
  type D1HistoryEntry,
} from './d1-history'

export function SqlHistoryDialog({
  open,
  entries,
  limit,
  onClose,
  onPick,
  onClear,
  onLimitChange,
}: {
  open: boolean
  entries: readonly D1HistoryEntry[]
  limit: number
  onClose: () => void
  onPick: (sql: string) => void
  onClear: () => void
  onLimitChange: (limit: number) => void
}) {
  const t = useCfT()
  const [search, setSearch] = useState('')
  const [limitDraft, setLimitDraft] = useState(String(limit))

  useEffect(() => {
    if (!open) return
    setSearch('')
    setLimitDraft(String(limit))
  }, [open, limit])

  const filtered = useMemo(() => filterHistory(entries, search), [entries, search])

  async function clearAll(): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.storage.d1_history_clear'),
      confirmLabel: t('cloudflare.storage.d1_history_clear'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    onClear()
  }

  function saveLimit(): void {
    onLimitChange(clampHistoryLimit(Number(limitDraft)))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${t('cloudflare.storage.d1_history')} (${entries.length})`}
      width={640}
      footer={(
        <>
          <Button variant="ghost" disabled={entries.length === 0} onClick={() => { void clearAll() }}>
            {t('cloudflare.storage.d1_history_clear')}
          </Button>
          <Button variant="secondary" onClick={onClose}>{uiT('common.close')}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={t('cloudflare.storage.d1_history_search_placeholder')}
          label={t('cloudflare.storage.d1_history_search_placeholder')}
        />

        <div className="max-h-64 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          {entries.length === 0 ? (
            <p className="px-3 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('cloudflare.storage.d1_history_empty')}
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('cloudflare.storage.d1_history_no_match')}
            </p>
          ) : (
            <ul>
              {filtered.map((entry) => (
                <li key={`${entry.ts}-${entry.sql}`}>
                  <button
                    type="button"
                    title={entry.sql}
                    onClick={() => {
                      onPick(entry.sql)
                      onClose()
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">
                      {entry.sql}
                    </span>
                    <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {formatDateTime(entry.ts)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('cloudflare.storage.d1_history_limit_label')} className="w-56">
            <Input
              type="number"
              min={5}
              max={500}
              value={limitDraft}
              onChange={(event) => setLimitDraft(event.target.value)}
            />
          </Field>
          <Button size="sm" variant="secondary" onClick={saveLimit}>
            {uiT('common.save')}
          </Button>
          <span className="pb-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('cloudflare.storage.d1_history_limit')}: {limit}
          </span>
        </div>
      </div>
    </Modal>
  )
}
