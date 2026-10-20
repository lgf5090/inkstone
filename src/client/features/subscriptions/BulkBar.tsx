/**
 * The row of things to do with a selection, and the two file operations that need no selection.
 *
 * Export and import live here rather than in the settings dialog because they act on the list the reader
 * is looking at, and because a settings screen is where a preference goes, not where a file goes.
 *
 * Import deliberately does not create anything until the reader has seen how many rows the file held:
 * a spreadsheet is the one input where a person can hand over four hundred lines without counting them,
 * and the number is the difference between reviewing an import and discovering one.
 */
import { useRef, useState, type ReactElement } from 'react'
import { Download, FileUp, Tag, Trash2, XCircle } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { isImeComposing } from '../../lib/ime'
import type { SubscriptionItem } from '@shared/subscriptions/model'
import { CSV_BOM, csvFilename, parseCsv, rowToInput, toCsv } from './csv'
import { downloadTextFile } from '../../lib/export-note'
import { useSubscriptions } from './store'

export function BulkBar({ items }: { items: readonly SubscriptionItem[] }): ReactElement | null {
  const selection = useSubscriptions((state) => state.selection)
  const clearSelection = useSubscriptions((state) => state.clearSelection)
  const bulk = useSubscriptions((state) => state.bulk)
  const importRows = useSubscriptions((state) => state.importRows)
  const fileRef = useRef<HTMLInputElement>(null)
  const [categoryDraft, setCategoryDraft] = useState<string | null>(null)
  const [pending, setPending] = useState<{ rows: ReturnType<typeof parseCsv>; filename: string } | null>(null)

  const report = (count: number, action: string): void => {
    useUi.getState().toast({
      title: t('subscriptions.bulk.done'),
      description: t('subscriptions.bulk.done_detail', { count, action }),
      tone: count > 0 ? 'success' : 'warning',
    })
  }

  const apply = async (action: 'activate' | 'deactivate', label: string): Promise<void> => {
    report(await bulk(action), label)
  }

  const applyCategory = async (): Promise<void> => {
    const category = (categoryDraft ?? '').trim()
    if (!category) return
    report(await bulk('set_category', category), t('subscriptions.bulk.category'))
    setCategoryDraft(null)
  }

  const trashSelected = async (): Promise<void> => {
    const ok = await confirm({
      title: t('subscriptions.bulk.trash'),
      description: t('subscriptions.bulk.trash_confirm', { count: selection.length }),
      confirmLabel: t('subscriptions.bulk.trash'),
    })
    if (ok) report(await bulk('trash'), t('subscriptions.bulk.trash'))
  }

  const exportCsv = (): void => {
    // Excel reads a UTF-8 file in the local codepage unless the document opens with a byte-order mark,
    // which is how a plan named in Chinese comes back as mojibake; the importer strips the same mark.
    downloadTextFile(csvFilename(), `${CSV_BOM}${toCsv(items)}`, 'text/csv;charset=utf-8')
  }

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      const text = await file.text()
      setPending({ rows: parseCsv(text), filename: file.name })
    } catch (error) {
      // A file the browser would not hand over is not an empty spreadsheet. Saying "0 rows" here would
      // send the reader back to check the file rather than the disk, the selection or the permission.
      useUi.getState().toast({
        title: t('subscriptions.import.read_failed'),
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      })
    }
  }

  const confirmImport = async (): Promise<void> => {
    if (!pending) return
    const result = await importRows(pending.rows.map(rowToInput))
    setPending(null)
    if (!result) return
    useUi.getState().toast({
      title: t('subscriptions.import.done'),
      description: t('subscriptions.import.done_detail', { created: result.created, skipped: result.skipped.length }),
      tone: result.skipped.length ? 'warning' : 'success',
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
      {selection.length > 0 && (
        <>
          <span className="text-[length:var(--text-11-5)] tabular-nums text-[var(--text-secondary)]">
            {t('subscriptions.bulk.selected', { count: selection.length })}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void apply('activate', t('subscriptions.bulk.activate'))}>
            {t('subscriptions.bulk.activate')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void apply('deactivate', t('subscriptions.bulk.deactivate'))}>
            {t('subscriptions.bulk.deactivate')}
          </Button>
          <Button size="sm" variant="secondary" icon={<Tag size={12} />} onClick={() => setCategoryDraft('')}>
            {t('subscriptions.bulk.category')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void trashSelected()}>
            {t('subscriptions.bulk.trash')}
          </Button>
          <IconButton label={t('subscriptions.bulk.clear')} size="sm" onClick={clearSelection}>
            <XCircle size={13} />
          </IconButton>
          {categoryDraft !== null && (
            <span className="flex w-full items-center gap-1.5">
              <Input
                className="min-w-0 flex-1"
                autoFocus
                value={categoryDraft}
                aria-label={t('subscriptions.bulk.category')}
                placeholder={t('subscriptions.bulk.category_placeholder')}
                onChange={(event) => setCategoryDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (isImeComposing(event)) return
                  if (event.key === 'Enter') void applyCategory()
                  if (event.key === 'Escape') setCategoryDraft(null)
                }}
              />
              <Button size="sm" variant="primary" disabled={!categoryDraft.trim()} onClick={() => void applyCategory()}>
                {t('subscriptions.bulk.apply')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCategoryDraft(null)}>{t('subscriptions.cancel')}</Button>
            </span>
          )}
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label={t('subscriptions.import.pick')}
        onChange={(event) => void pickFile(event.target.files?.[0])}
      />
      <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={exportCsv}>
        {t('subscriptions.export')}
      </Button>
      <Button size="sm" variant="ghost" icon={<FileUp size={13} />} onClick={() => fileRef.current?.click()}>
        {t('subscriptions.import')}
      </Button>
      {pending && (
        <div className="flex w-full items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
            {t('subscriptions.import.confirm', { filename: pending.filename, count: pending.rows.length })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setPending(null)}>{t('subscriptions.cancel')}</Button>
          <Button size="sm" variant="primary" onClick={() => void confirmImport()}>{t('subscriptions.import.go')}</Button>
        </div>
      )}
    </div>
  )
}
