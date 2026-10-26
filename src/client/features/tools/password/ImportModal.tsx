import { useState, type DragEvent, type ChangeEvent } from 'react'
import { UploadCloud, AlertCircle } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Modal } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Select, Textarea } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { usePasswordVaultStore } from './store'
import { parseCSV, type ParsedCsvAccount } from './utils/csv-parser'
import { encryptValue } from './crypto'
import { passwordApi } from './api'
import type { PasswordGroup } from '@shared/tools/password/types'

export interface ImportModalProps {
  open?: boolean
  onClose?: () => void
  group?: PasswordGroup | null
}

const IMPORT_TXT_VOCABULARY = {
  TITLE_PREFIX: '标题:',
  USER_PREFIX: '用户名:',
  PASS_PREFIX: '密码:',
  TITLE_KEY: '标题',
  USER_KEY1: '用户名',
  USER_KEY2: '账号',
  PASS_KEY: '密码',
  LINK_KEY1: '网址',
  LINK_KEY2: '链接',
  REMARK_KEY1: '备注',
  REMARK_KEY2: '说明',
}

export function parseImportData(text: string): ParsedCsvAccount[] {
  if (!text || !text.trim()) return []

  // Check if text is block-formatted TXT
  if (
    text.includes(IMPORT_TXT_VOCABULARY.TITLE_PREFIX) ||
    text.includes(IMPORT_TXT_VOCABULARY.USER_PREFIX) ||
    text.includes(IMPORT_TXT_VOCABULARY.PASS_PREFIX) ||
    text.includes('Title:') ||
    text.includes('Username:')
  ) {
    const blocks = text.split(/[-=]{3,}|\n\s*\n/)
    const results: ParsedCsvAccount[] = []

    for (const block of blocks) {
      const lines = block.split('\n')
      const acc: ParsedCsvAccount = { title: '', username: '', password: '', link: '', remark: '' }
      for (const line of lines) {
        const colonIdx = line.indexOf(':')
        if (colonIdx === -1) continue
        const k = line.substring(0, colonIdx).trim()
        const v = line.substring(colonIdx + 1).trim()
        if (k.includes(IMPORT_TXT_VOCABULARY.TITLE_KEY) || /title/i.test(k)) acc.title = v
        else if (k.includes(IMPORT_TXT_VOCABULARY.USER_KEY1) || k.includes(IMPORT_TXT_VOCABULARY.USER_KEY2) || /user|account/i.test(k)) acc.username = v
        else if (k.includes(IMPORT_TXT_VOCABULARY.PASS_KEY) || /pass|pwd/i.test(k)) acc.password = v
        else if (k.includes(IMPORT_TXT_VOCABULARY.LINK_KEY1) || k.includes(IMPORT_TXT_VOCABULARY.LINK_KEY2) || /url|link/i.test(k)) acc.link = v
        else if (k.includes(IMPORT_TXT_VOCABULARY.REMARK_KEY1) || k.includes(IMPORT_TXT_VOCABULARY.REMARK_KEY2) || /remark|note/i.test(k)) acc.remark = v
      }
      if (acc.title || acc.username || acc.password || acc.link) {
        results.push(acc)
      }
    }

    if (results.length > 0) {
      return results
    }
  }

  // Fall back to standard CSV parsing
  return parseCSV(text)
}

export function ImportModal({ open, onClose, group }: ImportModalProps) {
  const toast = useUi((s) => s.toast)
  const storeIsOpen = usePasswordVaultStore((s) => s.isImportModalOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeImportModal)
  const storeTargetGroup = usePasswordVaultStore((s) => s.targetGroupForExportImport)
  const groups = usePasswordVaultStore((s) => s.groups)
  const selectedGroupId = usePasswordVaultStore((s) => s.selectedGroupId)
  const keyIV = usePasswordVaultStore((s) => s.keyIV)
  const refreshData = usePasswordVaultStore((s) => s.refreshData)

  const isVisible = open !== undefined ? open : storeIsOpen
  const handleClose = onClose || storeClose
  const activeGroup = group !== undefined ? group : storeTargetGroup

  const [targetGroupId, setTargetGroupId] = useState<string>(
    activeGroup?.id || selectedGroupId || (groups[0]?.id ?? '')
  )
  const [rawText, setRawText] = useState<string>('')
  const [parsedData, setParsedData] = useState<ParsedCsvAccount[]>([])
  const [fileName, setFileName] = useState<string>('')
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMsg, setErrorMsg] = useState<string>('')

  const handleTextChange = (text: string) => {
    setRawText(text)
    setErrorMsg('')
    const parsed = parseImportData(text)
    setParsedData(parsed)
  }

  const handleFile = async (file: File) => {
    if (!file) return
    setFileName(file.name)
    setErrorMsg('')
    try {
      const text = await file.text()
      handleTextChange(text)
    } catch {
      setErrorMsg(t('tools.password.import.read_failed'))
    }
  }

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      void handleFile(file)
    }
  }

  const handleDragOver = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) {
      void handleFile(file)
    }
  }

  const handleSubmit = async () => {
    if (!targetGroupId) {
      setErrorMsg(t('tools.password.import.select_target'))
      return
    }
    if (!keyIV) {
      setErrorMsg(t('tools.password.import.vault_locked'))
      return
    }
    if (parsedData.length === 0) {
      setErrorMsg(t('tools.password.import.no_records'))
      return
    }

    setIsSubmitting(true)
    setErrorMsg('')
    try {
      const payload = parsedData.map((acc, index) => ({
        groupId: targetGroupId,
        title: acc.title ? encryptValue(keyIV, acc.title) : '',
        username: acc.username ? encryptValue(keyIV, acc.username) : '',
        password: acc.password ? encryptValue(keyIV, acc.password) : '',
        link: acc.link ? encryptValue(keyIV, acc.link) : '',
        remark: acc.remark ? encryptValue(keyIV, acc.remark) : '',
        favicon: '',
        isFavorite: false,
        sort: index,
      }))

      await passwordApi.batchImportAccounts(targetGroupId, payload)
      await refreshData()

      toast({
        title: t('tools.password.import.success', { count: parsedData.length }),
        tone: 'success',
      })
      handleClose()
    } catch (err: any) {
      setErrorMsg(err?.message || t('tools.password.import.failed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal
      open={isVisible}
      onClose={handleClose}
      title={t('tools.password.import.title')}
      width={680}
      dismissible={!isSubmitting}
    >
      <div className="flex flex-col gap-4 text-[var(--text-primary)]">
        {/* Target Group Selector */}
        <div className="flex items-center gap-2">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.password.batch.target_group')}:
          </span>
          <Select
            value={targetGroupId}
            onChange={(e) => setTargetGroupId(e.target.value)}
            className="h-8 min-w-44 text-[length:var(--text-12)]"
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </div>

        {/* Drag and drop upload area: a label whose control is the file input, so pressing anywhere on it
            opens the picker without a handler imitating a click, and the keyboard reaches the input. */}
        <label
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center gap-2 rounded-[var(--r-lg)] border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
            isDragging
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border-default)] bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)]'
          }`}
        >
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            onChange={handleFileInputChange}
            aria-label={t('tools.password.import.upload')}
            className="sr-only"
          />
          <div className="flex size-10 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[var(--text-secondary)] shadow-sm">
            <UploadCloud size={20} />
          </div>
          <div>
            <span className="font-medium text-[length:var(--text-13)] text-[var(--text-primary)]">
              {fileName ? fileName : t('tools.password.import.upload')}
            </span>
            <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.password.import.drop_hint')}
            </p>
          </div>
        </label>

        {/* Direct Text Paste Area */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.password.import.paste_hint')}
          </span>
          <Textarea
            value={rawText}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder={t('tools.password.import.paste_placeholder')}
            rows={3}
            className="font-mono text-[length:var(--text-12)]"
          />
        </div>

        {errorMsg && (
          <div className="flex items-center gap-2 rounded-[var(--r-md)] bg-red-500/10 p-2.5 text-[length:var(--text-12)] text-red-500">
            <AlertCircle size={15} />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Preview Section */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            <span>{t('tools.password.import.preview')}</span>
            <span>{t('tools.password.import.identified_count', { count: parsedData.length })}</span>
          </div>
          <div className="max-h-48 overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
            {parsedData.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                {t('tools.password.import.no_data')}
              </div>
            ) : (
              <table className="w-full text-left text-[length:var(--text-12)]">
                <thead className="sticky top-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]">
                  <tr>
                    <th className="p-2 font-medium">#</th>
                    <th className="p-2 font-medium">{t('tools.password.account.title')}</th>
                    <th className="p-2 font-medium">{t('tools.password.account.username')}</th>
                    <th className="p-2 font-medium">{t('tools.password.account.password')}</th>
                    <th className="p-2 font-medium">{t('tools.password.account.link')}</th>
                    <th className="p-2 font-medium">{t('tools.password.account.remark')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {parsedData.map((row, idx) => (
                    <tr key={idx} className="hover:bg-[var(--bg-hover)]">
                      <td className="p-2 text-[var(--text-quaternary)]">{idx + 1}</td>
                      <td className="p-2 font-medium text-[var(--text-primary)]">
                        {row.title || '-'}
                      </td>
                      <td className="p-2 text-[var(--text-secondary)]">{row.username || '-'}</td>
                      <td className="p-2 font-mono text-[var(--text-secondary)]">
                        {row.password ? '••••••••' : '-'}
                      </td>
                      <td className="p-2 text-[var(--text-secondary)] truncate max-w-36">
                        {row.link || '-'}
                      </td>
                      <td className="p-2 text-[var(--text-secondary)] truncate max-w-32">
                        {row.remark || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
          <Button
            type="button"
            variant="ghost"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleSubmit}
            loading={isSubmitting}
            disabled={parsedData.length === 0 || !targetGroupId}
          >
            {t('tools.password.import.confirm')} ({parsedData.length})
          </Button>
        </div>
      </div>
    </Modal>
  )
}
