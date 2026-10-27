/**
 * The CSV importer.
 *
 * The server decides everything about the file (header, duplicates, name extraction); this dialog
 * only collects the file and the `skipVerify` choice and shows the per-row answer. The result stays
 * on screen after the import so a reader can see which rows were skipped and why.
 */
import { useState } from 'react'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { Button } from '../../../../components/primitives'
import { Checkbox, Field, Input } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { accountsApi, type ImportResponse } from '../../api/accounts'
import { cfErrorText } from '../../api/client'
import { cfT } from '../../i18n'
import { ResultTable, SummaryCounts, type ResultRow } from './BatchDialogs'

export function ImportCsvDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: () => void
}) {
  const toast = useUi((state) => state.toast)
  const [file, setFile] = useState<File | null>(null)
  const [skipVerify, setSkipVerify] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reset(): void {
    setFile(null)
    setSkipVerify(false)
    setImporting(false)
    setResult(null)
    setError(null)
  }

  function close(): void {
    reset()
    onClose()
  }

  async function runImport(): Promise<void> {
    if (!file) {
      toast({ title: cfT('cloudflare.accounts.msg.csv_file_required'), tone: 'warning' })
      return
    }
    setImporting(true)
    setError(null)
    setResult(null)
    try {
      const response = await accountsApi.importCsv(file, skipVerify)
      setResult(response)
      toast({
        title: cfT('cloudflare.accounts.msg.import_complete', {
          success: response.summary.success,
          skipped: response.summary.skipped,
          error: response.summary.error,
          skipNote: skipVerify ? cfT('cloudflare.accounts.msg.import_skip_note') : '',
        }),
        tone: response.summary.error > 0 ? 'warning' : 'success',
      })
      onImported()
    } catch (caught) {
      const message = cfErrorText(caught)
      setError(message)
      toast({ title: t('common.action_failed'), description: message, tone: 'danger' })
    } finally {
      setImporting(false)
    }
  }

  const rows: ResultRow[] = (result?.results ?? []).map((row, index) => ({
    key: `${row.email}:${index}`,
    name: row.name,
    status: row.status,
    ...(row.message ? { message: row.message } : {}),
  }))

  return (
    <Modal
      open={open}
      onClose={close}
      title={cfT('cloudflare.accounts.import_modal_title')}
      width={720}
      dismissible={!importing}
      footer={(
        <>
          <Button variant="ghost" onClick={close} disabled={importing}>{t('common.close')}</Button>
          <Button loading={importing} disabled={!file} onClick={() => { void runImport() }}>
            {cfT('cloudflare.accounts.import_csv')}
          </Button>
        </>
      )}
    >
      <div className="grid gap-3">
        <p className="m-0 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2.5 text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
          {cfT('cloudflare.accounts.import_instructions')}
        </p>
        <Field label={cfT('cloudflare.accounts.select_csv_file')}>
          <Input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <Checkbox checked={skipVerify} onChange={setSkipVerify} label={cfT('cloudflare.accounts.skip_verify')} />
        {importing && (
          <p role="status" className="m-0 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {cfT('cloudflare.accounts.importing')}
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-12)] text-[var(--danger)]">
            {error}
          </p>
        )}
        {result && (
          <div className="grid gap-3">
            <SummaryCounts summary={result.summary} />
            <ResultTable rows={rows} firstColumn="email" label={cfT('cloudflare.accounts.import_modal_title')} />
          </div>
        )}
      </div>
    </Modal>
  )
}
