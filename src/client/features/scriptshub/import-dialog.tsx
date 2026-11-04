/**
 * Importing a snippet library from another tool.
 *
 * The parsers are shared with the tests and run before anything is sent: a file that cannot be read
 * is refused here, with the reason, rather than becoming a partial import the server has to unwind.
 * The conflict policy is asked before the button is pressed because "overwrite" is destructive and
 * the reader is choosing it for every duplicate at once.
 */
import { useMemo, useRef, useState } from 'react'
import { FileUp, FolderClosed } from 'lucide-react'
import type { ScriptFolder, ScriptImportConflict, ScriptImportSource } from '@shared/scriptshub/types'
import { detectScriptImportSource, parseScriptImport } from '@shared/scriptshub/import'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { SelectMenu } from '../../components/select-menu'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { FolderPicker } from '../folders/FolderPicker'
import { scriptshubApi } from './api'
import { folderPathOf } from './store'
import { asNotebookFolders } from './sidebar'

export function ImportDialog({
  open,
  folders,
  onClose,
  onImported,
}: {
  open: boolean
  folders: readonly ScriptFolder[]
  onClose: () => void
  onImported: () => void
}) {
  const toast = useUi((state) => state.toast)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [source, setSource] = useState<ScriptImportSource | 'auto'>('auto')
  const [conflict, setConflict] = useState<ScriptImportConflict>('skip')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const parsed = useMemo(() => {
    if (!text.trim()) return null
    try {
      const value = JSON.parse(text) as unknown
      const chosen = source === 'auto' ? detectScriptImportSource(value) : source
      const entries = parseScriptImport(chosen, value)
      return { entries, source: chosen }
    } catch (parseError) {
      return { error: parseError instanceof Error ? parseError.message : String(parseError), entries: [], source: 'generic' as ScriptImportSource }
    }
  }, [text, source])

  const pick = async (file: File | undefined) => {
    if (!file) return
    setReading(true)
    setError(null)
    try {
      setText(await file.text())
      setFileName(file.name)
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError))
    } finally {
      setReading(false)
    }
  }

  const run = async () => {
    if (!parsed || parsed.error || !parsed.entries.length) return
    setImporting(true)
    try {
      const result = await scriptshubApi.importEntries({
        source: parsed.source,
        conflict,
        folderId,
        entries: parsed.entries,
      })
      toast({
        title: t('scriptshub.import.done'),
        description: t('scriptshub.import.summary', {
          created: result.created,
          renamed: result.renamed,
          overwritten: result.overwritten,
          skipped: result.skipped,
        }),
        tone: 'success',
      })
      setText('')
      setFileName('')
      onImported()
      onClose()
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError))
    } finally {
      setImporting(false)
    }
  }

  const folderLabel = folderId
    ? folderPathOf(folders, folderId).map((folder) => folder.name).join(' / ')
    : t('scriptshub.sidebar.unfiled')

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('scriptshub.import.title')}
        description={t('scriptshub.import.description')}
        width={560}
        footer={(
          <>
            <Button variant="ghost" onClick={onClose}>{t('scriptshub.common.cancel')}</Button>
            <Button
              variant="primary"
              loading={importing}
              disabled={!parsed || Boolean(parsed.error) || !parsed.entries.length}
              onClick={() => void run()}
            >
              {t('scriptshub.import.run')}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => void pick(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => input.current?.click()}
            className={cn(
              'flex w-full flex-col items-center justify-center gap-2 rounded-[var(--r-md)] border border-dashed border-[var(--border-default)]',
              'px-4 py-7 text-center transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]',
            )}
          >
            <FileUp size={22} aria-hidden="true" className="text-[var(--text-tertiary)]" />
            <span className="text-[length:var(--text-12-5)] font-medium text-[var(--text-secondary)]">
              {reading ? t('scriptshub.import.reading') : fileName || t('scriptshub.import.pick')}
            </span>
            <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('scriptshub.import.formats')}</span>
          </button>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.import.source')}</span>
              <SelectMenu
                label={t('scriptshub.import.source')}
                value={source}
                onChange={setSource}
                options={[
                  { value: 'auto', label: t('scriptshub.import.source_auto') },
                  { value: 'masscode', label: 'masscode' },
                  { value: 'vscode', label: 'VS Code' },
                  { value: 'generic', label: t('scriptshub.import.source_generic') },
                ]}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.import.conflict')}</span>
              <SelectMenu
                label={t('scriptshub.import.conflict')}
                value={conflict}
                onChange={setConflict}
                options={[
                  { value: 'skip', label: t('scriptshub.import.conflict_skip') },
                  { value: 'rename', label: t('scriptshub.import.conflict_rename') },
                  { value: 'overwrite', label: t('scriptshub.import.conflict_overwrite') },
                ]}
              />
            </label>
          </div>

          <div className="space-y-1.5">
            <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.import.folder')}</span>
            <Button variant="secondary" block className="justify-between" onClick={() => setPickerOpen(true)}>
              <span className="flex min-w-0 items-center gap-2">
                <FolderClosed size={13} aria-hidden="true" />
                <span className="truncate">{folderLabel}</span>
              </span>
              <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('scriptshub.common.change')}</span>
            </Button>
          </div>

          {parsed?.error && <p className="text-[length:var(--text-12)] text-[var(--danger)]" role="alert">{parsed.error}</p>}
          {parsed && !parsed.error && (
            <div className="rounded-[var(--r-md)] bg-[var(--bg-raised)] p-3 text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {t('scriptshub.import.preview', { count: parsed.entries.length })}
            </div>
          )}
          {error && <p className="text-[length:var(--text-12)] text-[var(--danger)]" role="alert">{error}</p>}
        </div>
      </Modal>
      <FolderPicker
        open={pickerOpen}
        title={t('scriptshub.import.folder')}
        folders={asNotebookFolders(folders)}
        currentId={folderId}
        allowRoot
        rootLabel={t('scriptshub.sidebar.unfiled')}
        zIndex={2400}
        onSelect={setFolderId}
        onClose={() => setPickerOpen(false)}
      />
    </>
  )
}
