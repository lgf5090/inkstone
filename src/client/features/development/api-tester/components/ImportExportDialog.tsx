import { useEffect, useState } from 'react'
import { Download, RefreshCw, Trash2, Upload } from 'lucide-react'
import { normalizeState, stateDataOf } from '@shared/development/api-tester/state'
import type { ApiTesterFile } from '@shared/development/api-tester/types'
import { Modal, confirm } from '../../../../components/overlay'
import { Button, IconButton } from '../../../../components/primitives'
import { Textarea } from '../../../../components/form'
import { CopyButton } from '../../../../components/copy-button'
import { useUi } from '../../../../store/ui'
import { t } from '../../../../lib/i18n'
import { deleteFile, fetchFileText, fileUrl, listFiles, uploadText } from '../api'
import { formatSize } from '../lib/relay-client'
import { useApiTesterStore } from '../store'

export function ImportExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useApiTesterStore((s) => s.state)
  const workspaceId = useApiTesterStore((s) => s.activeWorkspaceId)
  const patchState = useApiTesterStore((s) => s.patchState)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [scriptWarning, setScriptWarning] = useState(false)
  const [files, setFiles] = useState<ApiTesterFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)

  const exportJson = JSON.stringify(stateDataOf(state), null, 2)

  const loadFiles = async () => {
    setFilesLoading(true)
    try {
      setFiles(await listFiles('json'))
    } catch (failure) {
      console.warn('[inkstone] API Tester server files could not be listed', failure)
    } finally {
      setFilesLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setText('')
    setError('')
    setScriptWarning(false)
    void loadFiles()
  }, [open])

  const download = () => {
    const blob = new Blob([exportJson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `api-tester-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const importText = (value: string) => {
    try {
      const parsed = JSON.parse(value) as unknown
      const normalized = normalizeState(parsed, workspaceId)
      const hasScripts = normalized.nodes.some((node) => node.preScript?.trim() || node.tests?.trim())
      if (hasScripts && !scriptWarning) {
        setScriptWarning(true)
        return
      }
      patchState(() => normalized)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const saveToServer = async () => {
    try {
      await uploadText(exportJson, 'json', `api-tester-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, 'application/json')
      useUi.getState().toast({ title: t('development.apitester.files.saved_at'), tone: 'success' })
      await loadFiles()
    } catch (failure) {
      useUi.getState().toast({ title: failure instanceof Error ? failure.message : String(failure), tone: 'danger' })
    }
  }

  const removeFile = async (file: ApiTesterFile) => {
    const ok = await confirm({
      title: t('development.apitester.files.delete'),
      description: t('development.apitester.files.delete_confirm'),
      tone: 'danger',
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return
    try {
      await deleteFile(file.id)
      setFiles((current) => current.filter((entry) => entry.id !== file.id))
    } catch (failure) {
      useUi.getState().toast({ title: failure instanceof Error ? failure.message : String(failure), tone: 'danger' })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.apitester.io_title')} description={t('development.apitester.io_desc')} width={700}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" className="gap-1" onClick={download}><Download size={13} /> {t('development.apitester.download_json')}</Button>
          <CopyButton text={exportJson} label={t('development.apitester.common.copy')} toastMessage={t('development.apitester.copied_to_clipboard')} className="h-7 px-2" />
          <Button size="sm" variant="ghost" className="gap-1" onClick={() => void saveToServer()}><Upload size={13} /> {t('development.apitester.io.save_to_server')}</Button>
        </div>
        <div className="space-y-1">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.apitester.import_data')}</span>
          <Textarea
            value={text}
            onChange={(event) => { setText(event.target.value); setError(''); setScriptWarning(false) }}
            placeholder={t('development.apitester.import_data_placeholder')}
            aria-label={t('development.apitester.import_data')}
            className="min-h-[140px] resize-y font-mono text-[length:var(--text-11)]"
            spellCheck={false}
          />
          {scriptWarning && <div className="rounded-[var(--r-sm)] border border-[var(--warning)]/40 bg-[var(--warning-softer)] p-2 text-[length:var(--text-10-5)] text-[var(--warning)]">{t('development.apitester.script_warning')}</div>}
          {error && <p className="text-[length:var(--text-10-5)] text-[var(--danger)]">{error}</p>}
          <Button size="sm" disabled={!text.trim()} onClick={() => importText(text)}>{scriptWarning ? t('development.apitester.import_with_scripts') : t('development.apitester.import')}</Button>
        </div>
        <div className="space-y-1 border-t border-[var(--border-subtle)] pt-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('development.apitester.files.title')}</span>
            <IconButton label={t('development.apitester.files.load')} size="sm" onClick={() => void loadFiles()}>
              <RefreshCw size={13} className={filesLoading ? 'animate-spin' : undefined} />
            </IconButton>
          </div>
          {files.length === 0 ? (
            <p className="py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.apitester.files.empty')}</p>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {files.map((file) => (
                <div key={file.id} className="flex items-center gap-2 border-b border-[var(--border-subtle)] py-1 text-[length:var(--text-11)]">
                  <span className="min-w-0 flex-1 truncate font-mono">{file.name}</span>
                  <span className="shrink-0 text-[var(--text-tertiary)]">{formatSize(file.size)}</span>
                  <span className="shrink-0 text-[var(--text-tertiary)]">{new Date(file.createdAt).toLocaleString()}</span>
                  <Button size="sm" variant="ghost" onClick={() => void fetchFileText(file.id).then((value) => { setText(value); setScriptWarning(false); setError('') }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))}>
                    {t('development.apitester.files.load')}
                  </Button>
                  <a href={fileUrl(file.id)} download={file.name} className="rounded-[var(--r-sm)] p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" aria-label={t('development.apitester.files.download')}>
                    <Download size={13} />
                  </a>
                  <IconButton label={t('development.apitester.files.delete')} size="sm" onClick={() => void removeFile(file)} className="text-[var(--text-tertiary)] hover:text-[var(--danger)]">
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
