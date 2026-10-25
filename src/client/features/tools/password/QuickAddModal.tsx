import { useState, useMemo } from 'react'
import { PlusCircle, AlertCircle } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Modal } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Select, Textarea, Segmented } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { usePasswordVaultStore } from './store'
import { parseCSVRows } from './utils/csv-parser'
import { encryptValue } from './crypto'
import { passwordApi } from './api'

export type QuickAddMode = 'standard' | 'minimal'

export interface QuickAddModalProps {
  open?: boolean
  onClose?: () => void
  defaultGroupId?: string
}

interface ParsedRow {
  title: string
  username: string
  password: string
  link: string
  remark: string
}

export function QuickAddModal({
  open,
  onClose,
  defaultGroupId,
}: QuickAddModalProps) {
  const toast = useUi((s) => s.toast)
  const storeIsOpen = usePasswordVaultStore((s) => s.isQuickAddModalOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeQuickAddModal)
  const groups = usePasswordVaultStore((s) => s.groups)
  const selectedGroupId = usePasswordVaultStore((s) => s.selectedGroupId)
  const keyIV = usePasswordVaultStore((s) => s.keyIV)
  const refreshData = usePasswordVaultStore((s) => s.refreshData)

  const isVisible = open !== undefined ? open : storeIsOpen
  const handleClose = onClose || storeClose

  const [mode, setMode] = useState<QuickAddMode>('standard')
  const [rawText, setRawText] = useState<string>('')
  const [targetGroupId, setTargetGroupId] = useState<string>(
    defaultGroupId || selectedGroupId || (groups[0]?.id ?? '')
  )
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMsg, setErrorMsg] = useState<string>('')

  // Parse lines in real time
  const parsedRecords = useMemo<ParsedRow[]>(() => {
    if (!rawText.trim()) return []

    const rows = parseCSVRows(rawText)
    const result: ParsedRow[] = []

    for (const cells of rows) {
      if (cells.length === 0 || !cells.some((c) => c.trim().length > 0)) {
        continue
      }

      if (mode === 'minimal') {
        // Minimal mode: title, link
        const title = (cells[0] || '').trim()
        const link = (cells[1] || '').trim()
        if (title || link) {
          result.push({
            title,
            username: '',
            password: '',
            link,
            remark: '',
          })
        }
      } else {
        // Standard mode: title, username, password, link, remark
        const title = (cells[0] || '').trim()
        const username = (cells[1] || '').trim()
        const password = cells[2] || ''
        const link = (cells[3] || '').trim()
        const remark = (cells[4] || '').trim()
        if (title || username || password || link || remark) {
          result.push({
            title,
            username,
            password,
            link,
            remark,
          })
        }
      }
    }

    return result
  }, [rawText, mode])

  const handleSubmit = async () => {
    if (!targetGroupId) {
      setErrorMsg(t('tools.password.quick_add.select_target'))
      return
    }
    if (!keyIV) {
      setErrorMsg(t('tools.password.quick_add.vault_locked'))
      return
    }
    if (parsedRecords.length === 0) {
      setErrorMsg(t('tools.password.quick_add.input_required'))
      return
    }

    setIsSubmitting(true)
    setErrorMsg('')

    try {
      // Encrypt each account payload
      const payload = parsedRecords.map((acc, index) => ({
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
        title: t('tools.password.quick_add.success', { count: parsedRecords.length }),
        tone: 'success',
      })
      setRawText('')
      handleClose()
    } catch (err: any) {
      setErrorMsg(err?.message || t('tools.password.quick_add.failed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const standardPlaceholder = 'GitHub, octocat, pass123, https://github.com, dev\nGoogle, user@gmail.com, pwd456, https://google.com, mail'
  const minimalPlaceholder = 'GitHub, https://github.com\nGoogle, https://google.com\nTwitter, https://x.com'

  return (
    <Modal
      open={isVisible}
      onClose={handleClose}
      title={t('tools.password.account.quick_add')}
      width={680}
      dismissible={!isSubmitting}
    >
      <div className="flex flex-col gap-4 text-[var(--text-primary)]">
        {/* Controls: Target group & Mode */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('tools.password.batch.target_group')}:
            </span>
            <Select
              value={targetGroupId}
              onChange={(e) => setTargetGroupId(e.target.value)}
              className="h-8 min-w-40 text-[length:var(--text-13)]"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="w-56">
            <Segmented<QuickAddMode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'standard', label: t('tools.password.quick_add.standard_mode') },
                { value: 'minimal', label: t('tools.password.quick_add.minimal_mode') },
              ]}
            />
          </div>
        </div>

        {/* Text Area */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <span>
              {mode === 'standard'
                ? t('tools.password.quick_add.standard_format')
                : t('tools.password.quick_add.minimal_format')}
            </span>
            <span>{t('tools.password.quick_add.parsed_count', { count: parsedRecords.length })}</span>
          </div>
          <Textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={mode === 'standard' ? standardPlaceholder : minimalPlaceholder}
            rows={5}
            className="font-mono text-[length:var(--text-12)] leading-relaxed"
          />
        </div>

        {/* Error message */}
        {errorMsg && (
          <div className="flex items-center gap-2 rounded-[var(--r-md)] bg-red-500/10 p-2.5 text-[length:var(--text-12)] text-red-500">
            <AlertCircle size={15} />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Preview Table */}
        <div className="flex flex-col gap-2">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.password.quick_add.preview')}
          </span>
          <div className="max-h-48 overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
            {parsedRecords.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                {t('tools.password.quick_add.preview_empty')}
              </div>
            ) : (
              <table className="w-full text-left text-[length:var(--text-12)]">
                <thead className="sticky top-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]">
                  <tr>
                    <th className="p-2 font-medium">#</th>
                    <th className="p-2 font-medium">{t('tools.password.account.title')}</th>
                    {mode === 'standard' && (
                      <>
                        <th className="p-2 font-medium">{t('tools.password.account.username')}</th>
                        <th className="p-2 font-medium">{t('tools.password.account.password')}</th>
                      </>
                    )}
                    <th className="p-2 font-medium">{t('tools.password.account.link')}</th>
                    {mode === 'standard' && (
                      <th className="p-2 font-medium">{t('tools.password.account.remark')}</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {parsedRecords.map((row, idx) => (
                    <tr key={idx} className="hover:bg-[var(--bg-hover)]">
                      <td className="p-2 text-[var(--text-quaternary)]">{idx + 1}</td>
                      <td className="p-2 font-medium text-[var(--text-primary)]">
                        {row.title || '-'}
                      </td>
                      {mode === 'standard' && (
                        <>
                          <td className="p-2 text-[var(--text-secondary)]">
                            {row.username || '-'}
                          </td>
                          <td className="p-2 font-mono text-[var(--text-secondary)]">
                            {row.password ? '••••••••' : '-'}
                          </td>
                        </>
                      )}
                      <td className="p-2 text-[var(--text-secondary)] truncate max-w-40">
                        {row.link || '-'}
                      </td>
                      {mode === 'standard' && (
                        <td className="p-2 text-[var(--text-secondary)] truncate max-w-32">
                          {row.remark || '-'}
                        </td>
                      )}
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
            disabled={parsedRecords.length === 0 || !targetGroupId}
            icon={<PlusCircle size={15} />}
          >
            {t('tools.password.quick_add.confirm_btn', { count: parsedRecords.length })}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
